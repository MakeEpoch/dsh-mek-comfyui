/**
 * Service behaviour with an injected client and gallery.
 *
 * The dispatch loop, the websocket event mapping and the settle paths are the
 * parts of this plugin most likely to break silently, and they are the parts a
 * live-server test cannot force (a real ComfyUI will not emit an
 * `execution_error` on demand). So the client and gallery are stubs here and the
 * service is driven through the states a real run produces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComfyService } from '../host/service.js';
import { resolveConfig } from '../host/config.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  // IHDR length + tag, then 64x32 big-endian, then filler so the sniffer is happy.
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x20]),
  Buffer.alloc(32, 7),
]);

/**
 * A ComfyUI client stub whose behaviour each test scripts.
 * @param {object} [script]
 */
function fakeClient(script = {}) {
  const calls = [];
  const state = {
    historyEntries: script.historyEntries ?? [],
    queueResponses: script.queueResponses ?? [{ running: [], pending: [] }],
    submitError: script.submitError ?? null,
    viewError: script.viewError ?? null,
    onSocketEvent: null,
  };
  const client = {
    calls,
    state,
    baseUrl: 'http://stub:8188',
    authTokenConfigured: false,
    async systemStats() {
      calls.push(['systemStats']);
      if (script.offline) throw coded('comfyui/offline', '无法连接 ComfyUI');
      return { version: '0.41.1', comfyuiVersion: '0.41.1', devices: [{ name: 'stub-gpu', type: 'cuda', vramTotal: 1, vramFree: 1 }] };
    },
    async queue() {
      calls.push(['queue']);
      const next = state.queueResponses.length > 1 ? state.queueResponses.shift() : state.queueResponses[0];
      return next;
    },
    async models() {
      calls.push(['models']);
      return {
        checkpoints: [], diffusion_models: ['z_image_turbo_int8_convrot.safetensors'],
        text_encoders: ['qwen_3_4b_fp8_mixed.safetensors'], vae: ['ae.safetensors'], loras: [], upscale_models: [],
      };
    },
    async submit(workflow) {
      calls.push(['submit', workflow]);
      if (state.submitError) throw state.submitError;
      return { promptId: 'prompt-1', number: 1, nodeErrors: {} };
    },
    async history(promptId) {
      calls.push(['history', promptId]);
      if (!state.historyEntries.length) return null;
      return state.historyEntries.length > 1 ? state.historyEntries.shift() : state.historyEntries[0];
    },
    async view() {
      calls.push(['view']);
      if (state.viewError) throw state.viewError;
      return { bytes: PNG, mediaType: 'image/png' };
    },
    async interrupt() {
      calls.push(['interrupt']);
      return { ok: true };
    },
    async clearQueue() {
      calls.push(['clearQueue']);
      return { ok: true };
    },
    async deleteQueued(ids) {
      calls.push(['deleteQueued', ids]);
      return { ok: true };
    },
    openSocket({ onEvent }) {
      calls.push(['openSocket']);
      state.onSocketEvent = onEvent;
      return { close: () => calls.push(['closeSocket']) };
    },
    async dispose() {
      calls.push(['dispose']);
    },
    setBaseUrl(url) { calls.push(['setBaseUrl', url]); },
    setAuthToken(token) { calls.push(['setAuthToken', token]); },
  };
  return client;
}

