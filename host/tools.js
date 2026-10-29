/**
 * Model-facing tools: generate, inspect the queue, cancel, list models.
 *
 * Registration is per agent scope, the same way the shipped tool packages do it:
 * `ctx.inject(['tools', 'systemPrompt'], …)` gives a scope that outlives the
 * plugin's own apply, and `agent/created` registers into every later agent so a
 * session started after the plugin loaded still sees the tools.
 *
 * The generate tool is deliberately synchronous by default (`wait: true`): a
 * model that asks for an image should get the image back in the same turn. With
 * `wait: false` it returns a job id the model can poll through `comfyui_status`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile } from 'node:fs/promises';

/** Wire names, exported so the client's tool-view registration cannot drift. */
export const TOOL_GENERATE = 'comfyui_generate';
export const TOOL_STATUS = 'comfyui_status';
export const TOOL_CANCEL = 'comfyui_cancel';
export const TOOL_MODELS = 'comfyui_models';

const SYSTEM_PROMPT_NAME = 'comfyui:guide';

/**
 * Register the ComfyUI tools on one agent-capable scope.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx scope that has `tools`
 * @param {object} options
 * @param {() => object} options.getService live service accessor (the service may restart)
 * @param {(level: string, message: string) => void} [options.logger]
 * @param {() => object} [options.settings] live resolved config accessor
 */
