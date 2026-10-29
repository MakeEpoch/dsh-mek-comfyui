/**
 * Host smoke test against a REAL ComfyUI server.
 *
 * This is the test that proves the plugin actually generates an image: it
 * submits a graph through `ComfyService`, follows it over the websocket, and
 * asserts the gallery has the PNG on disk. It is skipped when no server answers,
 * so `npm test` stays green on a machine without ComfyUI.
 *
 * Run explicitly: `node --test tests/host-live.test.mjs`
 * Point it elsewhere: `COMFYUI_TEST_URL=http://host:8188 node --test tests/host-live.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComfyService } from '../host/service.js';
import { ComfyClient } from '../host/comfy-client.js';
import { resolveConfig } from '../host/config.js';

const BASE_URL = process.env.COMFYUI_TEST_URL ?? 'http://127.0.0.1:8188';

/** @returns {Promise<boolean>} whether a ComfyUI server answers. */
async function serverUp() {
  try {
    const response = await fetch(`${BASE_URL}/system_stats`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

const available = await serverUp();

test('live: generate an image end to end and store it in the gallery', { skip: !available && `no ComfyUI at ${BASE_URL}` }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-live-'));
  const logger = (level, message) => {
    if (level !== 'debug') t.diagnostic(`[${level}] ${message}`);
  };
  const config = resolveConfig({
    baseUrl: BASE_URL,
    width: 512,
    height: 512,
    steps: 8,
    cfg: 1,
    batch: 1,
    generateTimeoutSeconds: 180,
    pollIntervalMs: 1000,
  });
  const service = new ComfyService({ ctx: { get: () => undefined, fiber: undefined }, logger, dir, config });
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  await service.start();

  // 1. The connection is real.
  const status = await service.status();
  assert.equal(status.connected, true, `not connected: ${JSON.stringify(status.lastError)}`);
  assert.match(status.version, /^\d+\.\d+/);
  t.diagnostic(`ComfyUI ${status.version}, devices: ${status.devices.map((d) => d.name).join(', ') || 'none'}`);

  // 2. The installed models match the default preset.
  const listing = await service.models({ refresh: true });
  assert.equal(listing.ok, true);
  const preset = service.getPreset('zimage-turbo');
  t.diagnostic(`preset zimage-turbo valid=${preset.valid} missing=${JSON.stringify(preset.missing)}`);
  if (preset.valid !== true) {
    // A server without these weights cannot run the default preset; report the
    // truth instead of failing the whole suite on a model-download problem.
    t.skip(`default preset models are not installed: ${preset.missing.join(', ')}`);
    return;
  }

  // 3. Generate.
  const started = Date.now();
  const job = await service.generate({
    prompt: 'a single red apple on a plain wooden table, soft daylight, product photo',
    presetId: 'zimage-turbo',
    width: 512,
    height: 512,
    steps: 8,
    seed: 1234,
  }, { source: 'chat', sessionId: 'test-session' });
  assert.equal(job.status, 'queued');
  assert.equal(job.seed, 1234);
  t.diagnostic(`job ${job.id.slice(0, 8)} queued`);

  const settled = await waitUntil(service, job.id, 180_000);
  t.diagnostic(`settled in ${Date.now() - started}ms as ${settled.status}`);
  assert.equal(settled.status, 'succeeded', `job failed: ${JSON.stringify(settled.error)}`);
  assert.ok(settled.images.length >= 1);
  assert.ok(settled.durationMs > 0);

  // 4. The PNG really exists, is a PNG, and matches the requested size.
  const image = settled.images[0];
  assert.ok(image.path, 'the settled job must expose an absolute file path');
  const info = await stat(image.path);
  assert.ok(info.size > 1000, `image is suspiciously small: ${info.size} bytes`);
  const bytes = await readFile(image.path);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG');
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.width, 512);
  assert.equal(image.height, 512);

  // 5. It is in the durable index, addressable by URL, and resolvable to a path.
  const gallery = await service.galleryList({ limit: 10 });
  assert.ok(gallery.items.some((item) => item.id === job.id), 'the job must be in the gallery index');
  assert.match(image.url, /^\/api\/dsh-comfyui\/image\?id=/);
  const resolved = await service.imagePath(image.id);
  assert.equal(resolved, image.path);

  // 6. The queue is empty again and status reflects it.
  const after = await service.status();
  assert.equal(after.queue.running, 0);
  assert.equal(after.queue.pending, 0);
  assert.ok(after.jobs.some((item) => item.id === job.id && item.status === 'succeeded'));
});

test('live: models() lists what the server actually has', { skip: !available && `no ComfyUI at ${BASE_URL}` }, async () => {
  const client = new ComfyClient({ baseUrl: BASE_URL, timeoutMs: 15_000 });
  try {
    const folders = await client.models({});
    assert.ok(Array.isArray(folders.diffusion_models));
    assert.ok(Array.isArray(folders.checkpoints));
    assert.ok(Array.isArray(folders.text_encoders));
    assert.ok(Array.isArray(folders.vae));
    // Sorted ascending.
    const sorted = [...folders.diffusion_models].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(folders.diffusion_models, sorted);
  } finally {
    await client.dispose();
  }
});

test('live: an unknown model produces a readable validation error', { skip: !available && `no ComfyUI at ${BASE_URL}` }, async () => {
  const client = new ComfyClient({ baseUrl: BASE_URL, timeoutMs: 15_000 });
  try {
    await assert.rejects(
      client.submit({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'definitely-not-installed.safetensors' } },
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } },
      }, {}),
      (error) => {
        assert.equal(error.code, 'comfyui/invalid');
        assert.match(error.message, /校验失败|not in/i);
        return true;
      },
    );
  } finally {
    await client.dispose();
  }
});

async function waitUntil(service, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = service.getJob(jobId);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
