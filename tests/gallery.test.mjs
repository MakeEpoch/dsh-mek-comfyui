/**
 * Unit tests for host/gallery.js.
 *
 * Everything runs in a `mkdtemp` sandbox: no network, no shared state, and the
 * whole tree is removed in `after`.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Gallery, sanitizeFilename } from '../host/gallery.js';

/** A tiny valid-looking PNG body; the gallery never decodes it. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

let sandbox;
let root;
let indexFile;
let gallery;

/** Build a Job matching CONTRACT §1, with one image. */
function makeJob(id, overrides = {}) {
  const createdAt = overrides.createdAt ?? Date.now();
  const imageId = `${id}-img`;
  return {
    id,
    promptId: `prompt-${id}`,
    number: 1,
    status: 'succeeded',
    prompt: overrides.prompt ?? `a photo of ${id}`,
    negative: '',
    presetId: 'zimage-turbo',
    presetName: 'Z-Image Turbo',
    model: 'z_image_turbo_bf16.safetensors',
    width: 512,
    height: 512,
    steps: 8,
    cfg: 1,
    sampler: 'res_multistep',
    scheduler: 'simple',
    seed: 42,
    batch: 1,
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt + 1000,
    durationMs: 1000,
    // A caller-supplied session wins: several tests scope jobs to a conversation.
    sessionId: overrides.sessionId ?? null,
    source: 'ui',
    progress: null,
    images: [{
      id: imageId,
      jobId: id,
      filename: `${id}.png`,
      subfolder: '',
      width: 512,
      height: 512,
      bytes: PNG_BYTES.length,
      mediaType: 'image/png',
      url: `/api/dsh-comfyui/image?id=${imageId}`,
      thumbUrl: `/api/dsh-comfyui/image?id=${imageId}`,
      createdAt,
      favorite: false,
    }],
    error: null,
    favorite: overrides.favorite ?? false,
  };
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'comfyui-gallery-'));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  const dir = await mkdtemp(join(sandbox, 'case-'));
  root = join(dir, 'gallery');
  indexFile = join(dir, 'index.json');
  gallery = new Gallery({ root, indexFile });
  await gallery.init();
});

describe('Gallery.init', () => {
  it('treats a missing index file as a fresh install', async () => {
    assert.equal(existsSync(indexFile), false);
    assert.deepEqual(await gallery.list(), { items: [], total: 0 });
    // `stats` also reports the scope and the whole-library totals.
    assert.deepEqual(await gallery.stats(), {
      count: 0, bytes: 0, favorites: 0, scope: 'all',
      all: { count: 0, bytes: 0, favorites: 0 },
    });
    assert.equal(existsSync(root), true);
  });

  it('falls back to an empty index when the file is corrupt', async () => {
    await writeFile(indexFile, '{ this is not json', 'utf8');
    const warnings = [];
    const fresh = new Gallery({
      root,
      indexFile,
      logger: (level, message) => warnings.push([level, message]),
    });
    await fresh.init();
    assert.deepEqual(await fresh.list(), { items: [], total: 0 });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'warn');
  });

  it('ignores a non-array index payload', async () => {
    await writeFile(indexFile, '{"hello":"world"}', 'utf8');
    const fresh = new Gallery({ root, indexFile });
    await fresh.init();
    assert.equal((await fresh.list()).total, 0);
  });

  it('rejects a missing root or index path', () => {
    assert.throws(() => new Gallery({ indexFile }), { code: 'comfyui/invalid' });
    assert.throws(() => new Gallery({ root }), { code: 'comfyui/invalid' });
  });
});