export function installComfyTools(ctx, { getService, logger = () => {}, settings = () => ({}), attachments = () => undefined, tools } = {}) {
  const registered = [];
  /**
   * The tool registry.
   *
   * Read from the injected scope when present (Cordis refuses `ctx.tools` on a
   * scope that did not declare the dependency, so `installComfyIntegration`
   * passes the resolved service down), with `ctx.tools` kept as the direct
   * caller's route for tests and for a call site that already injected it.
   */
  const registry = tools ?? (() => {
    try {
      return ctx?.tools;
    } catch {
      return undefined;
    }
  })();
  if (typeof registry?.register !== 'function') {
    throw new Error('ComfyUI 工具注册失败：作用域没有可用的 tools 服务');
  }
  /**
   * Durable attachment references, keyed by job id.
   *
   * `output.render` is synchronous, so the image bytes have to be admitted while
   * `execute` is still running and then looked up here. Entries are dropped as
   * soon as they are rendered, and the map is bounded so a long session cannot
   * grow it without limit.
   */
  const attachmentsByJob = new Map();

  const rememberAttachments = (jobId, refs) => {
    if (!refs.length) return;
    attachmentsByJob.set(jobId, refs);
    // Keep only the newest handful: a model renders a result right after the
    // call returns, so older entries are never read again.
    while (attachmentsByJob.size > 16) {
      const oldest = attachmentsByJob.keys().next().value;
      if (oldest === undefined) break;
      attachmentsByJob.delete(oldest);
    }
  };

  const requireService = () => {
    const service = getService();
    if (!service) {
      const error = new Error('ComfyUI 服务尚未就绪，请稍后重试。');
      error.code = 'comfyui/offline';
      throw error;
    }
    return service;
  };

  // ── comfyui_generate ──────────────────────────────────────────────────────
  registered.push(registry.register(defineTool({
    name: TOOL_GENERATE,
    description: 'Generate an image with the local ComfyUI server. Returns the saved image file paths and, when image return is enabled, the images themselves. Use it whenever the user asks for a picture, illustration, icon, poster, concept art, or any visual asset.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Positive prompt describing the image. Be specific about subject, style, lighting, composition and background.',
      },
      negative_prompt: {
        type: 'string',
        description: 'What to avoid. Defaults to the configured negative prompt when omitted.',
      },
      preset: {
        type: 'string',
        description: 'Workflow preset id (see comfyui_models). Omit to use the configured default preset.',
      },
      model: {
        type: 'string',
        description: 'Override the preset model file name (checkpoint for checkpoint presets, diffusion model otherwise).',
      },
      width: { type: 'number', description: 'Image width in pixels. Defaults to the configured value.' },
      height: { type: 'number', description: 'Image height in pixels. Defaults to the configured value.' },
      steps: { type: 'number', description: 'Sampling steps. Defaults to the preset value.' },
      cfg: { type: 'number', description: 'Classifier-free guidance scale. Defaults to the preset value.' },
      sampler: { type: 'string', description: 'Sampler name, e.g. res_multistep, euler, dpmpp_2m.' },
      scheduler: { type: 'string', description: 'Scheduler name, e.g. simple, karras, normal.' },
      seed: { type: 'number', description: 'Seed for reproducibility. Omit for a random seed.' },
      batch: { type: 'number', description: 'How many images to generate in one graph (1-8). Default 1.' },
      wait: {
        type: 'boolean',
        description: 'true (default) waits for the images and returns them; false returns a job id immediately.',
      },
      timeout_seconds: {
        type: 'number',
        description: 'How long to wait for the result. Defaults to the configured generate timeout.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          promptId: { type: 'string' },
          status: { type: 'string', required: true, enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] },
          seed: { type: 'integer', required: true },
          preset: { type: 'string', required: true },
          model: { type: 'string' },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          durationMs: { type: 'integer' },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                url: { type: 'string' },
                filename: { type: 'string', required: true },
                width: { type: 'integer' },
                height: { type: 'integer' },
                bytes: { type: 'integer' },
              },
            },
          },
          message: { type: 'string', required: true },
        },
      },
      render: (args, value) => renderGenerate(args, value, attachmentsByJob.get(value.jobId) ?? []),
      presentationMeta: (args, value) => ({ jobId: value.jobId, status: value.status }),
    },
    async execute(args, exec) {
      const service = requireService();
      const config = settings();
      const wait = args.wait !== false;
      const timeout = Number.isFinite(args.timeout_seconds) && args.timeout_seconds > 0
        ? Math.min(7200, Math.round(args.timeout_seconds))
        : (config.generateTimeoutSeconds ?? 600);

      const sessionId = exec?.agent?.session?.header?.id ?? null;
      const job = await service.generate({
        prompt: args.prompt,
        negative: args.negative_prompt,
        presetId: args.preset,
        width: args.width,
        height: args.height,
        steps: args.steps,
        cfg: args.cfg,
        sampler: args.sampler,
        scheduler: args.scheduler,
        seed: args.seed,
        batch: args.batch,
      }, { source: 'chat', sessionId });

      if (!wait) {
        return compact({
          jobId: job.id,
          status: job.status,
          seed: job.seed,
          preset: job.presetId,
          model: job.model,
          width: job.width,
          height: job.height,
          images: [],
          message: `已提交到 ComfyUI 队列（任务 ${job.id.slice(0, 8)}）。用 ${TOOL_STATUS} 查看进度，或让用户在右侧栏查看。`,
        });
      }

      const settled = await waitForJob(service, job.id, {
        timeoutMs: timeout * 1000,
        signal: exec?.signal,
      });

      // Admit the generated bytes as durable attachments so the render can put
      // real image blocks in the conversation. This is what lets the model look
      // at what it just made on the next step instead of guessing from a path.
      if (settled.status === 'succeeded' && config.autoAttachImages !== false && settled.images?.length) {
        try {
          const store = attachments();
          if (store?.saveImage) {
            const refs = [];
            for (const image of settled.images) {
              if (!image.path) continue;
              try {
                const bytes = await readFile(image.path);
                const ref = await store.saveImage({
                  data: bytes,
                  mediaType: image.mediaType === 'image/jpeg' || image.mediaType === 'image/webp' || image.mediaType === 'image/gif'
                    ? image.mediaType
                    : 'image/png',
                  name: image.filename,
                });
                refs.push({
                  attachmentId: ref.attachmentId,
                  mediaType: ref.mediaType,
                  bytes: ref.bytes,
                  width: ref.width,
                  height: ref.height,
                  ...(ref.name === undefined ? {} : { name: ref.name }),
                  ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
                });
              } catch (error) {
                logger('warn', `图片转附件失败 ${image.filename}：${error?.message ?? error}`);
              }
            }
            rememberAttachments(settled.id, refs);
          }
        } catch (error) {
          // No attachment store, or an image the store refuses: the file paths in
          // the text envelope still let the model read the images itself.
          logger('warn', `附件登记失败：${error?.message ?? error}`);
        }
      }

      return compact({
        jobId: settled.id,
        promptId: settled.promptId,
        status: settled.status,
        seed: settled.seed,
        preset: settled.presetId,
        model: settled.model,
        width: settled.width,
        height: settled.height,
        durationMs: settled.durationMs ?? undefined,
        images: (settled.images ?? []).map((image) => ({
          path: image.path ?? '',
          url: image.url,
          filename: image.filename,
          width: image.width,
          height: image.height,
          bytes: image.bytes,
        })),
        message: settled.status === 'succeeded'
          ? `生成完成：${settled.images.length} 张 ${settled.width}x${settled.height}，用时 ${formatDuration(settled.durationMs)}。图片已保存到图库。`
          : `生成未完成（${settled.status}）：${settled.error?.message ?? '未知原因'}`,
      });
    },
  })));

  // ── comfyui_status ────────────────────────────────────────────────────────
  registered.push(registry.register(defineTool({
    name: TOOL_STATUS,
    description: 'Report the ComfyUI connection, the running and queued generation jobs, and recent results. Use it to check on a job started with wait:false.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          baseUrl: { type: 'string', required: true },
          version: { type: 'string' },
          running: { type: 'integer', required: true },
          pending: { type: 'integer', required: true },
          active: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobId: { type: 'string', required: true },
              prompt: { type: 'string', required: true },
              percent: { type: 'integer', required: true },
              label: { type: 'string' },
            },
          },
          recent: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                jobId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                prompt: { type: 'string', required: true },
                createdAt: { type: 'integer', required: true },
                images: { type: 'integer', required: true },
                error: { type: 'string' },
              },
            },
          },
          lastError: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute() {
      const service = requireService();
      const status = await service.status();
      return compact({
        connected: status.connected,
        baseUrl: status.baseUrl,
        version: status.version || undefined,
        running: status.queue.running,
        pending: status.queue.pending,
        active: status.active
          ? {
            jobId: status.active.id,
            prompt: status.active.prompt,
            percent: status.active.progress?.percent ?? 0,
            label: status.active.progress?.label,
          }
          : undefined,
        recent: (status.jobs ?? []).slice(0, 8).map((job) => ({
          jobId: job.id,
          status: job.status,
          prompt: job.prompt,
          createdAt: job.createdAt,
          images: job.images?.length ?? 0,
          error: job.error?.message,
        })),
        lastError: status.lastError?.message,
      });
    },
  })));

  // ── comfyui_cancel ────────────────────────────────────────────────────────
  registered.push(registry.register(defineTool({
    name: TOOL_CANCEL,
    description: 'Cancel a ComfyUI generation: the running job, one queued job, or every queued job.',
    parameters: {
      job_id: { type: 'string', description: 'Job id to cancel. Omit to cancel whatever is currently running.' },
      all: { type: 'boolean', description: 'true cancels every queued job (the running one is left alone).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canceled: { type: 'integer', required: true },
          interrupted: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const service = requireService();
      const result = await service.cancel({ jobId: args.job_id, all: args.all === true });
      return {
        canceled: result.canceled,
        interrupted: result.interrupted,
        message: result.canceled
          ? `已取消 ${result.canceled} 个任务${result.interrupted ? '（已中断正在运行的生成）' : ''}。`
          : '没有可取消的任务。',
      };
    },
  })));

  // ── comfyui_models ────────────────────────────────────────────────────────
  registered.push(registry.register(defineTool({
    name: TOOL_MODELS,
    description: 'List the workflow presets this machine can run and the model files ComfyUI has installed. Check it before choosing a preset or model name.',
    parameters: {
      refresh: { type: 'boolean', description: 'true re-reads the model list from ComfyUI instead of using the cache.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          presets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                mode: { type: 'string', required: true },
                usable: { type: 'boolean' },
                missing: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          folders: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              checkpoints: { type: 'array', required: true, items: { type: 'string' } },
              diffusion_models: { type: 'array', required: true, items: { type: 'string' } },
              text_encoders: { type: 'array', required: true, items: { type: 'string' } },
              vae: { type: 'array', required: true, items: { type: 'string' } },
              loras: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderModels(value) }],
    },
    async execute(args) {
      const service = requireService();
      const listing = await service.models({ refresh: args.refresh === true });
      return compact({
        presets: service.listPresets().map((preset) => ({
          id: preset.id,
          name: preset.name,
          mode: preset.mode,
          usable: preset.valid === true,
          missing: preset.missing ?? [],
        })),
        folders: {
          checkpoints: listing.folders?.checkpoints ?? [],
          diffusion_models: listing.folders?.diffusion_models ?? [],
          text_encoders: listing.folders?.text_encoders ?? [],
          vae: listing.folders?.vae ?? [],
          loras: listing.folders?.loras ?? [],
        },
        error: listing.error?.message,
      });
    },
  })));

  logger('debug', `已注册 ${registered.length} 个 ComfyUI 工具`);
  return () => {
    for (const dispose of registered.reverse()) {
      try {
        dispose?.();
      } catch {
        /* unregister must never throw during teardown */
      }
    }
  };
}

