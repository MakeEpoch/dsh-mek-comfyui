/**
 * dsh host entry: `dsh-mek-comfyui`.
 *
 * Cordis semantics this plugin relies on:
 *  - `Config` is read by the Settings service, so every user-editable field is
 *    `volatile` and the token is `role('secret')`;
 *  - a Settings write updates volatile Config without remounting, so the service
 *    re-reads the persisted form and re-applies it after each save;
 *  - `ctx.effect` gives the runtime one teardown path for every exit — disable,
 *    config edit, or dsh shutdown.
 *
 * Failure policy: a broken ComfyUI, a corrupt gallery index or a missing
 * Settings service must never take the plugin down, because the settings page is
 * exactly where a user fixes those problems. Every start step degrades and
 * logs; only a missing Connection carrier is fatal, since nothing can be served
 * without it.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Config, resolveConfig } from './config.js';
import { createLogger } from './log.js';
import { ComfyService } from './service.js';
import { installComfyIntegration } from './tools.js';
import { registerRpc } from './rpc.js';

export const name = 'dsh-comfyui';

/**
 * `connection` carries the RPC channel and is required. `webServer`,
 * `settings`, `configEditor`, `tools` and `systemPrompt` are reached through
 * `ctx.get` / `ctx.inject` so a minimal composition still runs with a degraded
 * panel instead of failing to activate.
 */
export const inject = ['connection'];

export { Config };

/**
 * Mount the ComfyUI bridge.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin Context
 * @param {Record<string, unknown>} raw parsed Config (fields are live volatile refs)
 */
export function apply(ctx, raw) {
  // dsh already ran this Config schema, so `raw` is the parsed output whose
  // fields are volatile references. Parsing it again throws (volatile schemas
  // reject an enclosing volatile path), so keep it and let resolveConfig unwrap.
  const initial = raw && typeof raw === 'object' ? raw : Config({});
  const dir = safeHomeDir();
  const logger = createLogger(ctx, dir ? join(dir, 'logs') : undefined);

  let service = null;
  let stopRpc = null;
  let disposed = false;

  const getService = () => service;
  const getSettings = () => (service ? service.config : resolveConfig(initial));

  ctx.effect(() => {
    const installTools = (scope) => {
      try {
        installComfyIntegration(scope, { getService, settings: getSettings, logger });
      } catch (error) {
        logger('error', `工具挂载失败：${error?.message ?? error}`);
      }
    };

    const start = async () => {
      try {
        service = new ComfyService({ ctx, logger, dir: dir ?? safeTempDir(), config: initial });
      } catch (error) {
        logger('error', `服务构造失败：${error?.message ?? error}`);
        return;
      }
      await service.start();
      if (disposed) return;
      try {
        const dispose = await registerRpc({ ctx, getService, logger });
        stopRpc = dispose;
      } catch (error) {
        // Without the carrier the panel cannot talk to us, but the model-facing
        // tools still work; report rather than throw.
        logger('error', `面板接口注册失败：${error?.message ?? error}`);
      }
      if (disposed) {
        await stopRpc?.();
        return;
      }
      installTools(ctx);
    };

    start().catch((error) => logger('error', `启动失败：${error?.message ?? error}`));

    return async () => {
      disposed = true;
      try {
        await stopRpc?.();
      } catch {
        /* teardown continues */
      }
      stopRpc = null;
      try {
        await service?.dispose();
      } catch (error) {
        logger('warn', `关闭失败：${error?.message ?? error}`);
      }
      service = null;
    };
  }, 'comfyui: bridge');
}

/** `~/.dsh/comfyui`, or null when the home directory cannot be resolved. */
function safeHomeDir() {
  try {
    const dir = dshHomePath('comfyui');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return null;
  }
}

/** Last-resort data directory so the plugin still works with an unwritable home. */
function safeTempDir() {
  const dir = join(process.env.TMPDIR ?? '/tmp', `dsh-comfyui-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return process.cwd();
  }
}

/** Kept for parity with the other workspace plugins' logging helpers. */
export function appendLog(path, line) {
  try {
    appendFileSync(path, line);
  } catch {
    /* logging must never break the feature */
  }
}
