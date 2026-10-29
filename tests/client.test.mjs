/** Browser registration/render contracts of the actual distributable (no DOM/GPU needed). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

// Deliberately small React double: elements are inspectable and hooks run once.
// These are composition-contract tests, not a substitute for browser rendering.
const React = {
  Component: class { constructor(props) { this.props = props; } },
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (current) => ({ current }),
};

function loadPlugin() {
  let plugin;
  vm.runInNewContext(bundle, {
    window: { __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, 'dsh-mek-comfyui');
      plugin = factory((name) => {
        assert.equal(name, 'react', `unexpected runtime import: ${name}`);
        return React;
      });
    } } },
    console,
    AbortController,
    DOMException,
  }, { filename: 'comfyui/lib/client.js' });
  assert.equal(typeof plugin?.apply, 'function');
  return plugin;
}

const once = (fn) => {
  let live = true;
  return () => { if (live) { live = false; fn?.(); } };
};

/** Strict declaration ownership, keyed contributions, and declaration-bound inject. */
function createHost() {
  const specs = new Map([
    ['settings.section', { kind: 'list', scope: 'root' }],
    ['sidebar.right.pane.tab', { kind: 'keyed', scope: 'session' }],
    ['tool.call.toolview', { kind: 'keyed', scope: 'session' }],
  ]);
  const entries = new Map();
  const watchers = new Map();
  const effects = [];
  const errors = [];
  const tabs = new Map();
  const events = new Map();
  const notify = (name) => { for (const fn of watchers.get(name) ?? []) fn(); };
  const slots = {
    register(options, component) {
      const spec = specs.get(options.name);
      assert.ok(spec, `undeclared slot: ${options.name}`);
      // Children live in one registry, NOT underneath options.key or scope.
      for (const name of Object.keys(options.children ?? {})) {
        if (specs.has(name)) throw new Error(`slot "${name}" is already declared`);
      }
      const list = entries.get(options.name) ?? [];
      const cell = spec.kind === 'keyed' ? 'key' : spec.kind === 'list' ? 'id' : null;
      assert.ok(!list.some((entry) => (!cell || entry.options[cell] === options[cell]) && (entry.options.priority ?? 0) === (options.priority ?? 0)), 'duplicate slot cell');
      const entry = { options, component };
      entries.set(options.name, [...list, entry]);
      for (const [name, child] of Object.entries(options.children ?? {})) {
        specs.set(name, child);
        notify(name);
      }
      return once(() => {
        entries.set(options.name, (entries.get(options.name) ?? []).filter((item) => item !== entry));
        for (const name of Object.keys(options.children ?? {})) {
          specs.delete(name);
          notify(name);
        }
      });
    },
    inject(name, install) {
      let dispose;
      let active = false;
      const reconcile = () => {
        if (active && !specs.has(name)) { dispose?.(); dispose = undefined; active = false; }
        if (!active && specs.has(name)) { dispose = install(); active = true; }
      };
      const listeners = watchers.get(name) ?? new Set();
      listeners.add(reconcile);
      watchers.set(name, listeners);
      try { reconcile(); } catch (error) { listeners.delete(reconcile); throw error; }
      return once(() => { listeners.delete(reconcile); dispose?.(); });
    },
  };
  const ctx = {
    slots,
    connection: { rpc: { call() { throw new Error('unexpected RPC during registration'); } } },
    sidebarRight: {},
    sidebarRightTabs: { register(tab) {
      assert.ok(!tabs.has(tab.id));
      tabs.set(tab.id, tab);
      return once(() => tabs.delete(tab.id));
    } },
    logger: { error: (message) => errors.push(message) },
    effect(fn) {
      const dispose = once(fn());
      effects.push(dispose);
      return dispose;
    },
    on(name, fn) {
      events.set(name, fn);
      return once(() => events.delete(name));
    },
  };
  return { ctx, specs, entries, tabs, errors, events, dispose: () => [...effects].reverse().forEach((fn) => fn()) };
}

function registerReadImage(host) {
  return host.ctx.slots.register({
    name: 'tool.call.toolview', key: 'read_image',
    children: { 'tool.call.images': { kind: 'single', scope: 'session' } },
  }, () => null);
}

function cardOf(host) {
  const entry = host.entries.get('tool.call.toolview')?.find((item) => item.options.key === 'comfyui_generate');
  assert.ok(entry, `ComfyUI card missing: ${host.errors.join('; ')}`);
  assert.equal(entry.options.children, undefined, 'must not redeclare a base-owned image position');
  return entry.component;
}

