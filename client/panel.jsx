/**
 * 右侧栏 → ComfyUI.
 *
 * Three segmented views over the same Host data: 生成 / 队列 / 图库. The panel
 * owns one polling loop; it runs only while the body is mounted and the
 * document is visible, never stacks a tick on an in-flight one, and aborts
 * everything on unmount. A broken Host shows an error state, never a throw.
 */
import * as React from 'react';
import { installStyles } from './styles.js';
import {
  clampNumber,
  clampPercent,
  excerpt,
  flattenGallery,
  formatBytes,
  formatCount,
  formatRelativeTime,
  jobDuration,
  progressPercent,
  statusLabel,
  statusTone,
  wrapIndex,
  scopeSessionId,
  effectiveGalleryScope,
} from './format.js';
import { Field, Progress, Pill, SAMPLERS, SCHEDULERS } from './settings.jsx';

/** localStorage key for the panel's inner tab. */
const PANEL_TAB_KEY = 'dsh-comfyui:panel-tab';
/** Inner tabs in display order. */
const PANEL_TABS = [
  ['generate', '生成'],
  ['queue', '队列'],
  ['gallery', '图库'],
];
/** Gallery page size for 「加载更多」. */
const GALLERY_PAGE = 24;
/** How many finished jobs the queue view lists. */
const RECENT_LIMIT = 20;

/** localStorage key for the gallery scope. */
const GALLERY_SCOPE_KEY = 'dsh-comfyui:gallery-scope';

/**
 * Read the remembered gallery scope.
 * @returns {'current'|'all'|null} null when nothing usable is stored
 */
function readGalleryScope() {
  try {
    const value = localStorage.getItem(GALLERY_SCOPE_KEY);
    return value === 'current' || value === 'all' ? value : null;
  } catch {
    return null;
  }
}

/** Read the remembered inner tab. */
function readPanelTab() {
  try {
    const value = globalThis.localStorage?.getItem(PANEL_TAB_KEY);
    return PANEL_TABS.some(([id]) => id === value) ? value : 'generate';
  } catch {
    return 'generate';
  }
}

/** Persist the inner tab. */
function storePanelTab(id) {
  try { globalThis.localStorage?.setItem(PANEL_TAB_KEY, id); } catch { /* private mode */ }
}

/**
 * Render the sidebar tab body.
 * @param props.rpc shared RPC wrapper.
 * @param props.sessionId the owning session, forwarded to `generate.start`.
 */
