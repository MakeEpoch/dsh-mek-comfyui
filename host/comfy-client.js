/**
 * Dependency-free HTTP + WebSocket client for the ComfyUI server API.
 *
 * Only the endpoints this plugin needs are implemented, and every failure is
 * normalized into a `ComfyError` with a stable `comfyui/*` code so the RPC layer
 * can map it straight onto the contract's error envelope (CONTRACT §2).
 *
 * Two things are deliberate:
 *  - the client never logs the auth token (log.js redacts too, but the token is
 *    not put into a message or a URL we log in the first place);
 *  - the WebSocket auto-reconnects with capped backoff and re-emits `onOpen`,
 *    because a reconnect may have missed events and the caller has to re-sync.
 */
import { randomUUID } from 'node:crypto';
import { redact } from './log.js';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RECONNECT_DELAYS = Object.freeze([1000, 2000, 4000, 8000, 15000]);
const MAX_BODY_EXCERPT = 200;

/** Model folders surfaced by `models()` (CONTRACT `models.list`). */
export const MODEL_FOLDERS = Object.freeze([
  'checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras', 'upscale_models',
]);

/** A failure that carries a machine-readable `comfyui/*` code. */
export class ComfyError extends Error {
  /**
   * @param {string} code machine code, e.g. `comfyui/offline`.
   * @param {string} message user-facing message (Chinese where the UI shows it).
   * @param {object|string} [detail] diagnostic payload (never contains the token).
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ComfyError';
    this.code = code;
    this.detail = detail === undefined ? {} : detail;
  }
}

/**
 * Normalize a user-supplied server address.
 *
 * Accepts `host:8188`, `http://host:8188/`, and keeps a path prefix so a
 * reverse-proxied ComfyUI under `/comfy` still works. Non-http(s) schemes are
 * rejected rather than silently downgraded.
 * @param {string} raw
 * @returns {string} normalized base URL without a trailing slash.
 */
export function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new ComfyError('comfyui/invalid', 'ComfyUI 地址不能为空');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ComfyError('comfyui/invalid', `ComfyUI 地址格式不正确：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ComfyError('comfyui/invalid', 'ComfyUI 地址必须以 http:// 或 https:// 开头');
  }
  if (!url.hostname) throw new ComfyError('comfyui/invalid', `ComfyUI 地址缺少主机名：${value}`);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Short, redacted, single-line body excerpt for error details. */
function excerpt(text) {
  return redact(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, MAX_BODY_EXCERPT);
}

/** JSON parse that returns null for an empty body and a coded error otherwise. */
function parseJsonBody(text, path) {
  if (!String(text ?? '').trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ComfyError('comfyui/invalid', `ComfyUI 返回了无法解析的数据（${path}）`, {
      path,
      body: excerpt(text),
    });
  }
}

/** Pull the first node error message out of a `/prompt` rejection payload. */
function firstNodeError(data) {
  const nodeErrors = data?.node_errors;
  if (!nodeErrors || typeof nodeErrors !== 'object') return null;
  for (const entry of Object.values(nodeErrors)) {
    const errors = Array.isArray(entry?.errors) ? entry.errors : [];
    for (const error of errors) {
      const message = String(error?.message ?? '').trim();
      if (!message) continue;
      const details = String(error?.details ?? '').trim();
      const classType = String(entry?.class_type ?? '').trim();
      return {
        message: details ? `${message}（${details}）` : message,
        classType,
      };
    }
  }
  return null;
}

export class ComfyClient {
  #baseUrl;
  #authToken;
  #timeoutMs;
  #logger;
  #webSocketFactory;
  #reconnectDelays;
  #sockets = new Set();
  /** clientId -> the one live handle for that id. */
  #live = new Map();

  /**
   * @param {object} options
   * @param {string} options.baseUrl server address, scheme optional.
   * @param {string} [options.authToken] bearer token; never logged or returned.
   * @param {number} [options.timeoutMs] per-request deadline.
   * @param {(level: string, message: string) => void} [options.logger] injected logger.
   * @param {(url: string) => WebSocket} [options.webSocketFactory] test seam.
   * @param {number[]} [options.reconnectDelays] test seam; defaults to 1s..15s.
   */
  constructor({
    baseUrl,
    authToken = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = () => {},
    webSocketFactory,
    reconnectDelays,
  } = {}) {
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#authToken = String(authToken ?? '').trim();
    this.#timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.#logger = typeof logger === 'function' ? logger : () => {};
    this.#webSocketFactory = typeof webSocketFactory === 'function'
      ? webSocketFactory
      : (url) => new WebSocket(url);
    this.#reconnectDelays = Array.isArray(reconnectDelays) && reconnectDelays.length
      ? reconnectDelays.map((delay) => (Number.isFinite(delay) && delay > 0 ? delay : 1000))
      : DEFAULT_RECONNECT_DELAYS;
  }

  /** Normalized base URL, no trailing slash. */
  get baseUrl() {
    return this.#baseUrl;
  }

  /**
   * Change the server address. Live sockets are closed first: an open socket
   * still points at the previous server, and letting it reconnect there would
   * deliver events that no longer relate to this client.
   * @param {string} url
   */
  setBaseUrl(url) {
    const next = normalizeBaseUrl(url);
    if (next !== this.#baseUrl) this.#closeSockets();
    this.#baseUrl = next;
    return this.#baseUrl;
  }

  /**
   * Change the bearer token. Live sockets are closed so the next one carries
   * the new credentials in its query string.
   * @param {string} token
   */
  setAuthToken(token) {
    const next = String(token ?? '').trim();
    if (next !== this.#authToken) this.#closeSockets();
    this.#authToken = next;
  }

  /**
   * Change the per-request deadline without rebuilding the client.
   * Invalid values are ignored, so a bad settings field cannot disable timeouts.
   * @param {number} ms
   * @returns {number} the effective timeout.
   */
  setTimeout(ms) {
    const value = Number(ms);
    if (Number.isFinite(value) && value > 0) this.#timeoutMs = Math.trunc(value);
    return this.#timeoutMs;
  }

  /** Effective per-request deadline in milliseconds. */
  get timeoutMs() {
    return this.#timeoutMs;
  }

  /** Whether a token is configured (the value itself is never exposed). */
  get authTokenConfigured() {
    return this.#authToken.length > 0;
  }

  // ---------------------------------------------------------------- requests

  #url(path, query) {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.#baseUrl}${suffix}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        // Empty strings are meaningful here: ComfyUI expects `subfolder=` and `type=`.
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  #wsUrl(clientId) {
    const url = new URL(this.#url('/ws'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', clientId);
    if (this.#authToken) url.searchParams.set('token', this.#authToken);
    return url.toString();
  }

  /**
   * One HTTP round trip with a deadline composed from the caller's signal.
   * @returns {Promise<Response>}
   */
  async #request(path, { method = 'GET', body, signal, headers = {}, query, timeoutMs, accept } = {}) {
    if (signal !== undefined && signal !== null && typeof signal.aborted !== 'boolean') {
      throw new ComfyError('comfyui/invalid', '请求取消信号无效');
    }
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : this.#timeoutMs;
    const deadline = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const url = this.#url(path, query);
    const init = {
      method,
      signal: combined,
      headers: { accept: accept ?? 'application/json', ...headers },
    };
    if (this.#authToken) init.headers.authorization = `Bearer ${this.#authToken}`;
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    try {
      return await fetch(url, init);
    } catch (error) {
      if (signal?.aborted) {
        throw new ComfyError('comfyui/canceled', '请求已取消', { path });
      }
      if (deadline.aborted) {
        throw new ComfyError('comfyui/timeout', `ComfyUI 请求超时（${timeout}ms）`, { path, timeoutMs: timeout });
      }
      const reason = redact(String(error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error));
      throw new ComfyError('comfyui/offline', `无法连接 ComfyUI：${reason}`, { path, reason });
    }
  }

  async #readText(response) {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  /** Map a non-2xx response onto the contract's codes. */
  #statusError(status, text, path, data) {
    const body = excerpt(text);
    let code = 'comfyui/invalid';
    if (status === 401 || status === 403) code = 'comfyui/auth';
    else if (status === 404) code = 'comfyui/not-found';
    else if (status >= 500) code = 'comfyui/offline';

    const serverMessage = String(data?.error?.message ?? '').trim();
    let message;
    if (code === 'comfyui/auth') message = `ComfyUI 认证失败（HTTP ${status}），请检查访问令牌`;
    else if (code === 'comfyui/not-found') message = `ComfyUI 接口不存在（HTTP ${status}）：${path}`;
    else if (code === 'comfyui/offline') message = `无法连接 ComfyUI：服务器错误（HTTP ${status}）`;
    else message = `ComfyUI 拒绝了请求（HTTP ${status}）`;
    if (serverMessage && code !== 'comfyui/auth') message = `${message}：${serverMessage}`;

    return new ComfyError(code, message, { status, path, body });
  }