/**
 * Install the tools plus the system-prompt guidance, on the plugin scope and on
 * every agent created later.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} options see {@link installComfyTools}
 * @returns {boolean} whether the scope had the required services
 */
export function installComfyIntegration(ctx, options) {
  const logger = options.logger ?? (() => {});
  const installed = new WeakSet();
  // Resolve the attachment store from the *agent* scope when possible: the tool
  // runs there, and a Host scope may not have the service at all.
  const attachmentsFor = (scope) => () => {
    try {
      return scope?.get?.('attachments');
    } catch {
      return undefined;
    }
  };

  const install = (scope) => {
    if (!scope || installed.has(scope)) return;
    // Declare the dependency instead of reaching for `ctx.tools`.
    //
    // Cordis installs a Proxy over every Context and refuses `ctx.tools` on a
    // scope that did not inject it (`cannot get property "tools" without
    // inject`). `ctx.get('tools')` resolves the service without that guard, so
    // a probe through it succeeds — which is exactly how the first version of
    // this file passed its own check and then threw on the first `register()`.
    // `ctx.inject` is the supported path and it also gives us the right
    // activation lifetime: the callback runs when the service appears and is
    // released when it goes away.
    if (typeof scope.inject !== 'function') return;
    installed.add(scope);
    let dispose;
    try {
      dispose = scope.inject(['tools'], (toolsCtx) => {
        const registry = toolsCtx.tools;
        if (typeof registry?.register !== 'function') return;

        let disposeTools;
        try {
          disposeTools = installComfyTools(toolsCtx, {
            ...options,
            tools: registry,
            attachments: attachmentsFor(toolsCtx),
          });
        } catch (error) {
          logger('error', `工具注册失败：${error?.message ?? error}`);
          return;
        }

        // The system prompt is a separate, optional service; nesting the
        // injection keeps a composition without it working.
        let disposePrompt;
        let disposePromptInject;
        try {
          disposePromptInject = toolsCtx.inject?.(['systemPrompt'], (promptCtx) => {
            try {
              disposePrompt = promptCtx.systemPrompt.context({
                name: SYSTEM_PROMPT_NAME,
                order: 120,
                required: true,
                text: () => promptText(options.getService?.(), options.settings?.() ?? {}),
              });
            } catch (error) {
              logger('warn', `系统提示注册失败：${error?.message ?? error}`);
            }
          });
        } catch (error) {
          logger('warn', `系统提示注入失败：${error?.message ?? error}`);
        }

        return () => {
          try {
            disposePrompt?.();
          } catch {
            /* ignore */
          }
          try {
            disposePromptInject?.();
          } catch {
            /* ignore */
          }
          try {
            disposeTools?.();
          } catch {
            /* ignore */
          }
        };
      });
    } catch (error) {
      logger('error', `工具注入失败：${error?.message ?? error}`);
      installed.delete(scope);
      return;
    }
    // `scope.inject` owns the child fiber; disposing the plugin releases it.
    ctx.effect?.(() => () => {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
      installed.delete(scope);
    }, 'comfyui: tools');
  };

  install(ctx);
  try {
    ctx.on('agent/created', ({ agent }) => install(agent?.ctx), { global: true });
  } catch (error) {
    logger('warn', `agent 事件订阅失败：${error?.message ?? error}`);
  }
  return true;
}

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * Build the tool's content blocks.
 *
 * The text envelope always comes first so a model that cannot see images still
 * learns where the files are; the image blocks follow when the deployment has an
 * attachment store and the user left image return enabled.
 *
 * @param {object} args the model's call arguments
 * @param {object} value the canonical result value
 * @param {Array<object>} [refs] durable image references admitted during execute
 * @returns {Array<object>} content blocks
 */
