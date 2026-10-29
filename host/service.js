/**
 * The ComfyUI service: one local job queue in front of one ComfyUI server.
 *
 * Why a local queue instead of letting ComfyUI queue everything:
 *  - a single GPU runs one graph at a time, so a burst from the chat tool would
 *    otherwise sit in ComfyUI's queue with no prompt/params attached to it;
 *  - progress has to be attributable to a job, and ComfyUI's `/queue` only
 *    reports prompt ids;
 *  - the chat tool needs a stable `jobId` it can poll or cancel even before
 *    ComfyUI has accepted the prompt.
 *
 * So the service holds `jobs` (newest first), dispatches at most one at a time,
 * and follows the running one over the websocket, falling back to polling
 * `/queue` + `/history` when the socket cannot connect.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ComfyClient, ComfyError } from './comfy-client.js';
import { Gallery, sanitizeFilename } from './gallery.js';
import { readJson, writeJson, SerialQueue, clamp } from './json-store.js';
import { resolveConfig, resolveDefaults } from './config.js';
import {
  BUILTIN_PRESETS, normalizePreset, resolvePreset, validatePreset, buildWorkflow, outputNodeIds,
} from './presets.js';
import {
  describeSettingsEntry, persistedFormValue, savePanelSettings, resetPanelSettings,
} from './settings-bridge.js';
import { readImageSize, sniffMediaType } from './image-size.js';

/** How many finished jobs the in-memory history keeps (the gallery index holds the durable copy). */
const MAX_JOBS = 200;
/** How many pending jobs a single session may stack before we refuse. */
const MAX_PENDING = 32;
/** Statuses that occupy a queue slot. */
const ACTIVE = new Set(['queued', 'running']);

export class ComfyService {
  #ctx;
  #logger;
  #dir;
  #client;
  #gallery;
  #config;
  #queue = new SerialQueue();
  #jobs = [];
  #pending = [];
  #active = null;
  #socket = null;
  #socketClientId = randomUUID();
  #pollTimer = null;
  #disposed = false;
  #starting = null;
  #models = null;
  #modelsFetchedAt = 0;
  #serverInfo = { version: '', devices: [], checkedAt: 0 };
  #lastError = null;
  #unread = 0;
  #customPresets = [];
  #dispatcher = Promise.resolve();

