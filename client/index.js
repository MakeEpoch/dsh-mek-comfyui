/**
 * Browser half of `@dsh/comfyui`.
 *
 * Registers one settings section, one right-sidebar tab type (with its body
 * and guide entry), and the `comfyui_generate` conversation card. All
 * registrations live inside a single `ctx.effect`, so disposal is one cleanup
 * function; a partial failure tears everything down and logs once instead of
 * leaving a half-registered plugin behind.
 */
import * as React from 'react';
import { createRpc } from './rpc.js';
import { installStyles, removeStyles } from './styles.js';
import { SettingsPage } from './settings.jsx';
import { Panel } from './panel.jsx';
import { GenerateCard } from './tool-view.jsx';

export const name = 'dsh-comfyui-client';
export const inject = ['connection', 'slots', 'sidebarRight', 'sidebarRightTabs'];

/** Settings section id and sidebar tab type id. */
const SECTION_ID = 'comfyui';
const TAB_ID = '@dsh/comfyui';
const TAB_KIND = 'comfyui';
/** Settings nav position: after the media workflow section. */
const SECTION_ORDER = 34;
/** Guide-card position in the right sidebar's "add tab" list. */
const GUIDE_ORDER = 18;

/** Sidebar tab icon: a small image/spark glyph. */
const Icon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 4.5-4.5 3.5 3.5 3-3L20 17" />
  </svg>
);

/**
 * Wrap a component so a render failure inside the Host's slot tree shows a
 * readable fallback instead of unmounting the surrounding panel.
 */
function boundary(Component, label) {
  return class ComfyUiBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
      return { error };
    }

    componentDidCatch(error) {
      // Keep the console record for diagnosis; the UI stays usable.
      try { console.error(`[comfyui] ${label} 渲染失败：`, error); } catch { /* no console */ }
    }

    render() {
      if (this.state.error !== null) {
        return (
          <div className="cfq-banner" data-tone="error" role="alert">
            {label}渲染失败：{String(this.state.error?.message ?? this.state.error)}
          </div>
        );
      }
      return React.createElement(Component, this.props);
    }
  };
}

/**
 * Plugin body.
 * @param ctx dsh's client plugin context.
 */
export function apply(ctx) {
  let cleanup = () => {};
  try {
    cleanup = ctx.effect(() => {
      const disposers = [];
      const rpc = createRpc(ctx.connection);
      let disposed = false;
      let releaseStyles = () => {};

      /** Idempotent teardown that tolerates a partially finished setup. */
      const teardown = () => {
        if (disposed) return;
        disposed = true;
        for (const dispose of disposers.reverse()) {
          try { dispose?.(); } catch { /* one failing disposer must not stop the rest */ }
        }
        disposers.length = 0;
        try { rpc.dispose(); } catch { /* already closed */ }
        try { releaseStyles(); } catch { /* tag already gone */ }
        try { removeStyles(); } catch { /* tag already gone */ }
      };

      releaseStyles = installStyles();

      /** Register one slot contribution, recording its disposer. */
      const register = (label, run) => {
        try {
          const dispose = run();
          disposers.push(dispose);
          return true;
        } catch (error) {
          ctx.logger?.error?.(`[comfyui] client 注册失败：${error?.message ?? error}`);
          teardown();
          return false;
        }
      };

      const Settings = boundary(SettingsPage, 'ComfyUI 设置页');
      const PanelBody = boundary(Panel, 'ComfyUI 侧边栏');
      const Card = boundary(GenerateCard, 'ComfyUI 生成卡片');

      // The page and the panel read the same wrapper; a reset invalidates both.
      const settingsComponent = (props) => React.createElement(Settings, { ...props, rpc });
      settingsComponent.displayName = 'ComfyUiSettingsSection';
      const panelComponent = (props) => React.createElement(PanelBody, { ...props, rpc });
      panelComponent.displayName = 'ComfyUiSidebarTab';
      const cardComponent = (props) => React.createElement(Card, props);
      cardComponent.displayName = 'ComfyUiGenerateCard';

      register('settings.section', () => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: () => 'ComfyUI' },
        settingsComponent,
      )));

      register('sidebarRightTabs.register', () => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => 'ComfyUI',
        keepMounted: false,
        guide: [{
          id: 'comfyui',
          order: GUIDE_ORDER,
          title: () => 'ComfyUI 出图',
          description: () => '队列进度、生成参数与图片库',
          icon: Icon,
        }],
      }));

      register('sidebar.right.pane.tab', () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        panelComponent,
      )));

      register('tool.call.toolview', () => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
        {
          name: 'tool.call.toolview',
          key: 'comfyui_generate',
          // Shared presentation is a Factory, not a child-slot declaration.
          // `tool.call.images` belongs to the base read_image entry; declaring
          // it here would collide even though our toolview key is different.
        },
        cardComponent,
      )));

      register('connection/reset', () => ctx.on('connection/reset', () => {
        try { rpc.reset(); } catch { /* nothing cached */ }
      }));

      return teardown;
    }, 'comfyui: client');
  } catch (error) {
    // Never let a thrown registration escape `apply`.
    try { cleanup?.(); } catch { /* partial setup */ }
    ctx.logger?.error?.('[comfyui] client 注册失败：' + (error?.message ?? error));
  }
}