export function renderGenerate(args, value, refs = []) {
  const blocks = [{ type: 'text', text: renderGenerateText(args, value) }];
  for (const ref of refs) {
    if (!ref?.attachmentId) continue;
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        ...(ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions }),
      },
    });
  }
  return blocks;
}

function renderGenerateText(args, value) {
  const lines = [];
  const ok = value.status === 'succeeded';
  lines.push(ok
    ? `Generated ${value.images.length} image(s) at ${value.width}x${value.height} with ${value.preset}.`
    : `Generation ${value.status}: ${value.message}`);
  lines.push(`comfyui-job:${value.jobId}`);
  if (value.model) lines.push(`model: ${value.model}`);
  lines.push(`seed: ${value.seed}  steps: ${args?.steps ?? 'default'}  cfg: ${args?.cfg ?? 'default'}`);
  if (value.durationMs) lines.push(`duration: ${formatDuration(value.durationMs)}`);
  if (value.images.length) {
    lines.push('Files (open them with read_image to inspect, or reference them in the reply):');
    for (const image of value.images) {
      lines.push(`- ${image.path}${image.width ? ` (${image.width}x${image.height})` : ''}`);
    }
    lines.push('The same images are in the plugin gallery, visible in the right sidebar.');
  } else if (!ok) {
    lines.push(value.message);
  }
  // The transcript card is a client-side renderer over this same content, and
  // it reads structured fields (seed, duration, images) rather than re-parsing
  // prose. One JSON line keeps both readers happy: the model gets a readable
  // envelope above, the card gets an object it can parse.
  lines.push(JSON.stringify({
    jobId: value.jobId,
    status: value.status,
    seed: value.seed,
    preset: value.preset,
    model: value.model ?? null,
    width: value.width,
    height: value.height,
    durationMs: value.durationMs ?? null,
    images: value.images.map((image) => ({
      path: image.path,
      url: image.url ?? null,
      filename: image.filename,
      width: image.width ?? null,
      height: image.height ?? null,
    })),
    message: value.message,
  }));
  return lines.join('\n');
}