  /**
   * @param {object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   * @param {(level: string, message: string, detail?: unknown) => void} options.logger
   * @param {string} options.dir plugin data directory (`~/.dsh/comfyui`)
   * @param {Record<string, unknown>} options.config parsed Config (volatile refs)
   * @param {object} [options.client] injectable client, for tests
   * @param {object} [options.gallery] injectable gallery, for tests
   */
  constructor({ ctx, logger, dir, config, client, gallery }) {
    this.#ctx = ctx;
    this.#logger = logger;
    this.#dir = dir;
    this.#config = resolveConfig(config);
    this.#client = client ?? new ComfyClient({
      baseUrl: this.#config.baseUrl,
      authToken: this.#config.authToken,
      timeoutMs: this.#config.requestTimeoutSeconds * 1000,
      logger,
    });
    this.#gallery = gallery ?? new Gallery({
      root: this.#galleryRoot(this.#config),
      indexFile: join(dir, 'index.json'),
      logger,
    });
  }

  get config() {
    return this.#config;
  }

  get client() {
    return this.#client;
  }

  get gallery() {
    return this.#gallery;
  }

  get dir() {
    return this.#dir;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Load durable state. A failure here degrades the feature, never the host. */
  async start() {
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      try {
        await this.#gallery.init();
      } catch (error) {
        this.#logger('warn', `图库索引加载失败，按空库继续：${messageOf(error)}`);
      }
      try {
        const stored = await readJson(join(this.#dir, 'presets.json'), null, (error) => {
          this.#logger('warn', `presets.json 损坏，已忽略：${messageOf(error)}`);
        });
        this.#customPresets = Array.isArray(stored?.items)
          ? stored.items.map(normalizePreset).filter(Boolean)
          : [];
      } catch {
        this.#customPresets = [];
      }
      if (!this.#config.enabled) {
        this.#logger('info', '插件已关闭（enabled=false），不连接 ComfyUI');
        return;
      }
      // A dead server is the normal state at boot; report it and keep serving
      // the settings page, which is exactly where a user fixes the address.
      // The probe stays quiet about success (no log noise on every boot) but a
      // failure leaves one line: a wrong address is the most common problem and
      // a log file is the only evidence when the UI is not open.
      const probe = await this.refreshServer({ silent: true });
      if (probe.ok) this.#logger('info', `ComfyUI 已连接：${this.#config.baseUrl}`);
      else this.#logger('warn', `ComfyUI 暂不可用（${this.#config.baseUrl}）：${probe.error?.message ?? '未知原因'}`);
      this.#startPolling();
    })().catch((error) => {
      this.#logger('error', `服务启动失败：${messageOf(error)}`);
    });
    return this.#starting;
  }

  /** Idempotent teardown: socket, timers, gallery. */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopPolling();
    // A job still running belongs to ComfyUI now: the graph finishes server-side,
    // but this process can no longer follow it. Say so instead of leaving a
    // phantom "running" row in a status read taken during shutdown.
    if (this.#active && ACTIVE.has(this.#active.status)) {
      this.#settle(this.#active, 'canceled', { code: 'comfyui/canceled', message: '插件已关闭，任务仍在 ComfyUI 中继续执行' });
      this.#active = null;
    }
    for (const id of [...this.#pending]) {
      const job = this.#jobs.find((item) => item.id === id);
      if (job) this.#settle(job, 'canceled', { code: 'comfyui/canceled', message: '插件已关闭，排队任务已取消' });
    }
    this.#pending = [];
    try {
      this.#socket?.close?.();
    } catch {
      /* already gone */
    }
    this.#socket = null;
    try {
      await this.#client.dispose?.();
    } catch {
      /* best effort */
    }
    try {
      await this.#gallery.dispose?.();
    } catch {
      /* best effort */
    }
  }

  /**
   * Apply a settings change without remounting the plugin.
   * @param {Record<string, unknown>} raw parsed Config
   */
  reconfigure(raw) {
    const next = resolveConfig(raw);
    const previous = this.#config;
    this.#config = next;
    try {
      if (next.baseUrl !== previous.baseUrl) this.#client.setBaseUrl?.(next.baseUrl);
      if (next.authToken !== previous.authToken) this.#client.setAuthToken?.(next.authToken);
      this.#client.setTimeout?.(next.requestTimeoutSeconds * 1000);
    } catch (error) {
      this.#logger('warn', `连接参数更新失败：${messageOf(error)}`);
    }
    const root = this.#galleryRoot(next);
    if (root !== this.#gallery.root) {
      void this.#gallery.setRoot(root).catch((error) => {
        this.#logger('warn', `图库目录切换失败：${messageOf(error)}`);
      });
    }
    // A base-url change invalidates every cached model name and the socket.
    if (next.baseUrl !== previous.baseUrl) {
      this.#models = null;
      this.#modelsFetchedAt = 0;
      this.#restartSocket();
      void this.refreshServer({ silent: true });
    }
    this.#startPolling();
  }

  #galleryRoot(config) {
    const custom = typeof config.saveDir === 'string' ? config.saveDir.trim() : '';
    return custom ? custom : join(this.#dir, 'gallery');
  }

  // ── server / connection ──────────────────────────────────────────────────

  /**
   * Read `/system_stats` and remember it.
   * @param {{ silent?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, error?: object }>}
   */
  async refreshServer({ silent = false } = {}) {
    try {
      const stats = await this.#client.systemStats({});
      this.#serverInfo = {
        version: stats.comfyuiVersion ?? stats.version ?? '',
        devices: Array.isArray(stats.devices) ? stats.devices : [],
        checkedAt: Date.now(),
      };
      this.#lastError = null;
      if (!silent) this.#logger('info', `ComfyUI 已连接：${this.#config.baseUrl}`);
      return { ok: true };
    } catch (error) {
      const detail = { code: codeOf(error), message: messageOf(error) };
      this.#lastError = { ...detail, at: Date.now() };
      this.#serverInfo = { ...this.#serverInfo, checkedAt: Date.now() };
      if (!silent) this.#logger('warn', `ComfyUI 不可用：${detail.message}`);
      return { ok: false, error: detail };
    }
  }

  /**
   * Probe a candidate address without committing it.
   * @param {{ baseUrl?: string, authToken?: string }} [input]
   */
  async testConnection(input = {}) {
    const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
      ? input.baseUrl.trim()
      : this.#config.baseUrl;
    const authToken = typeof input.authToken === 'string' && input.authToken.trim()
      ? input.authToken.trim()
      : this.#config.authToken;
    const probe = new ComfyClient({
      baseUrl,
      authToken,
      timeoutMs: this.#config.requestTimeoutSeconds * 1000,
      logger: this.#logger,
    });
    try {
      const stats = await probe.systemStats({});
      return {
        ok: true,
        detail: '连接成功',
        version: stats.comfyuiVersion ?? stats.version ?? '',
        devices: Array.isArray(stats.devices) ? stats.devices : [],
      };
    } catch (error) {
      return {
        ok: false,
        detail: codeOf(error) === 'comfyui/auth' ? '鉴权失败：token 不正确' : '无法连接 ComfyUI',
        error: { code: codeOf(error), message: messageOf(error) },
      };
    } finally {
      await probe.dispose?.().catch?.(() => undefined);
    }
  }

  /**
   * The model listing, cached until `refresh`.
   * @param {{ refresh?: boolean }} [options]
   */
  async models({ refresh = false } = {}) {
    const stale = Date.now() - this.#modelsFetchedAt > 60_000;
    if (this.#models && !refresh && !stale) {
      return { ok: true, folders: this.#models, fetchedAt: this.#modelsFetchedAt };
    }
    try {
      const folders = await this.#client.models({});
      this.#models = normalizeFolders(folders);
      this.#modelsFetchedAt = Date.now();
      this.#lastError = null;
      return { ok: true, folders: this.#models, fetchedAt: this.#modelsFetchedAt };
    } catch (error) {
      return {
        ok: false,
        folders: this.#models ?? emptyFolders(),
        fetchedAt: this.#modelsFetchedAt,
        error: { code: codeOf(error), message: messageOf(error) },
      };
    }
  }

  #cachedFolders() {
    return this.#models;
  }

  // ── presets ──────────────────────────────────────────────────────────────

  /** Every preset, with model validity resolved against the cached listing. */
  listPresets() {
    const folders = this.#cachedFolders();
    const custom = this.#customPresets.map((preset) => {
      const validity = validatePreset(preset, folders);
      return { ...preset, ...validity };
    });
    const builtin = BUILTIN_PRESETS.map((preset) => ({ ...preset, ...validatePreset(preset, folders) }));
    return [...builtin, ...custom];
  }

  getPreset(id) {
    const resolved = resolvePreset(id, this.#customPresets);
    return { ...resolved, ...validatePreset(resolved, this.#cachedFolders()) };
  }

  /**
   * Create or update a custom preset.
   * @param {Record<string, any>} input
   */
  async savePreset(input) {
    const mode = ['unet', 'checkpoint', 'custom'].includes(input?.mode) ? input.mode : 'unet';
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) throw invalid('预设名称不能为空');
    const id = typeof input?.id === 'string' && input.id.trim()
      ? input.id.trim()
      : `custom-${randomUUID().slice(0, 8)}`;
    if (BUILTIN_PRESETS.some((preset) => preset.id === id)) throw invalid('内置预设不能覆盖，请换一个 id');
    const existing = this.#customPresets.find((preset) => preset.id === id);
    const preset = normalizePreset({
      id,
      name,
      mode,
      description: typeof input?.description === 'string' ? input.description : existing?.description ?? '',
      defaults: input?.defaults ?? existing?.defaults,
      models: input?.models ?? existing?.models,
      workflow: mode === 'custom' ? input?.workflow : null,
    });
    if (!preset) throw invalid('预设内容不完整：自定义模式需要一份 API 格式工作流');
    const items = this.#customPresets.filter((item) => item.id !== id);
    items.push(preset);
    this.#customPresets = items;
    await this.#persistPresets();
    return this.getPreset(id);
  }

  /**
   * Delete a custom preset.
   * @param {string} id
   */
  async deletePreset(id) {
    if (BUILTIN_PRESETS.some((preset) => preset.id === id)) throw invalid('内置预设不能删除');
    const before = this.#customPresets.length;
    this.#customPresets = this.#customPresets.filter((preset) => preset.id !== id);
    if (this.#customPresets.length === before) throw notFound('预设不存在');
    await this.#persistPresets();
    return { deleted: true };
  }

  async #persistPresets() {
    await this.#queue.run('presets', () => writeJson(join(this.#dir, 'presets.json'), {
      version: 1,
      items: this.#customPresets,
    }));
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  /**
   * Enqueue one generation.
   * @param {Record<string, any>} input
   * @param {{ source?: 'chat'|'ui'|'api', sessionId?: string|null }} [meta]
   */
  async generate(input, meta = {}) {
    if (!this.#config.enabled) throw codedError('comfyui/invalid', '插件已关闭，请先在设置里启用。');
    // The session is what the gallery filters by, so it is read from the
    // explicit meta first and from the request last: the chat tool knows the
    // session from the agent, the panel from its own tab.
    const requestedSession = typeof meta.sessionId === 'string' && meta.sessionId !== ''
      ? meta.sessionId
      : typeof input?.sessionId === 'string' && input.sessionId !== ''
        ? input.sessionId
        : null;
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw invalid('提示词不能为空');
    if (this.#pending.length >= MAX_PENDING) {
      throw codedError('comfyui/queue-full', `排队任务过多（${MAX_PENDING}），请先取消一些。`);
    }
    const presetId = typeof input?.presetId === 'string' && input.presetId ? input.presetId : this.#config.presetId;
    const preset = this.getPreset(presetId);
    const defaults = preset.defaults ?? {};
    const cfg = numberOr(input?.cfg, defaults.cfg, this.#config.cfg);
    const seed = resolveSeed(input?.seed, this.#config);
    const job = {
      id: randomUUID(),
      promptId: null,
      number: null,
      status: 'queued',
      prompt,
      negative: typeof input?.negative === 'string' && input.negative.trim()
        ? input.negative.trim()
        : (this.#config.negativePrompt || defaults.negative || ''),
      presetId: preset.id,
      presetName: preset.name,
      model: preset.mode === 'checkpoint' ? preset.models?.checkpoint ?? '' : preset.models?.unet ?? '',
      width: clamp(numberOr(input?.width, defaults.width, this.#config.width), 64, 8192),
      height: clamp(numberOr(input?.height, defaults.height, this.#config.height), 64, 8192),
      steps: clamp(numberOr(input?.steps, defaults.steps, this.#config.steps), 1, 200),
      cfg,
      sampler: textOr(input?.sampler, defaults.sampler, this.#config.sampler),
      scheduler: textOr(input?.scheduler, defaults.scheduler, this.#config.scheduler),
      seed,
      batch: clamp(numberOr(input?.batch, defaults.batch, this.#config.batch), 1, 8),
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      sessionId: requestedSession,
      source: meta.source ?? 'api',
      progress: null,
      images: [],
      error: null,
      favorite: false,
    };
    this.#jobs.unshift(job);
    this.#trimJobs();
    this.#pending.push(job.id);
    this.#logger('info', `任务入队 ${job.id.slice(0, 8)}：${preset.name} ${job.width}x${job.height} seed=${job.seed}`);
    void this.#drain();
    return this.serialize(job);
  }

  /** Newest-first job list. */
  listJobs({ limit = 30, offset = 0, status } = {}) {
    const filtered = status ? this.#jobs.filter((job) => job.status === status) : this.#jobs;
    return {
      items: filtered.slice(offset, offset + limit).map((job) => this.serialize(job)),
      total: filtered.length,
    };
  }

  getJob(id) {
    const job = this.#jobs.find((item) => item.id === id || item.promptId === id);
    return job ? this.serialize(job) : null;
  }

  #requireJob(id) {
    const job = this.#jobs.find((item) => item.id === id || item.promptId === id);
    if (!job) throw notFound('任务不存在');
    return job;
  }

  /** Current queue picture, shaped for the sidebar. */
  async queueState() {
    const running = this.#jobs.filter((job) => job.status === 'running');
    const pending = this.#pending
      .map((id) => this.#jobs.find((job) => job.id === id))
      .filter(Boolean);
    let server = null;
    try {
      const remote = await this.#client.queue({});
      server = {
        running: Array.isArray(remote?.running) ? remote.running.length : 0,
        pending: Array.isArray(remote?.pending) ? remote.pending.length : 0,
      };
      // Deliberately does NOT clear `#lastError`: `/queue` can answer while the
      // richer endpoints fail (a proxy allowlist, a partially healthy server),
      // and only `refreshServer` owns the connection verdict. Clearing it here
      // made a status read claim "connected" right after `/system_stats` failed.
    } catch (error) {
      server = null;
      this.#lastError = { code: codeOf(error), message: messageOf(error), at: Date.now() };
    }
    return {
      running: running.map((job) => this.serialize(job)),
      pending: pending.map((job) => this.serialize(job)),
      active: this.#active ? this.serialize(this.#active) : null,
      jobs: this.#jobs.slice(0, 40).map((job) => this.serialize(job)),
      server,
      unread: this.#unread,
    };
  }

  /** Everything the sidebar and settings page need in one round trip. */
  async status() {
    const queue = await this.queueState();
    const folders = this.#cachedFolders();
    return {
      connected: !this.#lastError,
      baseUrl: this.#config.baseUrl,
      enabled: this.#config.enabled,
      version: this.#serverInfo.version,
      devices: this.#serverInfo.devices,
      checkedAt: this.#serverInfo.checkedAt,
      modelsFetchedAt: this.#modelsFetchedAt,
      modelsAvailable: Boolean(folders),
      queue: { running: queue.running.length, pending: queue.pending.length, server: queue.server },
      active: queue.active,
      jobs: queue.jobs,
      unread: this.#unread,
      lastError: this.#lastError,
      pollIntervalMs: this.#config.pollIntervalMs,
    };
  }

  markRead() {
    this.#unread = 0;
    return { unread: 0 };
  }

  /**
   * Cancel one job, or the running one when no id is given.
   * @param {{ jobId?: string, all?: boolean }} [input]
   */
  async cancel({ jobId, all = false } = {}) {
    let canceled = 0;
    if (all) {
      for (const id of [...this.#pending]) {
        const job = this.#jobs.find((item) => item.id === id);
        if (!job) continue;
        this.#settle(job, 'canceled', { message: '已取消排队' });
        canceled += 1;
      }
      this.#pending = [];
      return { canceled, interrupted: false };
    }

    if (jobId) {
      const job = this.#requireJob(jobId);
      if (job.status === 'queued') {
        this.#pending = this.#pending.filter((id) => id !== job.id);
        this.#settle(job, 'canceled', { message: '已取消排队' });
        return { canceled: 1, interrupted: false };
      }
      if (job.status !== 'running') return { canceled: 0, interrupted: false };
      await this.#interruptRemote(job);
      return { canceled: 1, interrupted: true };
    }

    const running = this.#jobs.find((job) => job.status === 'running');
    if (running) {
      await this.#interruptRemote(running);
      return { canceled: 1, interrupted: true };
    }
    return { canceled: 0, interrupted: false };
  }

  /** Ask ComfyUI to stop the running graph, then drop it from the server queue. */
  async #interruptRemote(job) {
    try {
      await this.#client.interrupt({});
    } catch (error) {
      this.#logger('warn', `中断失败：${messageOf(error)}`);
    }
    if (job.promptId) {
      try {
        await this.#client.deleteQueued([job.promptId], {});
      } catch {
        /* already running, or already gone */
      }
    }
    this.#settle(job, 'canceled', { message: '已中断' });
    this.#active = null;
    void this.#drain();
  }

  /** Drop everything queued on the ComfyUI server (never interrupts the running graph). */
  async clearServerQueue() {
    try {
      await this.#client.clearQueue({});
      return { cleared: true };
    } catch (error) {
      throw codedError(codeOf(error), messageOf(error));
    }
  }

  // ── dispatch loop ────────────────────────────────────────────────────────

  /**
   * Run the next pending job. Re-entrant calls chain onto the same promise so a
   * burst of submissions cannot start two graphs.
   */
  #drain() {
    this.#dispatcher = this.#dispatcher.then(async () => {
      if (this.#disposed || this.#active) return;
      const id = this.#pending.shift();
      if (!id) return;
      const job = this.#jobs.find((item) => item.id === id);
      if (!job || job.status !== 'queued') return;
      try {
        await this.#run(job);
      } catch (error) {
        this.#settle(job, 'failed', { code: codeOf(error), message: messageOf(error) });
      } finally {
        this.#active = null;
        this.#stopPolling();
        if (this.#pending.length) void this.#drain();
      }
    }).catch((error) => {
      this.#logger('error', `调度失败：${messageOf(error)}`);
    });
    return this.#dispatcher;
  }

  async #run(job) {
    this.#active = job;
    job.status = 'running';
    job.startedAt = Date.now();
    job.progress = { value: 0, max: job.steps, percent: 0, node: null, label: '提交中' };

    const preset = resolvePreset(job.presetId, this.#customPresets);
    const workflow = buildWorkflow({
      preset,
      prompt: this.#config.promptPrefix
        ? `${this.#config.promptPrefix} ${job.prompt}`.trim()
        : job.prompt,
      negative: job.negative,
      width: job.width,
      height: job.height,
      seed: job.seed,
      steps: job.steps,
      cfg: job.cfg,
      sampler: job.sampler,
      scheduler: job.scheduler,
      batch: job.batch,
      filenamePrefix: `dsh-${job.id.slice(0, 8)}`,
    });

    const submitted = await this.#client.submit(workflow, { clientId: this.#socketClientId });
    job.promptId = submitted.promptId;
    job.number = Number.isFinite(submitted.number) ? submitted.number : null;
    job.progress = { value: 0, max: job.steps, percent: 0, node: null, label: '排队中' };
    this.#ensureSocket();

    const result = await this.#awaitCompletion(job);
    if (job.status === 'canceled') return;
    await this.#finalize(job, result, workflow);
  }

  /**
   * Wait for one job, over the socket when it is alive and by polling otherwise.
   * Resolves with the `/history` entry; rejects with a coded error.
   */
  async #awaitCompletion(job) {
    const deadline = Date.now() + this.#config.generateTimeoutSeconds * 1000;
    const pollMs = Math.max(500, Math.min(3000, this.#config.pollIntervalMs));

    // The socket may already have delivered the terminal event before this
    // promise starts (a fast graph); `#terminal` holds that outcome.
    for (;;) {
      if (job.status === 'canceled') return null;
      const terminal = job.__terminal;
      if (terminal) {
        delete job.__terminal;
        if (terminal.error) throw codedError('comfyui/node-error', terminal.error);
        return terminal.entry ?? null;
      }
      if (Date.now() > deadline) {
        throw codedError('comfyui/timeout', `生成超时（${this.#config.generateTimeoutSeconds}s）。任务可能仍在 ComfyUI 中运行。`);
      }
      await sleep(pollMs);
      if (job.status === 'canceled') return null;
      if (job.__terminal) continue;
      // Without a live socket, or when the socket missed the events, ask the
      // server directly. This is also what recovers a job after a reconnect.
      const entry = await this.#client.history(job.promptId, {}).catch(() => null);
      if (entry) {
        const status = entry.status?.status_str;
        if (status === 'error') {
          throw codedError('comfyui/node-error', executionErrorMessage(entry) ?? 'ComfyUI 执行失败');
        }
        if (entry.status?.completed) return entry;
      } else {
        // Not in history: it may have been canceled server-side, or it may
        // still be waiting. `/queue` distinguishes the two.
        const remote = await this.#client.queue({}).catch(() => null);
        if (remote) {
          const queued = [...(remote.running ?? []), ...(remote.pending ?? [])]
            .some((item) => item?.promptId === job.promptId || item?.[1] === job.promptId);
          if (!queued && job.promptId) {
            // Give history one more chance: a graph can finish between the two reads.
            const late = await this.#client.history(job.promptId, {}).catch(() => null);
            if (late?.status?.completed) return late;
            if (late) throw codedError('comfyui/node-error', executionErrorMessage(late) ?? 'ComfyUI 执行失败');
            throw codedError('comfyui/canceled', '任务已不在 ComfyUI 队列中，可能被外部取消。');
          }
        }
      }
    }
  }

  /** Turn a finished graph into gallery images and a settled job. */
  async #finalize(job, entry, workflow) {
    const outputs = entry?.outputs ?? {};
    const wanted = new Set(outputNodeIds(workflow));
    const images = [];
    for (const [nodeId, output] of Object.entries(outputs)) {
      if (wanted.size && !wanted.has(nodeId)) continue;
      const list = Array.isArray(output?.images) ? output.images : [];
      for (const image of list) {
        if (!image?.filename) continue;
        try {
          const fetched = await this.#client.view({
            filename: image.filename,
            subfolder: image.subfolder ?? '',
            type: image.type ?? 'output',
          }, {});
          // Prefer the server's own metadata; fall back to the file header so a
          // save node that omits it still produces a sized gallery entry.
          const size = readImageSize(fetched.bytes) ?? {};
          const saved = await this.#gallery.addImage(job.id, {
            filename: image.filename,
            subfolder: image.subfolder ?? '',
            bytes: fetched.bytes,
            mediaType: fetched.mediaType ?? sniffMediaType(fetched.bytes) ?? 'image/png',
            width: numberOr(image.metadata?.width, size.width, job.width),
            height: numberOr(image.metadata?.height, size.height, job.height),
          });
          images.push(saved);
        } catch (error) {
          this.#logger('warn', `输出图下载失败 ${image.filename}：${messageOf(error)}`);
        }
      }
    }
    job.images = images;
    job.finishedAt = Date.now();
    job.durationMs = job.startedAt ? job.finishedAt - job.startedAt : null;
    job.progress = { value: job.steps, max: job.steps, percent: 100, node: null, label: '已完成' };
    if (!images.length) {
      job.status = 'failed';
      job.error = { code: 'comfyui/node-error', message: 'ComfyUI 执行完成，但没有返回图片；请检查工作流是否包含 SaveImage 节点。' };
    } else {
      job.status = 'succeeded';
      if (this.#config.notifyOnComplete && job.source !== 'ui') this.#unread += 1;
    }
    await this.#persistJob(job);
    this.#logger('info', `任务完成 ${job.id.slice(0, 8)}：${images.length} 张，${Math.round((job.durationMs ?? 0) / 100) / 10}s`);
    await this.#enforceRetention();
  }

  #settle(job, status, error) {
    job.status = status;
    job.finishedAt = Date.now();
    job.durationMs = job.startedAt ? job.finishedAt - job.startedAt : null;
    job.error = error ? { code: codeOf(error), message: messageOf(error) } : null;
    if (status === 'canceled') {
      job.progress = { value: 0, max: job.steps, percent: 0, node: null, label: '已取消' };
    } else if (status === 'failed') {
      job.progress = { value: 0, max: job.steps, percent: 0, node: null, label: '失败' };
      if (this.#config.notifyOnComplete) this.#unread += 1;
    }
    void this.#persistJob(job);
  }

  async #persistJob(job) {
    if (!job.images?.length) return;
    try {
      await this.#gallery.save(this.serialize(job));
    } catch (error) {
      this.#logger('warn', `图库写入失败：${messageOf(error)}`);
    }
  }

  #trimJobs() {
    if (this.#jobs.length <= MAX_JOBS) return;
    const keep = [];
    let dropped = 0;
    for (const job of this.#jobs) {
      const active = ACTIVE.has(job.status);
      if (!active && dropped < this.#jobs.length - MAX_JOBS) {
        dropped += 1;
        continue;
      }
      keep.push(job);
    }
    this.#jobs = keep;
  }

  // ── websocket ────────────────────────────────────────────────────────────

  #ensureSocket() {
    if (this.#socket || this.#disposed) return;
    try {
      this.#socket = this.#client.openSocket({
        clientId: this.#socketClientId,
        onEvent: (event) => this.#onSocketEvent(event),
        onOpen: () => this.#logger('debug', 'ComfyUI websocket 已连接'),
        onClose: () => {
          this.#socket = null;
        },
      });
    } catch (error) {
      this.#socket = null;
      this.#logger('warn', `websocket 建立失败，改用轮询：${messageOf(error)}`);
    }
  }

  #restartSocket() {
    try {
      this.#socket?.close?.();
    } catch {
      /* already gone */
    }
    this.#socket = null;
  }

  /**
   * Translate ComfyUI's websocket protocol into job progress.
   * Verified event shapes (ComfyUI 0.41.1): `progress {value,max,node,prompt_id}`,
   * `executing {node,prompt_id}`, `executed {node,output,prompt_id}`,
   * `execution_start`, `execution_success`, `execution_error`, `status`.
   */
  #onSocketEvent(event) {
    try {
      const type = event?.type;
      const data = event?.data ?? {};
      if (type === 'progress') {
        const job = this.#jobForPrompt(data.prompt_id);
        if (!job) return;
        const value = Number(data.value) || 0;
        const max = Number(data.max) || job.steps || 1;
        job.progress = {
          value,
          max,
          percent: Math.min(99, Math.round((value / max) * 100)),
          node: data.node ? String(data.node) : null,
          label: `生成中 ${value}/${max}`,
        };
        return;
      }
      if (type === 'progress_state') {
        const job = this.#jobForPrompt(data.prompt_id);
        if (!job) return;
        const nodes = data.nodes ?? {};
        const sampler = Object.values(nodes).find((node) => node?.state === 'running' && Number(node.max) > 1);
        if (sampler) {
          const value = Number(sampler.value) || 0;
          const max = Number(sampler.max) || job.steps || 1;
          job.progress = {
            value,
            max,
            percent: Math.min(99, Math.round((value / max) * 100)),
            node: sampler.node_id ? String(sampler.node_id) : null,
            label: `生成中 ${value}/${max}`,
          };
        }
        return;
      }
      if (type === 'executing') {
        const job = this.#jobForPrompt(data.prompt_id);
        if (!job) return;
        if (data.node === null) {
          // `executing` with a null node means the prompt left the executor.
          // Completion arrives via `executed`/`execution_success`; ignore here.
          return;
        }
        if (job.progress) job.progress = { ...job.progress, label: job.progress.label === '排队中' ? '生成中' : job.progress.label };
        return;
      }
      if (type === 'execution_start') {
        const job = this.#jobForPrompt(data.prompt_id);
        if (!job) return;
        job.progress = { value: 0, max: job.steps, percent: 0, node: null, label: '生成中' };
        return;
      }
      if (type === 'execution_success') {
        const job = this.#jobForPrompt(data.prompt_id);
        if (!job || job.__terminal) return;
        // History is authoritative for outputs; the await loop picks it up on
        // its next tick, so only mark the terminal flag here.
        job.progress = { ...(job.progress ?? { value: 0, max: job.steps }), percent: 99, label: '收尾中' };
        void this.#resolveTerminal(job, null);
        return;
      }
      if (type === 'execution_error') {
        const job = this.#jobForPrompt(data.prompt_id);
        if (!job || job.__terminal) return;
        const message = typeof data.exception_message === 'string' && data.exception_message
          ? data.exception_message
          : 'ComfyUI 执行出错';
        void this.#resolveTerminal(job, message);
        return;
      }
      if (type === 'execution_interrupted') {
        const job = this.#jobForPrompt(data.prompt_id);
        if (!job) return;
        this.#settle(job, 'canceled', { message: 'ComfyUI 已中断' });
      }
    } catch (error) {
      this.#logger('warn', `websocket 事件处理失败：${messageOf(error)}`);
    }
  }

  async #resolveTerminal(job, error) {
    let entry = null;
    if (!error && job.promptId) {
      // `execution_success` arrives just before the history entry is readable;
      // retry briefly instead of racing it.
      for (let attempt = 0; attempt < 6 && !entry; attempt += 1) {
        entry = await this.#client.history(job.promptId, {}).catch(() => null);
        if (!entry) await sleep(250);
      }
    }
    job.__terminal = { error, entry };
  }

  #jobForPrompt(promptId) {
    if (!promptId) return null;
    return this.#jobs.find((job) => job.promptId === promptId && ACTIVE.has(job.status)) ?? null;
  }

  // ── polling fallback ─────────────────────────────────────────────────────

  /**
   * Keep `/system_stats` fresh while anything is running. The sidebar polls the
   * RPC itself; this loop only exists so a plugin without an open sidebar still
   * notices a server that came back or went away.
   */
  #startPolling() {
    if (this.#pollTimer || this.#disposed || !this.#config.enabled) return;
    const period = Math.max(15_000, this.#config.pollIntervalMs * 5);
    this.#pollTimer = setInterval(() => {
      if (this.#disposed) return;
      const busy = this.#active !== null || this.#pending.length > 0;
      if (!busy && !this.#lastError) return;
      void this.refreshServer({ silent: true });
    }, period);
    // A background timer must not keep the process alive on shutdown.
    this.#pollTimer.unref?.();
  }

  #stopPolling() {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  // ── gallery operations (delegated, with serialization) ───────────────────

  async galleryList(options) {
    return this.#gallery.list(options);
  }

  async galleryGet(id) {
    const job = await this.#gallery.get(id);
    if (!job) throw notFound('图片不存在');
    return job;
  }

  async galleryUpdate(id, patch) {
    const job = await this.#gallery.update(id, patch);
    if (!job) throw notFound('图片不存在');
    const inMemory = this.#jobs.find((item) => item.id === id);
    if (inMemory && typeof patch?.favorite === 'boolean') inMemory.favorite = patch.favorite;
    return job;
  }

  async galleryDelete(ids) {
    const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
    if (!list.length) throw invalid('没有指定要删除的任务');
    const deleted = await this.#gallery.delete(list);
    for (const id of list) {
      const job = this.#jobs.find((item) => item.id === id);
      if (job) job.images = [];
    }
    return { deleted };
  }

  async galleryStats(options) {
    return this.#gallery.stats(options);
  }

  async galleryPrune({ dryRun = false } = {}) {
    return this.#gallery.prune({
      retentionDays: this.#config.retentionDays,
      maxItems: this.#config.maxGalleryItems,
      dryRun,
    });
  }

  /** Apply the retention policy after a job lands in the gallery. */
  async #enforceRetention() {
    if (!this.#config.retentionDays && !this.#config.maxGalleryItems) return;
    try {
      const result = await this.#gallery.prune({
        retentionDays: this.#config.retentionDays,
        maxItems: this.#config.maxGalleryItems,
        dryRun: false,
      });
      if (result.removed) this.#logger('info', `按保留策略清理了 ${result.removed} 个任务`);
    } catch (error) {
      this.#logger('warn', `保留策略执行失败：${messageOf(error)}`);
    }
  }

  // ── settings ─────────────────────────────────────────────────────────────

  /** The panel's read model. The token is reduced to a presence flag. */
  settingsReadModel() {
    const { authToken, ...rest } = this.#config;
    return { ...rest, authToken: undefined, authTokenConfigured: Boolean(authToken) };
  }

  settingsDefaults() {
    const defaults = resolveDefaults();
    const { authToken, ...rest } = defaults;
    return { ...rest, authToken: undefined, authTokenConfigured: false };
  }

  /**
   * What the settings page needs to know about the dsh Settings form itself.
   * @returns {{ entryId: string, revision: number|undefined, readable: boolean, reason?: string }}
   */
  describeSettings() {
    try {
      return describeSettingsEntry(this.#ctx);
    } catch (error) {
      return { entryId: 'comfyui', revision: undefined, readable: false, reason: 'describe-failed', message: messageOf(error) };
    }
  }

  /**
   * Persist one panel edit, then apply it to the running instance without a
   * remount. A write that Settings refuses leaves the runtime untouched.
   * @param {Record<string, unknown>} patch
   * @param {number|undefined} expectedRevision
   */
  async updateSettings(patch, expectedRevision) {
    const descriptor = this.describeSettings();
    const result = await savePanelSettings({
      ctx: this.#ctx,
      patch,
      expectedRevision: expectedRevision ?? descriptor.revision,
    });
    // Re-read the persisted form and re-apply: a Settings write does not
    // remount this plugin, so the runtime has to adopt the new values itself.
    const persisted = persistedFormValue(this.#ctx);
    if (persisted) this.reconfigure(persisted);
    return {
      ...result,
      settings: this.settingsReadModel(),
      presets: this.listPresets(),
    };
  }

  /**
   * Restore the schema defaults for every editable field.
   * @param {number|undefined} expectedRevision
   */
  async resetSettings(expectedRevision) {
    const descriptor = this.describeSettings();
    const result = await resetPanelSettings({
      ctx: this.#ctx,
      expectedRevision: expectedRevision ?? descriptor.revision,
    });
    this.reconfigure({});
    return {
      ...result,
      settings: this.settingsReadModel(),
      presets: this.listPresets(),
    };
  }

  /** Fields the settings page may write. */
  static EDITABLE = new Set([
    'enabled', 'baseUrl', 'authToken', 'requestTimeoutSeconds', 'generateTimeoutSeconds', 'pollIntervalMs',
    'presetId', 'width', 'height', 'steps', 'cfg', 'sampler', 'scheduler', 'negativePrompt', 'promptPrefix',
    'seedMode', 'seed', 'batch', 'autoAttachImages', 'autoOpenSidebar', 'notifyOnComplete',
    'saveDir', 'retentionDays', 'maxGalleryItems',
  ]);

  // ── serialization ────────────────────────────────────────────────────────

  /** The wire shape: drop internal fields and resolve absolute file paths. */
  serialize(job) {
    const { __terminal, ...rest } = job;
    return {
      ...rest,
      images: (job.images ?? []).map((image) => ({
        ...image,
        // The chat tool needs a real path; the sidebar uses the URL.
        path: this.#imagePath(image),
      })),
    };
  }

  /**
   * The on-disk path of one image, derived synchronously for the wire shape.
   *
   * `serialize()` is synchronous but the gallery's `filePath()` is not, so the
   * path is recomputed here. It must use the gallery's own filename sanitizer,
   * otherwise the two would disagree for a name ComfyUI wrote with a character
   * the sanitizer strips, and the chat tool would hand the model a path that
   * does not exist. `gallery.filePath()` stays the authoritative, realpath-
   * checked answer for the HTTP route.
   * @param {object} image
   * @returns {string | null}
   */
  #imagePath(image) {
    try {
      const root = this.#gallery.root;
      if (!root || !image?.filename) return null;
      const jobId = String(image.jobId ?? '');
      if (!jobId || jobId.includes('/') || jobId.includes('\\') || jobId.includes('..')) return null;
      return join(root, jobId, sanitizeFilename(image.filename));
    } catch {
      return null;
    }
  }

  /** Absolute path of one image, verified by the gallery (path-traversal safe). */
  async imagePath(imageId) {
    return this.#gallery.filePath(imageId);
  }

  async imageRecord(imageId) {
    return this.#gallery.imageRecord(imageId);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  // Callers pass plain `{ code, message }` records when they already know the
  // shape (a canceled job, for example), so honour that instead of stringifying.
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error ?? 'unknown error');
}

