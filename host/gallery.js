/**
 * The durable image library: an on-disk Job index plus the copied image files.
 *
 * This module knows nothing about ComfyUI or HTTP — it is pure file/JSON work so
 * it can be unit-tested without a server. Two invariants drive the design:
 *
 *  - the index is always written through `SerialQueue` + `writeJson`, so
 *    concurrent saves cannot interleave a read-modify-write and lose entries;
 *  - every path derived from an id is re-checked against `root`, so a crafted
 *    image id can never read or delete a file outside the gallery.
 *
 * `index.json` stays a plain Job array (CONTRACT §6): other tooling may read it.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { readJson, SerialQueue, writeJson } from './json-store.js';

/** Same-origin image endpoint the client renders (CONTRACT §2). */
const IMAGE_URL_PREFIX = '/api/dsh-comfyui/image?id=';
const MAX_NAME_LENGTH = 120;
const DEFAULT_MEDIA_TYPE = 'image/png';
const DAY_MS = 24 * 60 * 60 * 1000;

const MEDIA_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
});

/** A failure that carries a machine-readable `comfyui/*` code. */
export class GalleryError extends Error {
  /**
   * @param {string} code machine code, e.g. `comfyui/invalid`.
   * @param {string} message user-facing message (Chinese where the UI shows it).
   * @param {object} [detail] diagnostic payload.
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GalleryError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Strip anything that could escape the target directory or break a filename.
 *
 * Control characters and both path separators are removed rather than replaced,
 * the extension is preserved, and the whole thing is capped at 120 chars. A name
 * that reduces to nothing (or to a dot name) falls back to `image.png`.
 * @param {string} filename
 * @returns {string}
 */
export function sanitizeFilename(filename) {
  const raw = String(filename ?? '');
  // Drop control characters and path separators; also drop Windows-reserved chars.
  let name = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim();
  // A leading dot would hide the file and `..` is a traversal primitive.
  name = name.replace(/^\.+/, '');
  if (!name) return 'image.png';

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const safeExt = ext.slice(0, 16);
  const maxStem = Math.max(1, MAX_NAME_LENGTH - safeExt.length);
  const safeStem = (stem || 'image').slice(0, maxStem);
  const result = `${safeStem}${safeExt}`;
  return result && result !== '.' && result !== '..' ? result : 'image.png';
}

/** Guess a media type from the file extension. */
function mediaTypeFor(filename, fallback) {
  if (typeof fallback === 'string' && fallback.startsWith('image/')) return fallback;
  return MEDIA_TYPES[extname(String(filename ?? '')).toLowerCase()] ?? DEFAULT_MEDIA_TYPE;
}

/** Is `child` inside `parent`? Both must already be resolved. */
function isInside(parent, child) {
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(base);
}

/** Coerce an unknown value into a non-negative finite integer. */
function count(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

/** A fresh, fully-populated ImageFile. */
function makeImage({ jobId, filename, subfolder, bytes, mediaType, width, height, favorite }) {
  const id = randomUUID();
  return {
    id,
    jobId,
    filename,
    subfolder: String(subfolder ?? ''),
    width: count(width, 0),
    height: count(height, 0),
    bytes: count(bytes, 0),
    mediaType: mediaTypeFor(filename, mediaType),
    url: `${IMAGE_URL_PREFIX}${id}`,
    thumbUrl: `${IMAGE_URL_PREFIX}${id}`,
    createdAt: Date.now(),
    favorite: favorite === true,
  };
}

/**
 * Rebuild one ImageFile from possibly-partial input.
 *
 * Extra properties are dropped on purpose: the index stays exactly the shape in
 * CONTRACT §1, and derived fields (url/thumbUrl/mediaType) cannot drift.
 * @param {object} image
 * @param {string} jobId owning job id, used when the record has none.
 */
function normalizeImage(image, jobId) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) {
    throw new GalleryError('comfyui/invalid', '图片数据格式不正确');
  }
  const id = String(image.id ?? '').trim() || randomUUID();
  const filename = sanitizeFilename(image.filename);
  return {
    id,
    jobId: String(image.jobId ?? jobId),
    filename,
    subfolder: String(image.subfolder ?? ''),
    width: count(image.width, 0),
    height: count(image.height, 0),
    bytes: count(image.bytes, 0),
    mediaType: mediaTypeFor(filename, image.mediaType),
    url: typeof image.url === 'string' && image.url ? image.url : `${IMAGE_URL_PREFIX}${id}`,
    thumbUrl: typeof image.thumbUrl === 'string' && image.thumbUrl ? image.thumbUrl : `${IMAGE_URL_PREFIX}${id}`,
    createdAt: count(image.createdAt, Date.now()),
    favorite: image.favorite === true,
  };
}