function renderStatus(value) {
  const lines = [];
  lines.push(value.connected
    ? `ComfyUI connected at ${value.baseUrl}${value.version ? ` (v${value.version})` : ''}.`
    : `ComfyUI is NOT reachable at ${value.baseUrl}${value.lastError ? `: ${value.lastError}` : ''}.`);
  lines.push(`running: ${value.running}  queued: ${value.pending}`);
  if (value.active) {
    lines.push(`active job ${value.active.jobId.slice(0, 8)}: ${value.active.percent}% ${value.active.label ?? ''} — ${truncate(value.active.prompt, 80)}`);
  }
  if (value.recent.length) {
    lines.push('Recent:');
    for (const job of value.recent) {
      lines.push(`- ${job.status} ${job.jobId.slice(0, 8)} (${job.images} image${job.images === 1 ? '' : 's'}) ${truncate(job.prompt, 60)}${job.error ? ` — ${job.error}` : ''}`);
    }
  } else {
    lines.push('No jobs yet.');
  }
  return lines.join('\n');
}

function renderModels(value) {
  const lines = [];
  lines.push('Presets:');
  for (const preset of value.presets) {
    const state = preset.usable === true ? 'ready' : preset.usable === false ? `missing: ${preset.missing.join(', ')}` : 'unknown';
    lines.push(`- ${preset.id} (${preset.mode}) — ${preset.name} [${state}]`);
  }
  const folders = value.folders ?? {};
  for (const [folder, names] of Object.entries(folders)) {
    if (!names?.length) continue;
    lines.push(`${folder}: ${names.join(', ')}`);
  }
  if (value.error) lines.push(`model listing error: ${value.error}`);
  return lines.join('\n');
}

