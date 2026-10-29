/**
 * Tool registration and rendering.
 *
 * The point of these tests is that the model-facing surface is well formed: the
 * registry accepts every schema, the tools refuse to run without a service, and
 * a settled job renders a text envelope a model can act on. No ComfyUI server is
 * required — the service is a stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  TOOL_CANCEL, TOOL_GENERATE, TOOL_MODELS, TOOL_STATUS,
  installComfyTools, installComfyIntegration, waitForJob,
} from '../host/tools.js';

/** A registry-shaped recorder that also validates via the real defineTool. */
function fakeTools() {
  const registered = new Map();
  return {
    registered,
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  };
}

/**
 * A scope that models Cordis's inject guard faithfully.
 *
 * The first version of this double exposed every service as a plain property,
 * so `ctx.tools` always worked and the real host's
 * `cannot get property "tools" without inject` slipped through to production.
 * Here an undeclared service access throws exactly like a Cordis Proxy, and
 * `inject(names, callback)` hands the callback a scope that declared them.
 *
 * @param {Record<string, unknown>} services services this scope can provide
 * @param {string[]} [declared] names already injected on this scope
 */
function fakeScope(services = {}, declared = []) {
  const effective = { tools: fakeTools(), ...services };
  const own = new Set(declared);
  const scope = {
    __disposers: [],
    __children: [],
    get(name) {
      // Resolution without the guard, like Cordis's `ctx.get`.
      return effective[name];
    },
    inject(names, callback) {
      const child = fakeScope(effective, [...own, ...names]);
      scope.__children.push(child);
      const dispose = callback(child);
      const disposer = () => { if (typeof dispose === 'function') dispose(); };
      scope.__disposers.push(disposer);
      return disposer;
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') scope.__disposers.push(dispose);
      return dispose;
    },
    on() {},
  };
  // Property access is guarded exactly like Cordis.
  return new Proxy(scope, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in effective && !own.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      if (typeof prop === 'string' && effective[prop] !== undefined && own.has(prop)) {
        return effective[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** A service stub that satisfies every tool. */
function stubService(overrides = {}) {
  return {
    generate: async (input) => ({
      id: 'job-abc',
      promptId: 'prompt-abc',
      status: 'queued',
      seed: 77,
      presetId: 'zimage-turbo',
      presetName: 'Z-Image Turbo',
      model: 'z_image_turbo_int8_convrot.safetensors',
      width: input.width ?? 1024,
      height: input.height ?? 1024,
      images: [],
      ...overrides.generateResult,
    }),
    getJob: (id) => ({ ...overrides.job, id }),
    status: async () => ({
      connected: true,
      baseUrl: 'http://127.0.0.1:8188',
      version: '0.41.1',
      queue: { running: 1, pending: 2 },
      active: { id: 'job-abc', prompt: 'a cat', progress: { percent: 42, label: '生成中 4/8' } },
      jobs: [
        { id: 'job-abc', status: 'running', prompt: 'a cat', createdAt: 1, images: [], error: null },
        { id: 'job-def', status: 'succeeded', prompt: 'a dog', createdAt: 2, images: [{ id: 'i1' }], error: null },
      ],
      lastError: null,
      ...overrides.status,
    }),
    cancel: async (input) => ({ canceled: input.all ? 3 : 1, interrupted: !input.all, ...overrides.cancel }),
    models: async (options) => ({
      ok: true,
      folders: {
        checkpoints: ['sd.safetensors'],
        diffusion_models: ['z.safetensors'],
        text_encoders: ['q.safetensors'],
        vae: ['ae.safetensors'],
        loras: [],
      },
      fetchedAt: 1,
      options,
      ...overrides.models,
    }),
    listPresets: () => [
      { id: 'zimage-turbo', name: 'Z', mode: 'unet', valid: true, missing: [] },
      { id: 'checkpoint-sdxl', name: 'SDXL', mode: 'checkpoint', valid: false, missing: ['未选择 checkpoint 模型'] },
    ],
  };
}

function textOf(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

test('all four tools register with schemas the real registry accepts', () => {
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, {
    getService: () => stubService(),
    settings: () => ({ generateTimeoutSeconds: 600, width: 1024, height: 1024, steps: 8 }),
  });
  try {
    assert.deepEqual([...scope.tools.registered.keys()].sort(), [TOOL_CANCEL, TOOL_GENERATE, TOOL_MODELS, TOOL_STATUS].sort());
    // The registry exposes compiled JSON Schema; a bad authoring shape would have
    // thrown inside defineTool above.
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    assert.equal(generate.parameters.type, 'object');
    assert.deepEqual(generate.parameters.required, ['prompt']);
    assert.ok(generate.parameters.properties.prompt);
    assert.ok(generate.parameters.properties.negative_prompt);
    assert.equal(generate.output.schema.type, 'object');
  } finally {
    dispose();
  }
  assert.equal(scope.tools.registered.size, 0);
});

test('the tools refuse to run before the service exists', async () => {
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, { getService: () => null, settings: () => ({}) });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    await assert.rejects(
      generate.execute({ prompt: 'x' }, {}),
      (error) => error.code === 'comfyui/offline',
    );
    const status = scope.tools.registered.get(TOOL_STATUS);
    await assert.rejects(status.execute({}, {}), (error) => error.code === 'comfyui/offline');
  } finally {
    dispose();
  }
});

test('comfyui_generate with wait:false returns the queued job immediately', async () => {
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, {
    getService: () => stubService(),
    settings: () => ({ generateTimeoutSeconds: 600 }),
  });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    const value = await generate.execute({ prompt: 'a cat', wait: false }, {});
    assert.equal(value.jobId, 'job-abc');
    assert.equal(value.status, 'queued');
    assert.deepEqual(value.images, []);
    assert.match(value.message, /队列/);
    assert.equal(value.seed, 77);
  } finally {
    dispose();
  }
});