for (const baseFirst of [true, false]) {
  test(`read_image and ComfyUI coexist (${baseFirst ? 'base' : 'plugin'} first), including disposal/reload`, () => {
    const host = createHost();
    const plugin = loadPlugin();
    let disposeRead;
    if (baseFirst) disposeRead = registerReadImage(host);
    plugin.apply(host.ctx);
    if (!baseFirst) disposeRead = registerReadImage(host);
    cardOf(host);
    assert.equal(host.entries.get('tool.call.toolview').length, 2);
    assert.equal(host.entries.get('settings.section').length, 1);
    assert.equal(host.entries.get('sidebar.right.pane.tab').length, 1);
    assert.equal(host.tabs.has('@dsh/comfyui'), true);
    assert.equal(host.errors.length, 0);

    disposeRead();
    cardOf(host); // the plugin does not depend on the read_image declaration lifetime
    disposeRead = registerReadImage(host);
    host.dispose();
    assert.equal(host.entries.get('tool.call.toolview').length, 1);
    assert.equal(host.entries.get('tool.call.toolview')[0].options.key, 'read_image');
    assert.equal(host.specs.has('tool.call.images'), true);
    assert.equal(host.tabs.size, 0);
    assert.equal(host.entries.get('settings.section').length, 0);
    assert.equal(host.entries.get('sidebar.right.pane.tab').length, 0);
    assert.equal(host.events.size, 0);

    plugin.apply(host.ctx);
    cardOf(host);
    assert.equal(host.errors.length, 0);
    host.dispose();
    disposeRead();
  });
}

function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    return expand(node.type.prototype instanceof React.Component
      ? new node.type(node.props).render()
      : node.type(node.props));
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
}

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => elements(node, predicate));
  if (tree === null || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

const attachment = { attachmentId: 'att-1', mediaType: 'image/png', width: 32, height: 32 };
function blockWithImages({ attachments = true } = {}) {
  return {
    phase: 'result', args: { prompt: 'test' },
    content: [
      { type: 'text', text: JSON.stringify({ images: [{ url: '/api/dsh-comfyui/image?id=i1', filename: 'test.png' }] }) },
      ...(attachments ? [{ type: 'image', attachment }] : []),
    ],
  };
}

function renderCard(props) {
  const host = createHost();
  loadPlugin().apply(host.ctx);
  const tree = expand(React.createElement(cardOf(host), props));
  host.dispose();
  return tree;
}

test('durable attachments use the shared gallery Factory, never a base child slot', () => {
  const calls = [];
  const loadImage = async () => new Blob();
  const tree = renderCard({
    phase: 'result', block: blockWithImages(), loadImage,
    renderSlot() { assert.fail('must not render another entry\'s child slot'); },
    renderFactorySlot(name, props, options) {
      calls.push({ name, props, options });
      return React.createElement('official-gallery', props);
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'conversation.images.content');
  assert.equal(calls[0].props.loadImage, loadImage);
  assert.equal(calls[0].props.images.length, 1);
  assert.equal(calls[0].props.images[0].attachment, attachment);
  assert.equal(calls[0].props.align, 'start');
  assert.equal(elements(calls[0].options.fallback, (node) => node.type === 'img').length, 1);
  assert.equal(elements(tree, (node) => node.type === 'official-gallery').length, 1);
  assert.equal(elements(tree, (node) => node.type === 'img').length, 0);
});

for (const reason of ['old renderer', 'no loader', 'no attachments', 'missing factory', 'throws', 'returns null']) {
  test(`image thumbnails remain available: ${reason}`, () => {
    let called = false;
    const props = {
      phase: 'result', block: blockWithImages({ attachments: reason !== 'no attachments' }),
      loadImage: reason === 'no loader' ? undefined : async () => new Blob(),
      renderFactorySlot: reason === 'old renderer' ? undefined : (name, input, options) => {
        called = true;
        if (reason === 'throws') throw new Error('unavailable');
        if (reason === 'returns null') return null;
        // Like FactoryOutlet: resolve fallback during render, not during dispatch.
        return React.createElement(() => options.fallback);
      },
    };
    const tree = renderCard(props);
    const images = elements(tree, (node) => node.type === 'img');
    assert.equal(images.length, 1);
    assert.equal(images[0].props.src, '/api/dsh-comfyui/image?id=i1');
    assert.equal(called, !['old renderer', 'no loader', 'no attachments'].includes(reason));
  });
}

test('running and text-only results never dispatch an image Factory', () => {
  for (const props of [
    { phase: 'start', block: { args: { prompt: 'test' } } },
    { phase: 'result', block: { phase: 'result', content: [{ type: 'text', text: '{"message":"queued"}' }] } },
  ]) {
    const tree = renderCard({ ...props, loadImage: async () => new Blob(), renderFactorySlot() { assert.fail('unexpected gallery'); } });
    assert.equal(elements(tree, (node) => node.type === 'img').length, 0);
    assert.equal(elements(tree, (node) => node.props?.role === 'alert').length, 0);
  }
});