/** Fill in fields a caller may have omitted, so the index stays uniform. */
function normalizeJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GalleryError('comfyui/invalid', '任务数据格式不正确');
  }
  const id = String(input.id ?? '').trim();
  if (!id) throw new GalleryError('comfyui/invalid', '任务缺少 id');
  if (!Array.isArray(input.images) || input.images.length === 0) {
    throw new GalleryError('comfyui/invalid', '任务必须包含至少一张图片');
  }
  const images = input.images.map((image) => normalizeImage(image, id));
  const createdAt = count(input.createdAt, Date.now());
  return {
    id,
    promptId: input.promptId ?? null,
    number: input.number ?? null,
    status: typeof input.status === 'string' ? input.status : 'succeeded',
    prompt: String(input.prompt ?? ''),
    negative: String(input.negative ?? ''),
    presetId: String(input.presetId ?? ''),
    presetName: String(input.presetName ?? ''),
    model: String(input.model ?? ''),
    width: count(input.width, 0),
    height: count(input.height, 0),
    steps: count(input.steps, 0),
    cfg: Number.isFinite(Number(input.cfg)) ? Number(input.cfg) : 0,
    sampler: String(input.sampler ?? ''),
    scheduler: String(input.scheduler ?? ''),
    seed: Number.isFinite(Number(input.seed)) ? Number(input.seed) : 0,
    batch: count(input.batch, images.length),
    createdAt,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    durationMs: input.durationMs ?? null,
    sessionId: input.sessionId ?? null,
    source: input.source === 'chat' || input.source === 'api' ? input.source : 'ui',
    progress: null,
    images,
    error: input.error && typeof input.error === 'object' ? input.error : null,
    favorite: input.favorite === true,
  };
}

export class Gallery {
  #root;
  #indexFile;
  #logger;
  #queue = new SerialQueue();
  #jobs = [];
  /** imageId -> image record, so `filePath`/`imageRecord` are O(1). */
  #images = new Map();
  #ready = false;
  #disposed = false;

  /**
   * @param {object} options
   * @param {string} options.root image directory, e.g. `~/.dsh/comfyui/gallery`.
   * @param {string} options.indexFile JSON path, e.g. `~/.dsh/comfyui/index.json`.
   * @param {(level: string, message: string, detail?: unknown) => void} [options.logger]
   */
  constructor({ root, indexFile, logger = () => {} } = {}) {
    if (!root || typeof root !== 'string') {
      throw new GalleryError('comfyui/invalid', '图库目录未配置');
    }
    if (!indexFile || typeof indexFile !== 'string') {
      throw new GalleryError('comfyui/invalid', '图库索引文件未配置');
    }
    this.#root = resolve(root);
    this.#indexFile = isAbsolute(indexFile) ? indexFile : resolve(indexFile);
    this.#logger = typeof logger === 'function' ? logger : () => {};
  }

  /** Absolute image directory. */
  get root() {
    return this.#root;
  }

