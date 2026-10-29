/**
 * The plugin's HTTP surface, on dsh's own `/api` carrier.
 *
 * Two routes:
 *  - `POST /api/dsh-comfyui`      the RPC envelope the browser already speaks
 *                                 (`ctx.connection.fetch.register`, which dsh
 *                                 guards with browser auth and its Host fence);
 *  - `GET  /api/dsh-comfyui/image` one gallery image, or a proxied ComfyUI
 *                                 `/view` for an image this plugin has not
 *                                 downloaded yet.
 *
 * The image route is deliberately narrow: an id from our own index, or a
 * filename validated against ComfyUI's own path rules. It never accepts a path.
 */
import { Readable } from 'node:stream';

/** Channel endpoint as the browser names it (Connection composes `${channel}/${endpoint}`). */
export const RPC_ENDPOINT = 'dsh-comfyui';
export const RPC_PATH = `/api/${RPC_ENDPOINT}`;
export const IMAGE_PATH = `${RPC_PATH}/image`;

/** Bodies are small JSON; 1 MiB is generous for a workflow paste. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Register both routes.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {() => object | null} options.getService
 * @param {(level: string, message: string) => void} [options.logger]
 * @returns {Promise<() => void>} disposer; rejects only when the carrier is missing.
 */
export async function registerRpc({ ctx, getService, logger = () => {} }) {
  const registry = ctx?.connection?.fetch;
  if (typeof registry?.register !== 'function') {
    throw new TypeError('dsh Connection Fetch registry is required for the ComfyUI panel');
  }
  const disposers = [];
  const stop = async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose?.();
      } catch {
        /* teardown must continue */
      }
    }
  };

  try {
    disposers.push(await registry.register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }

        let message;
        try {
          const text = await request.text();
          if (text.length > MAX_BODY_BYTES) return new Response('body too large', { status: 413 });
          message = JSON.parse(text);
        } catch {
          return new Response('body is not JSON', { status: 400 });
        }

        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
          || message.method !== RPC_ENDPOINT || !isRecord(call) || typeof call.method !== 'string') {
          return reply(rpcId, { ok: false, error: { code: 'comfyui/invalid', message: '无效的面板请求' } });
        }

        const service = getService();
        if (!service) {
          return reply(rpcId, {
            ok: false,
            error: { code: 'comfyui/offline', message: '插件仍在启动，请稍后重试。' },
          });
        }

        try {
          const value = await dispatch(service, call.method, call.payload ?? {});
          return reply(rpcId, { ok: true, value });
        } catch (error) {
          logger('debug', `面板调用 ${call.method} 失败：${error?.message ?? error}`);
          return reply(rpcId, {
            ok: false,
            error: {
              code: typeof error?.code === 'string' ? error.code : 'comfyui/unknown',
              message: error instanceof Error ? error.message : String(error),
              details: isRecord(error?.details) ? error.details : {},
            },
          });
        }
      },
    }));

    disposers.push(await registry.register({
      path: IMAGE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const service = getService();
        if (!service) return new Response('plugin is starting', { status: 503 });
        const url = new URL(request.url);
        try {
          const id = url.searchParams.get('id');
          if (id) {
            const record = await service.imageRecord(id);
            const path = await service.imagePath(id);
            if (!record || !path) return new Response('image not found', { status: 404 });
            const { createReadStream } = await import('node:fs');
            const { stat } = await import('node:fs/promises');
            let size;
            try {
              size = (await stat(path)).size;
            } catch {
              return new Response('image file missing', { status: 404 });
            }
            return new Response(Readable.toWeb(createReadStream(path)), {
              status: 200,
              headers: imageHeaders(record.mediaType, size),
            });
          }

          // Fallback: proxy one ComfyUI output image by name. This keeps the
          // gallery working for jobs finished before the plugin downloaded them
          // (for example after a restart), without exposing a generic proxy.
          const filename = url.searchParams.get('filename');
          if (!filename) return new Response('missing id or filename', { status: 400 });
          const subfolder = url.searchParams.get('subfolder') ?? '';
          const type = url.searchParams.get('type') ?? 'output';
          const fetched = await service.client.view({ filename, subfolder, type }, {});
          return new Response(fetched.bytes, {
            status: 200,
            headers: imageHeaders(fetched.mediaType, fetched.bytes.length),
          });
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : '';
          const status = code === 'comfyui/not-found' ? 404 : code === 'comfyui/invalid' ? 400 : 502;
          return new Response('image unavailable', { status });
        }
      },
    }));

    return () => {
      void stop();
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

function imageHeaders(mediaType, size) {
  return {
    'content-type': sanitizeMediaType(mediaType),
    'content-length': String(size),
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
  };
}

function sanitizeMediaType(value) {
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const type = String(value ?? '').split(';')[0].trim().toLowerCase();
  return allowed.has(type) ? type : 'application/octet-stream';
}

function reply(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The allowlist of what the browser may ask for. Every method maps to one
 * service call; nothing here can read a file or reach an arbitrary URL.
 * @param {object} service
 * @param {string} method
 * @param {Record<string, any>} payload
 */
async function dispatch(service, method, payload) {
  switch (method) {
    // connection / status
    case 'status.get':
      return service.status();
    case 'status.markRead':
      return service.markRead();
    case 'connection.test':
      return service.testConnection({
        baseUrl: payload.baseUrl,
        authToken: payload.authToken,
      });
    case 'models.list':
      return service.models({ refresh: payload.refresh === true });

    // settings
    case 'settings.get':
      return settingsPayload(service);
    case 'settings.update':
      return service.updateSettings(payload.patch, payload.expectedRevision);
    case 'settings.reset':
      return service.resetSettings(payload.expectedRevision);

    // presets
    case 'presets.list':
      return { items: service.listPresets() };
    case 'presets.get':
      return { item: service.getPreset(payload.id) };
    case 'presets.save':
      return { item: await service.savePreset(payload) };
    case 'presets.delete':
      return service.deletePreset(payload.id);

    // queue / jobs
    case 'queue.get':
      return service.queueState();
    case 'queue.cancel':
      return service.cancel({ jobId: payload.jobId });
    case 'queue.cancelAll':
      return service.cancel({ all: true });
    case 'queue.clear':
      return service.clearServerQueue();
    case 'jobs.get':
      return { job: requireJob(service, payload.id) };
    case 'jobs.list':
      return service.listJobs({
        limit: clampNumber(payload.limit, 1, 200, 30),
        offset: clampNumber(payload.offset, 0, 1_000_000, 0),
        status: typeof payload.status === 'string' ? payload.status : undefined,
      });

    // generation
    case 'generate.start':
      return {
        job: await service.generate(payload, {
          source: 'ui',
          sessionId: sessionIdOf(payload),
        }),
      };

    // gallery
    case 'gallery.list':
      return service.galleryList({
        limit: clampNumber(payload.limit, 1, 200, 30),
        offset: clampNumber(payload.offset, 0, 1_000_000, 0),
        query: typeof payload.query === 'string' ? payload.query.slice(0, 200) : '',
        favorite: payload.favorite === true,
        status: typeof payload.status === 'string' ? payload.status : undefined,
        sessionId: sessionIdOf(payload),
      });
    case 'gallery.get':
      return { job: await service.galleryGet(payload.id) };
    case 'gallery.update':
      return { job: await service.galleryUpdate(payload.id, { favorite: payload.favorite === true }) };
    case 'gallery.delete':
      return service.galleryDelete(payload.ids);
    case 'gallery.stats':
      return service.galleryStats({ sessionId: sessionIdOf(payload) });
    case 'gallery.prune':
      return service.galleryPrune({ dryRun: payload.dryRun === true });

    default: {
      const error = new Error(`未知的接口：${method}`);
      error.code = 'comfyui/unknown-method';
      throw error;
    }
  }
}

function settingsPayload(service) {
  return {
    settings: service.settingsReadModel(),
    defaults: service.settingsDefaults(),
    presets: service.listPresets(),
    ...service.describeSettings(),
  };
}

/**
 * Read the optional conversation scope from a request.
 *
 * A session id is an opaque host identifier, never a path or a query, so the
 * only validation that matters here is "a bounded string": anything else is
 * treated as "no scope" rather than rejected, because a gallery that refuses to
 * load over a malformed scope is worse than one that shows everything.
 *
 * @param {Record<string, any>} payload
 * @returns {string | undefined}
 */
function sessionIdOf(payload) {
  const value = payload?.sessionId;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 200) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function requireJob(service, id) {
  const job = service.getJob(id);
  if (!job) {
    const error = new Error('任务不存在');
    error.code = 'comfyui/not-found';
    throw error;
  }
  return job;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
