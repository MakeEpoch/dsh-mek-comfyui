/**
 * RPC client for `dsh-mek-comfyui`.
 *
 * The browser never talks to ComfyUI directly: every call rides dsh's shared
 * `/api` carrier and is answered by the Host half (see docs/CONTRACT.md §2).
 * This module owns the envelope unwrapping, the error taxonomy, the image URL,
 * and the lifecycle (reset on `connection/reset`, dispose on plugin cleanup).
 */

/** Channel endpoint the Host mounts; it must not carry a leading slash. */
export const ENDPOINT = 'dsh-comfyui';

/** Prefix the Host uses for every failure it reports. */
const CODE_PREFIX = 'comfyui/';

/**
 * Build the same-origin URL of one gallery image.
 *
 * Images are served by the Host's exact Fetch route, not by RPC, so an
 * `<img src>` stays cheap and cacheable.
 * @param id the ImageFile's `id`.
 */
export function imageUrl(id) {
  if (typeof id !== 'string' || id === '') return '';
  return `/api/${ENDPOINT}/image?id=${encodeURIComponent(id)}`;
}

/** Error raised for any failed RPC; carries the Host's code and details. */
export class ComfyUiError extends Error {
  /**
   * @param message human-readable message from the Host, or a local fallback.
   * @param options code/details from the failure envelope.
   */
  constructor(message, { code, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ComfyUiError';
    this.code = typeof code === 'string' && code !== '' ? code : `${CODE_PREFIX}unknown`;
    this.details = details && typeof details === 'object' ? details : {};
  }
}

/** Whether an error means "the Host could not reach ComfyUI". */
export function isOffline(error) {
  const code = error?.code;
  return code === `${CODE_PREFIX}offline` || code === `${CODE_PREFIX}timeout`;
}

/** Whether an error means "another writer won the revision race". */
export function isConflict(error) {
  if (error?.code === `${CODE_PREFIX}conflict`) return true;
  // The Host may report a plain invalid with a revision hint; treat a message
  // that names the revision as a conflict so the page refreshes instead of
  // silently discarding the user's draft.
  return /revision|版本|其他窗口/i.test(String(error?.message ?? ''));
}

/**
 * Create the RPC wrapper shared by the settings page, the sidebar panel, and
 * the conversation card.
 * @param connection dsh's `ctx.connection`.
 */
export function createRpc(connection) {
  const listeners = new Set();
  const inflight = new Set();
  let disposed = false;

  /**
   * Call one Host method.
   * @param method RPC method name from CONTRACT §2.
   * @param payload method payload.
   * @param signal optional caller cancellation.
   * @returns the method's `value` from the success envelope.
   */
  async function call(method, payload = {}, signal) {
    if (disposed) throw new ComfyUiError('连接已关闭，请刷新页面', { code: `${CODE_PREFIX}offline` });
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    let wire;
    try {
      wire = await connection.rpc.call('/api', ENDPOINT, { method, payload }, signal);
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError') throw cause;
      throw new ComfyUiError(`无法访问 dsh 接口（${method}）`, { code: `${CODE_PREFIX}offline`, cause });
    }
    // Connection returns the result envelope; a direct fixture may return the
    // bare result, so accept both shapes.
    const response = wire?.result ?? wire;
    if (response && response.ok === false) {
      const failure = response.error ?? {};
      throw new ComfyUiError(
        typeof failure.message === 'string' && failure.message !== '' ? failure.message : `请求失败（${method}）`,
        { code: failure.code, details: failure.details },
      );
    }
    return response?.value;
  }

  /**
   * Call one method with a fresh AbortController owned by the caller.
   *
   * Returning both the promise and its controller lets a component abort in
   * its own effect cleanup without threading a controller through every call.
   * @param method RPC method name.
   * @param payload method payload.
   */
  function track(method, payload = {}) {
    const controller = new AbortController();
    const promise = call(method, payload, controller.signal);
    inflight.add(controller);
    const settle = () => inflight.delete(controller);
    promise.then(settle, settle);
    return { promise, controller };
  }

  return {
    call,
    track,
    /** Same-origin URL for a gallery image id. */
    imageUrl,
    /** Subscribe to a connection reset (a listener may drop cached state). */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Notify every subscriber that the transport was replaced.
     *
     * In-flight requests are aborted first: their answers belong to the dead
     * connection and would otherwise land on a re-rendered tree.
     */
    reset() {
      for (const controller of [...inflight]) {
        try { controller.abort(); } catch { /* already settled */ }
      }
      inflight.clear();
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* one bad listener must not stop the rest */ }
      }
    },
    /** Mark the wrapper closed; later calls fail fast. */
    dispose() {
      disposed = true;
      this.reset();
      listeners.clear();
    },
  };
}