describe('Gallery.save / list / get', () => {
  it('round-trips a job and persists it to disk', async () => {
    const job = makeJob('job-1');
    const saved = await gallery.save(job);
    assert.equal(saved.id, 'job-1');
    assert.equal(saved.images.length, 1);
    assert.equal(saved.images[0].url, `/api/dsh-comfyui/image?id=${saved.images[0].id}`);
    assert.equal(saved.images[0].thumbUrl, saved.images[0].url);

    const listed = await gallery.list();
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, 'job-1');

    const fetched = await gallery.get('job-1');
    assert.equal(fetched.prompt, 'a photo of job-1');
    assert.equal(await gallery.has('job-1'), true);
    assert.equal(await gallery.has('nope'), false);
    assert.equal(await gallery.get('nope'), null);

    const onDisk = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.ok(Array.isArray(onDisk));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].id, 'job-1');
  });

  it('rejects a job without images', async () => {
    await assert.rejects(() => gallery.save({ ...makeJob('bad'), images: [] }), {
      code: 'comfyui/invalid',
    });
    await assert.rejects(() => gallery.save({ images: [{}] }), { code: 'comfyui/invalid' });
    await assert.rejects(() => gallery.save(null), { code: 'comfyui/invalid' });
  });

  it('upserts rather than duplicating on a repeated id', async () => {
    await gallery.save(makeJob('job-1'));
    await gallery.save({ ...makeJob('job-1'), prompt: 'updated prompt' });
    const listed = await gallery.list();
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].prompt, 'updated prompt');
  });

  it('sorts by createdAt descending', async () => {
    const now = Date.now();
    await gallery.save(makeJob('old', { createdAt: now - 5000 }));
    await gallery.save(makeJob('new', { createdAt: now }));
    await gallery.save(makeJob('mid', { createdAt: now - 1000 }));
    const listed = await gallery.list();
    assert.deepEqual(listed.items.map((job) => job.id), ['new', 'mid', 'old']);
  });

  it('does not let callers mutate stored records', async () => {
    const saved = await gallery.save(makeJob('job-1'));
    saved.prompt = 'mutated';
    saved.images.push({ id: 'ghost' });
    const fetched = await gallery.get('job-1');
    assert.equal(fetched.prompt, 'a photo of job-1');
    assert.equal(fetched.images.length, 1);
  });

  it('filters by query over prompt and filename', async () => {
    await gallery.save(makeJob('a', { prompt: 'A Red Apple on a table' }));
    await gallery.save(makeJob('b', { prompt: 'a blue cat' }));
    await gallery.save({ ...makeJob('c'), images: [{ ...makeJob('c').images[0], filename: 'Sunset_00001_.png' }] });

    assert.equal((await gallery.list({ query: 'apple' })).total, 1);
    assert.equal((await gallery.list({ query: 'APPLE' })).items[0].id, 'a');
    assert.equal((await gallery.list({ query: 'sunset' })).items[0].id, 'c');
    assert.equal((await gallery.list({ query: 'nope' })).total, 0);
    assert.equal((await gallery.list({ query: '' })).total, 3);
  });

  it('filters favorites', async () => {
    await gallery.save(makeJob('a', { favorite: true }));
    await gallery.save(makeJob('b'));
    const favorites = await gallery.list({ favorite: true });
    assert.equal(favorites.total, 1);
    assert.equal(favorites.items[0].id, 'a');
  });

  it('paginates and reports the pre-pagination total', async () => {
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      await gallery.save(makeJob(`job-${index}`, { createdAt: now + index }));
    }
    const first = await gallery.list({ limit: 2, offset: 0 });
    assert.equal(first.total, 5);
    assert.deepEqual(first.items.map((job) => job.id), ['job-4', 'job-3']);

    const second = await gallery.list({ limit: 2, offset: 2 });
    assert.equal(second.total, 5);
    assert.deepEqual(second.items.map((job) => job.id), ['job-2', 'job-1']);

    const last = await gallery.list({ limit: 2, offset: 4 });
    assert.equal(last.total, 5);
    assert.deepEqual(last.items.map((job) => job.id), ['job-0']);

    assert.equal((await gallery.list({ offset: 99 })).items.length, 0);
  });

  it('filters by status', async () => {
    await gallery.save(makeJob('ok'));
    await gallery.save({ ...makeJob('bad'), status: 'failed' });
    assert.equal((await gallery.list({ status: 'failed' })).total, 1);
    assert.equal((await gallery.list({ status: 'succeeded' })).total, 1);
  });
});

