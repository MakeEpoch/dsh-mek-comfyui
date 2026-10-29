/**
 * Settings read model, validation and the one write path.
 *
 * dsh has two edit surfaces and this plugin supports both:
 *  - the shipped "设置 → 插件 → 可配置插件" form, which dsh renders straight from
 *    this plugin's Config schema;
 *  - this plugin's own "设置 → ComfyUI" page, which needs live status, a
 *    connection test and model discovery, and therefore ships its own UI.
 *
 * Both persist through the profile's Cordis patch. This module owns the write
 * path so a bad value fails here with a readable message instead of becoming a
 * Loader error after the write.
 */
import { resolveConfig, normalizeBaseUrl } from './config.js';

/**
 * Fields the panel may write. Anything else in a patch is dropped rather than
 * rejected, so an older page cannot break on a field that was renamed.
 */
const EDITABLE = new Set([
  'enabled', 'baseUrl', 'authToken', 'requestTimeoutSeconds', 'generateTimeoutSeconds', 'pollIntervalMs',
  'presetId', 'width', 'height', 'steps', 'cfg', 'sampler', 'scheduler', 'negativePrompt', 'promptPrefix',
  'seedMode', 'seed', 'batch', 'autoAttachImages', 'autoOpenSidebar', 'notifyOnComplete',
  'saveDir', 'retentionDays', 'maxGalleryItems',
]);

export class SettingsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsUnavailableError';
    this.code = 'comfyui/settings-unavailable';
  }
}

/** Whether the panel is allowed to write a field. Exported for the schema test. */
export function isEditableField(field) {
  return EDITABLE.has(field);
}

/**
 * Find this plugin's profile entry id.
 *
 * Settings keys forms by entry id (the `id` of the bundle patch row), never by
 * package name, and Cordis may hand out a Context whose `.fiber` is a child of
 * the entry's runtime fiber — so identity alone is not enough and the fiber uid
 * is the reliable match.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{ ns: string, entry: object | null }}
 */
export function resolveSettingsEntry(ctx) {
  let entries = [];
  try {
    entries = ctx.get?.('configEditor')?.entries?.() ?? [];
  } catch {
    entries = [];
  }
  const nsOf = (entry) => {
    const value = entry?.options?.id;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const ownUid = ctx.fiber?.uid;
  const own = entries.find((entry) => {
    if (entry?.options?.name === 'dsh-mek-comfyui') return true;
    if (ownUid === undefined || !entry?.fiber) return false;
    return entry.fiber === ctx.fiber || entry.fiber.uid === ownUid;
  });
  const ownNs = nsOf(own);
  if (ownNs) return { ns: ownNs, entry: own };
  const byName = entries.find((entry) => entry?.options?.name === 'dsh-mek-comfyui');
  const byNameNs = nsOf(byName);
  if (byNameNs) return { ns: byNameNs, entry: byName };
  return { ns: 'comfyui', entry: null };
}

function requireSettings(ctx) {
  const settings = ctx.get?.('settings');
  if (!settings || typeof settings.update !== 'function') {
    throw new SettingsUnavailableError('dsh 的 Settings 服务未启用，无法保存设置；请改用「设置 → 插件」的配置表单。');
  }
  return settings;
}

/**
 * Describe the form so the panel can say whether dsh agrees it is editable.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function describeSettingsEntry(ctx) {
  const { ns, entry } = resolveSettingsEntry(ctx);
  const settings = ctx.get?.('settings');
  if (!settings || typeof settings.describe !== 'function') {
    return { entryId: ns, revision: undefined, readable: false, reason: 'settings-service-missing' };
  }
  try {
    const rows = settings.describe({ redactSecrets: true }) ?? [];
    const row = rows.find((item) => item?.ns === ns);
    if (!row) {
      return {
        entryId: ns,
        revision: undefined,
        readable: false,
        reason: 'entry-not-projected',
        entryFound: Boolean(entry),
        availableNs: rows.map((item) => item?.ns).filter(Boolean).slice(0, 40),
      };
    }
    return { entryId: ns, revision: row.revision, readable: true, secrets: row.secrets ?? [] };
  } catch (error) {
    return { entryId: ns, revision: undefined, readable: false, reason: 'describe-failed', message: String(error?.message ?? error) };
  }
}

/** The persisted form value, as Settings sees it in the profile patch. */
export function persistedFormValue(ctx) {
  const { ns } = resolveSettingsEntry(ctx);
  const settings = ctx.get?.('settings');
  if (!settings || typeof settings.describe !== 'function') return null;
  try {
    const row = (settings.describe({ redactSecrets: true }) ?? []).find((item) => item?.ns === ns);
    const value = row?.value;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Validate one panel edit and hand it to Settings.
 *
 * An empty `authToken` means "keep the stored one": the page never echoes the
 * secret back, so a blank box is not a request to clear it.
 *
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {Record<string, unknown>} options.patch raw form values
 * @param {number | undefined} options.expectedRevision revision the panel rendered
 * @returns {Promise<{ saved: true, entryId: string }>}
 */
export async function savePanelSettings({ ctx, patch, expectedRevision }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('没有收到任何设置');
  }
  const settings = requireSettings(ctx);
  const { ns } = resolveSettingsEntry(ctx);

  const clean = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!EDITABLE.has(field)) continue;
    if (field === 'authToken' && (value === undefined || value === null || !String(value).trim())) continue;
    clean[field] = value;
  }
  if (Object.keys(clean).length === 0) throw new TypeError('没有可保存的字段');

  validatePatch(clean);

  // Validate the merged value against the Config schema before it reaches the
  // profile, so a bad number or an unknown enum member fails here.
  resolveConfig(clean);
  await settings.update(ns, clean, expectedRevision);
  return { saved: true, entryId: ns };
}

