/**
 * Plugin Config schema and its normalizer.
 *
 * Same two-mark pattern the other workspace plugins use, because dsh's Settings
 * service only projects fields underneath a `volatile` node:
 *   .role('volatile')          -> serialized meta the Settings form reads
 *   .extra('volatile', true)   -> the runtime value becomes a live reference
 * so every user-editable field carries both, and `resolveConfig` unwraps the
 * references back into plain values for the code that needs them.
 *
 * The token is `role('secret')`: the Settings controller never returns it, only
 * whether one is stored.
 */
import z from '@deepseek-ai/schemastery';

/** Samplers this plugin offers. A custom workflow may use anything ComfyUI knows. */
export const SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral', 'lms',
  'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_2m',
  'dpmpp_2m_sde', 'dpmpp_3m_sde', 'ddpm', 'lcm', 'uni_pc', 'res_multistep', 'res_2s',
];

/** Schedulers this plugin offers. */
export const SCHEDULERS = [
  'normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta', 'linear_quadratic', 'kl_optimal',
];

const bool = (description, def) => z
  .boolean()
  .default(def)
  .description(description)
  .role('volatile')
  .extra('volatile', true);

const str = (description, def) => z
  .string()
  .default(def)
  .description(description)
  .role('volatile')
  .extra('volatile', true);

const int = (description, def, min, max) => z
  .number()
  .min(min)
  .max(max)
  .default(def)
  .description(description)
  .role('volatile')
  .extra('volatile', true);

const num = (description, def, min, max) => z
  .number()
  .min(min)
  .max(max)
  .default(def)
  .description(description)
  .role('volatile')
  .extra('volatile', true);

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
export const DEFAULT_PRESET_ID = 'zimage-turbo';

export const Config = z.object({
  // ── 总开关 ───────────────────────────────────────────────────────────────
  enabled: bool('关闭后不再连接 ComfyUI、不再注册生成工具，但保留全部配置与图片库。', true),

  // ── 连接 ────────────────────────────────────────────────────────────────
  baseUrl: str('ComfyUI 服务地址，例如 http://127.0.0.1:8188 或局域网 http://192.168.1.20:8188。', DEFAULT_BASE_URL),
  authToken: z
    .string()
    .role('secret')
    .extra('volatile', true)
    .description('ComfyUI 设置了 --enable-api-key 或反向代理鉴权时填写的 token；写入后设置页不再回显。'),
  requestTimeoutSeconds: int('单次 HTTP 请求超时（秒），用于读取模型列表、队列与系统信息。', 20, 5, 120),
  generateTimeoutSeconds: int('单次生成的最长等待（秒）；超时只结束等待，不会取消 ComfyUI 上的任务。', 600, 30, 7200),
  pollIntervalMs: int('右侧栏可见时的刷新间隔（毫秒）。页面隐藏或收起时自动停止。', 2000, 1000, 10000),

  // ── 生成默认值 ───────────────────────────────────────────────────────────
  presetId: str('默认工作流预设。预设决定模型与节点结构，下面的尺寸/步数等只覆盖参数。', DEFAULT_PRESET_ID),
  width: int('默认出图宽度（像素）。', 1024, 64, 8192),
  height: int('默认出图高度（像素）。', 1024, 64, 8192),
  steps: int('默认采样步数。', 8, 1, 200),
  cfg: num('默认 CFG。Turbo/蒸馏模型通常为 1。', 1, 0, 30),
  sampler: z
    .union(SAMPLERS.map((value) => z.const(value)))
    .default('res_multistep')
    .description('默认采样器。')
    .role('volatile')
    .extra('volatile', true),
  scheduler: z
    .union(SCHEDULERS.map((value) => z.const(value)))
    .default('simple')
    .description('默认调度器。')
    .role('volatile')
    .extra('volatile', true),
  negativePrompt: str('默认负面提示词。留空表示使用预设内置的负面条件。', ''),
  promptPrefix: str('拼接在每次提示词前面的通用修饰（风格、质量词等）。留空表示不追加。', ''),
  seedMode: z
    .union([z.const('random'), z.const('fixed')])
    .default('random')
    .description('random：每次随机种子；fixed：固定使用下面的种子，便于复现。')
    .role('volatile')
    .extra('volatile', true),
  seed: int('固定模式使用的种子；-1 表示随机。', -1, -1, 2 ** 48),
  batch: int('默认一次生成的图片数量。', 1, 1, 8),

  // ── 对话集成 ─────────────────────────────────────────────────────────────
  autoAttachImages: bool('对话里生成完成后，把图片作为图片块回传给模型，模型可以直接看图。', true),
  autoOpenSidebar: bool('对话里生成完成后自动展开右侧栏，显示本次进度与结果。', false),
  notifyOnComplete: bool('后台任务完成时在右侧栏标记未读，不弹窗。', true),

  // ── 图库与存储 ───────────────────────────────────────────────────────────
  saveDir: str('图片库目录。留空使用 ~/.dsh/comfyui/gallery；填写绝对路径可放到大盘或 NAS 挂载点。', ''),
  retentionDays: int('自动清理多少天前的图片；0 表示不按时间清理。收藏的图片永不清理。', 0, 0, 3650),
  maxGalleryItems: int('图库最多保留多少个任务；超出后从最旧的开始清理，0 表示不限制。收藏的图片永不清理。', 0, 0, 100000),
});