describe('Gallery.addImage / filePath / imageRecord', () => {
  it('writes real bytes and resolves the path', async () => {
    await gallery.save(makeJob('job-1'));
    const image = await gallery.addImage('job-1', {
      filename: 'result.png',
      subfolder: 'sub',
      bytes: PNG_BYTES,
      mediaType: 'image/png',
      width: 512,
      height: 512,
    });

    assert.equal(image.filename, 'result.png');
    assert.equal(image.bytes, PNG_BYTES.length);
    assert.equal(image.mediaType, 'image/png');
    assert.equal(image.width, 512);
    assert.equal(image.url, `/api/dsh-comfyui/image?id=${image.id}`);

    const path = await gallery.filePath(image.id);
    assert.ok(path);
    assert.equal(path.startsWith(root), true);
    assert.deepEqual(await readFile(path), PNG_BYTES);

    const record = await gallery.imageRecord(image.id);
    assert.equal(record.id, image.id);
    assert.equal(record.jobId, 'job-1');

    // The record is attached to the persisted job too.
    const job = await gallery.get('job-1');
    assert.equal(job.images.length, 2);
    assert.ok(job.images.some((entry) => entry.id === image.id));
  });

  it('returns null for an unknown image id', async () => {
    assert.equal(await gallery.filePath('does-not-exist'), null);
    assert.equal(await gallery.imageRecord('does-not-exist'), null);
  });

  it('rejects path traversal in the image id', async () => {
    for (const bad of ['../index.json', 'a/../../b', '..\\..\\x', 'nested/id']) {
      await assert.rejects(() => gallery.filePath(bad), { code: 'comfyui/invalid' });
    }
  });

  it('rejects traversal in the job id and sanitizes the filename', async () => {
    await assert.rejects(
      () => gallery.addImage('../evil', { filename: 'x.png', bytes: PNG_BYTES }),
      { code: 'comfyui/invalid' },
    );
    const image = await gallery.addImage('job-1', {
      filename: '../../etc/passwd',
      bytes: PNG_BYTES,
    });
    assert.equal(image.filename.includes('/'), false);
    assert.equal(image.filename.includes('..'), false);
    const path = await gallery.filePath(image.id);
    assert.equal(path.startsWith(root), true);
    assert.equal(existsSync(path), true);
  });

  it('sanitizes filenames deterministically', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'etcpasswd');
    assert.equal(sanitizeFilename('a/b\\c.png'), 'abc.png');
    assert.equal(sanitizeFilename(''), 'image.png');
    assert.equal(sanitizeFilename(null), 'image.png');
    assert.equal(sanitizeFilename('...'), 'image.png');
    assert.equal(sanitizeFilename('with\u0000null.png'), 'withnull.png');
    const long = sanitizeFilename(`${'x'.repeat(400)}.png`);
    assert.equal(long.length, 120);
    assert.equal(long.endsWith('.png'), true);
  });

  it('requires bytes and a job id', async () => {
    await assert.rejects(() => gallery.addImage('job-1', { filename: 'x.png' }), {
      code: 'comfyui/invalid',
    });
    await assert.rejects(() => gallery.addImage('', { filename: 'x.png', bytes: PNG_BYTES }), {
      code: 'comfyui/invalid',
    });
  });
});

describe('Gallery.update / delete / stats', () => {
  it('applies a partial patch', async () => {
    await gallery.save(makeJob('job-1'));
    const updated = await gallery.update('job-1', { favorite: true, prompt: 'new prompt' });
    assert.equal(updated.favorite, true);
    assert.equal(updated.prompt, 'new prompt');
    assert.equal(updated.id, 'job-1');
    assert.equal((await gallery.get('job-1')).favorite, true);
    assert.equal(await gallery.update('nope', { favorite: true }), null);
  });

  it('deletes the file and the index entry', async () => {
    await gallery.save(makeJob('job-1'));
    const image = await gallery.addImage('job-1', { filename: 'one.png', bytes: PNG_BYTES });
    const path = await gallery.filePath(image.id);
    assert.equal(existsSync(path), true);

    const removed = await gallery.delete(['job-1']);
    assert.equal(removed, 1);
    assert.equal(await gallery.get('job-1'), null);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(root, 'job-1')), false);

    const onDisk = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.deepEqual(onDisk, []);
    assert.equal(await gallery.delete(['job-1']), 0);
    assert.equal(await gallery.delete([]), 0);
  });

  it('tolerates a missing file when deleting', async () => {
    await gallery.save(makeJob('job-1'));
    await rm(join(root, 'job-1'), { recursive: true, force: true });
    assert.equal(await gallery.delete('job-1'), 1);
    assert.equal(await gallery.has('job-1'), false);
  });

  it('reports stats over jobs with images', async () => {
    await gallery.save(makeJob('a', { favorite: true }));
    await gallery.save(makeJob('b'));
    const stats = await gallery.stats();
    assert.equal(stats.count, 2);
    assert.equal(stats.favorites, 1);
    assert.equal(stats.bytes, PNG_BYTES.length * 2);
  });
});

