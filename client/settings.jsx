/**
 * 设置 → ComfyUI.
 *
 * Five tabs over one read model: 连接 / 模型 / 预设 / 生成默认值 / 图库与存储.
 * The Host owns the truth (`settings.get` → `settings.update` with
 * `expectedRevision`); this page keeps the user's unsaved draft in local state
 * and never clears it on a failed save, so a revision conflict costs a reload,
 * not the edit.
 */
import * as React from 'react';
import { installStyles } from './styles.js';
import { isConflict, isOffline } from './rpc.js';
import {
  clampNumber,
  formatBytes,
  formatCount,
  modeLabel,
  parseWorkflowJson,
  ratioHint,
  validateSettingsDraft,
} from './format.js';

/** localStorage key for the selected settings tab. */
const TAB_STORAGE_KEY = 'dsh-comfyui:tab';
/** Tab ids in display order; the first is the fallback. */
const TABS = ['connection', 'models', 'presets', 'generation', 'storage'];
/** Localised labels, kept beside the ids so the tab strip and panels agree. */
const TAB_LABELS = {
  connection: '连接',
  models: '模型',
  presets: '预设',
  generation: '生成默认值',
  storage: '图库与存储',
};
/** Fixed sampler list offered by the generate form (CONTRACT §2 tool args). */
export const SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms',
  'dpmpp_2s_ancestral', 'dpmpp_2m', 'dpmpp_3m_sde', 'res_multistep', 'ddpm', 'uni_pc',
];
/** Fixed scheduler list. */
export const SCHEDULERS = [
  'normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta',
];
/** Quick size presets with their aspect hint. */
const QUICK_SIZES = [
  [512, 512, '512 方图'],
  [768, 768, '768 方图'],
  [1024, 1024, '1024 方图'],
  [1328, 1328, '1328 方图'],
];
/** Model folder keys in display order; `upscale_models` is fetched but not edited. */
const MODEL_GROUPS = [
  ['checkpoints', 'Checkpoints'],
  ['diffusion_models', 'Diffusion Models'],
  ['text_encoders', 'Text Encoders'],
  ['vae', 'VAE'],
  ['loras', 'LoRAs'],
];
/** Settings fields whose controls are numeric inputs; they round-trip as strings. */
const NUMBER_FIELDS = new Set([
  'requestTimeoutSeconds', 'generateTimeoutSeconds', 'pollIntervalMs',
  'width', 'height', 'steps', 'cfg', 'seed', 'batch',
  'retentionDays', 'maxGalleryItems',
]);

/** Read the remembered tab, falling back when storage is unavailable. */
function readStoredTab() {
  try {
    const value = globalThis.localStorage?.getItem(TAB_STORAGE_KEY);
    return TABS.includes(value) ? value : 'connection';
  } catch {
    return 'connection';
  }
}

/** Remember the tab; a sandboxed storage must not break the page. */
function storeTab(id) {
  try { globalThis.localStorage?.setItem(TAB_STORAGE_KEY, id); } catch { /* private mode */ }
}

/**
 * Turn a Host settings read model into an editable draft.
 *
 * Numeric fields become strings so a half-typed value ("10", "", "1e") never
 * collapses to NaN mid-edit; the save path converts them back.
 * @param settings the `settings` object from `settings.get`.
 */
export function draftFromSettings(settings) {
  const source = settings !== null && typeof settings === 'object' ? settings : {};
  const draft = {};
  for (const field of NUMBER_FIELDS) {
    const value = source[field];
    draft[field] = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  }
  draft.baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl : '';
  draft.authToken = '';
  draft.presetId = typeof source.presetId === 'string' ? source.presetId : '';
  draft.sampler = typeof source.sampler === 'string' ? source.sampler : 'euler';
  draft.scheduler = typeof source.scheduler === 'string' ? source.scheduler : 'normal';
  draft.negativePrompt = typeof source.negativePrompt === 'string' ? source.negativePrompt : '';
  draft.promptPrefix = typeof source.promptPrefix === 'string' ? source.promptPrefix : '';
  draft.seedMode = source.seedMode === 'fixed' ? 'fixed' : 'random';
  draft.saveDir = typeof source.saveDir === 'string' ? source.saveDir : '';
  draft.autoAttachImages = source.autoAttachImages !== false;
  draft.autoOpenSidebar = source.autoOpenSidebar !== false;
  draft.notifyOnComplete = source.notifyOnComplete === true;
  return draft;
}

/**
 * A draft to edit when `settings.get` failed entirely.
 *
 * Without it a broken settings service would render empty tabs and leave the
 * user no way to correct the address that is causing the failure. The values
 * mirror the Host's own defaults; the Host still validates whatever is saved.
 */
export function fallbackDraft() {
  return draftFromSettings({
    baseUrl: '',
    requestTimeoutSeconds: 30,
    generateTimeoutSeconds: 300,
    pollIntervalMs: 2000,
    presetId: '',
    width: 1024,
    height: 1024,
    steps: 8,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'normal',
    negativePrompt: '',
    promptPrefix: '',
    seedMode: 'random',
    seed: 0,
    batch: 1,
    autoAttachImages: true,
    autoOpenSidebar: true,
    notifyOnComplete: false,
    saveDir: '',
    retentionDays: 30,
    maxGalleryItems: 500,
  });
}

/**
 * Convert a draft into the patch the Host accepts.
 *
 * An empty `authToken` means "keep the stored token" and is therefore omitted
 * rather than sent as an empty string, which the Host would treat as clearing.
 * @param draft the editable draft.
 */
export function patchFromDraft(draft) {
  const patch = {
    baseUrl: String(draft.baseUrl ?? '').trim(),
    requestTimeoutSeconds: Number(draft.requestTimeoutSeconds),
    generateTimeoutSeconds: Number(draft.generateTimeoutSeconds),
    pollIntervalMs: Number(draft.pollIntervalMs),
    presetId: String(draft.presetId ?? ''),
    width: Number(draft.width),
    height: Number(draft.height),
    steps: Number(draft.steps),
    cfg: Number(draft.cfg),
    sampler: String(draft.sampler ?? ''),
    scheduler: String(draft.scheduler ?? ''),
    negativePrompt: String(draft.negativePrompt ?? ''),
    promptPrefix: String(draft.promptPrefix ?? ''),
    seedMode: draft.seedMode === 'fixed' ? 'fixed' : 'random',
    seed: Number(draft.seed),
    batch: Number(draft.batch),
    autoAttachImages: Boolean(draft.autoAttachImages),
    autoOpenSidebar: Boolean(draft.autoOpenSidebar),
    notifyOnComplete: Boolean(draft.notifyOnComplete),
    saveDir: String(draft.saveDir ?? '').trim(),
    retentionDays: Number(draft.retentionDays),
    maxGalleryItems: Number(draft.maxGalleryItems),
  };
  const token = typeof draft.authToken === 'string' ? draft.authToken.trim() : '';
  if (token !== '') patch.authToken = token;
  return patch;
}

