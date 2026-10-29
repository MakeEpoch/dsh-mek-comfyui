/**
 * Plugin-scoped diagnostics.
 *
 * Two sinks on purpose: dsh's own logger for live debugging, and a file under
 * `~/.dsh/comfyui/logs/` because a systemd/journald deployment does not expose
 * plugin stdout. A failing sink never propagates — logging must not break the
 * feature it describes.
 */
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Strip anything token-shaped before a line reaches a sink. */
export function redact(value) {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    .replace(/\b[a-f0-9]{32,}\b/gi, '<redacted>');
}

/**
 * Build a level-tagged logger.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} [dir] directory for the file sink; omit to log to dsh only.
 * @returns {(level: 'debug'|'info'|'warn'|'error', message: string, detail?: unknown) => void}
 */
export function createLogger(ctx, dir) {
  let ready = false;
  let path = null;

  const fileSink = () => {
    if (ready) return path;
    ready = true;
    if (!dir) return null;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      path = join(dir, 'comfyui.log');
      try {
        if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
      } catch {
        /* no existing log, or rotation is not permitted: appending still works */
      }
    } catch {
      path = null;
    }
    return path;
  };

  const hostSink = (level) => {
    try {
      if (typeof ctx?.logger === 'function') {
        const sink = ctx.logger(level);
        if (typeof sink === 'function') return sink;
        if (sink && typeof sink[level] === 'function') return sink[level].bind(sink);
        return null;
      }
      const logger = ctx?.logger;
      if (logger && typeof logger[level] === 'function') return logger[level].bind(logger);
    } catch {
      /* a logger that throws is still a logger we do not need */
    }
    return null;
  };

  return (level, message, detail) => {
    if (level === 'debug' && process.env.DSH_COMFYUI_DEBUG !== '1') return;
    const extra = detail === undefined
      ? ''
      : ` ${typeof detail === 'string' ? detail : safeJson(detail)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [comfyui] ${redact(message)}${redact(extra)}\n`;
    const sink = fileSink();
    if (sink) {
      try {
        appendFileSync(sink, line);
      } catch {
        /* the file sink is best-effort */
      }
    }
    try {
      hostSink(level)?.(`[comfyui] ${redact(message)}${redact(extra)}`);
    } catch {
      /* same */
    }
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A no-op logger for unit tests and defensive fallbacks. */
export const silentLogger = () => {};