  /** JSON request that throws a mapped error for non-2xx. */
  async #json(path, options) {
    const response = await this.#request(path, options);
    const text = await this.#readText(response);
    const data = response.ok ? parseJsonBody(text, path) : (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    if (!response.ok) throw this.#statusError(response.status, text, path, data);
    return data;
  }

  // ------------------------------------------------------------------- reads

  /**
   * Server version + devices (CONTRACT `status.get`).
   * @returns {Promise<{ok: true, version: string|null, devices: object[], comfyuiVersion: string|null}>}
   */
  async systemStats({ signal } = {}) {
    const data = await this.#json('/system_stats', { signal });
    if (!data || typeof data !== 'object' || (!data.system && !Array.isArray(data.devices))) {
      throw new ComfyError('comfyui/invalid', 'ComfyUI 返回了意外的系统信息', {
        body: excerpt(JSON.stringify(data ?? '')),
      });
    }
    const version = typeof data.system?.comfyui_version === 'string'
      ? data.system.comfyui_version
      : (typeof data.comfyui_version === 'string' ? data.comfyui_version : null);
    const devices = (Array.isArray(data.devices) ? data.devices : []).map((device) => ({
      name: String(device?.name ?? ''),
      type: String(device?.type ?? ''),
      vramTotal: Number(device?.vram_total ?? 0),
      vramFree: Number(device?.vram_free ?? 0),
    }));
    return { ok: true, version, devices, comfyuiVersion: version };
  }