test('comfyui_generate with wait:true returns the settled images', async () => {
  const scope = fakeScope({}, ['tools']);
  const service = stubService();
  // The job is already finished, so waitForJob returns on its first read.
  service.getJob = () => ({
    id: 'job-abc',
    status: 'succeeded',
    seed: 77,
    presetId: 'zimage-turbo',
    width: 1024,
    height: 1024,
    durationMs: 12_900,
    error: null,
    images: [{
      id: 'i1',
      path: '/tmp/gallery/job-abc/out.png',
      url: '/api/dsh-comfyui/image?id=i1',
      filename: 'out.png',
      width: 1024,
      height: 1024,
      bytes: 2048,
    }],
  });
  const dispose = installComfyTools(scope, { getService: () => service, settings: () => ({ generateTimeoutSeconds: 600 }) });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    const value = await generate.execute({ prompt: 'a cat' }, {});
    assert.equal(value.status, 'succeeded');
    assert.equal(value.images.length, 1);
    assert.equal(value.images[0].path, '/tmp/gallery/job-abc/out.png');
    assert.equal(value.durationMs, 12_900);
    assert.match(value.message, /生成完成/);
  } finally {
    dispose();
  }
});

test('a failed job is reported, not thrown', async () => {
  const scope = fakeScope({}, ['tools']);
  const service = stubService();
  service.getJob = () => ({
    id: 'job-abc',
    status: 'failed',
    seed: 1,
    presetId: 'p',
    width: 512,
    height: 512,
    images: [],
    error: { code: 'comfyui/node-error', message: 'CUDA out of memory' },
  });
  const dispose = installComfyTools(scope, { getService: () => service, settings: () => ({}), tools: scope.tools });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    const value = await generate.execute({ prompt: 'a cat' }, {});
    assert.equal(value.status, 'failed');
    assert.match(value.message, /CUDA out of memory/);
  } finally {
    dispose();
  }
});

