/**
 * Pure display helpers for `dsh-mek-comfyui`.
 *
 * Everything in this module is a total function over untrusted Host data: no
 * React, no DOM, no imports. Callers get a display string for any input, and
 * malformed values degrade to an em dash rather than throwing, so a broken or
 * offline Host can never take the settings page down.
 */

/** Placeholder for a value the Host did not supply. */
export const UNKNOWN = '—';

/**
 * Coerce anything to a finite number, or `undefined`.
 *
 * `Number()` throws on a Symbol and on an object with a hostile `valueOf`, and
 * every helper here must stay total over Host data, so coercion is guarded.
 * @param value candidate from the Host.
 * @returns the finite number, or undefined.
 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
  if (typeof value !== 'string' && typeof value !== 'boolean') return undefined;
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  } catch {
    return undefined;
  }
}

/** Clamp `value` into `[min, max]`, returning `min` for non-finite input. */
export function clampNumber(value, min, max) {
  const number = toFiniteNumber(value);
  if (number === undefined) return min;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

/**
 * Clamp a progress percentage into 0..100.
 * @param value percent, fraction, or numeric string; anything unusable is 0.
 */
export function clampPercent(value) {
  const number = toFiniteNumber(value);
  if (number === undefined) return 0;
  if (number <= 0) return 0;
  if (number >= 100) return 100;
  return Math.round(number * 10) / 10;
}

/**
 * Derive a 0..100 percentage from a progress record.
 *
 * The Host already computes `percent`, but a running job may only carry
 * `value`/`max` (or neither), so fall back in that order.
 * @param progress the Job's `progress` field, or null.
 */
export function progressPercent(progress) {
  if (progress === null || typeof progress !== 'object') return 0;
  const { percent, value, max } = progress;
  const explicit = toFiniteNumber(percent);
  if (explicit !== undefined) return clampPercent(explicit);
  const done = toFiniteNumber(value);
  const total = toFiniteNumber(max);
  if (done !== undefined && total !== undefined && total > 0) return clampPercent((done / total) * 100);
  return 0;
}

/**
 * Human duration. Sub-second values keep millisecond precision so a fast
 * turbo model does not read as "0 秒".
 * @param ms milliseconds; negative or non-finite input is unknown.
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
  }
  return seconds === 60 ? `${minutes + 1} 分` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * Human byte count with one decimal below 10 units.
 * @param bytes byte count; negative or non-finite input is unknown.
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return UNKNOWN;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

/**
 * Relative "how long ago" text for an epoch-ms stamp.
 *
 * Future stamps (clock skew between browser and Host) read as 刚刚 instead of
 * a negative age.
 * @param stamp epoch milliseconds, or a parseable date string.
 * @param now reference instant, injectable for tests.
 */
export function formatRelativeTime(stamp, now = Date.now()) {
  const value = typeof stamp === 'number' ? stamp : Date.parse(String(stamp ?? ''));
  if (!Number.isFinite(value) || value <= 0) return UNKNOWN;
  const delta = Math.max(0, now - value);
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const days = Math.floor(delta / 86_400_000);
  if (days < 30) return `${days} 天前`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return UNKNOWN;
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Localised label for a Job status.
 *
 * Unknown statuses are returned verbatim (bounded) rather than mislabelled as
 * a known state.
 * @param status the Job's status string.
 */
export function statusLabel(status) {
  switch (status) {
    case 'queued': return '排队中';
    case 'running': return '生成中';
    case 'succeeded': return '已完成';
    case 'failed': return '失败';
    case 'canceled': return '已取消';
    default: return typeof status === 'string' && status.trim() !== '' ? status.trim().slice(0, 24) : '未知';
  }
}

/**
 * Visual tone for a status, used as `data-tone` in CSS.
 * @param status the Job's status string.
 */
export function statusTone(status) {
  switch (status) {
    case 'running': return 'running';
    case 'queued': return 'queued';
    case 'succeeded': return 'success';
    case 'failed': return 'error';
    case 'canceled': return 'muted';
    default: return 'muted';
  }
}

/**
 * Localised label for a preset mode badge.
 * @param mode `unet` | `checkpoint` | `custom`.
 */
export function modeLabel(mode) {
  switch (mode) {
    case 'unet': return 'UNet';
    case 'checkpoint': return 'Checkpoint';
    case 'custom': return '自定义工作流';
    default: return typeof mode === 'string' && mode !== '' ? mode : UNKNOWN;
  }
}

/**
 * Shorten a prompt for a single-line summary.
 * @param text prompt text of any length.
 * @param max maximum characters before the ellipsis.
 */
export function excerpt(text, max = 60) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Elapsed time for a job, using `durationMs` once settled and the wall clock
 * while it is still running.
 * @param job a Job-shaped record.
 * @param now reference instant, injectable for tests.
 */
export function jobDuration(job, now = Date.now()) {
  if (job === null || typeof job !== 'object') return UNKNOWN;
  if (typeof job.durationMs === 'number' && Number.isFinite(job.durationMs)) return formatDuration(job.durationMs);
  if (typeof job.startedAt === 'number' && Number.isFinite(job.startedAt)) return formatDuration(Math.max(0, now - job.startedAt));
  return UNKNOWN;
}

/**
 * Aspect-ratio hint for the generate form, e.g. `1:1 · 方形`.
 * @param width pixel width.
 * @param height pixel height.
 */
export function ratioHint(width, height) {
  const w = toFiniteNumber(width);
  const h = toFiniteNumber(height);
  if (w === undefined || h === undefined || w <= 0 || h <= 0) return '';
  const ratio = w / h;
  const known = [
    [1, '1:1 · 方形'],
    [4 / 3, '4:3 · 横向'],
    [3 / 4, '3:4 · 纵向'],
    [16 / 9, '16:9 · 宽屏'],
    [9 / 16, '9:16 · 竖屏'],
    [3 / 2, '3:2 · 横向'],
    [2 / 3, '2:3 · 纵向'],
    [1.294, '1.29:1 · 近似 1328×1024'],
  ];
  for (const [target, label] of known) if (Math.abs(ratio - target) < 0.02) return label;
  return `${ratio.toFixed(2)}:1`;
}

/** Number formatting that never yields `NaN` in the UI. */
export function formatCount(value) {
  const number = toFiniteNumber(value);
  if (number === undefined || number < 0) return UNKNOWN;
  return String(Math.round(number));
}

/**
 * Validate the settings draft before it is sent to the Host.
 *
 * The Host stays authoritative; this only spares the user a round trip for
 * mistakes the browser can see (a non-URL base address, an out-of-range
 * number, an empty token field that means "keep").
 * @param draft a settings draft with string-typed numeric fields.
 * @returns a map of field → message; empty when the draft may be submitted.
 */
export function validateSettingsDraft(draft) {
  const errors = {};
  if (draft === null || typeof draft !== 'object') return { form: '设置数据不可用' };
  const baseUrl = String(draft.baseUrl ?? '').trim();
  if (baseUrl !== '' && !/^https?:\/\/\S+$/i.test(baseUrl)) errors.baseUrl = '地址需以 http:// 或 https:// 开头';
  const range = (field, min, max, label) => {
    // A partial draft (a single-field form, a patch preview) omits fields it
    // does not own; only fields present are judged.
    if (!(field in draft)) return;
    const raw = draft[field];
    const number = raw === '' || raw === null || raw === undefined ? undefined : toFiniteNumber(raw);
    if (number === undefined) { errors[field] = `请填写${label}`; return; }
    if (number < min || number > max) errors[field] = `${label}需在 ${min} 到 ${max} 之间`;
  };
  range('requestTimeoutSeconds', 5, 600, '请求超时');
  range('generateTimeoutSeconds', 10, 3600, '生成超时');
  range('pollIntervalMs', 1000, 10_000, '轮询间隔');
  range('width', 64, 8192, '宽度');
  range('height', 64, 8192, '高度');
  range('steps', 1, 200, '步数');
  range('cfg', 0, 30, 'CFG');
  range('batch', 1, 8, '批量');
  range('retentionDays', 0, 3650, '保留天数');
  range('maxGalleryItems', 1, 100_000, '图库上限');
  if (draft.seedMode === 'fixed') range('seed', 0, 2 ** 48, '种子');
  return errors;
}

/**
 * Validate custom workflow JSON text from the preset form.
 *
 * Only structure is checked here: an object of API-format nodes. Placeholder
 * substitution is the Host's job (CONTRACT §5).
 * @param text textarea contents.
 * @returns `{ ok: true, value }` or `{ ok: false, message }` with a readable reason.
 */
export function parseWorkflowJson(text) {
  const source = String(text ?? '').trim();
  if (source === '') return { ok: false, message: '请粘贴 API 格式的工作流 JSON' };
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `JSON 解析失败：${detail}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: '工作流必须是一个 JSON 对象（节点 id → 节点定义）' };
  const nodes = Object.entries(value);
  if (nodes.length === 0) return { ok: false, message: '工作流为空，请粘贴至少一个节点' };
  for (const [id, node] of nodes) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return { ok: false, message: `节点 ${id} 不是对象` };
    if (!('class_type' in node)) return { ok: false, message: `节点 ${id} 缺少 class_type` };
  }
  return { ok: true, value };
}

/**
 * Flatten gallery jobs into the ordered image list the wall renders and the
 * viewer walks.
 *
 * The viewer's ←/→ must cross prompt boundaries — stepping through a library
 * one batch at a time and dead-ending is the single most annoying thing a
 * lightbox can do — so the panel and the viewer share one flat list rather than
 * each navigating inside its own group.
 *
 * @param {Array} jobs gallery jobs, newest first
 * @param {(id: string) => string} imageUrl fallback URL builder for an image id
 * @returns {Array<{ job: object, image: object, url: string }>} images in order
 */
export function flattenGallery(jobs, imageUrl) {
  const items = [];
  const seen = new Set();
  if (!Array.isArray(jobs)) return items;
  for (const job of jobs) {
    const images = Array.isArray(job?.images) ? job.images : [];
    for (const image of images) {
      const url = typeof image?.url === 'string' && image.url !== ''
        ? image.url
        : (typeof imageUrl === 'function' ? imageUrl(image?.id) : '');
      if (!url) continue;
      // A job that survived a partial refresh could repeat an image; one tile
      // per image keeps the index the viewer reports honest.
      const key = String(image?.id ?? `${job?.id}:${url}`);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ job, image, url });
    }
  }
  return items;
}

/**
 * Wrap an index into `[0, total)`.
 *
 * A viewer that stops at the last image forces a close-and-reopen to see the
 * neighbour, so navigation wraps; `-1` must land on the last item rather than
 * being clamped to the first.
 *
 * @param {number} index requested index, possibly out of range or negative
 * @param {number} total list length
 * @returns {number} a usable index, or 0 when the list is empty
 */
export function wrapIndex(index, total) {
  const size = Math.max(0, Math.trunc(Number(total) || 0));
  if (size === 0) return 0;
  const value = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
  return ((value % size) + size) % size;
}

/**
 * The session id a gallery scope filters by.
 *
 * `current` is only meaningful inside a conversation. A panel shown without a
 * bound session (a global view, or before the sidebar knows its tab) falls back
 * to the whole library rather than to an empty list, because an empty gallery
 * reads as data loss.
 *
 * @param {'current'|'all'|string} scope
 * @param {string|undefined|null} sessionId
 * @returns {string|undefined} the session to filter by, or undefined for all
 */
export function scopeSessionId(scope, sessionId) {
  if (scope !== 'current') return undefined;
  const value = typeof sessionId === 'string' ? sessionId.trim() : '';
  return value === '' ? undefined : value;
}

/**
 * Resolve the scope a panel should actually show.
 * @param {'current'|'all'|string} scope requested scope
 * @param {string|undefined|null} sessionId bound session
 * @returns {'current'|'all'}
 */
export function effectiveGalleryScope(scope, sessionId) {
  return scope === 'current' && scopeSessionId('current', sessionId) !== undefined ? 'current' : 'all';
}