  /** Running + pending queue entries, in submission order. */
  async queue({ signal } = {}) {
    const data = await this.#json('/queue', { signal });
    if (!data || typeof data !== 'object') {
      throw new ComfyError('comfyui/invalid', 'ComfyUI 返回了意外的队列信息');
    }
    return {
      running: normalizeQueueItems(data.queue_running),
      pending: normalizeQueueItems(data.queue_pending),
    };
  }

  /** Raw `/object_info` (can be ~2 MB; the caller caches it). */
  async objectInfo({ signal } = {}) {
    const data = await this.#json('/object_info', { signal });
    if (!data || typeof data !== 'object') {
      throw new ComfyError('comfyui/invalid', 'ComfyUI 返回了意外的节点信息');
    }
    return data;
  }

  /**
   * Installed model names per folder, sorted ascending.
   * `/models` lists folder names; `/models/<folder>` lists the files.
   */
  async models({ signal } = {}) {
    const result = Object.fromEntries(MODEL_FOLDERS.map((folder) => [folder, []]));
    let available = null;
    try {
      const folders = await this.#json('/models', { signal });
      if (Array.isArray(folders)) available = new Set(folders.map((folder) => String(folder)));
    } catch (error) {
      if (error?.code === 'comfyui/auth' || error?.code === 'comfyui/timeout' || error?.code === 'comfyui/canceled') {
        throw error;
      }
      this.#logger('warn', '读取 ComfyUI 模型目录列表失败，改为逐个查询', error?.message);
    }

    const entries = await Promise.all(MODEL_FOLDERS.map(async (folder) => {
      if (available && !available.has(folder)) return [folder, []];
      try {
        const items = await this.#json(`/models/${encodeURIComponent(folder)}`, { signal });
        return [folder, normalizeModelNames(items)];
      } catch (error) {
        if (error?.code === 'comfyui/auth' || error?.code === 'comfyui/timeout' || error?.code === 'comfyui/canceled') {
          throw error;
        }
        if (error?.code !== 'comfyui/not-found') {
          this.#logger('debug', `读取模型目录 ${folder} 失败`, error?.message);
        }
        return [folder, []];
      }
    }));
    for (const [folder, names] of entries) result[folder] = names;
    return result;
  }

  /** One history entry (`{ prompt, outputs, status, meta }`) or null. */
  async history(promptId, { signal } = {}) {
    const id = String(promptId ?? '').trim();
    if (!id) throw new ComfyError('comfyui/invalid', '缺少 promptId');
    const data = await this.#json(`/history/${encodeURIComponent(id)}`, { signal });
    if (!data || typeof data !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(data, id)) return data[id] ?? null;
    const entries = Object.values(data);
    return entries.length ? entries[0] : null;
  }