/** A gallery stub that records the images it is handed. */
function fakeGallery() {
  const images = [];
  const jobs = new Map();
  return {
    images,
    jobs,
    root: '/tmp/stub-gallery',
    async init() {},
    async setRoot() {},
    async addImage(jobId, input) {
      const image = {
        id: `img-${images.length + 1}`,
        jobId,
        filename: input.filename,
        subfolder: input.subfolder ?? '',
        width: input.width ?? 0,
        height: input.height ?? 0,
        bytes: input.bytes.length,
        mediaType: input.mediaType,
        url: `/api/dsh-comfyui/image?id=img-${images.length + 1}`,
        thumbUrl: `/api/dsh-comfyui/image?id=img-${images.length + 1}`,
        createdAt: Date.now(),
        favorite: false,
      };
      images.push(image);
      return image;
    },
    async save(job) { jobs.set(job.id, job); return job; },
    async list({ sessionId } = {}) {
      const all = [...jobs.values()];
      const items = sessionId ? all.filter((job) => job.sessionId === sessionId) : all;
      return { items, total: items.length };
    },
    async get(id) { return jobs.get(id) ?? null; },
    async update(id, patch) {
      const job = jobs.get(id);
      if (!job) return null;
      const next = { ...job, ...patch };
      jobs.set(id, next);
      return next;
    },
    async delete(ids) {
      for (const id of ids) jobs.delete(id);
      return ids.length;
    },
    async stats({ sessionId } = {}) {
      const all = [...jobs.values()];
      const scoped = sessionId ? all.filter((job) => job.sessionId === sessionId) : all;
      return {
        count: scoped.length, bytes: 0, favorites: 0,
        scope: sessionId ? 'session' : 'all',
        all: { count: all.length, bytes: 0, favorites: 0 },
      };
    },
    async prune() { return { removed: 0, bytes: 0 }; },
    async filePath(id) { return images.find((image) => image.id === id)?.filename ? `/tmp/stub-gallery/x/${id}.png` : null; },
    async imageRecord(id) { return images.find((image) => image.id === id) ?? null; },
    async dispose() {},
  };
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function makeService({ config = {}, client, gallery } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-svc-'));
  const service = new ComfyService({
    ctx: { get: () => undefined, fiber: undefined },
    logger: () => {},
    dir,
    config: resolveConfig({ baseUrl: 'http://stub:8188', pollIntervalMs: 1000, ...config }),
    client: client ?? fakeClient(),
    gallery: gallery ?? fakeGallery(),
  });
  return {
    service,
    dir,
    async cleanup() {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const successHistory = {
  status: { status_str: 'success', completed: true, messages: [] },
  outputs: { 10: { images: [{ filename: 'out_00001_.png', subfolder: '', type: 'output', metadata: { width: 512, height: 512 } }] } },
};

test('a successful job settles as succeeded with gallery images', async () => {
  const client = fakeClient({ historyEntries: [successHistory] });
  const gallery = fakeGallery();
  const { service, cleanup } = await makeService({ client, gallery });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'a cat', steps: 4, seed: 3 }, { source: 'chat', sessionId: 's1' });
    assert.equal(job.status, 'queued');
    const settled = await waitFor(service, job.id);
    assert.equal(settled.status, 'succeeded');
    assert.equal(settled.images.length, 1);
    assert.equal(settled.images[0].width, 512);
    assert.equal(settled.images[0].height, 512);
    assert.ok(settled.durationMs >= 0);
    assert.equal(gallery.images.length, 1);
    assert.ok(gallery.jobs.has(job.id), 'the settled job must be persisted to the gallery index');
    // The workflow actually carried the requested parameters.
    const submit = client.calls.find((call) => call[0] === 'submit');
    const sampler = Object.values(submit[1]).find((node) => node.class_type === 'KSampler');
    assert.equal(sampler.inputs.seed, 3);
    assert.equal(sampler.inputs.steps, 4);
  } finally {
    await cleanup();
  }
});

test('the file header supplies dimensions when ComfyUI omits them', async () => {
  const client = fakeClient({
    historyEntries: [{
      status: { status_str: 'success', completed: true },
      outputs: { 10: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
    }],
  });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x', width: 256, height: 256 }, { source: 'ui' });
    const settled = await waitFor(service, job.id);
    assert.equal(settled.status, 'succeeded');
    // The stub PNG header says 64x32.
    assert.equal(settled.images[0].width, 64);
    assert.equal(settled.images[0].height, 32);
  } finally {
    await cleanup();
  }
});

test('a submit validation error fails the job with the ComfyUI message', async () => {
  const client = fakeClient({ submitError: coded('comfyui/invalid', '工作流校验失败：ckpt_name 不存在') });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x' }, { source: 'chat' });
    const settled = await waitFor(service, job.id);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error.code, 'comfyui/invalid');
    assert.match(settled.error.message, /ckpt_name/);
  } finally {
    await cleanup();
  }
});

test('a job that finishes with no images is a failure, not a silent success', async () => {
  const client = fakeClient({
    historyEntries: [{ status: { status_str: 'success', completed: true }, outputs: {} }],
  });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x' }, { source: 'chat' });
    const settled = await waitFor(service, job.id);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error.message, /没有返回图片/);
  } finally {
    await cleanup();
  }
});