  /** Absolute index file path. */
  get indexFile() {
    return this.#indexFile;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Load the index and make sure the image directory exists. Idempotent. */
  async init() {
    this.#assertUsable();
    if (this.#ready) return;
    try {
      await mkdir(this.#root, { recursive: true });
    } catch (error) {
      throw new GalleryError('comfyui/invalid', `无法创建图库目录：${this.#root}`, {
        reason: error?.code ?? String(error),
      });
    }
    const loaded = await readJson(this.#indexFile, null, (error) => {
      this.#logger('warn', '图库索引损坏，已按空图库启动', error?.message ?? String(error));
    });
    if (loaded === null) {
      // Missing file is normal on a fresh install; a corrupt one is not.
      this.#jobs = [];
    } else if (Array.isArray(loaded)) {
      this.#jobs = loaded.filter((job) => job && typeof job === 'object' && Array.isArray(job.images));
    } else if (loaded && typeof loaded === 'object' && Array.isArray(loaded.jobs)) {
      // Tolerate an older `{ jobs: [] }` wrapper.
      this.#jobs = loaded.jobs.filter((job) => job && typeof job === 'object' && Array.isArray(job.images));
    } else {
      this.#logger('warn', '图库索引格式不正确，已按空图库启动');
      this.#jobs = [];
    }
    this.#jobs.sort((a, b) => count(b.createdAt) - count(a.createdAt));
    this.#reindex();
    this.#ready = true;
  }

  /**
   * Point the library at a different image directory, keeping the index.
   * Existing image files are not moved; callers switch directories deliberately.
   * @param {string} root
   */
  async setRoot(root) {
    this.#assertUsable();
    if (!root || typeof root !== 'string') {
      throw new GalleryError('comfyui/invalid', '图库目录不能为空');
    }
    const next = resolve(root);
    try {
      await mkdir(next, { recursive: true });
    } catch (error) {
      throw new GalleryError('comfyui/invalid', `无法创建图库目录：${next}`, {
        reason: error?.code ?? String(error),
      });
    }
    this.#root = next;
  }

  /** Release resources. Idempotent and safe before `init()`. */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#jobs = [];
    this.#images.clear();
    this.#ready = false;
  }

  // ---------------------------------------------------------------------- reads

  /**
   * Page through the library, newest first.
   * @param {{limit?: number, offset?: number, query?: string, favorite?: boolean, status?: string}} [options]
   * @returns {Promise<{items: object[], total: number}>}
   */
  async list({ limit = 30, offset = 0, query = '', favorite = false, status, sessionId } = {}) {
    this.#assertUsable();
    const needle = String(query ?? '').trim().toLowerCase();
    const statusFilter = typeof status === 'string' && status.trim() ? status.trim() : null;
    // `undefined`/`null` means "the whole library"; a string means "only this
    // conversation". An empty string is treated as absent, not as a filter for
    // jobs that have no session, because that is never what a caller means.
    const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;

    const matches = this.#visibleJobs().filter((job) => {
      if (session !== null && job.sessionId !== session) return false;
      if (statusFilter && job.status !== statusFilter) return false;
      if (favorite === true && job.favorite !== true) return false;
      if (!needle) return true;
      if (String(job.prompt ?? '').toLowerCase().includes(needle)) return true;
      return job.images.some((image) => String(image?.filename ?? '').toLowerCase().includes(needle));
    });

