import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_PRESETS, PLACEHOLDERS, buildWorkflow, builtinPreset, expandCustomWorkflow,
  normalizePreset, outputNodeIds, resolvePreset, unknownPlaceholders, validatePreset,
} from '../host/presets.js';

const baseParams = {
  prompt: 'a cat',
  negative: '',
  width: 512,
  height: 512,
  seed: 42,
  steps: 8,
  cfg: 1,
  sampler: 'res_multistep',
  scheduler: 'simple',
  batch: 1,
};

test('every built-in preset has an id, a name and a mode', () => {
  assert.ok(BUILTIN_PRESETS.length >= 2);
  for (const preset of BUILTIN_PRESETS) {
    assert.ok(preset.id);
    assert.ok(preset.name);
    assert.ok(['unet', 'checkpoint', 'custom'].includes(preset.mode));
    assert.equal(preset.kind, 'builtin');
  }
  // ids are unique
  assert.equal(new Set(BUILTIN_PRESETS.map((p) => p.id)).size, BUILTIN_PRESETS.length);
});

test('the unet workflow wires loaders, sampler and a save node', () => {
  const workflow = buildWorkflow({ preset: builtinPreset('zimage-turbo'), ...baseParams });
  const types = Object.values(workflow).map((node) => node.class_type);
  assert.ok(types.includes('UNETLoader'));
  assert.ok(types.includes('CLIPLoader'));
  assert.ok(types.includes('VAELoader'));
  assert.ok(types.includes('KSampler'));
  assert.ok(types.includes('VAEDecode'));
  assert.ok(types.includes('SaveImage'));

  const sampler = Object.values(workflow).find((node) => node.class_type === 'KSampler');
  assert.equal(sampler.inputs.seed, 42);
  assert.equal(sampler.inputs.steps, 8);
  assert.equal(sampler.inputs.cfg, 1);
  assert.equal(sampler.inputs.sampler_name, 'res_multistep');
  assert.equal(sampler.inputs.scheduler, 'simple');
  // A CFG of 1 has no negative branch to speak of; the graph zeroes it out.
  const negative = Object.values(workflow).find((node) => node.inputs?.conditioning !== undefined);
  assert.equal(negative.class_type, 'ConditioningZeroOut');
});

test('a CFG above 1 builds a real negative prompt branch', () => {
  const workflow = buildWorkflow({
    preset: builtinPreset('zimage-turbo'),
    ...baseParams,
    cfg: 5,
    negative: 'blurry',
  });
  const encodes = Object.values(workflow).filter((node) => node.class_type === 'CLIPTextEncode');
  assert.equal(encodes.length, 2);
  assert.ok(encodes.some((node) => node.inputs.text === 'blurry'));
});

test('the checkpoint preset uses a single loader and plain latent', () => {
  const preset = {
    ...builtinPreset('checkpoint-sdxl'),
    models: { checkpoint: 'sd_xl_base_1.0.safetensors' },
  };
  const workflow = buildWorkflow({ preset, ...baseParams, cfg: 6, steps: 25 });
  const types = Object.values(workflow).map((node) => node.class_type);
  assert.ok(types.includes('CheckpointLoaderSimple'));
  assert.ok(!types.includes('UNETLoader'));
  assert.ok(types.includes('EmptyLatentImage'));
  assert.ok(!types.includes('EmptySD3LatentImage'));
  assert.ok(!types.includes('ModelSamplingAuraFlow'));
});

test('a checkpoint preset without a model fails with a coded error', () => {
  assert.throws(
    () => buildWorkflow({ preset: builtinPreset('checkpoint-sdxl'), ...baseParams }),
    (error) => error.code === 'comfyui/model-missing',
  );
});

test('a unet preset missing a model fails with a coded error', () => {
  const preset = { ...builtinPreset('zimage-turbo'), models: { unet: 'x.safetensors' } };
  assert.throws(
    () => buildWorkflow({ preset, ...baseParams }),
    (error) => error.code === 'comfyui/model-missing',
  );
});

test('a LoRA node is inserted between the loaders and the sampler', () => {
  const preset = {
    ...builtinPreset('zimage-turbo'),
    models: { ...builtinPreset('zimage-turbo').models, lora: 'style.safetensors', loraStrength: 0.7 },
  };
  const workflow = buildWorkflow({ preset, ...baseParams });
  const lora = Object.values(workflow).find((node) => node.class_type === 'LoraLoader');
  assert.ok(lora);
  assert.equal(lora.inputs.lora_name, 'style.safetensors');
  assert.equal(lora.inputs.strength_model, 0.7);
});

test('outputNodeIds finds the save sink', () => {
  const workflow = buildWorkflow({ preset: builtinPreset('zimage-turbo'), ...baseParams });
  const ids = outputNodeIds(workflow);
  assert.equal(ids.length, 1);
  assert.equal(workflow[ids[0]].class_type, 'SaveImage');
});

test('validatePreset compares declared models with the server listing', () => {
  const preset = builtinPreset('zimage-turbo');
  const good = validatePreset(preset, {
    diffusion_models: [preset.models.unet],
    text_encoders: [preset.models.clip],
    vae: [preset.models.vae],
    checkpoints: [],
    loras: [],
  });
  assert.equal(good.valid, true);
  assert.deepEqual(good.missing, []);

  const bad = validatePreset(preset, { diffusion_models: [], text_encoders: [], vae: [], checkpoints: [], loras: [] });
  assert.equal(bad.valid, false);
  assert.equal(bad.missing.length, 3);

  // Unknown (no listing yet) is distinct from invalid.
  assert.equal(validatePreset(preset, null).valid, null);
});