/** A labelled form control column. */
export function Field({ label, hint, children }) {
  return (
    <label className="cfq-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** A checkbox row with a longer explanation. */
export function Check({ label, hint, checked, onChange, disabled }) {
  return (
    <label className="cfq-check">
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}{hint ? <><br /><span className="cfq-hint">{hint}</span></> : null}</span>
    </label>
  );
}

/** A pill with a semantic tone and optional leading dot. */
export function Pill({ tone = 'muted', dot = true, children }) {
  return <span className="cfq-pill" data-tone={tone}>{dot ? <span className="cfq-dot" aria-hidden="true" /> : null}{children}</span>;
}

/** A determinate or animated progress bar. */
export function Progress({ percent, indeterminate, label, right }) {
  const value = clampNumber(percent, 0, 100);
  return (
    <div className="cfq-prog">
      <div
        className="cfq-progTrack"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(value)}
        aria-label={label || '生成进度'}
      >
        <div className="cfq-progFill" data-indeterminate={indeterminate ? 'true' : 'false'} style={indeterminate ? undefined : { width: `${value}%` }} />
      </div>
      {label || right ? (
        <div className="cfq-progMeta"><span>{label || ''}</span><span>{right || ''}</span></div>
      ) : null}
    </div>
  );
}

/**
 * Render the settings section.
 *
 * @param props.rpc the shared RPC wrapper from `client/index.js`.
 * @param props.notify optional toast bridge; the page works without one.
 */