export function Panel({ rpc, sessionId }) {
  const [tab, setTab] = React.useState(readPanelTab);
  const [status, setStatus] = React.useState(null);
  const [statusError, setStatusError] = React.useState('');
  const [queue, setQueue] = React.useState(null);
  const [queueError, setQueueError] = React.useState('');
  const [settings, setSettings] = React.useState(null);
  const [presets, setPresets] = React.useState([]);
  const [recent, setRecent] = React.useState([]);
  const [now, setNow] = React.useState(() => Date.now());

  const [prompt, setPrompt] = React.useState('');
  const [negative, setNegative] = React.useState('');
  const [presetId, setPresetId] = React.useState('');
  const [advanced, setAdvanced] = React.useState({ width: '', height: '', steps: '', cfg: '', sampler: '', scheduler: '', seed: '', batch: '' });
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [busyJob, setBusyJob] = React.useState('');
  const [settingsHint, setSettingsHint] = React.useState(false);

  const [gallery, setGallery] = React.useState([]);
  const [galleryTotal, setGalleryTotal] = React.useState(0);
  const [galleryQuery, setGalleryQuery] = React.useState('');
  const [galleryFav, setGalleryFav] = React.useState(false);
  const [galleryLoading, setGalleryLoading] = React.useState(false);
  const [galleryError, setGalleryError] = React.useState('');
  const [galleryStats, setGalleryStats] = React.useState(null);
  /**
   * Which slice of the library the gallery shows.
   *
   * The sidebar belongs to a conversation, so that conversation is the default:
   * a user looking at chat A should not have chat B's pictures in the way. The
   * whole library stays one click away because that is where "where did that
   * image go?" is actually answered.
   */
  const [galleryScope, setGalleryScope] = React.useState(() => {
    const remembered = readGalleryScope();
    if (remembered !== null) return remembered;
    return typeof sessionId === 'string' && sessionId !== '' ? 'current' : 'all';
  });
  /**
   * The image viewer, owned by the panel rather than by the gallery tab: the
   * 生成 and 队列 thumbnails open the same viewer, and moving between tabs must
   * not strand an open overlay.
   *
   * `{ items: [{ job, image }], index }` — a flat list so ←/→ cross job
   * boundaries instead of stopping at the end of one prompt's batch.
   */
  const [lightbox, setLightbox] = React.useState(null);

  const openLightbox = React.useCallback((items, index) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const safe = Math.min(Math.max(0, Number(index) || 0), items.length - 1);
    setLightbox({ items, index: safe });
  }, []);
  const closeLightbox = React.useCallback(() => setLightbox(null), []);

  const mounted = React.useRef(true);
  /** Controllers owned by this panel, aborted together on unmount. */
  const controllers = React.useRef(new Set());
  /** True while a poll tick is in flight; guards against stacking. */
  const polling = React.useRef(false);
  /** Controller for the current poll tick, aborted when the loop stops. */
  const tickAbort = React.useRef(null);
  /** Whether the user has already chosen a preset; guards the initial seed. */
  const presetChosen = React.useRef(false);

  React.useEffect(() => {
    const release = installStyles();
    mounted.current = true;
    return () => {
      mounted.current = false;
      release();
    };
  }, []);

  /** One request under the panel's lifetime. */
  const call = React.useCallback(async (method, payload) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await rpc.call(method, payload, controller.signal);
    } finally {
      controllers.current.delete(controller);
    }
  }, [rpc]);

  /** Read settings once (poll interval, presets, generation defaults). */
  const loadSettings = React.useCallback(async () => {
    try {
      const value = await call('settings.get', {});
      if (!mounted.current || value === undefined) return;
      setSettings(value?.settings ?? null);
      setPresets(Array.isArray(value?.presets) ? value.presets : []);
      const settingsValue = value?.settings ?? {};
      if (!presetChosen.current && typeof settingsValue.presetId === 'string') setPresetId(settingsValue.presetId);
      setAdvanced((current) => {
        if (current.width !== '' || current.height !== '') return current;
        const pick = (value_, fallback) => (typeof value_ === 'number' && Number.isFinite(value_) ? String(value_) : fallback);
        return {
          width: pick(settingsValue.width, '1024'),
          height: pick(settingsValue.height, '1024'),
          steps: pick(settingsValue.steps, '8'),
          cfg: pick(settingsValue.cfg, '1'),
          sampler: typeof settingsValue.sampler === 'string' ? settingsValue.sampler : 'euler',
          scheduler: typeof settingsValue.scheduler === 'string' ? settingsValue.scheduler : 'normal',
          seed: '',
          batch: pick(settingsValue.batch, '1'),
        };
      });
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted.current) return;
      setStatusError((current) => current || error?.message || '无法读取设置');
    }
  }, [call]);

  /** One poll tick: status + queue together, or neither. */
  const tick = React.useCallback(async () => {
    if (!mounted.current || polling.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    polling.current = true;
    const controller = new AbortController();
    tickAbort.current = controller;
    controllers.current.add(controller);
    try {
      const [statusValue, queueValue] = await Promise.all([
        rpc.call('status.get', {}, controller.signal),
        rpc.call('queue.get', {}, controller.signal),
      ]);
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(statusValue ?? null);
      setStatusError('');
      setQueue(queueValue ?? null);
      setQueueError('');
      const jobs = Array.isArray(queueValue?.jobs) ? queueValue.jobs : [];
      setRecent(jobs.filter((job) => job?.status !== 'running' && job?.status !== 'queued').slice(0, RECENT_LIMIT));
    } catch (error) {
      if (!mounted.current || error?.name === 'AbortError' || controller.signal.aborted) return;
      setStatusError(error?.message || '无法读取连接状态');
      setQueueError(error?.message || '无法读取队列');
    } finally {
      controllers.current.delete(controller);
      if (tickAbort.current === controller) tickAbort.current = null;
      polling.current = false;
    }
  }, [rpc]);

  /** Load one gallery page; `reset` starts from offset 0. */
  const loadGallery = React.useCallback(async ({ reset = false, query = galleryQuery, favorite = galleryFav, scope = galleryScope } = {}) => {
    setGalleryLoading(true);
    setGalleryError('');
    const offset = reset ? 0 : gallery.length;
    const payload = { limit: GALLERY_PAGE, offset };
    const trimmed = String(query ?? '').trim();
    if (trimmed !== '') payload.query = trimmed;
    if (favorite) payload.favorite = true;
    const scopeSession = scopeSessionId(scope, sessionId);
    if (scopeSession !== undefined) payload.sessionId = scopeSession;
    try {
      const value = await call('gallery.list', payload);
      if (!mounted.current || value === undefined) return;
      const items = Array.isArray(value?.items) ? value.items : [];
      setGallery((current) => {
        if (reset) return items;
        const seen = new Set(current.map((job) => String(job?.id)));
        return [...current, ...items.filter((job) => !seen.has(String(job?.id)))];
      });
      setGalleryTotal(typeof value?.total === 'number' && Number.isFinite(value.total) ? value.total : items.length);
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted.current) return;
      setGalleryError(error?.message || '无法读取图库');
    } finally {
      if (mounted.current) setGalleryLoading(false);
    }
  }, [call, gallery.length, galleryQuery, galleryFav, galleryScope, sessionId]);

  /** Refresh gallery totals for the header. */
  const loadGalleryStats = React.useCallback(async ({ scope = galleryScope } = {}) => {
    try {
      const scopeSession = scopeSessionId(scope, sessionId);
      const value = await call('gallery.stats', scopeSession === undefined ? {} : { sessionId: scopeSession });
      if (!mounted.current || value === undefined) return;
      setGalleryStats(value ?? null);
    } catch { /* totals are decoration; a failure leaves them unknown */ }
  }, [call, galleryScope, sessionId]);

  // Mount: settings once, then the first tick and the first gallery page.
  React.useEffect(() => {
    loadSettings().catch(() => {});
    tick().catch(() => {});
    loadGallery({ reset: true }).catch(() => {});
    loadGalleryStats().catch(() => {});
    // The initial reads are mount-scoped on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling loop: restarted when the interval changes or visibility returns.
  const interval = settings?.pollIntervalMs === undefined || settings?.pollIntervalMs === null
    ? 2000
    : clampNumber(settings.pollIntervalMs, 1000, 10_000);
  React.useEffect(() => {
    let timer = null;
    let stopped = false;
    const clear = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };
    const stopInFlight = () => {
      const controller = tickAbort.current;
      tickAbort.current = null;
      if (controller !== null) { try { controller.abort(); } catch { /* settled */ } }
      polling.current = false;
    };
    const start = () => {
      if (stopped || timer !== null) return;
      timer = setInterval(() => { if (!stopped) tick().catch(() => {}); }, interval);
    };
    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        clear();
        stopInFlight();
      } else {
        tick().catch(() => {});
        start();
      }
    };
    const hasDocument = typeof document !== 'undefined';
    if (!hasDocument || document.visibilityState !== 'hidden') start();
    if (hasDocument) document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clear();
      stopInFlight();
      if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [interval, tick]);

  // Elapsed-time ticker for the running job (1 Hz, independent of polling).
  const hasRunning = Boolean(queue?.running?.length || queue?.active);
  React.useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = setInterval(() => { if (mounted.current) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  // Unmount: abort every outstanding request.
  React.useEffect(() => () => {
    mounted.current = false;
    for (const controller of controllers.current) { try { controller.abort(); } catch { /* settled */ } }
    controllers.current.clear();
    const controller = tickAbort.current;
    tickAbort.current = null;
    if (controller !== null) { try { controller.abort(); } catch { /* settled */ } }
  }, []);

  const selectTab = (id) => {
    setTab(id);
    storePanelTab(id);
    setActionError('');
    if (id === 'gallery') {
      loadGallery({ reset: true }).catch(() => {});
      loadGalleryStats().catch(() => {});
    }
  };

  /** Submit one generation from the panel form. */
  const generate = async () => {
    const text = prompt.trim();
    if (text === '' || starting) return;
    setStarting(true);
    setStartError('');
    try {
      const payload = { prompt: text, sessionId: sessionId ?? undefined };
      if (negative.trim() !== '') payload.negative = negative.trim();
      if (presetId !== '') payload.presetId = presetId;
      const numeric = (value, min, max) => {
        if (value === '' || value === null || value === undefined) return undefined;
        const number = Number(value);
        return Number.isFinite(number) ? clampNumber(number, min, max) : undefined;
      };
      const width = numeric(advanced.width, 64, 8192);
      const height = numeric(advanced.height, 64, 8192);
      const steps = numeric(advanced.steps, 1, 200);
      const cfg = numeric(advanced.cfg, 0, 30);
      const batch = numeric(advanced.batch, 1, 8);
      const seed = numeric(advanced.seed, 0, 2 ** 48);
      if (width !== undefined) payload.width = width;
      if (height !== undefined) payload.height = height;
      if (steps !== undefined) payload.steps = steps;
      if (cfg !== undefined) payload.cfg = cfg;
      if (batch !== undefined) payload.batch = batch;
      if (seed !== undefined) payload.seed = seed;
      if (advanced.sampler !== '') payload.sampler = advanced.sampler;
      if (advanced.scheduler !== '') payload.scheduler = advanced.scheduler;
      await call('generate.start', payload);
      if (!mounted.current) return;
      setPrompt('');
      tick().catch(() => {});
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted.current) return;
      setStartError(error?.message || '提交生成失败');
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  /** Cancel one job (or the running one when no id is given). */
  const cancelJob = async (jobId) => {
    setBusyJob(String(jobId ?? 'current'));
    setActionError('');
    try {
      await call('queue.cancel', jobId ? { jobId } : {});
      if (mounted.current) tick().catch(() => {});
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted.current) return;
      setActionError(error?.message || '取消失败');
    } finally {
      if (mounted.current) setBusyJob('');
    }
  };

  /** Interrupt the running job on the ComfyUI side. */
  const interrupt = async () => {
    setBusyJob('interrupt');
    setActionError('');
    try {
      await call('queue.interrupt', {});
      if (mounted.current) tick().catch(() => {});
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted.current) return;
      setActionError(error?.message || '中断失败');
    } finally {
      if (mounted.current) setBusyJob('');
    }
  };

  /** Drop everything still waiting. */
  const clearQueue = async () => {
    setBusyJob('clear');
    setActionError('');
    try {
      await call('queue.clear', {});
      if (mounted.current) tick().catch(() => {});
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted.current) return;
      setActionError(error?.message || '清空排队失败');
    } finally {
      if (mounted.current) setBusyJob('');
    }
  };

  /** Toggle one job's favorite flag and mirror it locally. */
  const hasSession = typeof sessionId === 'string' && sessionId.trim() !== '';
  const effectiveScope = effectiveGalleryScope(galleryScope, sessionId);
  const switchScope = (next) => {
    if (next === galleryScope && next === effectiveScope) return;
    setGalleryScope(next);
    try { localStorage.setItem(GALLERY_SCOPE_KEY, next); } catch { /* storage is optional */ }
    // The list belongs to the previous scope; drop it and refetch immediately
    // instead of letting the effect re-run against a stale offset.
    setGallery([]);
    setGalleryTotal(0);
    setGalleryLoading(true);
    loadGallery({ reset: true, scope: next }).catch(() => {});
    loadGalleryStats({ scope: next }).catch(() => {});
  };

  const toggleFavorite = async (job) => {
    const id = String(job?.id ?? '');
    if (id === '') return;
    const next = job?.favorite !== true;
    setGallery((current) => current.map((item) => (String(item?.id) === id ? { ...item, favorite: next } : item)));
    try {
      await call('gallery.update', { id, favorite: next });
      if (mounted.current) loadGalleryStats().catch(() => {});
    } catch (error) {
      if (!mounted.current) return;
      setGallery((current) => current.map((item) => (String(item?.id) === id ? { ...item, favorite: !next } : item)));
      if (error?.name !== 'AbortError') setGalleryError(error?.message || '收藏失败');
    }
  };

  /** Delete one job's images after an explicit confirmation. */
  const deleteJob = async (job) => {
    const id = String(job?.id ?? '');
    if (id === '') return;
    const confirmed = typeof globalThis.confirm === 'function'
      ? globalThis.confirm('删除这组图片？此操作不可撤销。')
      : false;
    if (!confirmed) return;
    setBusyJob(id);
    try {
      await call('gallery.delete', { ids: [id] });
      if (!mounted.current) return;
      setGallery((current) => current.filter((item) => String(item?.id) !== id));
      setGalleryTotal((current) => Math.max(0, current - 1));
      loadGalleryStats().catch(() => {});
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted.current) return;
      setGalleryError(error?.message || '删除失败');
    } finally {
      if (mounted.current) setBusyJob('');
    }
  };

  const connected = status?.connected === true;
  const running = Array.isArray(queue?.running) ? queue.running : [];
  const pending = Array.isArray(queue?.pending) ? queue.pending : [];
  const active = queue?.active ?? status?.active ?? null;
  const latest = active ?? recent[0] ?? null;

  return (
    <div className="cfqp">
      <div className="cfqp-top">
        <div className="cfq-seg" role="tablist" aria-label="ComfyUI 面板">
          {PANEL_TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id ? 'true' : 'false'} aria-pressed={tab === id ? 'true' : 'false'} onClick={() => selectTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <Pill tone={connected ? 'success' : statusError ? 'error' : 'muted'}>{connected ? '已连接' : statusError ? '离线' : '未连接'}</Pill>
      </div>

      <div className="cfqp-body">
        {!connected ? (
          <Unconnected
            baseUrl={status?.baseUrl || settings?.baseUrl || ''}
            error={statusError}
            hintOpen={settingsHint}
            onHint={() => setSettingsHint((current) => !current)}
            onRetry={() => tick().catch(() => {})}
          />
        ) : null}
        {actionError ? <div className="cfq-banner" data-tone="error" role="alert">{actionError}</div> : null}

        {tab === 'generate' ? (
          <>
            <section className="cfqp-card">
              <Field label="提示词">
                <textarea
                  rows={4}
                  value={prompt}
                  placeholder="描述你想生成的画面…"
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); generate().catch(() => {}); }
                  }}
                />
              </Field>
              {presets.length > 0 ? (
                <Field label="预设">
                  <select value={presetId} onChange={(event) => { presetChosen.current = true; setPresetId(event.target.value); }}>
                    <option value="">（使用默认预设）</option>
                    {presets.map((preset) => (
                      <option key={String(preset?.id)} value={String(preset?.id)}>{String(preset?.name ?? preset?.id)}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <details className="cfq-adv" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                <summary>高级</summary>
                <div className="cfq-grid">
                  <Field label="宽度"><input type="number" min={64} max={8192} step={8} value={advanced.width} onChange={(event) => setAdvanced({ ...advanced, width: event.target.value })} /></Field>
                  <Field label="高度"><input type="number" min={64} max={8192} step={8} value={advanced.height} onChange={(event) => setAdvanced({ ...advanced, height: event.target.value })} /></Field>
                  <Field label="步数"><input type="number" min={1} max={200} value={advanced.steps} onChange={(event) => setAdvanced({ ...advanced, steps: event.target.value })} /></Field>
                  <Field label="CFG"><input type="number" min={0} max={30} step="0.1" value={advanced.cfg} onChange={(event) => setAdvanced({ ...advanced, cfg: event.target.value })} /></Field>
                  <Field label="采样器">
                    <select value={advanced.sampler} onChange={(event) => setAdvanced({ ...advanced, sampler: event.target.value })}>
                      <option value="">（默认）</option>
                      {SAMPLERS.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </Field>
                  <Field label="调度器">
                    <select value={advanced.scheduler} onChange={(event) => setAdvanced({ ...advanced, scheduler: event.target.value })}>
                      <option value="">（默认）</option>
                      {SCHEDULERS.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </Field>
                  <Field label="种子" hint="留空随机"><input type="number" min={0} step={1} value={advanced.seed} onChange={(event) => setAdvanced({ ...advanced, seed: event.target.value })} /></Field>
                  <Field label="批量" hint="1–8"><input type="number" min={1} max={8} value={advanced.batch} onChange={(event) => setAdvanced({ ...advanced, batch: event.target.value })} /></Field>
                </div>
                <Field label="负向提示词">
                  <textarea rows={2} value={negative} onChange={(event) => setNegative(event.target.value)} />
                </Field>
              </details>
              <div className="cfq-actions">
                <button type="button" data-kind="primary" onClick={() => generate().catch(() => {})} disabled={starting || prompt.trim() === ''}>
                  {starting ? '提交中…' : '生成'}
                </button>
                {active ? <button type="button" onClick={() => cancelJob('').catch(() => {})} disabled={busyJob !== ''}>取消</button> : null}
              </div>
              {startError ? <div className="cfq-err" role="alert">{startError}</div> : null}
            </section>

            <section className="cfqp-sec">
              <div className="cfqp-secHead"><span className="cfqp-secTitle">最近一次生成</span></div>
              {latest === null ? (
                <EmptyState title="还没有生成任务" hint="输入提示词后点「生成」，进度会显示在这里。" />
              ) : (
                <JobCard job={latest} now={now} rpc={rpc} onCancel={cancelJob} busy={busyJob} onOpen={openLightbox} />
              )}
            </section>
          </>
        ) : null}

        {tab === 'queue' ? (
          <>
            <section className="cfqp-sec">
              <div className="cfqp-secHead">
                <span className="cfqp-secTitle">运行 {running.length} · 排队 {pending.length}</span>
                <button type="button" data-kind="ghost" onClick={() => clearQueue().catch(() => {})} disabled={pending.length === 0 || busyJob !== ''}>清空排队</button>
              </div>
              {queueError ? <div className="cfq-banner" data-tone="error" role="alert">{queueError}</div> : null}
              {running.length === 0 ? <div className="cfq-hint">当前没有运行中的任务。</div> : running.map((job) => (
                <JobCard key={String(job?.id)} job={job} now={now} rpc={rpc} onCancel={cancelJob} onInterrupt={interrupt} busy={busyJob} showThumbs={false} />
              ))}
            </section>

            <section className="cfqp-sec">
              <div className="cfqp-secHead"><span className="cfqp-secTitle">排队中</span></div>
              {pending.length === 0 ? <div className="cfq-hint">没有排队任务。</div> : (
                <div className="cfqp-list">
                  {pending.map((job) => (
                    <div key={String(job?.id)} className="cfqp-card">
                      <div className="cfqp-prompt">{excerpt(job?.prompt, 80) || '（无提示词）'}</div>
                      <div className="cfqp-meta">
                        <span>{statusLabel(job?.status)}</span>
                        <span>{formatRelativeTime(job?.createdAt)}</span>
                        <span>{formatCount(job?.width)}×{formatCount(job?.height)}</span>
                      </div>
                      <div className="cfq-actions">
                        <button type="button" data-kind="ghost" onClick={() => cancelJob(job?.id).catch(() => {})} disabled={busyJob !== ''}>取消</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="cfqp-sec">
              <div className="cfqp-secHead"><span className="cfqp-secTitle">最近完成</span><span className="cfq-hint">{recent.length} 条</span></div>
              {recent.length === 0 ? <div className="cfq-hint">还没有完成的任务。</div> : (
                <div className="cfqp-list">
                  {recent.map((job) => <RecentRow key={String(job?.id)} job={job} rpc={rpc} onOpen={openLightbox} />)}
                </div>
              )}
            </section>
          </>
        ) : null}

        {tab === 'gallery' ? (
          <>
            <div className="cfqp-scope" role="group" aria-label="图库范围">
              <button
                type="button"
                data-kind="seg"
                aria-pressed={effectiveScope === 'current'}
                disabled={!hasSession}
                title={hasSession ? '只看这个对话生成的图片' : '当前没有绑定对话，只能查看全部'}
                onClick={() => switchScope('current')}
              >当前对话</button>
              <button
                type="button"
                data-kind="seg"
                aria-pressed={effectiveScope === 'all'}
                title="查看所有对话的图片"
                onClick={() => switchScope('all')}
              >全部{galleryStats?.all ? ` ${formatCount(galleryStats.all.count)}` : ''}</button>
            </div>
            <div className="cfqp-search">
              <input
                type="search"
                value={galleryQuery}
                placeholder="搜索提示词…"
                onChange={(event) => setGalleryQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') loadGallery({ reset: true }).catch(() => {}); }}
              />
              <button type="button" data-kind="ghost" onClick={() => loadGallery({ reset: true }).catch(() => {})} disabled={galleryLoading}>搜索</button>
            </div>
            <div className="cfqp-secHead">
              <label className="cfq-check">
                <input type="checkbox" checked={galleryFav} onChange={(event) => { const next = event.target.checked; setGalleryFav(next); loadGallery({ reset: true, favorite: next }).catch(() => {}); }} />
                <span>仅收藏</span>
              </label>
              <span className="cfq-hint">
                {effectiveScope === 'current' ? '本对话 ' : ''}
                {formatCount(galleryTotal)} 组 · {formatBytes(galleryStats?.bytes)}
                {effectiveScope === 'current' && galleryStats?.all
                  ? ` / 全部 ${formatCount(galleryStats.all.count)}`
                  : ''}
              </span>
            </div>
            {galleryError ? <div className="cfq-banner" data-tone="error" role="alert">{galleryError}</div> : null}
            {gallery.length === 0 && !galleryLoading ? (
              !connected ? (
                <EmptyState title="还没有生成过图片" hint="Host 未连接，先检查设置里的地址。" />
              ) : effectiveScope === 'current' ? (
                galleryStats?.all?.count > 0 ? (
                  <div className="cfq-empty">
                    <strong>这个对话还没有生成过图片</strong>
                    <span>全部图库里有 {formatCount(galleryStats.all.count)} 组。</span>
                    <div className="cfq-actions">
                      <button type="button" data-kind="ghost" onClick={() => switchScope('all')}>查看全部</button>
                    </div>
                  </div>
                ) : (
                  <EmptyState title="还没有生成过图片" hint="在「生成」里出图，或让我在对话里生成，图片会出现在这里。" />
                )
              ) : (
                <EmptyState title="还没有生成过图片" hint="在对话或「生成」里出图后，图片会出现在这里。" />
              )
            ) : (
              <GalleryWall
                jobs={gallery} rpc={rpc} busyJob={busyJob}
                onFavorite={toggleFavorite} onDelete={deleteJob}
                onOpen={openLightbox}
              />
            )}
            {gallery.length > 0 && gallery.length < galleryTotal ? (
              <div className="cfq-actions" style={{ justifyContent: 'center' }}>
                <button type="button" data-kind="ghost" onClick={() => loadGallery().catch(() => {})} disabled={galleryLoading}>
                  {galleryLoading ? '加载中…' : '加载更多'}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {lightbox !== null ? (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          rpc={rpc}
          busyJob={busyJob}
          onClose={closeLightbox}
          onIndex={(next) => setLightbox((current) => {
            if (current === null) return current;
            if (current.items.length === 0) return null;
            return { ...current, index: wrapIndex(next, current.items.length) };
          })}
          onFavorite={toggleFavorite}
          onDelete={deleteJob}
        />
      ) : null}
    </div>
  );
}

/**
 * The "not connected" state.
 *
 * It names the address the Host is configured with and offers a pointer to the
 * settings page; the button only reveals text, so a broken Host cannot be
 * pushed further into a bad state by clicking it.
 */
function Unconnected({ baseUrl, error, hintOpen, onHint, onRetry }) {
  return (
    <div className="cfqp-card">
      <div className="cfq-cardHead">
        <span className="cfq-cardTitle">未连接 ComfyUI</span>
        <Pill tone={error ? 'error' : 'muted'}>{error ? '离线' : '未连接'}</Pill>
      </div>
      <div className="cfq-mono">{baseUrl || '尚未配置服务地址'}</div>
      {error ? <div className="cfq-err" role="alert">{error}</div> : null}
      <div className="cfq-hint">确认 ComfyUI 正在运行，并检查地址与访问令牌。</div>
      <div className="cfq-actions">
        <button type="button" onClick={onHint}>去设置</button>
        <button type="button" data-kind="ghost" onClick={onRetry}>重试</button>
      </div>
      {hintOpen ? <div className="cfq-hint">在「设置 → ComfyUI → 连接」里填写 Base URL，然后点「测试连接」。</div> : null}
    </div>
  );
}

/** A helpful empty state with an optional non-destructive hint action. */
function EmptyState({ title, hint }) {
  return (
    <div className="cfq-empty">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

/**
 * One image thumbnail.
 *
 * With `onOpen` it feeds the panel's viewer, which keeps the whole app on one
 * consistent click target; without it (a caller that has no viewer) it falls
 * back to a plain link so the thumbnail is never inert.
 */
function Thumb({ image, rpc, size, onOpen, items, index, job }) {
  const url = typeof image?.url === 'string' && image.url !== '' ? image.url : rpc.imageUrl(image?.id);
  if (url === '') return null;
  const img = (
    <img src={url} alt={String(image?.filename ?? '生成结果')} loading="lazy" decoding="async" style={size ? { width: size, height: size } : undefined} />
  );
  if (typeof onOpen === 'function') {
    return (
      <button
        type="button"
        className="cfqp-thumb"
        title={String(job?.prompt ?? image?.filename ?? '查看大图')}
        aria-label={`查看大图：${String(image?.filename ?? '生成结果')}`}
        onClick={() => onOpen(Array.isArray(items) && items.length > 0 ? items : [{ job, image, url }], index ?? 0)}
      >{img}</button>
    );
  }
  return (
    <a className="cfqp-thumb" href={url} target="_blank" rel="noreferrer" title={String(image?.filename ?? '打开原图')}>
      {img}
    </a>
  );
}

/** The live job card: prompt, progress, elapsed, and result thumbnails. */
function JobCard({ job, now, rpc, onCancel, onInterrupt, busy, showThumbs = true, onOpen }) {
  const running = job?.status === 'running';
  const queued = job?.status === 'queued';
  const percent = progressPercent(job?.progress);
  const images = Array.isArray(job?.images) ? job.images : [];
  const label = typeof job?.progress?.label === 'string' && job.progress.label !== ''
    ? job.progress.label
    : running ? '生成中' : statusLabel(job?.status);
  return (
    <div className="cfqp-card" data-state={running ? 'running' : 'idle'}>
      <div className="cfqp-prompt">{excerpt(job?.prompt, 120) || '（无提示词）'}</div>
      {running || queued ? (
        <Progress percent={percent} indeterminate={queued || percent <= 0} label={label} right={jobDuration(job, now)} />
      ) : (
        <div className="cfqp-meta">
          <Pill tone={statusTone(job?.status)}>{statusLabel(job?.status)}</Pill>
          <span>{jobDuration(job, now)}</span>
          <span>{formatCount(job?.width)}×{formatCount(job?.height)}</span>
          <span>{formatCount(job?.steps)} 步</span>
          <span>seed {formatCount(job?.seed)}</span>
        </div>
      )}
      {job?.error?.message ? <div className="cfq-err">{String(job.error.message)}</div> : null}
      {showThumbs && images.length > 0 ? (
        <div className="cfqp-thumbs">
          {images.map((image, index) => (
            <Thumb
              key={String(image?.id ?? index)}
              image={image} rpc={rpc} job={job} onOpen={onOpen}
              items={flattenGallery([job], rpc.imageUrl)}
              index={index}
            />
          ))}
        </div>
      ) : null}
      <div className="cfq-actions">
        {running || queued ? (
          <>
            <button type="button" data-kind="ghost" onClick={() => onCancel(job?.id).catch(() => {})} disabled={busy !== ''}>取消</button>
            {running && onInterrupt ? <button type="button" data-kind="ghost" onClick={() => onInterrupt().catch(() => {})} disabled={busy !== ''}>中断</button> : null}
          </>
        ) : null}
        {job?.presetName ? <span className="cfq-hint">{String(job.presetName)}</span> : null}
      </div>
    </div>
  );
}

/** A compact finished-job row in the queue view. */
function RecentRow({ job, rpc, onOpen }) {
  const images = Array.isArray(job?.images) ? job.images : [];
  return (
    <div className="cfqp-card">
      <div className="cfqp-prompt">{excerpt(job?.prompt, 80) || '（无提示词）'}</div>
      <div className="cfqp-meta">
        <Pill tone={statusTone(job?.status)}>{statusLabel(job?.status)}</Pill>
        <span>{jobDuration(job)}</span>
        <span>{formatRelativeTime(job?.createdAt)}</span>
      </div>
      {images.length > 0 ? (
        <div className="cfqp-thumbs">
          {images.slice(0, 4).map((image, index) => (
            <Thumb
              key={String(image?.id ?? index)}
              image={image} rpc={rpc} job={job} onOpen={onOpen}
              items={flattenGallery([job], rpc.imageUrl)}
              index={index}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The gallery wall.
 *
 * A true gallery presentation rather than a grouped list: every image is shown
 * at its own aspect ratio in a packed multi-column wall, so a 16:9 and a 9:16
 * generation both look right instead of being cropped into identical squares.
 * Clicking one opens the viewer; the per-tile buttons stay for quick actions.
 *
 * The wall is built from a flat list of images so the viewer's ←/→ can walk the
 * whole library, not just one prompt's batch.
 */
function GalleryWall({ jobs, rpc, busyJob, onFavorite, onDelete, onOpen }) {
  const items = React.useMemo(() => flattenGallery(jobs, rpc.imageUrl), [jobs, rpc]);

  if (items.length === 0) return null;

  return (
    <div className="cfqw-wall" role="list">
      {items.map((item, index) => {
        const favorite = item.image?.favorite === true || item.job?.favorite === true;
        const width = Number(item.image?.width) || Number(item.job?.width) || 0;
        const height = Number(item.image?.height) || Number(item.job?.height) || 0;
        return (
          <div
            key={String(item.image?.id ?? index)}
            className="cfqw-item"
            role="listitem"
            data-favorite={favorite ? 'true' : 'false'}
          >
            <button
              type="button"
              className="cfqw-open"
              onClick={() => onOpen(items, index)}
              title={String(item.job?.prompt ?? '查看大图')}
              aria-label={`查看第 ${index + 1} 张：${excerpt(item.job?.prompt, 40) || '生成结果'}`}
            >
              <img
                src={item.url}
                alt={String(item.image?.filename ?? '生成结果')}
                loading="lazy"
                decoding="async"
                {...(width > 0 && height > 0 ? { width, height } : {})}
              />
            </button>
            {favorite ? <span className="cfqw-badge" aria-label="已收藏">★</span> : null}
            <div className="cfqw-actions">
              <button
                type="button"
                data-fav={favorite ? 'true' : 'false'}
                title={favorite ? '取消收藏' : '收藏'}
                aria-label={favorite ? '取消收藏' : '收藏'}
                onClick={() => onFavorite({ ...item.job, favorite }).catch(() => {})}
              >{favorite ? '★' : '☆'}</button>
              <a
                href={item.url}
                download={typeof item.image?.filename === 'string' ? item.image.filename : ''}
                title="下载"
                aria-label="下载"
              >↓</a>
              <button
                type="button"
                title="删除"
                aria-label="删除"
                disabled={busyJob !== ''}
                onClick={() => {
                  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                    && !window.confirm('删除这一组生成记录和图片？此操作不可恢复。')) return;
                  onDelete(item.job).catch(() => {});
                }}
              >×</button>
            </div>
            {width > 0 && height > 0 ? (
              <span className="cfqw-size">{width}×{height}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The full-screen image viewer.
 *
 * Kept in the DOM only while open, so the closed state costs nothing. Body
 * scroll is locked and restored, keyboard focus moves to the dialog and returns
 * to whatever opened it, and every listener is removed on unmount.
 */
function Lightbox({ items, index, rpc, busyJob, onClose, onIndex, onFavorite, onDelete }) {
  const dialog = React.useRef(null);
  const closeButton = React.useRef(null);
  const [pending, setPending] = React.useState(false);
  const total = Array.isArray(items) ? items.length : 0;
  const current = total > 0 ? items[Math.min(Math.max(0, index), total - 1)] : null;

  // Keyboard: arrows step through the library, Escape closes. Registered on the
  // window so it works whether focus is on the image, a button, or nothing.
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onIndex(index - 1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onIndex(index + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, onClose, onIndex]);

  // Lock the page behind the overlay, restoring the previous value on close.
  React.useEffect(() => {
    const body = typeof document !== 'undefined' ? document.body : null;
    const previous = body?.style.overflow ?? '';
    if (body) body.style.overflow = 'hidden';
    return () => {
      if (body) body.style.overflow = previous;
    };
  }, []);

  // Move focus into the dialog, and give it back to the opener on close.
  React.useEffect(() => {
    const opener = typeof document !== 'undefined' ? document.activeElement : null;
    try {
      closeButton.current?.focus?.();
    } catch { /* focus is best-effort */ }
    return () => {
      try {
        if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
      } catch { /* likewise */ }
    };
  }, []);

  if (!current) return null;
  const url = current.url;
  const job = current.job;
  const image = current.image;
  const favorite = image?.favorite === true || job?.favorite === true;
  const width = Number(image?.width) || Number(job?.width) || 0;
  const height = Number(image?.height) || Number(job?.height) || 0;
  const atStart = index <= 0;
  const atEnd = index >= total - 1;

  const step = (delta) => onIndex(index + delta);

  const run = async (action) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } catch { /* the panel shows its own error banner */ } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="cfql-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        className="cfql-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="图片查看器"
      >
        <div className="cfql-head">
          <span className="cfql-count">{index + 1} / {total}</span>
          <div className="cfql-headActions">
            <a href={url} target="_blank" rel="noreferrer" className="cfql-link">新窗口</a>
            <button type="button" ref={closeButton} className="cfql-close" onClick={onClose} aria-label="关闭">✕</button>
          </div>
        </div>

        <div className="cfql-stage">
          <button
            type="button"
            className="cfql-nav" data-side="left"
            onClick={() => step(-1)} disabled={atStart} aria-label="上一张"
          >‹</button>
          <img
            key={url}
            src={url}
            alt={String(image?.filename ?? '生成结果')}
            decoding="async"
          />
          <button
            type="button"
            className="cfql-nav" data-side="right"
            onClick={() => step(1)} disabled={atEnd} aria-label="下一张"
          >›</button>
        </div>

        <div className="cfql-body">
          <p className="cfql-prompt">{String(job?.prompt ?? '') || '（无提示词）'}</p>
          {job?.negative ? <p className="cfql-negative">负面：{String(job.negative)}</p> : null}
          <div className="cfql-meta">
            {width > 0 && height > 0 ? <span>{width}×{height}</span> : null}
            {Number(job?.steps) > 0 ? <span>{Number(job.steps)} 步</span> : null}
            {Number.isFinite(Number(job?.seed)) ? <span>seed {formatCount(job.seed)}</span> : null}
            {job?.presetName ? <span>{String(job.presetName)}</span> : null}
            {job?.createdAt ? <span>{formatRelativeTime(job.createdAt)}</span> : null}
          </div>
          <div className="cfql-actions">
            <button
              type="button"
              data-fav={favorite ? 'true' : 'false'}
              disabled={pending}
              onClick={() => run(() => onFavorite({ ...job, favorite }))}
            >{favorite ? '★ 已收藏' : '☆ 收藏'}</button>
            <a href={url} download={typeof image?.filename === 'string' ? image.filename : ''}>↓ 下载</a>
            <button
              type="button"
              disabled={pending || busyJob !== ''}
              onClick={() => run(async () => {
                if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                  && !window.confirm('删除这一组生成记录和图片？此操作不可恢复。')) return;
                await onDelete(job);
                // After a delete the viewer would point at a removed image;
                // show the neighbour, or close when it was the last one.
                if (total <= 1) onClose();
                else onIndex(index >= total - 1 ? index - 1 : index);
              })}
            >× 删除</button>
          </div>
        </div>
      </div>
    </div>
  );
}