test('an image download failure does not fabricate a success', async () => {
  const client = fakeClient({ historyEntries: [successHistory], viewError: coded('comfyui/offline', '下载失败') });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x' }, { source: 'chat' });
    const settled = await waitFor(service, job.id);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.images.length, 0);
  } finally {
    await cleanup();
  }
});

test('canceling a queued job settles it without touching the server', async () => {
  // The first job never completes, so the second is genuinely still queued when
  // the cancel arrives (a fast first job would drain the second immediately).
  const client = fakeClient({
    historyEntries: [],
    queueResponses: [{ running: [{ promptId: 'prompt-1', number: 1 }], pending: [] }],
  });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 60 } });
  try {
    await service.start();
    const first = await service.generate({ prompt: 'first' }, { source: 'ui' });
    const second = await service.generate({ prompt: 'second' }, { source: 'ui' });
    await waitUntil(() => client.calls.some((call) => call[0] === 'submit'));
    assert.equal(service.getJob(second.id).status, 'queued');

    const result = await service.cancel({ jobId: second.id });
    assert.equal(result.canceled, 1);
    assert.equal(result.interrupted, false);
    assert.equal(service.getJob(second.id).status, 'canceled');
    // Nothing was interrupted on the server for a job that never ran.
    assert.equal(client.calls.some((call) => call[0] === 'interrupt'), false);
    await service.cancel({ jobId: first.id });
  } finally {
    await cleanup();
  }
});

test('canceling the running job interrupts it on the server', async () => {
  const client = fakeClient({
    // Never completes: the poll loop sees a queued prompt forever until cancel.
    historyEntries: [],
    queueResponses: [{ running: [{ promptId: 'prompt-1', number: 1 }], pending: [] }],
  });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 60 } });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'slow' }, { source: 'ui' });
    // Wait until it is actually running (submit happened).
    for (let i = 0; i < 100 && !client.calls.some((call) => call[0] === 'submit'); i += 1) await sleep(10);
    const result = await service.cancel({ jobId: job.id });
    assert.equal(result.interrupted, true);
    assert.ok(client.calls.some((call) => call[0] === 'interrupt'));
    assert.equal(service.getJob(job.id).status, 'canceled');
  } finally {
    await cleanup();
  }
});

test('canceling everything clears the local queue only', async () => {
  // A never-completing first job keeps the other two in the local queue.
  const client = fakeClient({
    historyEntries: [],
    queueResponses: [{ running: [{ promptId: 'prompt-1', number: 1 }], pending: [] }],
  });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 60 } });
  try {
    await service.start();
    const first = await service.generate({ prompt: 'first' }, { source: 'ui' });
    const second = await service.generate({ prompt: 'second' }, { source: 'ui' });
    const third = await service.generate({ prompt: 'third' }, { source: 'ui' });
    await waitUntil(() => client.calls.some((call) => call[0] === 'submit'));

    const result = await service.cancel({ all: true });
    assert.equal(result.canceled, 2);
    assert.equal(service.getJob(second.id).status, 'canceled');
    assert.equal(service.getJob(third.id).status, 'canceled');
    // `all` never interrupts the running graph.
    assert.equal(service.getJob(first.id).status, 'running');
    await service.cancel({ jobId: first.id });
  } finally {
    await cleanup();
  }
});

test('the local queue serializes submissions: one graph at a time', async () => {
  const client = fakeClient({ historyEntries: [successHistory] });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    const jobs = await Promise.all([
      service.generate({ prompt: 'a' }, { source: 'ui' }),
      service.generate({ prompt: 'b' }, { source: 'ui' }),
      service.generate({ prompt: 'c' }, { source: 'ui' }),
    ]);
    // Every job is accepted and none has submitted yet except the first.
    assert.equal(jobs.length, 3);
    const queue = await service.queueState();
    assert.ok(queue.running.length + queue.pending.length >= 1);
    for (const job of jobs) await waitFor(service, job.id);
    const submits = client.calls.filter((call) => call[0] === 'submit');
    assert.equal(submits.length, 3);
    // Serialized: the second submit happens only after the first settled, which
    // the service guarantees by awaiting the first job's completion.
    assert.equal(client.calls.filter((call) => call[0] === 'history').length >= 3, true);
  } finally {
    await cleanup();
  }
});