/**
 * Reset every editable field to its schema default.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {number | undefined} options.expectedRevision
 */
export async function resetPanelSettings({ ctx, expectedRevision }) {
  const settings = requireSettings(ctx);
  const { ns } = resolveSettingsEntry(ctx);
  await settings.replace(ns, {}, expectedRevision);
  return { saved: true, entryId: ns };
}

/** Field-level checks that produce a message a user can act on. */
function validatePatch(patch) {
  if ('baseUrl' in patch) {
    if (typeof patch.baseUrl !== 'string' || !normalizeBaseUrl(patch.baseUrl)) {
      throw new TypeError('ComfyUI 地址格式不正确，请填写类似 http://127.0.0.1:8188 的地址');
    }
  }
  if ('authToken' in patch && typeof patch.authToken !== 'string') {
    throw new TypeError('token 必须是字符串');
  }
  const numeric = {
    requestTimeoutSeconds: [5, 120, '请求超时'],
    generateTimeoutSeconds: [30, 7200, '生成超时'],
    pollIntervalMs: [1000, 10000, '刷新间隔'],
    width: [64, 8192, '宽度'],
    height: [64, 8192, '高度'],
    steps: [1, 200, '步数'],
    cfg: [0, 30, 'CFG'],
    seed: [-1, 2 ** 48, '种子'],
    batch: [1, 8, '批量'],
    retentionDays: [0, 3650, '保留天数'],
    maxGalleryItems: [0, 100000, '图库上限'],
  };
  for (const [field, [min, max, label]] of Object.entries(numeric)) {
    if (!(field in patch)) continue;
    const value = Number(patch[field]);
    if (!Number.isFinite(value)) throw new TypeError(`${label}必须是数字`);
    if (value < min || value > max) throw new TypeError(`${label}必须在 ${min} 到 ${max} 之间`);
  }
  for (const field of ['enabled', 'autoAttachImages', 'autoOpenSidebar', 'notifyOnComplete']) {
    if (field in patch && typeof patch[field] !== 'boolean') throw new TypeError('开关值必须是布尔值');
  }
  if ('seedMode' in patch && !['random', 'fixed'].includes(patch.seedMode)) {
    throw new TypeError('未知的种子模式');
  }
  if ('saveDir' in patch && typeof patch.saveDir !== 'string') {
    throw new TypeError('图库目录必须是字符串');
  }
  if ('presetId' in patch && (typeof patch.presetId !== 'string' || !patch.presetId.trim())) {
    throw new TypeError('默认预设不能为空');
  }
  for (const field of ['negativePrompt', 'promptPrefix']) {
    if (field in patch && typeof patch[field] !== 'string') throw new TypeError('提示词必须是字符串');
    if (field in patch && patch[field].length > 8000) throw new TypeError('提示词过长（上限 8000 字符）');
  }
}
