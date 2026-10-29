/**
 * Host-side contract tests that do not need a ComfyUI server.
 *
 * The RPC surface is the boundary a browser can reach, so these tests are about
 * what it refuses as much as what it returns: unknown methods, a bad envelope,
 * a wrong content type, and a missing service must all fail in a described way
 * instead of throwing through the carrier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_ENDPOINT, RPC_PATH, IMAGE_PATH, registerRpc } from '../host/rpc.js';
import { resolveConfig } from '../host/config.js';
import { ComfyService } from '../host/service.js';
import { isEditableField, resolveSettingsEntry } from '../host/settings-bridge.js';

/**
 * A tiny fake carrier that keeps the registered handlers addressable.
 */
function fakeRegistry() {
  const routes = new Map();
  return {
    routes,
    register({ path, methods, fetch }) {
      routes.set(path, { methods, fetch });
      return () => routes.delete(path);
    },
  };
}

function fakeCtx(registry, extra = {}) {
  return {
    connection: { fetch: registry },
    fiber: undefined,
    get(name) {
      return extra[name];
    },
  };
}

async function rpc(routes, method, payload = {}, { rpcId = 'r1', raw } = {}) {
  const route = routes.get(RPC_PATH);
  const body = raw ?? JSON.stringify({
    type: 'client-request',
    rpcId,
    method: RPC_ENDPOINT,
    payload: { method, payload },
  });
  const response = await route.fetch(new Request(`http://local${RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }));
  const json = await response.json();
  return { status: response.status, json };
}

/** A stub service that records the calls the RPC layer makes. */
function stubService(overrides = {}) {
  const calls = [];
  const base = {
    status: async () => ({ connected: false, jobs: [] }),
    markRead: () => ({ unread: 0 }),
    testConnection: async (input) => ({ ok: false, detail: 'stub', input }),
    models: async (options) => ({ ok: true, folders: {}, fetchedAt: 0, options }),
    settingsReadModel: () => ({ baseUrl: 'http://127.0.0.1:8188', authTokenConfigured: false }),
    settingsDefaults: () => ({ baseUrl: 'http://127.0.0.1:8188' }),
    describeSettings: () => ({ entryId: 'comfyui', revision: 3, readable: true }),
    listPresets: () => [{ id: 'zimage-turbo', name: 'Z', mode: 'unet' }],
    getPreset: (id) => ({ id, name: 'Z', mode: 'unet' }),
    savePreset: async (input) => ({ id: input.id ?? 'new', name: input.name }),
    deletePreset: async () => ({ deleted: true }),
    updateSettings: async (patch, revision) => ({ saved: true, entryId: 'comfyui', patch, revision }),
    resetSettings: async (revision) => ({ saved: true, entryId: 'comfyui', revision }),
    queueState: async () => ({ running: [], pending: [], jobs: [] }),
    cancel: async (input) => ({ canceled: 0, interrupted: false, input }),
    clearServerQueue: async () => ({ cleared: true }),
    getJob: (id) => (id === 'known' ? { id: 'known', status: 'succeeded' } : null),
    listJobs: (options) => ({ items: [], total: 0, options }),
    generate: async (input) => ({ id: 'job-1', ...input }),
    galleryList: async (options) => ({ items: [], total: 0, options }),
    galleryGet: async () => ({ id: 'x', images: [] }),
    galleryUpdate: async (id, patch) => ({ id, ...patch }),
    galleryDelete: async (ids) => ({ deleted: ids.length }),
    galleryStats: async () => ({ count: 0, bytes: 0, favorites: 0 }),
    galleryPrune: async (options) => ({ removed: 0, bytes: 0, options }),
    imageRecord: async () => null,
    imagePath: async () => null,
    client: { view: async () => ({ bytes: Buffer.from([1, 2, 3]), mediaType: 'image/png' }) },
  };
  for (const [key, fn] of Object.entries(overrides)) base[key] = fn;
  // Wrap everything so the tests can assert dispatch without knowing each shape.
  const wrapped = new Proxy(base, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls.push({ method: key, args });
        return value.apply(target, args);
      };
    },
  });
  return { service: wrapped, calls };
}

test('the RPC route paths are the ones the browser composes', () => {
  assert.equal(RPC_ENDPOINT, 'dsh-comfyui');
  assert.equal(RPC_PATH, '/api/dsh-comfyui');
  assert.equal(IMAGE_PATH, '/api/dsh-comfyui/image');
});

test('status.get round-trips through the envelope', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const { status, json } = await rpc(registry.routes, 'status.get');
  assert.equal(status, 200);
  assert.equal(json.type, 'server-response');
  assert.equal(json.rpcId, 'r1');
  assert.equal(json.result.ok, true);
  assert.equal(json.result.value.connected, false);
});

test('settings.get merges the read model with the form descriptor and presets', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const { json } = await rpc(registry.routes, 'settings.get');
  assert.equal(json.result.ok, true);
  assert.equal(json.result.value.entryId, 'comfyui');
  assert.equal(json.result.value.revision, 3);
  assert.ok(Array.isArray(json.result.value.presets));
  assert.equal(json.result.value.settings.baseUrl, 'http://127.0.0.1:8188');
});

test('an unknown method is refused with a coded error, not an exception', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const { status, json } = await rpc(registry.routes, 'nope.nothing');
  assert.equal(status, 200);
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'comfyui/unknown-method');
});

test('a service error keeps its code and message', async () => {
  const registry = fakeRegistry();
  const { service } = stubService({
    generate: async () => {
      const error = new Error('模型缺失');
      error.code = 'comfyui/model-missing';
      throw error;
    },
  });
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const { json } = await rpc(registry.routes, 'generate.start', { prompt: 'x' });
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'comfyui/model-missing');
  assert.equal(json.result.error.message, '模型缺失');
});

test('a wrong content type is rejected before parsing', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const route = registry.routes.get(RPC_PATH);
  const response = await route.fetch(new Request(`http://local${RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  }));
  assert.equal(response.status, 415);
});

test('a malformed envelope is answered with a bad-request result', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const { json } = await rpc(registry.routes, 'status.get', {}, {
    raw: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'someone-else', payload: {} }),
  });
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'comfyui/invalid');
});