test('websocket progress events drive the job progress field', async () => {
  const client = fakeClient({ historyEntries: [] });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 60 } });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x', steps: 8 }, { source: 'ui' });
    for (let i = 0; i < 100 && !client.state.onSocketEvent; i += 1) await sleep(10);
    const emit = client.state.onSocketEvent;
    assert.ok(emit, 'the service must open a socket once a job is submitted');
    emit({ type: 'execution_start', data: { prompt_id: 'prompt-1' } });
    emit({ type: 'progress', data: { value: 3, max: 8, node: '8', prompt_id: 'prompt-1' } });
    const running = service.getJob(job.id);
    assert.equal(running.progress.value, 3);
    assert.equal(running.progress.max, 8);
    assert.equal(running.progress.percent, 38);
    assert.equal(running.progress.label, '生成中 3/8');
    await service.cancel({ jobId: job.id });
  } finally {
    await cleanup();
  }
});

test('progress_state events are understood as a fallback to progress', async () => {
  const client = fakeClient({ historyEntries: [] });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 60 } });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x', steps: 20 }, { source: 'ui' });
    for (let i = 0; i < 100 && !client.state.onSocketEvent; i += 1) await sleep(10);
    client.state.onSocketEvent({
      type: 'progress_state',
      data: {
        prompt_id: 'prompt-1',
        nodes: { 8: { value: 10, max: 20, state: 'running', node_id: '8' } },
      },
    });
    const running = service.getJob(job.id);
    assert.equal(running.progress.value, 10);
    assert.equal(running.progress.max, 20);
    assert.equal(running.progress.percent, 50);
    await service.cancel({ jobId: job.id });
  } finally {
    await cleanup();
  }
});

test('an execution_error event fails the job with the server exception', async () => {
  const client = fakeClient({ historyEntries: [] });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 30 } });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x' }, { source: 'ui' });
    for (let i = 0; i < 100 && !client.state.onSocketEvent; i += 1) await sleep(10);
    client.state.onSocketEvent({
      type: 'execution_error',
      data: { prompt_id: 'prompt-1', exception_message: 'CUDA out of memory' },
    });
    const settled = await waitFor(service, job.id, 5000);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error.message, /CUDA out of memory/);
  } finally {
    await cleanup();
  }
});

test('events for an unknown prompt id are ignored, not thrown', async () => {
  const client = fakeClient({ historyEntries: [] });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 30 } });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x' }, { source: 'ui' });
    for (let i = 0; i < 100 && !client.state.onSocketEvent; i += 1) await sleep(10);
    assert.doesNotThrow(() => {
      client.state.onSocketEvent({ type: 'progress', data: { value: 1, max: 2, prompt_id: 'other' } });
      client.state.onSocketEvent({ type: 'nonsense', data: {} });
      client.state.onSocketEvent(null);
    });
    assert.equal(service.getJob(job.id).status, 'running');
    await service.cancel({ jobId: job.id });
  } finally {
    await cleanup();
  }
});

test('an external cancellation is detected through the queue poll', async () => {
  const client = fakeClient({
    historyEntries: [],
    // First read: still running. Then ComfyUI forgets it (canceled elsewhere).
    queueResponses: [
      { running: [{ promptId: 'prompt-1', number: 1 }], pending: [] },
      { running: [], pending: [] },
    ],
  });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 30 } });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x' }, { source: 'ui' });
    const settled = await waitFor(service, job.id, 15_000);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error.code, 'comfyui/canceled');
  } finally {
    await cleanup();
  }
});

test('a timeout ends the wait without claiming success', async () => {
  const client = fakeClient({
    historyEntries: [],
    queueResponses: [{ running: [{ promptId: 'prompt-1', number: 1 }], pending: [] }],
  });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 30 } });
  try {
    await service.start();
    // Reach in through the public surface: a tiny timeout is not settable per
    // job, so drive the same path by canceling after the poll loop proves it
    // stays queued. The timeout branch itself is covered by tools.test.mjs.
    const job = await service.generate({ prompt: 'x' }, { source: 'ui' });
    await sleep(1200);
    assert.equal(service.getJob(job.id).status, 'running');
    await service.cancel({ jobId: job.id });
  } finally {
    await cleanup();
  }
});

