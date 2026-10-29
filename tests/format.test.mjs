import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN,
  clampNumber,
  clampPercent,
  progressPercent,
  formatDuration,
  formatBytes,
  formatRelativeTime,
  statusLabel,
  statusTone,
  modeLabel,
  excerpt,
  jobDuration,
  ratioHint,
  formatCount,
  validateSettingsDraft,
  parseWorkflowJson,
  flattenGallery,
  wrapIndex,
  scopeSessionId,
  effectiveGalleryScope,
} from '../client/format.js';

test('clampNumber bounds and rejects non-finite input', () => {
  assert.equal(clampNumber(5, 1, 10), 5);
  assert.equal(clampNumber(-5, 1, 10), 1);
  assert.equal(clampNumber(50, 1, 10), 10);
  assert.equal(clampNumber('7', 1, 10), 7);
  assert.equal(clampNumber('nope', 1, 10), 1);
  assert.equal(clampNumber(Number.NaN, 2, 10), 2);
});

test('clampPercent stays inside 0..100 and rounds to one decimal', () => {
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(50), 50);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(-1), 0);
  assert.equal(clampPercent(101), 100);
  assert.equal(clampPercent(33.333), 33.3);
  assert.equal(clampPercent('42'), 42);
  assert.equal(clampPercent('x'), 0);
  assert.equal(clampPercent(undefined), 0);
});

test('progressPercent prefers percent, then value/max, then 0', () => {
  assert.equal(progressPercent(null), 0);
  assert.equal(progressPercent({ percent: 40 }), 40);
  assert.equal(progressPercent({ value: 4, max: 8 }), 50);
  assert.equal(progressPercent({ percent: Number.NaN, value: 1, max: 4 }), 25);
  assert.equal(progressPercent({ value: 3, max: 0 }), 0);
  assert.equal(progressPercent({}), 0);
});

test('formatDuration covers ms, seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0 毫秒');
  assert.equal(formatDuration(320), '320 毫秒');
  assert.equal(formatDuration(12980), '13.0 秒');
  assert.equal(formatDuration(59_900), '59.9 秒');
  assert.equal(formatDuration(60_000), '1 分 0 秒');
  assert.equal(formatDuration(125_000), '2 分 5 秒');
  assert.equal(formatDuration(3_600_000), '1 小时 0 分');
  assert.equal(formatDuration(-1), UNKNOWN);
  assert.equal(formatDuration(Number.NaN), UNKNOWN);
  assert.equal(formatDuration('12'), UNKNOWN);
});

test('formatBytes scales units and never prints NaN', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 15.5), '16 MB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
  assert.equal(formatBytes(1024 ** 5), '1024 TB');
  assert.equal(formatBytes(-1), UNKNOWN);
  assert.equal(formatBytes(null), UNKNOWN);
});

test('formatRelativeTime buckets ages and tolerates clock skew', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now - 1000, now), '刚刚');
  assert.equal(formatRelativeTime(now + 5000, now), '刚刚');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3 小时前');
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2 天前');
  assert.equal(formatRelativeTime(0, now), UNKNOWN);
  assert.equal(formatRelativeTime('not-a-date', now), UNKNOWN);
  assert.match(formatRelativeTime(now - 40 * 86_400_000, now), /^\d{4}-\d{2}-\d{2}$/);
});

test('statusLabel maps every contract status and degrades safely', () => {
  assert.equal(statusLabel('queued'), '排队中');
  assert.equal(statusLabel('running'), '生成中');
  assert.equal(statusLabel('succeeded'), '已完成');
  assert.equal(statusLabel('failed'), '失败');
  assert.equal(statusLabel('canceled'), '已取消');
  assert.equal(statusLabel('weird'), 'weird');
  assert.equal(statusLabel(''), '未知');
  assert.equal(statusLabel(null), '未知');
  assert.equal(statusLabel('x'.repeat(80)).length, 24);
});

test('statusTone maps to CSS tones', () => {
  assert.equal(statusTone('running'), 'running');
  assert.equal(statusTone('queued'), 'queued');
  assert.equal(statusTone('succeeded'), 'success');
  assert.equal(statusTone('failed'), 'error');
  assert.equal(statusTone('canceled'), 'muted');
  assert.equal(statusTone('anything-else'), 'muted');
});