test('a missing service reports offline instead of crashing', async () => {
  const registry = fakeRegistry();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => null });
  const { json } = await rpc(registry.routes, 'status.get');
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'comfyui/offline');
});

test('pagination inputs are clamped, not trusted', async () => {
  const registry = fakeRegistry();
  const { service, calls } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  await rpc(registry.routes, 'jobs.list', { limit: 99999, offset: -5 });
  const call = calls.find((item) => item.method === 'listJobs');
  assert.deepEqual(call.args[0], { limit: 200, offset: 0, status: undefined });

  await rpc(registry.routes, 'gallery.list', { limit: 0, offset: 10, query: 'x'.repeat(500) });
  const galleryCall = calls.find((item) => item.method === 'galleryList');
  assert.equal(galleryCall.args[0].limit, 1);
  assert.equal(galleryCall.args[0].offset, 10);
  assert.equal(galleryCall.args[0].query.length, 200);
});

test('jobs.get reports not-found for an unknown id', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const { json } = await rpc(registry.routes, 'jobs.get', { id: 'missing' });
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'comfyui/not-found');
});

test('the image route rejects a request with neither id nor filename', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const route = registry.routes.get(IMAGE_PATH);
  const response = await route.fetch(new Request(`http://local${IMAGE_PATH}`, { method: 'GET' }));
  assert.equal(response.status, 400);
});

test('the image route reports 404 for an unknown id', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const route = registry.routes.get(IMAGE_PATH);
  const response = await route.fetch(new Request(`http://local${IMAGE_PATH}?id=unknown`, { method: 'GET' }));
  assert.equal(response.status, 404);
});

test('the image route never serves a non-image content type', async () => {
  const registry = fakeRegistry();
  const { service } = stubService({
    imageRecord: async () => ({ id: 'i1', mediaType: 'text/html' }),
    imagePath: async () => '/nonexistent/definitely-missing.png',
  });
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const route = registry.routes.get(IMAGE_PATH);
  // A missing file must not fall through to a directory listing or a 500.
  const response = await route.fetch(new Request(`http://local${IMAGE_PATH}?id=i1`, { method: 'GET' }));
  assert.equal(response.status, 404);
});

test('the image route proxies a ComfyUI filename and forces an image content type', async () => {
  const registry = fakeRegistry();
  const { service } = stubService({
    client: { view: async () => ({ bytes: Buffer.from([9, 9]), mediaType: 'image/webp' }) },
  });
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const route = registry.routes.get(IMAGE_PATH);
  const response = await route.fetch(new Request(`http://local${IMAGE_PATH}?filename=a.png&type=output`, { method: 'GET' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /private/);
});

test('the image route maps a ComfyUI validation error to 400', async () => {
  const registry = fakeRegistry();
  const { service } = stubService({
    client: {
      view: async () => {
        const error = new Error('bad name');
        error.code = 'comfyui/invalid';
        throw error;
      },
    },
  });
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const route = registry.routes.get(IMAGE_PATH);
  const response = await route.fetch(new Request(`http://local${IMAGE_PATH}?filename=../etc/passwd`, { method: 'GET' }));
  assert.equal(response.status, 400);
});

test('registerRpc refuses a context without the connection carrier', async () => {
  await assert.rejects(
    registerRpc({ ctx: { get: () => undefined }, getService: () => null }),
    /Connection Fetch registry/,
  );
});

test('the disposer removes both routes and is idempotent', async () => {
  const registry = fakeRegistry();
  const { service } = stubService();
  const dispose = await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  assert.equal(registry.routes.size, 2);
  await dispose();
  assert.equal(registry.routes.size, 0);
  await dispose();
});

test('the settings write path only accepts declared fields', () => {
  assert.equal(isEditableField('baseUrl'), true);
  assert.equal(isEditableField('authToken'), true);
  assert.equal(isEditableField('presetId'), true);
  assert.equal(isEditableField('__proto__'), false);
  assert.equal(isEditableField('anythingElse'), false);
});

test('resolveSettingsEntry falls back to the row id without a configEditor', () => {
  const result = resolveSettingsEntry({ get: () => undefined, fiber: undefined });
  assert.equal(result.ns, 'comfyui');
  assert.equal(result.entry, null);
});

test('a settings save without the Settings service fails with an actionable code', async () => {
  const registry = fakeRegistry();
  const { service } = stubService({
    updateSettings: async () => {
      const error = new Error('dsh 的 Settings 服务未启用');
      error.code = 'comfyui/settings-unavailable';
      throw error;
    },
  });
  await registerRpc({ ctx: fakeCtx(registry), getService: () => service });
  const { json } = await rpc(registry.routes, 'settings.update', { patch: { width: 512 } });
  assert.equal(json.result.ok, false);
  assert.equal(json.result.error.code, 'comfyui/settings-unavailable');
});

test('a real service reports offline when no server answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-rpc-'));
  const service = new ComfyService({
    ctx: { get: () => undefined },
    logger: () => {},
    dir,
    config: resolveConfig({ baseUrl: 'http://127.0.0.1:1', requestTimeoutSeconds: 5 }),
  });
  try {
    await service.start();
    const status = await service.status();
    assert.equal(status.connected, false);
    assert.ok(status.lastError);
    assert.equal(typeof status.lastError.message, 'string');
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