  /** Download an output image; `mediaType` comes from the response headers. */
  async view({ filename, subfolder = '', type = 'output' } = {}, { signal } = {}) {
    const name = String(filename ?? '').trim();
    if (!name) throw new ComfyError('comfyui/invalid', '缺少图片文件名');
    if (name.includes('..') || name.includes('\0') || name.includes('\\')) {
      throw new ComfyError('comfyui/invalid', '图片文件名不合法', { filename: name });
    }
    const kind = String(type ?? 'output');
    if (!['output', 'temp', 'input'].includes(kind)) {
      throw new ComfyError('comfyui/invalid', '图片类型不合法', { type: kind });
    }
    const response = await this.#request('/view', {
      signal,
      accept: 'image/*',
      query: { filename: name, subfolder: String(subfolder ?? ''), type: kind },
    });
    if (!response.ok) {
      const text = await this.#readText(response);
      throw this.#statusError(response.status, text, '/view');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const header = String(response.headers.get('content-type') ?? '').split(';')[0].trim();
    return { bytes, mediaType: header || 'image/png' };
  }

  // ------------------------------------------------------------------ writes

  /**
   * POST a workflow to `/prompt`.
   * @returns {Promise<{promptId: string, number: number|null, nodeErrors: object}>}
   */
  async submit(workflow, { clientId, signal } = {}) {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      throw new ComfyError('comfyui/invalid', '工作流必须是 API 格式的对象');
    }
    const id = typeof clientId === 'string' && clientId.trim() ? clientId.trim() : randomUUID();
    const response = await this.#request('/prompt', {
      method: 'POST',
      signal,
      body: { prompt: workflow, client_id: id },
    });
    const text = await this.#readText(response);
    let data = null;
    try {
      data = text.trim() ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const nodeError = firstNodeError(data);
      if (nodeError) {
        const where = nodeError.classType ? `（节点 ${nodeError.classType}）` : '';
        throw new ComfyError('comfyui/invalid', `工作流校验失败${where}：${nodeError.message}`, {
          status: response.status,
          path: '/prompt',
          body: excerpt(text),
          nodeErrors: data?.node_errors ?? {},
        });
      }
      throw this.#statusError(response.status, text, '/prompt', data);
    }

    const nodeError = firstNodeError(data);
    if (nodeError) {
      const where = nodeError.classType ? `（节点 ${nodeError.classType}）` : '';
      throw new ComfyError('comfyui/invalid', `工作流校验失败${where}：${nodeError.message}`, {
        status: response.status,
        path: '/prompt',
        body: excerpt(text),
        nodeErrors: data?.node_errors ?? {},
      });
    }
    const serverError = String(data?.error?.message ?? data?.error?.type ?? '').trim();
    if (serverError) {
      throw new ComfyError('comfyui/invalid', `ComfyUI 拒绝了该工作流：${serverError}`, {
        status: response.status,
        path: '/prompt',
        body: excerpt(text),
      });
    }
    const promptId = typeof data?.prompt_id === 'string' ? data.prompt_id : '';
    if (!promptId) {
      throw new ComfyError('comfyui/invalid', 'ComfyUI 未返回 prompt_id', { body: excerpt(text) });
    }
    return {
      promptId,
      number: Number.isFinite(Number(data?.number)) ? Number(data.number) : null,
      nodeErrors: data?.node_errors && typeof data.node_errors === 'object' ? data.node_errors : {},
    };
  }

  /** Interrupt the currently executing prompt. */
  async interrupt({ signal } = {}) {
    await this.#json('/interrupt', { method: 'POST', signal });
    return { ok: true };
  }

  /** Drop everything that is still pending; the running prompt is untouched. */
  async clearQueue({ signal } = {}) {
    await this.#json('/queue', { method: 'POST', signal, body: { clear: true } });
    return { ok: true };
  }

  /** Delete specific pending prompts by id. */
  async deleteQueued(promptIds, { signal } = {}) {
    if (!Array.isArray(promptIds)) throw new ComfyError('comfyui/invalid', 'promptIds 必须是数组');
    const ids = promptIds.map((id) => String(id ?? '').trim()).filter(Boolean);
    if (!ids.length) return { ok: true, deleted: 0 };
    await this.#json('/queue', { method: 'POST', signal, body: { delete: ids } });
    return { ok: true, deleted: ids.length };
  }

  // --------------------------------------------------------------- websocket

  /**
   * Open the event socket used for live progress.
   *
   * Text frames are parsed and forwarded as `{ type, data }`; binary frames are
   * preview images and are ignored. The socket reconnects with capped backoff
   * while it is wanted, and every (re)connect re-emits `onOpen` so the caller can
   * re-sync state that may have been missed.
   *
   * Only one socket may be live per `clientId`: opening a second one with the
   * same id closes the first. Callers that drop their handle on `onClose` (a
   * transient drop does not end the reconnect loop) therefore cannot end up with
   * two reconnecting sockets.
   * @returns {{ close: () => void, clientId: string }}
   */
  openSocket({ clientId, onEvent, onOpen, onClose } = {}) {
    const id = typeof clientId === 'string' && clientId.trim() ? clientId.trim() : randomUUID();
    const previous = this.#live.get(id);
    if (previous) {
      this.#live.delete(id);
      try {
        previous.close();
      } catch {
        /* the old socket is being replaced, not repaired */
      }
    }
    const url = this.#wsUrl(id);
    const delays = this.#reconnectDelays;
    let wanted = true;
    let closed = false;
    let socket = null;
    let timer = null;
    let attempt = 0;

    const notify = (handler, payload) => {
      if (typeof handler !== 'function') return;
      try {
        handler(payload);
      } catch (error) {
        this.#logger('warn', 'ComfyUI 事件回调抛出异常', error?.message ?? String(error));
      }
    };

    const schedule = () => {
      if (!wanted || closed) return;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
      timer.unref?.();
    };

    const connect = () => {
      if (!wanted || closed) return;
      let next;
      try {
        next = this.#webSocketFactory(url);
      } catch (error) {
        this.#logger('warn', '无法创建 ComfyUI WebSocket 连接', error?.message ?? String(error));
        schedule();
        return;
      }
      socket = next;
      this.#sockets.add(handle);
      this.#live.set(id, handle);
      try {
        next.onopen = () => {
          attempt = 0;
          notify(onOpen);
        };
        next.onmessage = (event) => {
          const data = event?.data;
          // Preview frames are binary; only JSON text frames carry events.
          if (typeof data !== 'string') return;
          let frame;
          try {
            frame = JSON.parse(data);
          } catch {
            this.#logger('debug', '忽略无法解析的 ComfyUI WebSocket 帧');
            return;
          }
          if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
          notify(onEvent, { type: frame.type, data: frame.data });
        };
        next.onerror = () => {
          /* a close event always follows; reconnect is handled there */
        };
        next.onclose = () => {
          if (socket === next) socket = null;
          this.#sockets.delete(handle);
          if (this.#live.get(id) === handle) this.#live.delete(id);
          notify(onClose);
          schedule();
        };
      } catch (error) {
        this.#logger('warn', 'ComfyUI WebSocket 绑定事件失败', error?.message ?? String(error));
        schedule();
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      wanted = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.onopen = null;
          current.onmessage = null;
          current.onerror = null;
          current.onclose = null;
          current.close();
        } catch (error) {
          this.#logger('debug', '关闭 ComfyUI WebSocket 失败', error?.message ?? String(error));
        }
      }
      this.#sockets.delete(handle);
      if (this.#live.get(id) === handle) this.#live.delete(id);
      notify(onClose);
    };

    const handle = {
      close,
      get clientId() {
        return id;
      },
    };

    connect();
    return handle;
  }

  /** Close every live socket without changing any other state. */
  #closeSockets() {
    for (const handle of [...this.#sockets]) {
      try {
        handle.close();
      } catch {
        /* closing must never throw */
      }
    }
    this.#sockets.clear();
    this.#live.clear();
  }

  /** Close every socket this client opened. Idempotent. */
  dispose() {
    this.#closeSockets();
  }
}

/** `/queue` items are `[number, prompt_id, workflow, extra, outputs]`; tolerate objects too. */
function normalizeQueueItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (Array.isArray(item)) {
      return {
        promptId: typeof item[1] === 'string' ? item[1] : String(item[1] ?? ''),
        number: Number.isFinite(Number(item[0])) ? Number(item[0]) : null,
      };
    }
    if (item && typeof item === 'object') {
      return {
        promptId: typeof item.prompt_id === 'string' ? item.prompt_id : String(item.prompt_id ?? item.promptId ?? ''),
        number: Number.isFinite(Number(item.number)) ? Number(item.number) : null,
      };
    }
    return { promptId: '', number: null };
  });
}

/**
 * `/models/<folder>` returns plain name strings on current ComfyUI builds; the
 * documented shape is `[{ name }]`. Accept both.
 */
function normalizeModelNames(items) {
  if (!Array.isArray(items)) return [];
  const names = new Set();
  for (const item of items) {
    const name = typeof item === 'string' ? item : item?.name;
    if (typeof name === 'string' && name.trim()) names.add(name.trim());
  }
  return [...names].sort();
}