test('validatePreset reports an unset checkpoint as needing a choice', () => {
  const result = validatePreset(builtinPreset('checkpoint-sdxl'), { checkpoints: [], diffusion_models: [], text_encoders: [], vae: [], loras: [] });
  assert.equal(result.valid, false);
  assert.match(result.missing[0], /checkpoint/);
});

test('resolvePreset falls back to the shipped default for an unknown id', () => {
  const preset = resolvePreset('does-not-exist', []);
  assert.equal(preset.id, 'zimage-turbo');
});

test('resolvePreset returns a deep copy so callers cannot mutate the table', () => {
  const preset = resolvePreset('zimage-turbo', []);
  preset.models.unet = 'mutated';
  assert.notEqual(builtinPreset('zimage-turbo').models.unet, 'mutated');
});

test('normalizePreset rejects a custom preset with no workflow', () => {
  assert.equal(normalizePreset({ id: 'x', name: 'X', mode: 'custom' }), null);
  assert.equal(normalizePreset({ id: 'x', name: 'X', mode: 'unet' })?.mode, 'unet');
  assert.equal(normalizePreset(null), null);
  assert.equal(normalizePreset({ id: '', name: 'X' }), null);
});

test('normalizePreset keeps the workflow of a custom preset', () => {
  const workflow = { '1': { class_type: 'SaveImage', inputs: { filename_prefix: '{{prompt}}' } } };
  const preset = normalizePreset({ id: 'c1', name: 'C1', mode: 'custom', workflow });
  assert.deepEqual(preset.workflow, workflow);
  assert.equal(preset.kind, 'custom');
});

test('expandCustomWorkflow substitutes exact placeholders with native types', () => {
  const workflow = {
    '1': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-{{seed}}' } },
  };
  const expanded = expandCustomWorkflow(workflow, {
    seed: 7, steps: 12, cfg: 3.5, prompt: 'a dog',
  });
  assert.equal(expanded['1'].inputs.seed, 7);
  assert.equal(typeof expanded['1'].inputs.seed, 'number');
  assert.equal(expanded['1'].inputs.steps, 12);
  assert.equal(expanded['1'].inputs.cfg, 3.5);
  assert.equal(expanded['2'].inputs.text, 'a dog');
  // An embedded placeholder stays a string.
  assert.equal(expanded['3'].inputs.filename_prefix, 'dsh-7');
});

test('expandCustomWorkflow leaves unknown placeholders untouched and does not mutate input', () => {
  const workflow = { '1': { class_type: 'X', inputs: { a: '{{unknown}}', b: '{{prompt}}' } } };
  const snapshot = JSON.stringify(workflow);
  const expanded = expandCustomWorkflow(workflow, { prompt: 'p' });
  assert.equal(expanded['1'].inputs.a, '{{unknown}}');
  assert.equal(expanded['1'].inputs.b, 'p');
  assert.equal(JSON.stringify(workflow), snapshot);
});

test('expandCustomWorkflow walks arrays and rejects a non-object', () => {
  const expanded = expandCustomWorkflow({ '1': { inputs: { list: ['{{seed}}', 'x'] } } }, { seed: 3 });
  assert.deepEqual(expanded['1'].inputs.list, [3, 'x']);
  assert.throws(() => expandCustomWorkflow([], {}), (error) => error.code === 'comfyui/invalid');
  assert.throws(() => expandCustomWorkflow(null, {}), (error) => error.code === 'comfyui/invalid');
});

test('a custom preset goes through the same build entry point', () => {
  const preset = normalizePreset({
    id: 'c2', name: 'C2', mode: 'custom',
    workflow: {
      '1': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } },
    },
  });
  const workflow = buildWorkflow({ preset, ...baseParams });
  assert.equal(workflow['1'].inputs.seed, 42);
  assert.equal(workflow['1'].inputs.steps, 8);
});

test('unknownPlaceholders reports names outside the supported set', () => {
  assert.deepEqual(unknownPlaceholders({ a: '{{prompt}}' }), []);
  assert.deepEqual(unknownPlaceholders({ a: '{{nope}}' }).sort(), ['nope']);
  for (const name of PLACEHOLDERS) {
    assert.deepEqual(unknownPlaceholders({ a: `{{${name}}}` }), [], name);
  }
});

test('an unset model is reported as missing even before the listing arrives', () => {
  // The blank model fields are knowable without asking the server; reporting
  // them as merely "unknown" hid a configuration step the user could complete.
  const unsetCheckpoint = validatePreset(builtinPreset('checkpoint-sdxl'), null);
  assert.equal(unsetCheckpoint.valid, false);
  assert.deepEqual(unsetCheckpoint.missing, ['未选择 checkpoint 模型']);

  const unsetUnet = validatePreset({ ...builtinPreset('zimage-turbo'), models: {} }, null);
  assert.equal(unsetUnet.valid, false);
  assert.equal(unsetUnet.missing.length, 3);

  // A fully configured preset with no listing yet is genuinely unknown.
  assert.equal(validatePreset(builtinPreset('zimage-turbo'), null).valid, null);
});