function codeOf(error) {
  if (error instanceof ComfyError) return error.code;
  if (error && typeof error.code === 'string') return error.code;
  return 'comfyui/unknown';
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalid(message) {
  return codedError('comfyui/invalid', message);
}

function notFound(message) {
  return codedError('comfyui/not-found', message);
}

function numberOr(...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function textOr(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

function resolveSeed(input, config) {
  const value = Number(input);
  if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (config.seedMode === 'fixed' && Number.isFinite(config.seed) && config.seed >= 0) return Math.floor(config.seed);
  return Math.floor(Math.random() * 2 ** 32);
}

function emptyFolders() {
  return { checkpoints: [], diffusion_models: [], text_encoders: [], vae: [], loras: [], upscale_models: [] };
}

function normalizeFolders(folders) {
  const next = emptyFolders();
  for (const key of Object.keys(next)) {
    const value = folders?.[key];
    if (Array.isArray(value)) next[key] = value.filter((item) => typeof item === 'string').sort((a, b) => a.localeCompare(b));
  }
  return next;
}

/** Pull the human message out of a `/history` status message list. */
function executionErrorMessage(entry) {
  const messages = entry?.status?.messages;
  if (!Array.isArray(messages)) return null;
  for (const item of messages) {
    if (!Array.isArray(item) || item[0] !== 'execution_error') continue;
    const data = item[1] ?? {};
    const text = data.exception_message ?? data.message;
    if (typeof text === 'string' && text) return text;
  }
  return null;
}