test('the generate render names the file paths so a model can read them', () => {
  const definition = defineTool({
    name: 'probe',
    description: 'x',
    parameters: { prompt: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [],
    },
    async execute() {
      return { ok: true };
    },
  });
  assert.ok(definition);

  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, { getService: () => stubService(), settings: () => ({}) });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    const blocks = generate.output.render({ prompt: 'a cat' }, {
      jobId: 'job-abc',
      status: 'succeeded',
      seed: 5,
      preset: 'zimage-turbo',
      model: 'z.safetensors',
      width: 1024,
      height: 1024,
      durationMs: 2500,
      images: [{ path: '/tmp/a.png', filename: 'a.png', width: 1024, height: 1024 }],
      message: '生成完成',
    });
    const text = textOf(blocks);
    assert.match(text, /Generated 1 image/);
    assert.match(text, /comfyui-job:job-abc/);
    assert.match(text, /\/tmp\/a\.png/);
    assert.match(text, /right sidebar/);
  } finally {
    dispose();
  }
});

test('comfyui_status renders a compact summary', async () => {
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, { getService: () => stubService(), settings: () => ({}) });
  try {
    const status = scope.tools.registered.get(TOOL_STATUS);
    const value = await status.execute({}, {});
    assert.equal(value.connected, true);
    assert.equal(value.running, 1);
    assert.equal(value.pending, 2);
    assert.equal(value.active.percent, 42);
    const text = textOf(status.output.render({}, value));
    assert.match(text, /connected at http:\/\/127\.0\.0\.1:8188/);
    assert.match(text, /running: 1/);
    assert.match(text, /生成中 4\/8/);
  } finally {
    dispose();
  }
});

test('comfyui_cancel reports the interrupted state', async () => {
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, { getService: () => stubService(), settings: () => ({}) });
  try {
    const cancel = scope.tools.registered.get(TOOL_CANCEL);
    const single = await cancel.execute({ job_id: 'job-abc' }, {});
    assert.equal(single.canceled, 1);
    assert.equal(single.interrupted, true);
    assert.match(single.message, /已中断/);
    const all = await cancel.execute({ all: true }, {});
    assert.equal(all.canceled, 3);
    assert.match(all.message, /已取消 3 个任务/);
  } finally {
    dispose();
  }
});

test('comfyui_models lists presets with their usability', async () => {
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, { getService: () => stubService(), settings: () => ({}) });
  try {
    const models = scope.tools.registered.get(TOOL_MODELS);
    const value = await models.execute({ refresh: true }, {});
    assert.equal(value.presets.length, 2);
    assert.equal(value.presets[0].usable, true);
    assert.equal(value.presets[1].usable, false);
    assert.deepEqual(value.folders.diffusion_models, ['z.safetensors']);
    const text = textOf(models.output.render({}, value));
    assert.match(text, /zimage-turbo/);
    assert.match(text, /missing:/);
  } finally {
    dispose();
  }
});