test('modeLabel localises preset modes', () => {
  assert.equal(modeLabel('unet'), 'UNet');
  assert.equal(modeLabel('checkpoint'), 'Checkpoint');
  assert.equal(modeLabel('custom'), '自定义工作流');
  assert.equal(modeLabel('mystery'), 'mystery');
  assert.equal(modeLabel(undefined), UNKNOWN);
});

test('excerpt flattens whitespace and clamps length', () => {
  assert.equal(excerpt('  hello   world  '), 'hello world');
  assert.equal(excerpt('abcdef', 4), 'abc…');
  assert.equal(excerpt('abc', 10), 'abc');
  assert.equal(excerpt(null), '');
});

test('jobDuration prefers recorded duration then elapsed wall clock', () => {
  const now = 10_000;
  assert.equal(jobDuration({ durationMs: 12980 }, now), '13.0 秒');
  assert.equal(jobDuration({ durationMs: null, startedAt: 4000 }, now), '6.0 秒');
  assert.equal(jobDuration({ durationMs: null, startedAt: null }, now), UNKNOWN);
  assert.equal(jobDuration(null, now), UNKNOWN);
});

test('ratioHint names common aspect ratios', () => {
  assert.equal(ratioHint(1024, 1024), '1:1 · 方形');
  assert.equal(ratioHint(1328, 1328), '1:1 · 方形');
  assert.equal(ratioHint(1024, 768), '4:3 · 横向');
  assert.equal(ratioHint(768, 1024), '3:4 · 纵向');
  assert.equal(ratioHint(1920, 1080), '16:9 · 宽屏');
  assert.equal(ratioHint(0, 100), '');
  assert.equal(ratioHint('a', 1), '');
  assert.match(ratioHint(1000, 400), /:1$/);
});

test('formatCount renders non-negative counts only', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(12.6), '13');
  assert.equal(formatCount(-1), UNKNOWN);
  assert.equal(formatCount('7'), '7');
  assert.equal(formatCount(null), UNKNOWN);
});

test('validateSettingsDraft accepts a well-formed draft', () => {
  const errors = validateSettingsDraft({
    baseUrl: 'http://127.0.0.1:8188',
    requestTimeoutSeconds: 30,
    generateTimeoutSeconds: 300,
    pollIntervalMs: 2000,
    width: 1024,
    height: 1024,
    steps: 8,
    cfg: 1,
    batch: 1,
    retentionDays: 0,
    maxGalleryItems: 500,
    seedMode: 'random',
    seed: 0,
  });
  assert.deepEqual(errors, {});
});

test('validateSettingsDraft flags bad values without throwing', () => {
  const errors = validateSettingsDraft({
    baseUrl: 'ftp://example.com',
    requestTimeoutSeconds: 1,
    generateTimeoutSeconds: '',
    pollIntervalMs: 99_999,
    width: 10,
    height: 99_999,
    steps: 0,
    cfg: 99,
    batch: 12,
    retentionDays: -1,
    maxGalleryItems: 0,
    seedMode: 'fixed',
    seed: '',
  });
  assert.ok(errors.baseUrl);
  assert.ok(errors.requestTimeoutSeconds);
  assert.ok(errors.generateTimeoutSeconds);
  assert.ok(errors.pollIntervalMs);
  assert.ok(errors.width);
  assert.ok(errors.height);
  assert.ok(errors.steps);
  assert.ok(errors.cfg);
  assert.ok(errors.batch);
  assert.ok(errors.retentionDays);
  assert.ok(errors.maxGalleryItems);
  assert.ok(errors.seed);
  assert.deepEqual(validateSettingsDraft(null), { form: '设置数据不可用' });
});

test('validateSettingsDraft allows an empty baseUrl (Host default)', () => {
  assert.deepEqual(validateSettingsDraft({ baseUrl: '  ' }), {});
});

test('parseWorkflowJson accepts API-format objects only', () => {
  const good = parseWorkflowJson(JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}' } } }));
  assert.equal(good.ok, true);
  assert.equal(good.value['3'].class_type, 'KSampler');

  assert.equal(parseWorkflowJson('').ok, false);
  assert.equal(parseWorkflowJson('{').ok, false);
  const array = parseWorkflowJson('[]');
  assert.equal(array.ok, false);
  assert.match(array.message, /JSON 对象/);
  const empty = parseWorkflowJson('{}');
  assert.equal(empty.ok, false);
  const noClass = parseWorkflowJson('{"1":{"inputs":{}}}');
  assert.equal(noClass.ok, false);
  assert.match(noClass.message, /class_type/);
  const notObject = parseWorkflowJson('{"1":5}');
  assert.equal(notObject.ok, false);
});

