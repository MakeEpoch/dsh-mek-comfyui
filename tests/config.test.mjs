import test from 'node:test';
import assert from 'node:assert/strict';

import { Config, resolveConfig, resolveDefaults, normalizeBaseUrl, SAMPLERS, SCHEDULERS } from '../host/config.js';

test('resolveDefaults returns plain values, not volatile references', () => {
  const defaults = resolveDefaults();
  assert.equal(typeof defaults.baseUrl, 'string');
  assert.equal(typeof defaults.width, 'number');
  assert.equal(typeof defaults.enabled, 'boolean');
  // A leaked reference would serialize as an object.
  assert.doesNotMatch(JSON.stringify(defaults), /"get":/);
  assert.equal(defaults.baseUrl, 'http://127.0.0.1:8188');
});

test('resolveConfig merges a partial patch over the defaults', () => {
  const config = resolveConfig({ width: 768, steps: 12 });
  assert.equal(config.width, 768);
  assert.equal(config.steps, 12);
  assert.equal(config.height, resolveDefaults().height);
  assert.equal(config.enabled, true);
});

test('resolveConfig clamps out-of-range numbers instead of throwing', () => {
  const config = resolveConfig({ width: 99999, steps: -5, cfg: 1000, batch: 99 });
  assert.equal(config.width, 8192);
  assert.equal(config.steps, 1);
  assert.equal(config.cfg, 30);
  assert.equal(config.batch, 8);
});

test('resolveConfig falls back for unusable values', () => {
  const defaults = resolveDefaults();
  const config = resolveConfig({
    width: 'not a number',
    sampler: 'not-a-sampler',
    scheduler: 'not-a-scheduler',
    seedMode: 'sideways',
    enabled: 'yes',
  });
  assert.equal(config.width, defaults.width);
  assert.equal(config.sampler, defaults.sampler);
  assert.equal(config.scheduler, defaults.scheduler);
  assert.equal(config.seedMode, defaults.seedMode);
  assert.equal(config.enabled, defaults.enabled);
});

test('resolveConfig normalizes the base url', () => {
  assert.equal(resolveConfig({ baseUrl: '192.168.1.5:8188' }).baseUrl, 'http://192.168.1.5:8188');
  assert.equal(resolveConfig({ baseUrl: 'http://host:8188/' }).baseUrl, 'http://host:8188');
  assert.equal(resolveConfig({ baseUrl: 'https://host/comfy/' }).baseUrl, 'https://host/comfy');
  // A copied reverse-proxy address with /api is trimmed back to the origin.
  assert.equal(resolveConfig({ baseUrl: 'https://host/comfy/api' }).baseUrl, 'https://host/comfy');
});

test('normalizeBaseUrl rejects a non-http scheme and empty input', () => {
  assert.equal(normalizeBaseUrl(''), null);
  assert.equal(normalizeBaseUrl('   '), null);
  assert.equal(normalizeBaseUrl('ftp://host:21'), null);
  assert.equal(normalizeBaseUrl('file:///tmp/x'), null);
});

test('the token is preserved but is not part of the schema defaults', () => {
  const config = resolveConfig({ authToken: 'secret-token' });
  assert.equal(config.authToken, 'secret-token');
  assert.equal(resolveDefaults().authToken, '');
});

test('every sampler and scheduler offered by the schema normalizes to itself', () => {
  for (const sampler of SAMPLERS) {
    assert.equal(resolveConfig({ sampler }).sampler, sampler, sampler);
  }
  for (const scheduler of SCHEDULERS) {
    assert.equal(resolveConfig({ scheduler }).scheduler, scheduler, scheduler);
  }
});

test('the parsed schema exposes a defaults projection the settings page can render', () => {
  const parsed = Config({});
  assert.ok(parsed && typeof parsed === 'object');
  const defaults = resolveDefaults();
  for (const key of Object.keys(defaults)) {
    assert.ok(key in parsed, `schema is missing ${key}`);
  }
});

test('prompt fields are trimmed only where trimming is safe', () => {
  // promptPrefix and saveDir are trimmed; prompt-like free text keeps its shape.
  const config = resolveConfig({ promptPrefix: '  cinematic  ', saveDir: '  /data/pics  ' });
  assert.equal(config.promptPrefix, '  cinematic  ');
  assert.equal(config.saveDir, '/data/pics');
});