test('installComfyIntegration also installs the system prompt and unregisters on teardown', () => {
  const contexts = [];
  const scope = fakeScope({
    systemPrompt: {
      context(entry) {
        contexts.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
  });
  const dispose = installComfyIntegration(scope, {
    getService: () => stubService(),
    settings: () => ({ enabled: true, width: 1024, height: 1024, steps: 8 }),
    logger: () => {},
  });
  assert.equal(typeof dispose, 'boolean');
  // Registration happens on the scope that actually declared `tools`.
  const injected = scope.__children.at(-1);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, 'comfyui:guide');
  assert.equal(contexts[0].required, true);
  const text = contexts[0].text({ agent: {} });
  assert.match(text, /ComfyUI/);
  assert.match(text, /comfyui_generate/);
  assert.match(text, /zimage-turbo/);

  // Teardown runs every registered disposer exactly once.
  for (const item of [...(scope.__disposers ?? [])].reverse()) item();
  assert.equal(injected.tools.registered.size, 0);
});

test('the system prompt is empty when the plugin is disabled', () => {
  const contexts = [];
  const scope = fakeScope({
    systemPrompt: {
      context(entry) {
        contexts.push(entry);
        return () => {};
      },
    },
  });
  installComfyIntegration(scope, {
    getService: () => stubService(),
    settings: () => ({ enabled: false }),
    logger: () => {},
  });
  assert.equal(contexts[0].text({ agent: {} }), '');
});

test('waitForJob gives up with a coded timeout', async () => {
  const service = { getJob: () => ({ id: 'x', status: 'running' }) };
  await assert.rejects(
    waitForJob(service, 'x', { timeoutMs: 30, intervalMs: 10 }),
    (error) => error.code === 'comfyui/timeout',
  );
});

test('waitForJob honours an aborted signal', async () => {
  const service = { getJob: () => ({ id: 'x', status: 'running' }) };
  const controller = new AbortController();
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(
    waitForJob(service, 'x', { timeoutMs: 5000, intervalMs: 10, signal: controller.signal }),
    /cancelled by test/,
  );
});

test('waitForJob reports a vanished job instead of hanging', async () => {
  const service = { getJob: () => null };
  await assert.rejects(
    waitForJob(service, 'gone', { timeoutMs: 1000, intervalMs: 10 }),
    (error) => error.code === 'comfyui/not-found',
  );
});

test('a settled image is admitted as an attachment and rendered as an image block', async () => {
  // The render function is synchronous, so the tool must admit the bytes during
  // execute and hand the reference to the render. This test pins that contract:
  // a model that cannot see images still gets the paths, and one that can gets
  // real image blocks.
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-att-'));
  const png = join(dir, 'out.png');
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));

  const admitted = [];
  const store = {
    async saveImage({ data, mediaType, name }) {
      admitted.push({ size: data.length, mediaType, name });
      return {
        attachmentId: `att-${admitted.length}`,
        mediaType,
        bytes: data.length,
        width: 512,
        height: 512,
        name,
      };
    },
  };
  const service = stubService();
  service.getJob = () => ({
    id: 'job-img',
    status: 'succeeded',
    seed: 1,
    presetId: 'zimage-turbo',
    width: 512,
    height: 512,
    durationMs: 1000,
    error: null,
    images: [{ id: 'i1', path: png, url: '/api/dsh-comfyui/image?id=i1', filename: 'out.png', mediaType: 'image/png', width: 512, height: 512, bytes: 11 }],
  });

  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, {
    getService: () => service,
    settings: () => ({ generateTimeoutSeconds: 60, autoAttachImages: true }),
    attachments: () => store,
  });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    const value = await generate.execute({ prompt: 'a cat' }, {});
    assert.equal(value.status, 'succeeded');
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].mediaType, 'image/png');
    assert.equal(admitted[0].name, 'out.png');

    const blocks = generate.output.render({ prompt: 'a cat' }, value);
    assert.equal(blocks[0].type, 'text');
    const images = blocks.filter((block) => block.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].attachment.attachmentId, 'att-1');
    assert.equal(images[0].attachment.width, 512);

    // A second render of the same job must not silently lose the images.
    const again = generate.output.render({ prompt: 'a cat' }, value);
    assert.equal(again.filter((block) => block.type === 'image').length, 1);
  } finally {
    dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('autoAttachImages=false keeps the text envelope only', async () => {
  const service = stubService();
  service.getJob = () => ({
    id: 'job-nope',
    status: 'succeeded',
    seed: 1,
    presetId: 'p',
    width: 64,
    height: 64,
    images: [{ id: 'i1', path: '/nonexistent/x.png', filename: 'x.png', mediaType: 'image/png' }],
  });
  let admitted = 0;
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, {
    getService: () => service,
    settings: () => ({ generateTimeoutSeconds: 60, autoAttachImages: false }),
    attachments: () => ({ async saveImage() { admitted += 1; throw new Error('should not be called'); } }),
  });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    const value = await generate.execute({ prompt: 'x' }, {});
    assert.equal(admitted, 0);
    const blocks = generate.output.render({ prompt: 'x' }, value);
    assert.equal(blocks.filter((block) => block.type === 'image').length, 0);
    assert.match(textOf(blocks), /\/nonexistent\/x\.png/);
  } finally {
    dispose();
  }
});

