/**
 * Small durable JSON helpers.
 *
 * Every write goes through a temp file + rename so a crash cannot leave a
 * truncated index behind, and every read treats "missing" and "corrupt" the
 * same way: the caller gets its fallback and the plugin keeps running.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Read and parse a JSON file.
 * @param {string} path
 * @param {unknown} fallback value returned when the file is missing or unparseable.
 * @param {(error: Error) => void} [onError] notified for corrupt (not missing) files.
 */
export async function readJson(path, fallback, onError) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' && onError) onError(error);
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    onError?.(error);
    return fallback;
  }
}

/**
 * Atomically write a JSON file, creating parent directories.
 * @param {string} path
 * @param {unknown} value
 */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/**
 * Serialize async work per key, so two concurrent saves of the same file cannot
 * interleave read-modify-write and lose one of them.
 */
export class SerialQueue {
  #tails = new Map();

  /**
   * Run `task` after every earlier task queued under the same key settles.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  run(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}

/** Clamp a number into an inclusive range, falling back when it is not finite. */
export function clamp(value, min, max, fallback = min) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Round to at most `digits` decimals without exponent notation surprises. */
export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