describe('Gallery.prune', () => {
  it('removes jobs older than retentionDays', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await gallery.save(makeJob('fresh', { createdAt: now - day }));
    await gallery.save(makeJob('stale', { createdAt: now - 10 * day }));
    await gallery.save(makeJob('ancient', { createdAt: now - 40 * day }));

    const dry = await gallery.prune({ retentionDays: 7, dryRun: true });
    assert.equal(dry.removed, 2);
    assert.equal(dry.bytes, PNG_BYTES.length * 2);
    assert.equal((await gallery.list()).total, 3);

    const real = await gallery.prune({ retentionDays: 7 });
    assert.equal(real.removed, 2);
    assert.equal(real.bytes, PNG_BYTES.length * 2);
    const ids = (await gallery.list()).items.map((job) => job.id);
    assert.deepEqual(ids, ['fresh']);
  });

  it('treats retentionDays 0 as disabled', async () => {
    await gallery.save(makeJob('old', { createdAt: Date.now() - 1000 * 24 * 60 * 60 * 1000 }));
    assert.deepEqual(await gallery.prune({ retentionDays: 0 }), { removed: 0, bytes: 0 });
    assert.equal((await gallery.list()).total, 1);
  });

  it('trims the oldest jobs down to maxItems', async () => {
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      await gallery.save(makeJob(`job-${index}`, { createdAt: now + index }));
    }
    const result = await gallery.prune({ maxItems: 2 });
    assert.equal(result.removed, 3);
    const remaining = (await gallery.list()).items.map((job) => job.id);
    assert.deepEqual(remaining, ['job-4', 'job-3']);
    assert.equal(existsSync(join(root, 'job-0')), false);
  });

  it('never prunes favorites', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await gallery.save(makeJob('fav-old', { createdAt: now - 30 * day, favorite: true }));
    await gallery.save(makeJob('old', { createdAt: now - 30 * day }));
    await gallery.save(makeJob('new', { createdAt: now }));

    const byAge = await gallery.prune({ retentionDays: 7 });
    assert.equal(byAge.removed, 1);
    assert.equal(await gallery.has('fav-old'), true);

    // fav-old (favorite) + new remain; a limit of 2 therefore removes nothing.
    const byCount = await gallery.prune({ maxItems: 2 });
    assert.equal(byCount.removed, 0);
    assert.equal((await gallery.list()).total, 2);

    // A limit of 1 must take `new` rather than the older favorite.
    const aggressive = await gallery.prune({ maxItems: 1 });
    assert.equal(aggressive.removed, 1);
    assert.equal(await gallery.has('fav-old'), true);
    assert.equal(await gallery.has('new'), false);
  });

  it('counts favorites against maxItems without deleting them', async () => {
    const now = Date.now();
    await gallery.save(makeJob('fav', { createdAt: now, favorite: true }));
    await gallery.save(makeJob('mid', { createdAt: now - 10 }));
    await gallery.save(makeJob('old', { createdAt: now - 20 }));

    const result = await gallery.prune({ maxItems: 2 });
    assert.equal(result.removed, 1);
    assert.deepEqual((await gallery.list()).items.map((job) => job.id), ['fav', 'mid']);
  });
});

describe('Gallery concurrency and lifecycle', () => {
  it('keeps every entry when 20 saves race', async () => {
    const jobs = Array.from({ length: 20 }, (_, index) => makeJob(`race-${index}`));
    await Promise.all(jobs.map((job) => gallery.save(job)));
    const listed = await gallery.list({ limit: 100 });
    assert.equal(listed.total, 20);
    const ids = new Set(listed.items.map((job) => job.id));
    for (let index = 0; index < 20; index += 1) assert.equal(ids.has(`race-${index}`), true);

    const onDisk = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.equal(onDisk.length, 20);
  });

  it('keeps every image when adds race', async () => {
    await gallery.save(makeJob('job-1'));
    const images = await Promise.all(
      Array.from({ length: 10 }, (_, index) => gallery.addImage('job-1', {
        filename: `shot-${index}.png`,
        bytes: PNG_BYTES,
      })),
    );
    assert.equal(new Set(images.map((image) => image.id)).size, 10);
    const job = await gallery.get('job-1');
    assert.equal(job.images.length, 11);
    const files = await readdir(join(root, 'job-1'));
    assert.equal(files.length, 10);
  });

  it('switches root without losing the index', async () => {
    await gallery.save(makeJob('job-1'));
    const nextRoot = join(sandbox, 'other-root');
    await gallery.setRoot(nextRoot);
    assert.equal(gallery.root, nextRoot);
    assert.equal((await gallery.list()).total, 1);
    assert.equal(existsSync(nextRoot), true);
  });

  it('dispose is idempotent and rejects further use', async () => {
    await gallery.dispose();
    await gallery.dispose();
    await assert.rejects(() => gallery.list(), { code: 'comfyui/invalid' });
  });

  it('dispose is safe before init', async () => {
    const fresh = new Gallery({ root: join(sandbox, 'never'), indexFile: join(sandbox, 'never.json') });
    await fresh.dispose();
    await fresh.dispose();
  });

  it('rolls back in memory when the index write fails', async () => {
    const dir = join(sandbox, 'flaky');
    const flakyIndex = join(dir, 'index.json');
    const flaky = new Gallery({ root: join(dir, 'gallery'), indexFile: flakyIndex });
    await flaky.init();
    await flaky.save(makeJob('job-1'));
    const good = await readFile(flakyIndex, 'utf8');

    // Replace the index directory with a regular file: mkdir/rename must fail.
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'not a directory', 'utf8');

    await assert.rejects(() => flaky.save(makeJob('job-2')));
    assert.equal(await flaky.has('job-2'), false);
    assert.equal(await flaky.has('job-1'), true);
    // The previous good write is still on disk, untouched.
    assert.equal(JSON.parse(good).length, 1);
  });
});