test('helpers are total over hostile input', () => {
  const hostile = [undefined, null, 0, -1, '', 'x', [], {}, Number.NaN, Number.POSITIVE_INFINITY, Symbol.iterator];
  for (const value of hostile) {
    assert.doesNotThrow(() => formatDuration(value));
    assert.doesNotThrow(() => formatBytes(value));
    assert.doesNotThrow(() => clampPercent(value));
    assert.doesNotThrow(() => statusLabel(value));
    assert.doesNotThrow(() => excerpt(value));
    assert.doesNotThrow(() => ratioHint(value, value));
    assert.doesNotThrow(() => parseWorkflowJson(value));
  }
});

test('flattenGallery orders images across jobs and skips unusable entries', () => {
  const url = (id) => (id ? `/api/dsh-comfyui/image?id=${id}` : '');
  const jobs = [
    { id: 'j1', images: [{ id: 'a', url: '/x/a.png' }, { id: 'b' }] },
    { id: 'j2', images: [{ id: 'c', url: '/x/c.png' }, { id: '', url: '' }] },
    { id: 'j3', images: [] },
    { id: 'j4' },
    { id: 'j5', images: [{ id: 'a', url: '/x/a.png' }] },
  ];
  const items = flattenGallery(jobs, url);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.image.id), ['a', 'b', 'c']);
  // The fallback URL builder fills in a missing url.
  assert.equal(items[1].url, '/api/dsh-comfyui/image?id=b');
  // A repeated image id is not listed twice.
  assert.equal(items.filter((item) => item.image.id === 'a').length, 1);
  // Each entry keeps its owning job, which the viewer reads for metadata.
  assert.equal(items[0].job.id, 'j1');
  assert.equal(items[2].job.id, 'j2');
});

test('flattenGallery tolerates a non-array and a missing url builder', () => {
  assert.deepEqual(flattenGallery(null, () => ''), []);
  assert.deepEqual(flattenGallery(undefined, () => ''), []);
  assert.deepEqual(flattenGallery([{ id: 'j', images: [{ id: 'x', url: '/x.png' }] }], undefined).length, 1);
  // Without a URL at all the image cannot be displayed, so it is dropped.
  assert.deepEqual(flattenGallery([{ id: 'j', images: [{ id: 'x' }] }], undefined), []);
});

test('wrapIndex wraps in both directions and never leaves the range', () => {
  assert.equal(wrapIndex(0, 5), 0);
  assert.equal(wrapIndex(4, 5), 4);
  assert.equal(wrapIndex(5, 5), 0);
  assert.equal(wrapIndex(6, 5), 1);
  // Stepping back from the first image lands on the last.
  assert.equal(wrapIndex(-1, 5), 4);
  assert.equal(wrapIndex(-6, 5), 4);
  // Degenerate inputs.
  assert.equal(wrapIndex(3, 0), 0);
  assert.equal(wrapIndex(Number.NaN, 5), 0);
  assert.equal(wrapIndex(2.7, 5), 2);
});

test('scopeSessionId only filters when a conversation is actually bound', () => {
  assert.equal(scopeSessionId('current', 'session-a'), 'session-a');
  assert.equal(scopeSessionId('current', '  session-a  '), 'session-a');
  // All means all, regardless of the bound session.
  assert.equal(scopeSessionId('all', 'session-a'), undefined);
  // A missing or blank session cannot scope anything.
  assert.equal(scopeSessionId('current', undefined), undefined);
  assert.equal(scopeSessionId('current', null), undefined);
  assert.equal(scopeSessionId('current', ''), undefined);
  assert.equal(scopeSessionId('current', '   '), undefined);
  // An unknown scope behaves like "all" rather than filtering by a junk value.
  assert.equal(scopeSessionId('nonsense', 'session-a'), undefined);
});

test('effectiveGalleryScope degrades 当前对话 to 全部 without a session', () => {
  // Showing an empty gallery because the panel has no session would read as
  // data loss, so the requested scope is downgraded instead.
  assert.equal(effectiveGalleryScope('current', 'session-a'), 'current');
  assert.equal(effectiveGalleryScope('current', undefined), 'all');
  assert.equal(effectiveGalleryScope('current', ''), 'all');
  assert.equal(effectiveGalleryScope('all', 'session-a'), 'all');
  assert.equal(effectiveGalleryScope(undefined, 'session-a'), 'all');
});