    const start = count(offset, 0);
    const size = Math.max(0, count(limit, 30));
    return {
      items: matches.slice(start, start + size).map((job) => clone(job)),
      total: matches.length,
    };
  }

  /** One job by id, or null. */
  async get(id) {
    this.#assertUsable();
    const key = String(id ?? '').trim();
    if (!key) return null;
    const job = this.#jobs.find((entry) => entry.id === key);
    return job ? clone(job) : null;
  }

  /** Whether a job id is present. */
  async has(id) {
    this.#assertUsable();
    const key = String(id ?? '').trim();
    return Boolean(key) && this.#jobs.some((entry) => entry.id === key);
  }

  /** Resolve an image id to its absolute path; null when unknown. */
  async filePath(imageId) {
    this.#assertUsable();
    const id = String(imageId ?? '');
    if (!id.trim()) return null;
    if (id.includes('\0') || id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new GalleryError('comfyui/invalid', '图片 id 不合法', { imageId: id.slice(0, 80) });
    }
    const image = this.#images.get(id);
    if (!image) return null;
    const target = resolve(this.#root, String(image.jobId), String(image.filename));
    if (!isInside(this.#root, target)) {
      throw new GalleryError('comfyui/invalid', '图片路径超出图库目录', { imageId: id });
    }
    // Symlinks are the one way a path that looks inside can point outside.
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(this.#root), realpath(target)]);
      if (!isInside(realRoot, realTarget)) {
        throw new GalleryError('comfyui/invalid', '图片路径超出图库目录', { imageId: id });
      }
      return realTarget;
    } catch (error) {
      if (error instanceof GalleryError) throw error;
      if (error?.code === 'ENOENT') return target;
      return target;
    }
  }

  /** The ImageFile record for an id, or null. */
  async imageRecord(imageId) {
    this.#assertUsable();
    const id = String(imageId ?? '').trim();
    if (!id) return null;
    const image = this.#images.get(id);
    return image ? clone(image) : null;
  }

  // --------------------------------------------------------------------- writes

  /**
   * Insert or replace a finished job. Requires a non-empty `images[]`.
   * @param {object} job
   * @returns {Promise<object>} the stored job
   */
  async save(job) {
    this.#assertUsable();
    const normalized = normalizeJob(job);
    return this.#mutate(async () => {
      const index = this.#jobs.findIndex((entry) => entry.id === normalized.id);
      if (index >= 0) this.#jobs[index] = normalized;
      else this.#jobs.push(normalized);
      this.#sortJobs();
      this.#reindex();
      return clone(normalized);
    });
  }

  /**
   * Copy image bytes into `<root>/<jobId>/<safeName>` and register the record.
   *
   * The record is attached to the job when it already exists in the index; when
   * the caller has not saved the job yet it is still resolvable by `filePath` in
   * this process, and the following `save(job)` persists it with the job.
   * @param {string} jobId
   * @param {{filename: string, subfolder?: string, bytes: Buffer|Uint8Array, mediaType?: string, width?: number, height?: number}} input
   * @returns {Promise<object>} ImageFile
   */
  async addImage(jobId, { filename, subfolder = '', bytes, mediaType, width, height } = {}) {
    this.#assertUsable();
    const jobKey = String(jobId ?? '').trim();
    if (!jobKey) throw new GalleryError('comfyui/invalid', '缺少任务 id');
    if (jobKey.includes('/') || jobKey.includes('\\') || jobKey.includes('..') || jobKey.includes('\0')) {
      throw new GalleryError('comfyui/invalid', '任务 id 不合法');
    }
    if (!bytes || typeof bytes.length !== 'number') {
      throw new GalleryError('comfyui/invalid', '图片数据不能为空');
    }
    const safeName = sanitizeFilename(filename);
    const dir = join(this.#root, jobKey);
    const target = resolve(dir, safeName);
    if (!isInside(this.#root, target)) {
      throw new GalleryError('comfyui/invalid', '图片路径超出图库目录');
    }

    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(target, buffer, { mode: 0o600 });
    } catch (error) {
      throw new GalleryError('comfyui/invalid', `无法写入图片文件：${safeName}`, {
        reason: error?.code ?? String(error),
      });
    }

    const image = makeImage({
      jobId: jobKey,
      filename: safeName,
      subfolder,
      bytes: buffer.length,
      mediaType,
      width,
      height,
      favorite: false,
    });

    await this.#mutate(async () => {
      const job = this.#jobs.find((entry) => entry.id === jobKey);
      if (job) {
        job.images = [...job.images.filter((entry) => entry.id !== image.id), image];
      }
      this.#images.set(image.id, image);
    });
    return clone(image);
  }

  /**
   * Shallow-merge a patch into a stored job.
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async update(id, patch) {
    this.#assertUsable();
    const key = String(id ?? '').trim();
    if (!key) return null;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new GalleryError('comfyui/invalid', '更新内容格式不正确');
    }
    return this.#mutate(async () => {
      const job = this.#jobs.find((entry) => entry.id === key);
      if (!job) return null;
      const next = { ...job, ...patch, id: job.id };
      if (Array.isArray(patch.images)) {
        if (patch.images.length === 0) {
          throw new GalleryError('comfyui/invalid', '任务必须包含至少一张图片');
        }
        next.images = patch.images.map((image) => normalizeImage(image, job.id));
      }
      next.favorite = next.favorite === true;
      Object.assign(job, next);
      this.#reindex();
      return clone(job);
    });
  }

  /**
   * Delete jobs by id, files first, then index entries.
   * @param {string[]} ids
   * @returns {Promise<number>} how many index entries were removed
   */
  async delete(ids) {
    this.#assertUsable();
    const keys = new Set(
      (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim()).filter(Boolean),
    );
    if (!keys.size) return 0;

    const doomed = this.#jobs.filter((job) => keys.has(job.id));
    if (!doomed.length) return 0;

    // Files first: an index entry whose files are gone is worse than the reverse.
    for (const job of doomed) {
      for (const image of job.images) {
        await this.#removeFile(job.id, image.filename);
      }
      // Remove the per-job directory. The id came from the index file, so it is
      // re-checked against root before a recursive delete is attempted.
      const dir = resolve(this.#root, String(job.id));
      if (!isInside(this.#root, dir) || dir === this.#root) {
        this.#logger('warn', '跳过图库目录之外的删除目标', { jobId: job.id });
        continue;
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        this.#logger('warn', `删除图库目录失败：${job.id}`, error?.message ?? String(error));
      }
    }

    return this.#mutate(async () => {
      this.#jobs = this.#jobs.filter((job) => !keys.has(job.id));
      this.#reindex();
      return doomed.length;
    });
  }

  /** Aggregate size of the library. */
  /**
   * Totals for one scope, plus the whole-library totals.
   *
   * The gallery defaults to the current conversation, so the switcher has to be
   * able to say how much is outside it ("当前对话 3 · 全部 12") without a second
   * round trip. Both halves are computed from the in-memory index, so this stays
   * one cheap pass.
   *
   * @param {{ sessionId?: string }} [options] restrict the primary totals
   */
  async stats({ sessionId } = {}) {
    this.#assertUsable();
    const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
    const tally = (jobs) => {
      let bytes = 0;
      let favorites = 0;
      for (const job of jobs) {
        if (job.favorite === true) favorites += 1;
        for (const image of job.images) bytes += count(image?.bytes, 0);
      }
      return { count: jobs.length, bytes, favorites };
    };
    const all = this.#visibleJobs();
    const scoped = session === null ? all : all.filter((job) => job.sessionId === session);
    return { ...tally(scoped), scope: session === null ? 'all' : 'session', all: tally(all) };
  }

  /**
   * Remove old jobs and trim the library down to `maxItems`.
   *
   * Favorites are never removed. `retentionDays <= 0` disables the age rule;
   * `maxItems <= 0` disables the size rule.
   * @param {{retentionDays?: number, maxItems?: number, dryRun?: boolean}} [options]
   * @returns {Promise<{removed: number, bytes: number}>}
   */
  async prune({ retentionDays = 0, maxItems = 0, dryRun = false } = {}) {
    this.#assertUsable();
    const days = Number(retentionDays);
    const limit = Number(maxItems);
    const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * DAY_MS : null;
    const max = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;

    const sorted = this.#visibleJobs().slice().sort((a, b) => count(a.createdAt) - count(b.createdAt));
    const doomed = new Map();

    if (cutoff !== null) {
      for (const job of sorted) {
        if (job.favorite === true) continue;
        if (count(job.createdAt) < cutoff) doomed.set(job.id, job);
      }
    }

    if (max > 0) {
      let remaining = sorted.length - doomed.size;
      for (const job of sorted) {
        if (remaining <= max) break;
        if (doomed.has(job.id)) continue;
        if (job.favorite === true) continue;
        doomed.set(job.id, job);
        remaining -= 1;
      }
    }

    let removed = 0;
    let bytes = 0;
    for (const job of doomed.values()) {
      removed += 1;
      for (const image of job.images) bytes += count(image?.bytes, 0);
    }
    if (dryRun || removed === 0) return { removed, bytes };

    await this.delete([...doomed.keys()]);
    return { removed, bytes };
  }

  // -------------------------------------------------------------------- internals

  /** Reject use after `dispose()`. */
  #assertUsable() {
    if (this.#disposed) {
      throw new GalleryError('comfyui/invalid', '图库已关闭');
    }
  }

  /** Jobs that carry at least one image, newest first (CONTRACT gallery.list). */
  #visibleJobs() {
    return this.#jobs.filter((job) => Array.isArray(job.images) && job.images.length > 0);
  }

  #sortJobs() {
    this.#jobs.sort((a, b) => count(b.createdAt) - count(a.createdAt));
  }

  /** Rebuild the image lookup after any index change. */
  #reindex() {
    this.#images.clear();
    for (const job of this.#jobs) {
      for (const image of job.images) {
        if (!image || typeof image !== 'object') continue;
        if (!image.jobId) image.jobId = job.id;
        this.#images.set(image.id, image);
      }
    }
  }

  /** Best-effort file removal; ENOENT is normal, other failures are logged. */
  async #removeFile(jobId, filename) {
    const target = resolve(this.#root, String(jobId), String(filename));
    if (!isInside(this.#root, target)) {
      this.#logger('warn', '跳过图库目录之外的删除目标', { jobId });
      return;
    }
    try {
      await rm(target, { force: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      this.#logger('warn', `删除图片文件失败：${filename}`, error?.message ?? String(error));
    }
  }

  /**
   * Serialize a read-modify-write of the index, then persist it atomically.
   * The in-memory state is only committed after a successful write, so a failed
   * write leaves memory consistent with what is on disk.
   * @template T
   * @param {() => Promise<T>} apply
   * @returns {Promise<T>}
   */
  async #mutate(apply) {
    return this.#queue.run(this.#indexFile, async () => {
      const previousJobs = this.#jobs.map((job) => clone(job));
      const previousImages = new Map(this.#images);
      try {
        const result = await apply();
        await writeJson(this.#indexFile, this.#jobs);
        return result;
      } catch (error) {
        this.#jobs = previousJobs;
        this.#images = previousImages;
        throw error;
      }
    });
  }
}

/** Deep-ish copy so callers cannot mutate stored records. */
function clone(value) {
  return structuredClone(value);
}