describe('Gallery index file mode', () => {
  it('writes the index with restrictive permissions', async () => {
    await gallery.save(makeJob('job-1'));
    const info = await stat(indexFile);
    assert.equal(info.mode & 0o777, 0o600);
  });
});

// ── conversation scoping ─────────────────────────────────────────────────────

describe('Gallery conversation scoping', () => {
  /** A job owned by one conversation. */
  const owned = (id, sessionId, overrides = {}) => makeJob(id, { sessionId, ...overrides });

  it('scopes a list to one conversation and omits everyone else', async () => {
    await gallery.save(owned('a1', 'session-a'));
    await gallery.save(owned('a2', 'session-a'));
    await gallery.save(owned('b1', 'session-b'));
    await gallery.save(owned('c1', null));

    const scoped = await gallery.list({ sessionId: 'session-a' });
    assert.equal(scoped.total, 2);
    assert.deepEqual(scoped.items.map((job) => job.id).sort(), ['a1', 'a2']);

    // No scope means the whole library.
    assert.equal((await gallery.list({})).total, 4);
    // An empty string is "no scope", not "jobs without a session".
    assert.equal((await gallery.list({ sessionId: '' })).total, 4);
    // An unknown session is an empty result, not everything.
    assert.equal((await gallery.list({ sessionId: 'nope' })).total, 0);
  });

  it('keeps query, favourite and pagination working inside a scope', async () => {
    await gallery.save(owned('a1', 'session-a', { prompt: 'red apple', createdAt: 3 }));
    await gallery.save(owned('a2', 'session-a', { prompt: 'blue sky', favorite: true, createdAt: 2 }));
    await gallery.save(owned('a3', 'session-a', { prompt: 'red car', createdAt: 1 }));
    await gallery.save(owned('b1', 'session-b', { prompt: 'red apple' }));

    const red = await gallery.list({ sessionId: 'session-a', query: 'red' });
    assert.deepEqual(red.items.map((job) => job.id).sort(), ['a1', 'a3']);

    const fav = await gallery.list({ sessionId: 'session-a', favorite: true });
    assert.deepEqual(fav.items.map((job) => job.id), ['a2']);

    const page = await gallery.list({ sessionId: 'session-a', limit: 2, offset: 1 });
    assert.equal(page.items.length, 2);
    // `total` counts every match in scope, before the window.
    assert.equal(page.total, 3);
  });

  it('reports the scoped totals and the whole library together', async () => {
    await gallery.save(owned('a1', 'session-a', { favorite: true }));
    await gallery.save(owned('a2', 'session-a'));
    await gallery.save(owned('b1', 'session-b'));

    const scoped = await gallery.stats({ sessionId: 'session-a' });
    assert.equal(scoped.scope, 'session');
    assert.equal(scoped.count, 2);
    assert.equal(scoped.favorites, 1);
    assert.equal(scoped.all.count, 3, 'the switcher needs the out-of-scope total');
    assert.equal(scoped.all.favorites, 1);

    const all = await gallery.stats({});
    assert.equal(all.scope, 'all');
    assert.equal(all.count, 3);
    assert.equal(all.all.count, 3);
  });

  it('keeps jobs saved before scoping existed visible in the whole library', async () => {
    // The index predates the sessionId field, so existing entries have no owner.
    // They must stay reachable through 全部 and simply not appear under any
    // conversation — dropping them would look like data loss after an upgrade.
    const legacy = makeJob('legacy');
    delete legacy.sessionId;
    await gallery.save(legacy);
    await gallery.save(owned('recent', 'session-a'));

    const all = await gallery.list({});
    assert.deepEqual(all.items.map((job) => job.id).sort(), ['legacy', 'recent']);

    const scoped = await gallery.list({ sessionId: 'session-a' });
    assert.deepEqual(scoped.items.map((job) => job.id), ['recent']);

    // A missing session normalizes to null rather than being dropped.
    const stored = await gallery.get('legacy');
    assert.equal(stored.sessionId, null);
  });
});