/** Unwrap one volatile reference, tolerating both plain and referenced values. */
function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Turn parsed Config (whose fields are live volatile references) into plain
 * values, applying the schema defaults for anything missing or unusable.
 * @param {Record<string, unknown>} raw parsed Config or a partial patch.
 * @returns {Record<string, unknown>}
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const plain = {};
  for (const key of Object.keys(source)) plain[key] = unwrap(source[key]);
  const defaults = defaultsOf();
  const merged = { ...defaults, ...stripUndefined(plain) };
  return normalize(merged, defaults);
}

/** The schema defaults as plain values. */
export function resolveDefaults() {
  return defaultsOf();
}

let cachedDefaults = null;

function defaultsOf() {
  if (cachedDefaults) return cachedDefaults;
  const parsed = Config({});
  const plain = {};
  for (const key of Object.keys(parsed)) plain[key] = unwrap(parsed[key]);
  cachedDefaults = normalize(plain, plain);
  return cachedDefaults;
}

function stripUndefined(value) {
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) next[key] = item;
  }
  return next;
}

/** Coerce, clamp and validate. An unusable field falls back to its default. */
function normalize(value, defaults) {
  const number = (key, min, max) => {
    const candidate = Number(value[key]);
    if (!Number.isFinite(candidate)) return defaults[key];
    return Math.min(max, Math.max(min, Math.round(candidate)));
  };
  const decimal = (key, min, max) => {
    const candidate = Number(value[key]);
    if (!Number.isFinite(candidate)) return defaults[key];
    return Math.min(max, Math.max(min, Math.round(candidate * 100) / 100));
  };
  const text = (key) => (typeof value[key] === 'string' ? value[key].trim() : defaults[key]);
  const flag = (key) => (typeof value[key] === 'boolean' ? value[key] : defaults[key]);
  const oneOf = (key, allowed) => (allowed.includes(value[key]) ? value[key] : defaults[key]);

  const baseUrl = normalizeBaseUrl(text('baseUrl')) ?? DEFAULT_BASE_URL;

  return {
    enabled: flag('enabled'),
    baseUrl,
    authToken: typeof value.authToken === 'string' ? value.authToken : '',
    requestTimeoutSeconds: number('requestTimeoutSeconds', 5, 120),
    generateTimeoutSeconds: number('generateTimeoutSeconds', 30, 7200),
    pollIntervalMs: number('pollIntervalMs', 1000, 10000),

    presetId: text('presetId') || DEFAULT_PRESET_ID,
    width: number('width', 64, 8192),
    height: number('height', 64, 8192),
    steps: number('steps', 1, 200),
    cfg: decimal('cfg', 0, 30),
    sampler: oneOf('sampler', SAMPLERS),
    scheduler: oneOf('scheduler', SCHEDULERS),
    negativePrompt: typeof value.negativePrompt === 'string' ? value.negativePrompt : '',
    promptPrefix: typeof value.promptPrefix === 'string' ? value.promptPrefix : '',
    seedMode: oneOf('seedMode', ['random', 'fixed']),
    seed: number('seed', -1, 2 ** 48),
    batch: number('batch', 1, 8),

    autoAttachImages: flag('autoAttachImages'),
    autoOpenSidebar: flag('autoOpenSidebar'),
    notifyOnComplete: flag('notifyOnComplete'),

    saveDir: typeof value.saveDir === 'string' ? value.saveDir.trim() : '',
    retentionDays: number('retentionDays', 0, 3650),
    maxGalleryItems: number('maxGalleryItems', 0, 100000),
  };
}

/**
 * Accept `host:port` and `http://host:port/` alike; drop the trailing slash and
 * any `/api` suffix a user may have copied from a reverse proxy.
 * @param {string} input
 * @returns {string | null} normalized origin+path, or null when unusable.
 */
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/api$/i, '');
  return `${url.protocol}//${url.host}${path}`;
}