export function SettingsPage({ rpc, notify }) {
  const [tab, setTab] = React.useState(readStoredTab);
  const [model, setModel] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [defaults, setDefaults] = React.useState(null);
  const [presets, setPresets] = React.useState([]);
  const [revision, setRevision] = React.useState(null);
  const [readable, setReadable] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [saveNotice, setSaveNotice] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState({});
  const [status, setStatus] = React.useState(null);
  const [statusError, setStatusError] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [folders, setFolders] = React.useState(null);
  const [foldersError, setFoldersError] = React.useState('');
  const [foldersLoading, setFoldersLoading] = React.useState(false);
  const [stats, setStats] = React.useState(null);
  const [prunePlan, setPrunePlan] = React.useState(null);
  const [pruning, setPruning] = React.useState(false);
  const [busyPreset, setBusyPreset] = React.useState('');

  const alive = React.useRef(true);
  /** One controller for the whole page; every request rides it. */
  const pageAbort = React.useRef(null);
  /** The request-level controllers, aborted individually and on unmount. */
  const requestAborts = React.useRef(new Set());

  React.useEffect(() => {
    // Reference-counted: the tag disappears when the last consumer unmounts.
    const release = installStyles();
    return release;
  }, []);

  /** Run one RPC under the page's lifetime; resolves to undefined when aborted. */
  const run = React.useCallback(async (method, payload) => {
    const controller = new AbortController();
    const page = pageAbort.current;
    if (page !== null) {
      if (page.signal.aborted) throw new DOMException('aborted', 'AbortError');
      page.signal.addEventListener('abort', () => { try { controller.abort(); } catch { /* settled */ } }, { once: true });
    }
    requestAborts.current.add(controller);
    try {
      return await rpc.call(method, payload, controller.signal);
    } finally {
      requestAborts.current.delete(controller);
    }
  }, [rpc]);

  /** Load the settings read model into draft + presets, preserving nothing. */
  const load = React.useCallback(async ({ keepDraft = false } = {}) => {
    setLoading(true);
    setLoadError('');
    try {
      const value = await run('settings.get', {});
      if (!alive.current || value === undefined) return;
      const settings = value?.settings ?? {};
      setModel(settings);
      setDefaults(value?.defaults ?? null);
      setPresets(Array.isArray(value?.presets) ? value.presets : []);
      setRevision(typeof value?.revision === 'number' ? value.revision : null);
      setReadable(value?.readable !== false);
      if (!keepDraft) setDraft(draftFromSettings(settings));
      if (value?.readable === false) setLoadError(String(value?.reason ?? '当前 profile 无法保存插件设置'));
    } catch (error) {
      if (!alive.current || error?.name === 'AbortError') return;
      setLoadError(error?.message || '读取设置失败');
      // Keep the page editable: a user who mistyped the address must still be
      // able to correct it even though the read failed.
      setDraft((current) => current ?? fallbackDraft());
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [run]);

  /** Poll the live connection status; used by the 连接 tab's pill. */
  const loadStatus = React.useCallback(async () => {
    try {
      const value = await run('status.get', {});
      if (!alive.current || value === undefined) return;
      setStatus(value);
      setStatusError('');
    } catch (error) {
      if (!alive.current || error?.name === 'AbortError') return;
      setStatus(null);
      setStatusError(error?.message || '无法读取连接状态');
    }
  }, [run]);

  /** Load the model folder lists. */
  const loadModels = React.useCallback(async ({ refresh = false } = {}) => {
    setFoldersLoading(true);
    setFoldersError('');
    try {
      const value = await run('models.list', refresh ? { refresh: true } : {});
      if (!alive.current || value === undefined) return;
      if (value?.ok === false) {
        setFoldersError(String(value?.error?.message ?? '无法读取模型列表'));
        setFolders(null);
      } else {
        setFolders(value?.folders ?? null);
      }
    } catch (error) {
      if (!alive.current || error?.name === 'AbortError') return;
      setFoldersError(error?.message || '无法读取模型列表');
    } finally {
      if (alive.current) setFoldersLoading(false);
    }
  }, [run]);

  /** Load gallery totals for the storage tab. */
  const loadStats = React.useCallback(async () => {
    try {
      const value = await run('gallery.stats', {});
      if (!alive.current || value === undefined) return;
      setStats(value ?? null);
    } catch {
      // The storage tab shows unknown totals; a missing stats call is not fatal.
      if (alive.current) setStats(null);
    }
  }, [run]);

  // Page lifetime: one controller, aborted on unmount, plus the initial reads.
  React.useEffect(() => {
    alive.current = true;
    pageAbort.current = new AbortController();
    load().catch(() => {});
    loadStatus().catch(() => {});
    loadStats().catch(() => {});
    return () => {
      alive.current = false;
      const page = pageAbort.current;
      pageAbort.current = null;
      try { page?.abort(); } catch { /* already aborted */ }
      for (const controller of requestAborts.current) { try { controller.abort(); } catch { /* settled */ } }
      requestAborts.current.clear();
    };
  }, [load, loadStatus, loadStats]);

  // Lazy loads: the model and storage tabs fetch when first shown, not before.
  React.useEffect(() => {
    if (tab === 'models' && folders === null && !foldersLoading && foldersError === '') loadModels().catch(() => {});
  }, [tab, folders, foldersLoading, foldersError, loadModels]);
  React.useEffect(() => {
    if (tab === 'storage' && stats === null) loadStats().catch(() => {});
  }, [tab, stats, loadStats]);

  // Keep the live status fresh while the connection tab is visible.
  React.useEffect(() => {
    if (tab !== 'connection') return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadStatus().catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [tab, loadStatus]);

  const selectTab = (id) => {
    setTab(id);
    storeTab(id);
    setSaveNotice('');
    setSaveError('');
  };

  /** Update one draft field without losing anything else. */
  const setField = (field, value) => {
    setDraft((current) => (current === null ? current : { ...current, [field]: value }));
    setFieldErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSaveNotice('');
  };

  const dirty = React.useMemo(() => {
    if (draft === null || model === null) return false;
    const baseline = draftFromSettings(model);
    for (const key of Object.keys(baseline)) {
      if (key === 'authToken') { if (String(draft.authToken ?? '').trim() !== '') return true; continue; }
      if (String(draft[key] ?? '') !== String(baseline[key] ?? '')) return true;
    }
    return false;
  }, [draft, model]);

  /** Save the draft; a conflict re-reads instead of dropping the edit. */
  const save = async () => {
    if (draft === null || saving) return;
    const errors = validateSettingsDraft(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSaveError('请先修正标红的字段');
      setSaveNotice('');
      return;
    }
    setSaving(true);
    setSaveError('');
    setSaveNotice('');
    try {
      const patch = patchFromDraft(draft);
      const value = await run('settings.update', { patch, expectedRevision: revision });
      if (!alive.current || value === undefined) return;
      setSaveNotice('已保存');
      setModel(value?.settings ?? model);
      if (typeof value?.settings === 'object' && value.settings !== null) setDraft(draftFromSettings(value.settings));
      // Re-read so the revision and the Host-computed preset validity agree.
      const fresh = await run('settings.get', {});
      if (!alive.current || fresh === undefined) return;
      if (typeof fresh?.revision === 'number') setRevision(fresh.revision);
      setPresets(Array.isArray(fresh?.presets) ? fresh.presets : presets);
      setDefaults(fresh?.defaults ?? defaults);
      notify?.('已保存 ComfyUI 设置');
    } catch (error) {
      if (!alive.current || error?.name === 'AbortError') return;
      if (isConflict(error)) {
        setSaveError('其他窗口已修改，已刷新');
        // Keep the draft: re-read only the revision and presets, then let the
        // user save again on top of the fresh revision.
        try {
          const fresh = await run('settings.get', {});
          if (!alive.current || fresh === undefined) return;
          if (typeof fresh?.revision === 'number') setRevision(fresh.revision);
          setPresets(Array.isArray(fresh?.presets) ? fresh.presets : presets);
          setDefaults(fresh?.defaults ?? defaults);
          setModel(fresh?.settings ?? model);
        } catch { /* the next save reports the real problem */ }
      } else if (isOffline(error)) {
        setSaveError('无法访问 dsh，设置未保存；请刷新页面后重试');
      } else {
        setSaveError(error?.message || '保存失败');
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  /** Restore Host defaults, keeping the current draft when the Host refuses. */
  const resetDefaults = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    setSaveNotice('');
    try {
      const value = await run('settings.reset', { expectedRevision: revision });
      if (!alive.current || value === undefined) return;
      setSaveNotice('已恢复默认值');
      if (typeof value?.settings === 'object' && value.settings !== null) {
        setModel(value.settings);
        setDraft(draftFromSettings(value.settings));
      }
      const fresh = await run('settings.get', {});
      if (!alive.current || fresh === undefined) return;
      if (typeof fresh?.revision === 'number') setRevision(fresh.revision);
      setPresets(Array.isArray(fresh?.presets) ? fresh.presets : presets);
      setDefaults(fresh?.defaults ?? defaults);
    } catch (error) {
      if (!alive.current || error?.name === 'AbortError') return;
      setSaveError(isConflict(error) ? '其他窗口已修改，请刷新后重试' : error?.message || '恢复默认值失败');
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  /** Run `connection.test` against the draft's address and token. */
  const testConnection = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const payload = {};
      const baseUrl = String(draft?.baseUrl ?? '').trim();
      if (baseUrl !== '') payload.baseUrl = baseUrl;
      const token = String(draft?.authToken ?? '').trim();
      if (token !== '') payload.authToken = token;
      const value = await run('connection.test', payload);
      if (!alive.current || value === undefined) return;
      setTestResult(value ?? { ok: false, error: { message: '没有返回结果' } });
      loadStatus().catch(() => {});
    } catch (error) {
      if (!alive.current || error?.name === 'AbortError') return;
      setTestResult({ ok: false, error: { message: error?.message || '测试失败' } });
    } finally {
      if (alive.current) setTesting(false);
    }
  };

  /** Save a preset from the create form; the Host owns validation. */
  const createPreset = async (form) => {
    setBusyPreset('create');
    try {
      const value = await run('presets.save', form);
      if (!alive.current || value === undefined) return { ok: false, message: '' };
      const fresh = await run('presets.list', {});
      if (alive.current) setPresets(Array.isArray(fresh?.items) ? fresh.items : presets);
      notify?.('已创建预设');
      return { ok: true, item: value?.item };
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, message: '' };
      return { ok: false, message: error?.message || '创建预设失败' };
    } finally {
      if (alive.current) setBusyPreset('');
    }
  };

  /** Delete a custom preset. */
  const deletePreset = async (id) => {
    setBusyPreset(id);
    try {
      await run('presets.delete', { id });
      if (!alive.current) return;
      const fresh = await run('presets.list', {});
      if (alive.current) setPresets(Array.isArray(fresh?.items) ? fresh.items : presets.filter((item) => item?.id !== id));
      if (draft !== null && draft.presetId === id) setField('presetId', '');
      notify?.('已删除预设');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setSaveError(error?.message || '删除预设失败');
    } finally {
      if (alive.current) setBusyPreset('');
    }
  };

  /** Make one preset the default generation preset. */
  const makeDefaultPreset = async (id) => {
    if (draft === null) return;
    const previous = draft.presetId;
    setField('presetId', id);
    setBusyPreset(id);
    try {
      await run('settings.update', { patch: { presetId: id }, expectedRevision: revision });
      if (!alive.current) return;
      const fresh = await run('settings.get', {});
      if (!alive.current || fresh === undefined) return;
      if (typeof fresh?.revision === 'number') setRevision(fresh.revision);
      setModel(fresh?.settings ?? model);
      setSaveNotice('已设为默认预设');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setField('presetId', previous);
      setSaveError(isConflict(error) ? '其他窗口已修改，已刷新' : error?.message || '设置默认预设失败');
      if (isConflict(error)) {
        const fresh = await run('settings.get', {}).catch(() => undefined);
        if (alive.current && fresh !== undefined && typeof fresh?.revision === 'number') setRevision(fresh.revision);
      }
    } finally {
      if (alive.current) setBusyPreset('');
    }
  };

  /** Ask the Host what a prune would remove, then confirm before removing. */
  const pruneGallery = async () => {
    if (pruning) return;
    setPruning(true);
    try {
      if (prunePlan === null) {
        const plan = await run('gallery.prune', { dryRun: true });
        if (!alive.current || plan === undefined) return;
        setPrunePlan(plan ?? { removed: 0, bytes: 0 });
      } else {
        await run('gallery.prune', { dryRun: false });
        if (!alive.current) return;
        setPrunePlan(null);
        setSaveNotice('已清理过期图片');
        loadStats().catch(() => {});
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setSaveError(error?.message || '清理失败');
    } finally {
      if (alive.current) setPruning(false);
    }
  };

  if (loading && model === null && draft === null) {
    return <div className="cfq"><div className="cfq-banner" data-tone="info">正在读取 ComfyUI 设置…</div></div>;
  }

  const selectedPreset = presets.find((item) => item?.id === draft?.presetId) ?? null;
  const missingModels = Array.isArray(selectedPreset?.missing) ? selectedPreset.missing : [];
  const readOnly = !readable;

  return (
    <div className="cfq">
      <div className="cfq-header">
        <div>
          <h2>ComfyUI</h2>
          <p>把本机或远程 ComfyUI 接入 dsh：对话里出图，右侧栏看队列与图库。</p>
        </div>
        <div className="cfq-actions">
          {dirty ? <Pill tone="warn">有未保存的更改</Pill> : <Pill tone="muted">已保存</Pill>}
        </div>
      </div>

      {loadError ? <div className="cfq-banner" data-tone="error" role="alert">{loadError}</div> : null}

      <div className="cfq-tabs" role="tablist" aria-label="ComfyUI 设置分区">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="cfq-tab"
            aria-selected={tab === id ? 'true' : 'false'}
            aria-controls={`cfq-panel-${id}`}
            id={`cfq-tab-${id}`}
            onClick={() => selectTab(id)}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>

      {tab === 'connection' ? (
        <ConnectionTab
          draft={draft} setField={setField} errors={fieldErrors}
          status={status} statusError={statusError} onRetry={loadStatus}
          testing={testing} testResult={testResult} onTest={testConnection}
          authTokenConfigured={Boolean(model?.authTokenConfigured)}
          disabled={readOnly}
        />
      ) : null}

      {tab === 'models' ? (
        <ModelsTab
          folders={folders} error={foldersError} loading={foldersLoading}
          onRefresh={() => loadModels({ refresh: true })}
          presets={presets} selectedPreset={selectedPreset} missing={missingModels}
        />
      ) : null}

      {tab === 'presets' ? (
        <PresetsTab
          presets={presets} draft={draft} setField={setField} folders={folders}
          busyPreset={busyPreset} onCreate={createPreset} onDelete={deletePreset}
          onMakeDefault={makeDefaultPreset} onLoadModels={loadModels} foldersLoading={foldersLoading}
          disabled={readOnly}
        />
      ) : null}

      {tab === 'generation' ? (
        <GenerationTab draft={draft} setField={setField} errors={fieldErrors} presets={presets} />
      ) : null}

      {tab === 'storage' ? (
        <StorageTab
          draft={draft} setField={setField} errors={fieldErrors} stats={stats}
          onPrune={pruneGallery} prunePlan={prunePlan} pruning={pruning}
          onCancelPrune={() => setPrunePlan(null)}
          defaultSaveDir="~/.dsh/comfyui/gallery"
        />
      ) : null}

      <div className="cfq-footer">
        <span className="cfq-hint">
          {saveError ? <span className="cfq-err" role="alert">{saveError}</span> : saveNotice ? <span className="cfq-ok">{saveNotice}</span> : '保存后立即生效；生成中的任务不受影响。'}
        </span>
        <div className="cfq-actions">
          <button type="button" data-kind="ghost" onClick={resetDefaults} disabled={saving || readOnly}>恢复默认</button>
          <button type="button" data-kind="primary" onClick={save} disabled={saving || draft === null || readOnly}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 连接 tab: address, token, timeouts, and the live connection test. */
function ConnectionTab({ draft, setField, errors, status, statusError, onRetry, testing, testResult, onTest, authTokenConfigured, disabled }) {
  if (draft === null) return null;
  const connected = status?.connected === true;
  const tone = connected ? 'success' : statusError || status?.lastError ? 'error' : 'muted';
  const label = connected ? '已连接' : statusError ? '状态未知' : '未连接';
  const version = status?.version;
  const devices = Array.isArray(status?.devices) ? status.devices : [];
  return (
    <>
      <section className="cfq-card">
        <div className="cfq-cardHead">
          <span className="cfq-cardTitle">连接状态</span>
          <div className="cfq-actions">
            <Pill tone={tone}>{label}</Pill>
            <button type="button" data-kind="ghost" onClick={onRetry}>重试</button>
          </div>
        </div>
        {statusError ? <div className="cfq-err">{statusError}</div> : null}
        {status?.lastError?.message ? <div className="cfq-err">最近错误：{String(status.lastError.message)}</div> : null}
        <div className="cfq-stat">
          <span>地址 <b className="cfq-mono">{status?.baseUrl || draft.baseUrl || '未配置'}</b></span>
          <span>版本 <b>{typeof version === 'string' && version !== '' ? version : '—'}</b></span>
          {status?.queue ? <span>队列 <b>{formatCount(status.queue.running)} 运行 · {formatCount(status.queue.pending)} 排队</b></span> : null}
        </div>
        {devices.length > 0 ? (
          <div className="cfq-row" style={{ display: 'block' }}>
            {devices.map((device, index) => (
              <div key={`${device?.name ?? 'device'}-${index}`} className="cfq-hint" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>{String(device?.name ?? '设备')}</span>
                <span>{String(device?.type ?? '')}</span>
                <span>显存 {formatBytes(device?.vramTotal)}（空闲 {formatBytes(device?.vramFree)}）</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="cfq-card">
        <div className="cfq-cardHead"><span className="cfq-cardTitle">服务地址</span></div>
        <Field label="Base URL" hint="ComfyUI 的 HTTP 地址，例如 http://127.0.0.1:8188" >
          <input
            type="text"
            value={draft.baseUrl}
            placeholder="http://127.0.0.1:8188"
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => setField('baseUrl', event.target.value)}
          />
        </Field>
        {errors.baseUrl ? <div className="cfq-err">{errors.baseUrl}</div> : null}
        <Field
          label="访问令牌（可选）"
          hint={authTokenConfigured ? '已配置：留空表示保留现有令牌' : 'ComfyUI 前面有反向代理并开启鉴权时填写'}
        >
          <div className="cfq-actions">
            <input
              type="password"
              value={draft.authToken}
              placeholder={authTokenConfigured ? '已配置，留空保留' : '未配置'}
              disabled={disabled}
              autoComplete="new-password"
              onChange={(event) => setField('authToken', event.target.value)}
              style={{ flex: '1 1 200px' }}
            />
            {authTokenConfigured ? <Pill tone="success">已配置</Pill> : null}
          </div>
        </Field>
        <div className="cfq-grid" data-cols="3">
          <Field label="请求超时（秒）" hint="普通 API 请求">
            <input type="number" min={5} max={600} value={draft.requestTimeoutSeconds} disabled={disabled} onChange={(event) => setField('requestTimeoutSeconds', event.target.value)} />
          </Field>
          <Field label="生成超时（秒）" hint="等待出图的上限">
            <input type="number" min={10} max={3600} value={draft.generateTimeoutSeconds} disabled={disabled} onChange={(event) => setField('generateTimeoutSeconds', event.target.value)} />
          </Field>
          <Field label="轮询间隔（毫秒）" hint="1000–10000">
            <input type="number" min={1000} max={10000} step={500} value={draft.pollIntervalMs} disabled={disabled} onChange={(event) => setField('pollIntervalMs', event.target.value)} />
          </Field>
        </div>
        {errors.requestTimeoutSeconds ? <div className="cfq-err">{errors.requestTimeoutSeconds}</div> : null}
        {errors.generateTimeoutSeconds ? <div className="cfq-err">{errors.generateTimeoutSeconds}</div> : null}
        {errors.pollIntervalMs ? <div className="cfq-err">{errors.pollIntervalMs}</div> : null}
        <div className="cfq-actions">
          <button type="button" onClick={onTest} disabled={testing || disabled}>{testing ? '测试中…' : '测试连接'}</button>
        </div>
        {testResult !== null ? (
          testResult.ok === true ? (
            <div className="cfq-banner" data-tone="info">
              <span className="cfq-ok">连接正常</span>
              <span>版本 {String(testResult.version ?? '—')}</span>
              <span>{Array.isArray(testResult.devices) && testResult.devices.length > 0
                ? testResult.devices.map((device) => `${device?.name ?? '设备'}（${formatBytes(device?.vramTotal)}）`).join(' · ')
                : '未报告设备'}</span>
            </div>
          ) : (
            <div className="cfq-banner" data-tone="error" role="alert">
              连接失败：{String(testResult.error?.message ?? '未知原因')}
            </div>
          )
        ) : null}
      </section>
    </>
  );
}

/** One chip that copies its model name and confirms visually. */
function CopyChip({ name }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef(null);
  const mounted = React.useRef(true);
  React.useEffect(() => () => {
    mounted.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(String(name));
    } catch {
      // Clipboard is permission-gated; fall back to a temporary textarea.
      try {
        const area = document.createElement('textarea');
        area.value = String(name);
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand?.('copy');
        document.body.removeChild(area);
      } catch { /* copying is a convenience, never a requirement */ }
    }
    if (!mounted.current) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (mounted.current) setCopied(false); }, 1400);
  };
  return (
    <button type="button" className="cfq-chip" data-copied={copied ? 'true' : 'false'} title={`复制 ${name}`} onClick={copy}>
      {copied ? '已复制' : name}
    </button>
  );
}
/** 模型 tab: five grouped chip lists plus the missing-model warning. */
function ModelsTab({ folders, error, loading, onRefresh, presets, selectedPreset, missing }) {
  return (
    <>
      <section className="cfq-card">
        <div className="cfq-cardHead">
          <span className="cfq-cardTitle">模型文件</span>
          <div className="cfq-actions">
            <button type="button" onClick={onRefresh} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
          </div>
        </div>
        <div className="cfq-hint">点击模型名可复制，方便粘贴到预设或工作流里。</div>
        {error ? <div className="cfq-banner" data-tone="error" role="alert">{error}</div> : null}
        {missing.length > 0 ? (
          <div className="cfq-banner" data-tone="warn" role="alert">
            当前默认预设「{String(selectedPreset?.name ?? selectedPreset?.id ?? '')}」缺少模型：{missing.join('、')}
          </div>
        ) : null}
        {folders === null && !error && loading ? <div className="cfq-hint">正在读取模型列表…</div> : null}
        {folders === null && !error && !loading ? <div className="cfq-hint">尚未读取模型列表。</div> : null}
        {folders !== null ? MODEL_GROUPS.map(([key, title]) => {
          const list = Array.isArray(folders[key]) ? folders[key] : [];
          return (
            <div key={key} className="cfq-row" style={{ display: 'block' }}>
              <div className="cfq-cardHead" style={{ marginBottom: 6 }}>
                <span className="cfq-cardTitle" style={{ fontSize: 13 }}>{title}</span>
                <Pill tone="muted" dot={false}>{list.length} 个</Pill>
              </div>
              {list.length === 0 ? <div className="cfq-hint">未发现文件</div> : (
                <div className="cfq-chips">
                  {list.map((name) => <CopyChip key={String(name)} name={String(name)} />)}
                </div>
              )}
            </div>
          );
        }) : null}
      </section>
      <section className="cfq-card">
        <div className="cfq-cardHead"><span className="cfq-cardTitle">预设可用性</span></div>
        {presets.length === 0 ? <div className="cfq-hint">还没有预设。</div> : presets.map((preset) => (
          <div key={String(preset?.id)} className="cfq-row">
            <div className="cfq-rowMain">
              <span className="cfq-rowTitle">{String(preset?.name ?? preset?.id ?? '未命名')}</span>
              <span className="cfq-hint">{Array.isArray(preset?.missing) && preset.missing.length > 0 ? `缺少：${preset.missing.join('、')}` : '模型齐全'}</span>
            </div>
            <Pill tone={preset?.valid === false ? 'error' : preset?.valid === true ? 'success' : 'muted'}>
              {preset?.valid === false ? '不可用' : preset?.valid === true ? '可用' : '未校验'}
            </Pill>
          </div>
        ))}
      </section>
    </>
  );
}

/** 预设 tab: the preset list and the create form. */
function PresetsTab({ presets, draft, setField, folders, busyPreset, onCreate, onDelete, onMakeDefault, onLoadModels, foldersLoading, disabled }) {
  return (
    <>
      <section className="cfq-card">
        <div className="cfq-cardHead"><span className="cfq-cardTitle">工作流预设</span><Pill tone="muted" dot={false}>{presets.length} 个</Pill></div>
        {presets.length === 0 ? <div className="cfq-empty"><strong>还没有预设</strong><span>内置预设由 Host 提供；如果这里是空的，说明 Host 未就绪。</span></div> : presets.map((preset) => {
          const id = String(preset?.id ?? '');
          const isDefault = draft?.presetId === id;
          const missing = Array.isArray(preset?.missing) ? preset.missing : [];
          return (
            <div key={id} className="cfq-row">
              <div className="cfq-rowMain">
                <span className="cfq-rowTitle">
                  {String(preset?.name ?? id)}
                  {preset?.kind === 'custom' ? <span className="cfq-hint"> · 自定义</span> : null}
                </span>
                <span className="cfq-hint">{String(preset?.description ?? '')}</span>
                {missing.length > 0 ? <span className="cfq-err">缺少模型：{missing.join('、')}</span> : null}
              </div>
              <div className="cfq-actions">
                <Pill tone="muted" dot={false}>{modeLabel(preset?.mode)}</Pill>
                <Pill tone={preset?.valid === false ? 'error' : preset?.valid === true ? 'success' : 'muted'} dot={false}>
                  {preset?.valid === false ? '不可用' : preset?.valid === true ? '可用' : '未校验'}
                </Pill>
                <button type="button" data-kind={isDefault ? 'ghost' : undefined} disabled={isDefault || disabled || busyPreset === id} onClick={() => onMakeDefault(id)}>
                  {isDefault ? '当前默认' : '设为默认'}
                </button>
                {preset?.kind === 'custom' ? (
                  <button type="button" data-kind="danger" disabled={disabled || busyPreset === id} onClick={() => onDelete(id)}>删除</button>
                ) : null}
              </div>
            </div>
          );
        })}
      </section>
      <PresetForm
        folders={folders} foldersLoading={foldersLoading} onLoadModels={onLoadModels}
        busy={busyPreset === 'create'} onCreate={onCreate} disabled={disabled}
      />
    </>
  );
}

/** The create-preset form, including the custom workflow JSON validator. */
function PresetForm({ folders, foldersLoading, onLoadModels, busy, onCreate, disabled }) {
  const emptyForm = {
    name: '',
    mode: 'unet',
    checkpoint: '',
    unet: '',
    clip: '',
    clipType: '',
    vae: '',
    lora: '',
    loraStrength: '1',
    width: '1024', height: '1024', steps: '8', cfg: '1',
    sampler: 'euler', scheduler: 'normal', negative: '',
    workflow: '',
  };
  const [form, setForm] = React.useState(emptyForm);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const set = (field, value) => { setForm((current) => ({ ...current, [field]: value })); setError(''); setNotice(''); };

  const options = (key) => (Array.isArray(folders?.[key]) ? folders[key] : []);
  const submit = async () => {
    const name = form.name.trim();
    if (name === '') { setError('请填写预设名称'); return; }
    const defaults = {
      width: clampNumber(form.width, 64, 8192),
      height: clampNumber(form.height, 64, 8192),
      steps: clampNumber(form.steps, 1, 200),
      cfg: clampNumber(form.cfg, 0, 30),
      sampler: form.sampler,
      scheduler: form.scheduler,
      negative: form.negative,
      batch: 1,
    };
    const models = {};
    if (form.mode === 'checkpoint') { if (form.checkpoint !== '') models.checkpoint = form.checkpoint; }
    else if (form.mode === 'unet') {
      if (form.unet !== '') models.unet = form.unet;
      if (form.clip !== '') models.clip = form.clip;
      if (form.clipType.trim() !== '') models.clipType = form.clipType.trim();
      if (form.vae !== '') models.vae = form.vae;
      if (form.lora !== '') { models.lora = form.lora; models.loraStrength = clampNumber(form.loraStrength, 0, 4); }
    }
    const payload = { name, mode: form.mode, defaults, models };
    if (form.mode === 'custom') {
      const parsed = parseWorkflowJson(form.workflow);
      if (!parsed.ok) { setError(parsed.message); return; }
      payload.workflow = parsed.value;
    }
    const result = await onCreate(payload);
    if (result?.ok === true) {
      setForm(emptyForm);
      setNotice('已创建');
    } else if (result?.message) setError(result.message);
  };

  return (
    <section className="cfq-card">
      <div className="cfq-cardHead"><span className="cfq-cardTitle">新建自定义预设</span></div>
      <div className="cfq-grid">
        <Field label="名称"><input type="text" value={form.name} placeholder="例如 zimage-turbo-1328" disabled={disabled} onChange={(event) => set('name', event.target.value)} /></Field>
        <Field label="模式" hint="unet：分离模型；checkpoint：单文件；custom：自带 API 工作流">
          <select value={form.mode} disabled={disabled} onChange={(event) => set('mode', event.target.value)}>
            <option value="unet">unet</option>
            <option value="checkpoint">checkpoint</option>
            <option value="custom">custom</option>
          </select>
        </Field>
      </div>
      {folders === null ? (
        <div className="cfq-actions">
          <button type="button" data-kind="ghost" onClick={onLoadModels} disabled={foldersLoading}>{foldersLoading ? '读取中…' : '读取模型列表'}</button>
          <span className="cfq-hint">读取后可从下拉框挑选模型</span>
        </div>
      ) : null}
      {form.mode === 'checkpoint' ? (
        <Field label="Checkpoint">
          <ModelSelect value={form.checkpoint} onChange={(value) => set('checkpoint', value)} list={options('checkpoints')} disabled={disabled} />
        </Field>
      ) : null}
      {form.mode === 'unet' ? (
        <>
          <div className="cfq-grid">
            <Field label="UNet / Diffusion model"><ModelSelect value={form.unet} onChange={(value) => set('unet', value)} list={options('diffusion_models')} disabled={disabled} /></Field>
            <Field label="VAE"><ModelSelect value={form.vae} onChange={(value) => set('vae', value)} list={options('vae')} disabled={disabled} /></Field>
            <Field label="Text encoder"><ModelSelect value={form.clip} onChange={(value) => set('clip', value)} list={options('text_encoders')} disabled={disabled} /></Field>
            <Field label="CLIP type" hint="例如 lumina2"><input type="text" value={form.clipType} disabled={disabled} onChange={(event) => set('clipType', event.target.value)} /></Field>
            <Field label="LoRA（可选）"><ModelSelect value={form.lora} onChange={(value) => set('lora', value)} list={options('loras')} disabled={disabled} /></Field>
            <Field label="LoRA 强度"><input type="number" step="0.05" min="0" max="4" value={form.loraStrength} disabled={disabled} onChange={(event) => set('loraStrength', event.target.value)} /></Field>
          </div>
        </>
      ) : null}
      <div className="cfq-grid" data-cols="3">
        <Field label="默认宽度"><input type="number" min={64} max={8192} value={form.width} disabled={disabled} onChange={(event) => set('width', event.target.value)} /></Field>
        <Field label="默认高度"><input type="number" min={64} max={8192} value={form.height} disabled={disabled} onChange={(event) => set('height', event.target.value)} /></Field>
        <Field label="步数"><input type="number" min={1} max={200} value={form.steps} disabled={disabled} onChange={(event) => set('steps', event.target.value)} /></Field>
        <Field label="CFG"><input type="number" min={0} max={30} step="0.1" value={form.cfg} disabled={disabled} onChange={(event) => set('cfg', event.target.value)} /></Field>
        <Field label="采样器">
          <select value={form.sampler} disabled={disabled} onChange={(event) => set('sampler', event.target.value)}>
            {SAMPLERS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label="调度器">
          <select value={form.scheduler} disabled={disabled} onChange={(event) => set('scheduler', event.target.value)}>
            {SCHEDULERS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="默认负向提示词"><textarea rows={2} value={form.negative} disabled={disabled} onChange={(event) => set('negative', event.target.value)} /></Field>
      {form.mode === 'custom' ? (
        <Field
          label="API 格式工作流 JSON"
          hint="可用占位符：{{prompt}} {{negative}} {{width}} {{height}} {{seed}} {{steps}} {{cfg}} {{sampler}} {{scheduler}} {{batch}} {{denoise}} {{model}}"
        >
          <textarea rows={8} value={form.workflow} spellCheck={false} disabled={disabled} onChange={(event) => set('workflow', event.target.value)} placeholder='{"3": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}"}}}' />
        </Field>
      ) : null}
      {error ? <div className="cfq-err" role="alert">{error}</div> : null}
      {notice ? <div className="cfq-ok">{notice}</div> : null}
      <div className="cfq-actions">
        <button type="button" data-kind="primary" onClick={submit} disabled={busy || disabled}>{busy ? '创建中…' : '创建预设'}</button>
        <button type="button" data-kind="ghost" onClick={() => { setForm(emptyForm); setError(''); setNotice(''); }} disabled={busy || disabled}>清空</button>
      </div>
    </section>
  );
}

/** A select over one model folder, with a free-text escape hatch. */
function ModelSelect({ value, onChange, list, disabled }) {
  const options = Array.isArray(list) ? list : [];
  const known = value === '' || options.includes(value);
  return (
    <select value={known ? value : '__custom__'} disabled={disabled} onChange={(event) => onChange(event.target.value === '__custom__' ? '' : event.target.value)}>
      <option value="">（未选择）</option>
      {options.map((name) => <option key={String(name)} value={String(name)}>{String(name)}</option>)}
      {!known ? <option value="__custom__">{value}</option> : null}
    </select>
  );
}

/** 生成默认值 tab. */
function GenerationTab({ draft, setField, errors, presets }) {
  if (draft === null) return null;
  return (
    <>
      <section className="cfq-card">
        <div className="cfq-cardHead"><span className="cfq-cardTitle">尺寸与采样</span></div>
        <div className="cfq-quick">
          {QUICK_SIZES.map(([width, height, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => { setField('width', String(width)); setField('height', String(height)); }}
              aria-pressed={String(draft.width) === String(width) && String(draft.height) === String(height)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="cfq-grid" data-cols="3">
          <Field label="宽度"><input type="number" min={64} max={8192} step={8} value={draft.width} onChange={(event) => setField('width', event.target.value)} /></Field>
          <Field label="高度"><input type="number" min={64} max={8192} step={8} value={draft.height} onChange={(event) => setField('height', event.target.value)} /></Field>
          <Field label="比例"><span className="cfq-hint" style={{ paddingTop: 6 }}>{ratioHint(draft.width, draft.height) || '—'}</span></Field>
          <Field label="步数"><input type="number" min={1} max={200} value={draft.steps} onChange={(event) => setField('steps', event.target.value)} /></Field>
          <Field label="CFG"><input type="number" min={0} max={30} step="0.1" value={draft.cfg} onChange={(event) => setField('cfg', event.target.value)} /></Field>
          <Field label="批量" hint="1–8"><input type="number" min={1} max={8} value={draft.batch} onChange={(event) => setField('batch', event.target.value)} /></Field>
          <Field label="采样器">
            <select value={SAMPLERS.includes(draft.sampler) ? draft.sampler : SAMPLERS[0]} onChange={(event) => setField('sampler', event.target.value)}>
              {SAMPLERS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="调度器">
            <select value={SCHEDULERS.includes(draft.scheduler) ? draft.scheduler : SCHEDULERS[0]} onChange={(event) => setField('scheduler', event.target.value)}>
              {SCHEDULERS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="默认预设">
            <select value={draft.presetId} onChange={(event) => setField('presetId', event.target.value)}>
              <option value="">（跟随 Host）</option>
              {presets.map((preset) => <option key={String(preset?.id)} value={String(preset?.id)}>{String(preset?.name ?? preset?.id)}</option>)}
            </select>
          </Field>
        </div>
        {errors.width ? <div className="cfq-err">{errors.width}</div> : null}
        {errors.height ? <div className="cfq-err">{errors.height}</div> : null}
        {errors.steps ? <div className="cfq-err">{errors.steps}</div> : null}
        {errors.cfg ? <div className="cfq-err">{errors.cfg}</div> : null}
        {errors.batch ? <div className="cfq-err">{errors.batch}</div> : null}
      </section>

      <section className="cfq-card">
        <div className="cfq-cardHead"><span className="cfq-cardTitle">提示词与种子</span></div>
        <Field label="负向提示词"><textarea rows={3} value={draft.negativePrompt} onChange={(event) => setField('negativePrompt', event.target.value)} /></Field>
        <Field label="提示词前缀" hint="每次生成时自动加在提示词前面"><textarea rows={2} value={draft.promptPrefix} onChange={(event) => setField('promptPrefix', event.target.value)} /></Field>
        <div className="cfq-field">
          <span>种子模式</span>
          <div className="cfq-actions">
            <label className="cfq-check"><input type="radio" name="cfq-seed-mode" checked={draft.seedMode === 'random'} onChange={() => setField('seedMode', 'random')} /><span>每次随机</span></label>
            <label className="cfq-check"><input type="radio" name="cfq-seed-mode" checked={draft.seedMode === 'fixed'} onChange={() => setField('seedMode', 'fixed')} /><span>固定种子</span></label>
            <input
              type="number" min={0} step={1} value={draft.seed} style={{ maxWidth: 160 }}
              disabled={draft.seedMode !== 'fixed'}
              onChange={(event) => setField('seed', event.target.value)}
            />
          </div>
          {errors.seed ? <span className="cfq-err">{errors.seed}</span> : null}
        </div>
      </section>

      <section className="cfq-card">
        <div className="cfq-cardHead"><span className="cfq-cardTitle">生成后行为</span></div>
        <Check label="把生成结果作为图片回传给模型" hint="对话里出图后，模型能看到图片" checked={draft.autoAttachImages} onChange={(value) => setField('autoAttachImages', value)} />
        <Check label="生成完成后自动展开右侧栏" checked={draft.autoOpenSidebar} onChange={(value) => setField('autoOpenSidebar', value)} />
        <Check label="长任务完成时标记未读" checked={draft.notifyOnComplete} onChange={(value) => setField('notifyOnComplete', value)} />
      </section>
    </>
  );
}

/** 图库与存储 tab. */
function StorageTab({ draft, setField, errors, stats, onPrune, prunePlan, pruning, onCancelPrune, defaultSaveDir }) {
  if (draft === null) return null;
  return (
    <>
      <section className="cfq-card">
        <div className="cfq-cardHead"><span className="cfq-cardTitle">存储位置</span></div>
        <Field label="图库目录" hint={`留空使用默认目录 ${defaultSaveDir}`}>
          <input type="text" value={draft.saveDir} placeholder={defaultSaveDir} spellCheck={false} onChange={(event) => setField('saveDir', event.target.value)} />
        </Field>
        <div className="cfq-grid">
          <Field label="保留天数" hint="0 表示不按时间清理">
            <input type="number" min={0} max={3650} value={draft.retentionDays} onChange={(event) => setField('retentionDays', event.target.value)} />
          </Field>
          <Field label="图库上限（条）" hint="收藏的图片不会被清理">
            <input type="number" min={1} max={100000} value={draft.maxGalleryItems} onChange={(event) => setField('maxGalleryItems', event.target.value)} />
          </Field>
        </div>
        {errors.retentionDays ? <div className="cfq-err">{errors.retentionDays}</div> : null}
        {errors.maxGalleryItems ? <div className="cfq-err">{errors.maxGalleryItems}</div> : null}
      </section>

      <section className="cfq-card">
        <div className="cfq-cardHead">
          <span className="cfq-cardTitle">图库占用</span>
          <div className="cfq-actions">
            {prunePlan === null ? (
              <button type="button" onClick={onPrune} disabled={pruning}>{pruning ? '检查中…' : '清理过期'}</button>
            ) : (
              <>
                <button type="button" data-kind="primary" onClick={onPrune} disabled={pruning}>{pruning ? '清理中…' : '确认清理'}</button>
                <button type="button" data-kind="ghost" onClick={onCancelPrune} disabled={pruning}>取消</button>
              </>
            )}
          </div>
        </div>
        <div className="cfq-stat">
          <span>图片 <b>{formatCount(stats?.count)}</b> 张</span>
          <span>占用 <b>{formatBytes(stats?.bytes)}</b></span>
          <span>收藏 <b>{formatCount(stats?.favorites)}</b> 张</span>
        </div>
        {prunePlan !== null ? (
          <div className="cfq-banner" data-tone="warn">
            将删除 {formatCount(prunePlan.removed)} 项，释放 {formatBytes(prunePlan.bytes)}。收藏的图片不会被删除。
          </div>
        ) : null}
        <div className="cfq-hint">清理按「保留天数」与「图库上限」计算，只会删除未收藏的图片。</div>
      </section>
    </>
  );
}