test('a failing attachment store degrades to paths instead of failing the tool', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-att2-'));
  const png = join(dir, 'out.png');
  await writeFile(png, Buffer.alloc(16, 1));

  const service = stubService();
  service.getJob = () => ({
    id: 'job-bad',
    status: 'succeeded',
    seed: 1,
    presetId: 'p',
    width: 64,
    height: 64,
    images: [{ id: 'i1', path: png, filename: 'out.png', mediaType: 'image/png' }],
  });
  const scope = fakeScope({}, ['tools']);
  const dispose = installComfyTools(scope, {
    getService: () => service,
    settings: () => ({ generateTimeoutSeconds: 60, autoAttachImages: true }),
    attachments: () => ({
      async saveImage() {
        const error = new Error('IMAGE_TOO_LARGE');
        error.code = 'IMAGE_TOO_LARGE';
        throw error;
      },
    }),
  });
  try {
    const generate = scope.tools.registered.get(TOOL_GENERATE);
    const value = await generate.execute({ prompt: 'x' }, {});
    assert.equal(value.status, 'succeeded');
    const blocks = generate.output.render({ prompt: 'x' }, value);
    assert.equal(blocks.filter((block) => block.type === 'image').length, 0);
    assert.match(textOf(blocks), new RegExp(png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('registration never touches ctx.tools without declaring the inject', () => {
  // Regression: the first version probed with `ctx.get('tools')`, which resolves
  // without the guard, so the check passed and then `ctx.tools.register` threw
  // in the real host ("cannot get property \"tools\" without inject"). The fake
  // scope now throws on undeclared access, so this test fails if the code ever
  // goes back to reading a service it did not inject.
  const scope = fakeScope({ systemPrompt: { context: () => () => {} } });
  const errors = [];
  const logger = (level, message) => { if (level === 'error') errors.push(message); };
  const installed = installComfyIntegration(scope, {
    getService: () => stubService(),
    settings: () => ({ enabled: true, width: 1024, height: 1024, steps: 8 }),
    logger,
  });
  try {
    assert.equal(installed, true);
    assert.deepEqual(errors, [], 'registration must not report an error');
    // The work happened on the injected child, not the un-injected root.
    assert.equal(scope.__children.length >= 1, true);
    const injected = scope.__children[0];
    assert.equal(injected.tools.registered.size, 4);
    assert.equal(injected.__children.length >= 1, true, 'system prompt injection should nest');
  } finally {
    for (const item of [...(scope.__disposers ?? [])].reverse()) item();
  }
});

test('a scope without an inject method is skipped instead of throwing', () => {
  // A minimal composition may hand over something that is not a Context.
  const errors = [];
  const bare = { get: () => undefined, effect: () => () => {}, on: () => {} };
  const result = installComfyIntegration(bare, {
    getService: () => null,
    settings: () => ({}),
    logger: (level, message) => { if (level === 'error') errors.push(message); },
  });
  assert.equal(result, true);
  assert.deepEqual(errors, []);
});

test('every tool result is a lossless JSON value', async () => {
  // The live host rejected `comfyui_models` with `value is not lossless JSON`
  // because the result carried `error: undefined`. Unit tests that only read the
  // returned object never notice; this one applies the host's own predicate.
  const { isJsonValue } = await import('@deepseek-ai/dsh-util-values');
  const scope = fakeScope({}, ['tools']);

  // `stubService` returns a job with optional fields absent, and `models()`
  // returns no error, which is exactly the shape that failed in production.
  const service = stubService();
  service.getJob = () => ({
    id: 'job-loose',
    status: 'succeeded',
    seed: 1,
    presetId: 'p',
    width: 64,
    height: 64,
    images: [{ id: 'i1', path: '/tmp/x.png', filename: 'x.png' }],
    // Deliberately absent: promptId, durationMs, model, error.
  });
  const dispose = installComfyTools(scope, {
    getService: () => service,
    settings: () => ({ generateTimeoutSeconds: 60 }),
  });
  try {
    const cases = [
      [TOOL_GENERATE, { prompt: 'a cat' }, {}],
      [TOOL_STATUS, {}, {}],
      [TOOL_CANCEL, { all: true }, {}],
      [TOOL_MODELS, {}, {}],
    ];
    for (const [name, args, exec] of cases) {
      const tool = scope.tools.registered.get(name);
      const value = await tool.execute(args, exec);
      assert.equal(isJsonValue(value), true, `${name} returned a non-lossless value: ${JSON.stringify(value)}`);
      // No property anywhere may hold `undefined`.
      const scan = (node, path) => {
        if (Array.isArray(node)) return node.forEach((item, index) => scan(item, `${path}[${index}]`));
        if (node === null || typeof node !== 'object') return;
        for (const [key, item] of Object.entries(node)) {
          assert.notEqual(item, undefined, `${name}: ${path}.${key} is undefined`);
          scan(item, `${path}.${key}`);
        }
      };
      scan(value, name);
    }
  } finally {
    dispose();
  }
});

test('a status read with no error and no active job is still lossless', async () => {
  // The other half of the production failure: nothing is wrong, so every
  // optional field is absent rather than an explicit undefined.
  const { isJsonValue } = await import('@deepseek-ai/dsh-util-values');
  const scope = fakeScope({}, ['tools']);
  const service = stubService({
    status: {
      connected: false,
      version: '',
      active: null,
      jobs: [],
      lastError: null,
    },
  });
  const dispose = installComfyTools(scope, { getService: () => service, settings: () => ({}) });
  try {
    const status = scope.tools.registered.get(TOOL_STATUS);
    const value = await status.execute({}, {});
    assert.equal(isJsonValue(value), true, JSON.stringify(value));
    assert.equal(value.lastError, undefined);
    assert.equal(value.version, undefined);
    assert.equal(value.active, undefined);
    assert.deepEqual(value.recent, []);
    // The renderer must survive the absent fields too.
    assert.match(textOf(status.output.render({}, value)), /NOT reachable/);
  } finally {
    dispose();
  }
});

test('an unknown preset state is not reported as missing', () => {
  // On the first request after activation the model listing has not been read,
  // so `valid` is null. Reporting that as 模型未就绪 told the model every preset
  // was broken before it had a chance to work.
  const contexts = [];
  const scope = fakeScope({
    systemPrompt: {
      context(entry) { contexts.push(entry); return () => {}; },
    },
  });
  const service = stubService();
  // `valid: null` = unknown; `valid: false` = confirmed missing.
  service.listPresets = () => [
    { id: 'ready', name: 'Ready', mode: 'unet', valid: true },
    { id: 'unknown', name: 'Unknown', mode: 'unet', valid: null },
    { id: 'broken', name: 'Broken', mode: 'unet', valid: false },
  ];
  const installed = installComfyIntegration(scope, {
    getService: () => service,
    settings: () => ({ enabled: true, width: 512, height: 512, steps: 8 }),
    logger: () => {},
  });
  try {
    assert.equal(installed, true);
    const text = contexts[0].text({ agent: {} });
    // Usable presets are listed without a warning.
    assert.match(text, /Presets to try: ready, unknown\./);
    // The confirmed-broken one is called out separately, not silently dropped.
    assert.match(text, /1 preset\(s\) need model configuration.*broken/);
  } finally {
    for (const item of [...(scope.__disposers ?? [])].reverse()) item();
  }
});

test('a service that throws while listing presets leaves usable guidance', () => {
  const contexts = [];
  const scope = fakeScope({
    systemPrompt: { context(entry) { contexts.push(entry); return () => {}; } },
  });
  const service = stubService();
  service.listPresets = () => { throw new Error('gallery index unreadable'); };
  const installed = installComfyIntegration(scope, {
    getService: () => service,
    settings: () => ({ enabled: true, width: 512, height: 512, steps: 8 }),
    logger: () => {},
  });
  try {
    assert.equal(installed, true);
    const text = contexts[0].text({ agent: {} });
    assert.match(text, /comfyui_models/);
    assert.match(text, /comfyui_generate/);
  } finally {
    for (const item of [...(scope.__disposers ?? [])].reverse()) item();
  }
});