/** Prompt guidance, kept short: it is prepended to every request. */
function promptText(service, config) {
  if (!service || config.enabled === false) return '';
  const all = (() => {
    try {
      return service.listPresets();
    } catch {
      return [];
    }
  })();
  // `valid: null` means "the model listing has not been read yet", which is the
  // state on the very first request after activation. Only a confirmed `false`
  // (a successful listing that lacks the files) makes a preset unusable, so the
  // two states are reported differently instead of warning about all of them.
  const usable = all.filter((preset) => preset.valid !== false);
  const broken = all.filter((preset) => preset.valid === false);
  const names = usable.slice(0, 6).map((preset) => preset.id).join(', ');
  const lines = [
    'A local ComfyUI server is connected to this session.',
    `- Call ${TOOL_GENERATE} to create images; it waits for the result and returns saved file paths.`,
    `- Call ${TOOL_STATUS} to check progress, ${TOOL_CANCEL} to cancel, ${TOOL_MODELS} to list presets and installed models.`,
    names ? `- Presets to try: ${names}.` : '- No preset is usable yet; call comfyui_models before generating.',
  ];
  if (broken.length) {
    lines.push(`- ${broken.length} preset(s) need model configuration before they can run: ${broken.map((preset) => preset.id).join(', ')}. Call comfyui_models for the missing files.`);
  }
  lines.push(
    `- Default size ${config.width}x${config.height}, ${config.steps} steps. Override width/height/steps for other shapes or quality.`,
    '- Generated images are also kept in the plugin gallery, shown in the right sidebar; do not claim delivery unless the tool returned paths.',
  );
  return lines.join('\n');
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Poll a job until it leaves the active states.
 * @param {object} service
 * @param {string} jobId
 * @param {{ timeoutMs: number, signal?: AbortSignal, intervalMs?: number }} options
 */
export async function waitForJob(service, jobId, { timeoutMs, signal, intervalMs = 700 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted?.();
    const job = service.getJob(jobId);
    if (!job) {
      const error = new Error('任务已丢失（插件可能重启过）。');
      error.code = 'comfyui/not-found';
      throw error;
    }
    if (!['queued', 'running'].includes(job.status)) return job;
    if (Date.now() > deadline) {
      const error = new Error(`等待生成超时（${Math.round(timeoutMs / 1000)}s）。任务 ${jobId.slice(0, 8)} 可能仍在运行，可用 ${TOOL_STATUS} 查看。`);
      error.code = 'comfyui/timeout';
      throw error;
    }
    await delay(intervalMs, signal);
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Drop every `undefined`-valued property from a tool result.
 *
 * The host validates a tool's canonical value with the same rules as a JSON
 * round trip, so an explicitly-`undefined` field (the natural result of
 * `something?.maybe`) makes the whole call fail with
 * `value is not lossless JSON` — after the work is already done. Building the
 * optional fields conditionally would work too, but one chokepoint is harder to
 * forget than a dozen call sites.
 *
 * @template T
 * @param {T} value
 * @returns {T} the same shape, with undefined properties removed
 */
function compact(value) {
  if (Array.isArray(value)) return value.map((item) => compact(item));
  if (value === null || typeof value !== 'object') return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    next[key] = compact(item);
  }
  return next;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