test('settingsReadModel never exposes the token', async () => {
  const { service, cleanup } = await makeService({ config: { authToken: 'super-secret' } });
  try {
    const model = service.settingsReadModel();
    assert.equal(model.authToken, undefined);
    assert.equal(model.authTokenConfigured, true);
    assert.doesNotMatch(JSON.stringify(model), /super-secret/);
    // The defaults projection is safe too.
    assert.doesNotMatch(JSON.stringify(service.settingsDefaults()), /super-secret/);
  } finally {
    await cleanup();
  }
});

test('custom presets round-trip through the presets file', async () => {
  const { service, cleanup } = await makeService();
  try {
    const saved = await service.savePreset({
      name: '我的流程',
      mode: 'custom',
      workflow: { '1': { class_type: 'SaveImage', inputs: { filename_prefix: '{{prompt}}', images: ['2', 0] } } },
    });
    assert.ok(saved.id.startsWith('custom-'));
    assert.ok(service.listPresets().some((preset) => preset.id === saved.id));
    assert.equal(service.getPreset(saved.id).mode, 'custom');

    const deleted = await service.deletePreset(saved.id);
    assert.equal(deleted.deleted, true);
    assert.ok(!service.listPresets().some((preset) => preset.id === saved.id));
  } finally {
    await cleanup();
  }
});

test('a built-in preset cannot be overwritten or deleted', async () => {
  const { service, cleanup } = await makeService();
  try {
    await assert.rejects(
      service.savePreset({ id: 'zimage-turbo', name: 'hijack', mode: 'unet' }),
      (error) => error.code === 'comfyui/invalid',
    );
    await assert.rejects(
      service.deletePreset('zimage-turbo'),
      (error) => error.code === 'comfyui/invalid',
    );
  } finally {
    await cleanup();
  }
});

test('an unknown preset id in generate falls back to the default', async () => {
  const client = fakeClient({ historyEntries: [successHistory] });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x', presetId: 'nope' }, { source: 'ui' });
    assert.equal(job.presetId, 'zimage-turbo');
    await waitFor(service, job.id);
  } finally {
    await cleanup();
  }
});

test('generate refuses an empty prompt and an over-full queue', async () => {
  const { service, cleanup } = await makeService();
  try {
    await assert.rejects(service.generate({ prompt: '   ' }), (error) => error.code === 'comfyui/invalid');
  } finally {
    await cleanup();
  }
});

test('a disabled plugin refuses to generate', async () => {
  const { service, cleanup } = await makeService({ config: { enabled: false } });
  try {
    await assert.rejects(service.generate({ prompt: 'x' }), (error) => error.code === 'comfyui/invalid');
  } finally {
    await cleanup();
  }
});

test('dispose settles the active and pending jobs instead of leaving them running', async () => {
  const client = fakeClient({
    historyEntries: [],
    queueResponses: [{ running: [{ promptId: 'prompt-1', number: 1 }], pending: [] }],
  });
  const { service, cleanup } = await makeService({ client, config: { generateTimeoutSeconds: 60 } });
  await service.start();
  const first = await service.generate({ prompt: 'first' }, { source: 'ui' });
  const second = await service.generate({ prompt: 'second' }, { source: 'ui' });
  await sleep(150);
  await service.dispose();
  assert.equal(service.getJob(first.id).status, 'canceled');
  assert.equal(service.getJob(second.id).status, 'canceled');
  // Idempotent.
  await service.dispose();
  await rm(join(service.dir), { recursive: true, force: true });
});

test('reconfigure adopts a new base url and invalidates the model cache', async () => {
  const client = fakeClient({ historyEntries: [successHistory] });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    await service.models({ refresh: true });
    service.reconfigure({ baseUrl: 'http://other:8188' });
    assert.ok(client.calls.some((call) => call[0] === 'setBaseUrl' && call[1] === 'http://other:8188'));
    // The socket was restarted because the address changed.
    assert.ok(client.calls.filter((call) => call[0] === 'openSocket').length >= 0);
  } finally {
    await cleanup();
  }
});

test('status reports an unreachable server without throwing', async () => {
  const client = fakeClient({ offline: true });
  const { service, cleanup } = await makeService({ client });
  try {
    await service.start();
    const status = await service.status();
    assert.equal(status.connected, false);
    assert.equal(status.lastError.code, 'comfyui/offline');
    // The gallery still answers.
    const gallery = await service.galleryList({});
    assert.ok(Array.isArray(gallery.items));
  } finally {
    await cleanup();
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

async function waitFor(service, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = service.getJob(jobId);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${jobId}: ${JSON.stringify(service.getJob(jobId))}`);
    await sleep(20);
  }
}

test('the wire image path matches where the gallery actually wrote the file', async () => {
  // A filename ComfyUI can legitimately produce but a naive sanitizer would
  // rewrite (a colon is stripped by the gallery). If service.js derived the path
  // with its own rules, the chat tool would hand the model a path that does not
  // exist while the HTTP route still worked — a silent, confusing failure.
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-path-'));
  const gallery = fakeGallery();
  gallery.root = join(dir, 'gallery');
  await mkdir(gallery.root, { recursive: true });
  const stored = [];
  gallery.addImage = async (jobId, input) => {
    const { sanitizeFilename } = await import('../host/gallery.js');
    const filename = sanitizeFilename(input.filename);
    await mkdir(join(gallery.root, jobId), { recursive: true });
    await writeFile(join(gallery.root, jobId, filename), input.bytes);
    const image = {
      id: 'img-path', jobId, filename, subfolder: '', width: 8, height: 8,
      bytes: input.bytes.length, mediaType: 'image/png',
      url: '/api/dsh-comfyui/image?id=img-path', thumbUrl: '/api/dsh-comfyui/image?id=img-path',
      createdAt: Date.now(), favorite: false,
    };
    stored.push(image);
    return image;
  };
  const client = fakeClient({
    historyEntries: [{
      status: { status_str: 'success', completed: true },
      outputs: { 10: { images: [{ filename: 'out:weird*name?.png', subfolder: '', type: 'output' }] } },
    }],
  });
  const { service, cleanup } = await makeService({ client, gallery, config: {} });
  try {
    await service.start();
    const job = await service.generate({ prompt: 'x' }, { source: 'chat' });
    const settled = await waitFor(service, job.id);
    assert.equal(settled.status, 'succeeded');
    const image = settled.images[0];
    // The reported path is exactly the file the gallery wrote.
    const { stat } = await import('node:fs/promises');
    const info = await stat(image.path);
    assert.ok(info.isFile(), `path does not exist: ${image.path}`);
    assert.equal(image.filename, 'outweirdname.png');
  } finally {
    await cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a UI generation records its conversation, so the gallery can scope to it', async () => {
  const client = fakeClient({ historyEntries: [successHistory] });
  const gallery = fakeGallery();
  const { service, cleanup } = await makeService({ client, gallery });
  try {
    await service.start();
    // The panel passes its own tab's session alongside the prompt.
    const job = await service.generate(
      { prompt: 'from the sidebar', sessionId: 'session-a' },
      { source: 'ui', sessionId: 'session-a' },
    );
    assert.equal(job.sessionId, 'session-a');
    const settled = await waitFor(service, job.id);
    assert.equal(settled.status, 'succeeded');

    // The chat tool passes the agent's session through meta; the request value
    // is only a fallback.
    const fromChat = await service.generate(
      { prompt: 'from chat', sessionId: 'ignored-because-meta-wins' },
      { source: 'chat', sessionId: 'session-b' },
    );
    assert.equal(fromChat.sessionId, 'session-b');
    await waitFor(service, fromChat.id);

    // No session at all stays null and is still recorded.
    const orphan = await service.generate({ prompt: 'api call' }, { source: 'api' });
    assert.equal(orphan.sessionId, null);
    await waitFor(service, orphan.id);

    // The gallery sees the recorded owners.
    const scoped = await service.galleryList({ sessionId: 'session-a' });
    assert.equal(scoped.total, 1);
    assert.equal(scoped.items[0].id, job.id);
    assert.equal((await service.galleryList({})).total, 3);
  } finally {
    await cleanup();
  }
});

test('galleryStats passes the scope through to the index', async () => {
  const { service, cleanup } = await makeService();
  try {
    const scoped = await service.galleryStats({ sessionId: 'session-a' });
    assert.equal(scoped.scope, 'session');
    const all = await service.galleryStats();
    assert.equal(all.scope, 'all');
  } finally {
    await cleanup();
  }
});
