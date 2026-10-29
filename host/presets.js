/**
 * Workflow presets: the mapping from a user request to a ComfyUI API-format
 * graph, plus the placeholder expansion a custom preset goes through.
 *
 * Three modes cover what a local ComfyUI actually offers:
 *  - `unet`: split-file models (diffusion_models + text_encoders + vae), the
 *    layout Z-Image / Flux / SD3 releases ship with;
 *  - `checkpoint`: one all-in-one checkpoint file, the classic SD1.5/SDXL path;
 *  - `custom`: an API-format workflow the user pasted, with placeholders.
 *
 * The built-in `zimage-turbo` preset matches the models installed on this
 * machine, so a fresh install generates immediately instead of erroring on a
 * model name the user has never downloaded.
 */
import { DEFAULT_PRESET_ID } from './config.js';

/** Placeholders a custom workflow may use (CONTRACT §5). */
export const PLACEHOLDERS = [
  'prompt', 'negative', 'width', 'height', 'seed', 'steps', 'cfg',
  'sampler', 'scheduler', 'batch', 'denoise', 'model',
];

const NUMERIC_PLACEHOLDERS = new Set([
  'width', 'height', 'seed', 'steps', 'cfg', 'batch', 'denoise',
]);

/** Parameter fields a preset supplies defaults for. */
const DEFAULT_PARAMS = Object.freeze({
  width: 1024,
  height: 1024,
  steps: 8,
  cfg: 1,
  sampler: 'res_multistep',
  scheduler: 'simple',
  negative: '',
  batch: 1,
});

/**
 * The presets shipped with the plugin.
 *
 * `models` names the files the graph expects; `validatePreset` compares them
 * against the server's real `/models` listing so the UI can say "缺模型" before
 * a user waits for a failed generation.
 */
export const BUILTIN_PRESETS = Object.freeze([
  {
    id: 'zimage-turbo',
    name: 'Z-Image Turbo（分体模型，8 步）',
    kind: 'builtin',
    mode: 'unet',
    description: 'Z-Image Turbo 的 int8 分体模型：8 步、CFG 1，出图快，适合草稿与日常配图。',
    defaults: { ...DEFAULT_PARAMS, width: 1024, height: 1024, steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' },
    models: {
      unet: 'z_image_turbo_int8_convrot.safetensors',
      clip: 'qwen_3_4b_fp8_mixed.safetensors',
      clipType: 'lumina2',
      vae: 'ae.safetensors',
    },
  },
  {
    id: 'zimage-turbo-bf16',
    name: 'Z-Image Turbo BF16（分体模型，质量优先）',
    kind: 'builtin',
    mode: 'unet',
    description: '同款 Turbo 的 BF16 权重，显存占用更高，细节更稳；8 步、CFG 1。',
    defaults: { ...DEFAULT_PARAMS, width: 1024, height: 1024, steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' },
    models: {
      unet: 'z_image_turbo_bf16.safetensors',
      clip: 'qwen_3_4b_fp8_mixed.safetensors',
      clipType: 'lumina2',
      vae: 'ae.safetensors',
    },
  },
  {
    id: 'checkpoint-sdxl',
    name: '通用 Checkpoint（SDXL / SD1.5 单文件）',
    kind: 'builtin',
    mode: 'checkpoint',
    description: '标准 Checkpoint 流程：正负提示词 + 空 latent + KSampler。把模型换成你下载的单文件权重即可。',
    defaults: { ...DEFAULT_PARAMS, width: 1024, height: 1024, steps: 25, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras', negative: 'low quality, blurry, watermark, text' },
    models: { checkpoint: '' },
  },
]);

/** Deep clone through JSON; every preset is plain data. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Look up a built-in preset by id.
 * @param {string} id
 * @returns {object | undefined}
 */
export function builtinPreset(id) {
  return BUILTIN_PRESETS.find((preset) => preset.id === id);
}

/**
 * Merge a stored custom preset with the shape the rest of the plugin expects,
 * so a hand-edited `presets.json` cannot crash the UI.
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const record = /** @type {Record<string, any>} */ (raw);
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const mode = ['unet', 'checkpoint', 'custom'].includes(record.mode) ? record.mode : 'unet';
  if (!id || !name) return null;
  const defaults = { ...DEFAULT_PARAMS };
  if (record.defaults && typeof record.defaults === 'object') {
    for (const key of Object.keys(DEFAULT_PARAMS)) {
      const value = record.defaults[key];
      if (key === 'negative') {
        if (typeof value === 'string') defaults.negative = value;
      } else if (key === 'sampler' || key === 'scheduler') {
        if (typeof value === 'string' && value) defaults[key] = value;
      } else if (Number.isFinite(Number(value))) {
        defaults[key] = Number(value);
      }
    }
  }
  const models = {};
  if (record.models && typeof record.models === 'object') {
    for (const key of ['checkpoint', 'unet', 'clip', 'clipType', 'vae', 'lora']) {
      const value = record.models[key];
      if (typeof value === 'string') models[key] = value;
    }
    if (Number.isFinite(Number(record.models.loraStrength))) models.loraStrength = Number(record.models.loraStrength);
  }
  const workflow = record.workflow && typeof record.workflow === 'object' && !Array.isArray(record.workflow)
    ? record.workflow
    : null;
  if (mode === 'custom' && !workflow) return null;
  return {
    id,
    name,
    kind: 'custom',
    mode,
    description: typeof record.description === 'string' ? record.description : '',
    defaults,
    models,
    workflow,
  };
}

/**
 * The effective preset: the built-in definition, a stored custom one, or the
 * shipped default when the id is unknown.
 * @param {string} id
 * @param {object[]} customPresets
 * @returns {object}
 */
export function resolvePreset(id, customPresets = []) {
  const builtin = builtinPreset(id);
  if (builtin) return clone(builtin);
  const custom = customPresets.find((preset) => preset?.id === id);
  if (custom) return clone(custom);
  return clone(builtinPreset(DEFAULT_PRESET_ID) ?? BUILTIN_PRESETS[0]);
}

/**
 * Compare a preset's declared model files with what the server reports.
 * @param {object} preset
 * @param {{ checkpoints?: string[], diffusion_models?: string[], text_encoders?: string[], vae?: string[], loras?: string[] } | null} folders
 * @returns {{ valid: boolean | null, missing: string[] }} `valid: null` = unknown (no listing yet)
 */
export function validatePreset(preset, folders) {
  const missing = [];
  const has = (list, name) => Array.isArray(list) && list.includes(name);
  const mode = preset?.mode;
  const models = preset?.models ?? {};
  if (mode === 'custom') return { valid: null, missing: [] };
  // "Nothing is selected yet" is knowable without a server listing, so it is
  // checked first: a preset whose model fields are blank is unusable whatever
  // the server has installed, and reporting it as merely unknown hides a
  // configuration step the user can complete right now.
  const unset = [];
  if (mode === 'checkpoint') {
    if (!models.checkpoint) unset.push('未选择 checkpoint 模型');
  } else {
    if (!models.unet) unset.push('未选择 diffusion_models 模型');
    if (!models.clip) unset.push('未选择 text_encoders 模型');
    if (!models.vae) unset.push('未选择 vae 模型');
  }
  if (unset.length) return { valid: false, missing: unset };
  // Every model field is set at this point, so the listing decides validity.
  if (!folders) return { valid: null, missing: [] };
  if (mode === 'checkpoint') {
    if (!has(folders.checkpoints, models.checkpoint)) missing.push(`checkpoints/${models.checkpoint}`);
  } else {
    if (!has(folders.diffusion_models, models.unet)) missing.push(`diffusion_models/${models.unet}`);
    if (!has(folders.text_encoders, models.clip)) missing.push(`text_encoders/${models.clip}`);
    if (!has(folders.vae, models.vae)) missing.push(`vae/${models.vae}`);
    if (models.lora && !has(folders.loras, models.lora)) missing.push(`loras/${models.lora}`);
  }
  return { valid: missing.length === 0, missing };
}

/** Node ids are stable so a workflow diff is readable; they need not match ComfyUI's UI ids. */
const NODE = Object.freeze({
  checkpoint: '1',
  unet: '1',
  clip: '2',
  vae: '3',
  positive: '4',
  negative: '5',
  latent: '6',
  sampling: '7',
  sampler: '8',
  decode: '9',
  save: '10',
  lora: '11',
});

/**
 * Build the API-format workflow for one request.
 *
 * @param {object} options
 * @param {object} options.preset resolved preset (built-in or custom)
 * @param {string} options.prompt
 * @param {string} options.negative
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.seed
 * @param {number} options.steps
 * @param {number} options.cfg
 * @param {string} options.sampler
 * @param {string} options.scheduler
 * @param {number} options.batch
 * @param {string} [options.filenamePrefix]
 * @returns {Record<string, { class_type: string, inputs: Record<string, unknown> }>}
 */
export function buildWorkflow(options) {
  const {
    preset, prompt, negative, width, height, seed, steps, cfg, sampler, scheduler, batch,
    filenamePrefix = 'dsh-comfyui',
  } = options;
  const models = preset?.models ?? {};
  if (preset?.mode === 'custom') {
    return expandCustomWorkflow(preset.workflow, {
      prompt, negative, width, height, seed, steps, cfg, sampler, scheduler, batch,
      denoise: 1, model: models.checkpoint || models.unet || '',
    });
  }

  const graph = {};
  let modelRef;
  let clipRef;
  let vaeRef;

  if (preset?.mode === 'checkpoint') {
    if (!models.checkpoint) {
      throw codedError('comfyui/model-missing', '这个预设还没有选择 checkpoint 模型，请先在设置 → 模型里选择一个。');
    }
    graph[NODE.checkpoint] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: models.checkpoint },
    };
    modelRef = [NODE.checkpoint, 0];
    clipRef = [NODE.checkpoint, 1];
    vaeRef = [NODE.checkpoint, 2];
  } else {
    if (!models.unet || !models.clip || !models.vae) {
      throw codedError('comfyui/model-missing', '这个预设缺少 diffusion_models / text_encoders / vae 模型，请先在设置里补全。');
    }
    graph[NODE.unet] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: models.unet, weight_dtype: 'default' },
    };
    graph[NODE.clip] = {
      class_type: 'CLIPLoader',
      inputs: { clip_name: models.clip, type: models.clipType || 'stable_diffusion', device: 'default' },
    };
    graph[NODE.vae] = {
      class_type: 'VAELoader',
      inputs: { vae_name: models.vae },
    };
    modelRef = [NODE.unet, 0];
    clipRef = [NODE.clip, 0];
    vaeRef = [NODE.vae, 0];
  }

  if (models.lora) {
    graph[NODE.lora] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: models.lora,
        strength_model: Number(models.loraStrength ?? 1),
        strength_clip: Number(models.loraStrength ?? 1),
        model: modelRef,
        clip: clipRef,
      },
    };
    modelRef = [NODE.lora, 0];
    clipRef = [NODE.lora, 1];
  }

  graph[NODE.positive] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: prompt, clip: clipRef },
  };

  // A distilled model is trained with CFG 1, where the negative branch has no
  // effect; `ConditioningZeroOut` is the graph those releases ship with and it
  // keeps the KSampler signature identical to the CFG>1 case.
  if (cfg <= 1.0001) {
    graph[NODE.negative] = {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: [NODE.positive, 0] },
    };
  } else {
    graph[NODE.negative] = {
      class_type: 'CLIPTextEncode',
      inputs: { text: negative || '', clip: clipRef },
    };
  }

  // The Z-Image / Lumina family expects AuraFlow sampling; the checkpoint path
  // uses the plain model so an arbitrary SDXL file still works.
  if (preset?.mode !== 'checkpoint') {
    graph[NODE.sampling] = {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { shift: 3, model: modelRef },
    };
    modelRef = [NODE.sampling, 0];
  }

  graph[NODE.latent] = preset?.mode === 'checkpoint'
    ? { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batch } }
    : { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: batch } };

  graph[NODE.sampler] = {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      denoise: 1,
      model: modelRef,
      positive: [NODE.positive, 0],
      negative: [NODE.negative, 0],
      latent_image: [NODE.latent, 0],
    },
  };

  graph[NODE.decode] = {
    class_type: 'VAEDecode',
    inputs: { samples: [NODE.sampler, 0], vae: vaeRef },
  };

  graph[NODE.save] = {
    class_type: 'SaveImage',
    inputs: { filename_prefix: filenamePrefix, images: [NODE.decode, 0] },
  };

  return graph;
}

/**
 * Substitute placeholders in an API-format workflow.
 *
 * A string that is exactly one placeholder takes the target's native type, so
 * `"{{seed}}"` becomes a number; a placeholder embedded in a longer string is
 * replaced textually. Arrays and objects are walked; node keys are untouched.
 *
 * @param {Record<string, unknown>} workflow
 * @param {Record<string, string | number>} values
 * @returns {Record<string, unknown>} a fresh graph
 */
export function expandCustomWorkflow(workflow, values) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw codedError('comfyui/invalid', '自定义工作流必须是一个 JSON 对象（ComfyUI 的「Save (API Format)」内容）。');
  }
  const expand = (value) => {
    if (typeof value === 'string') {
      const exact = /^\{\{(\w+)\}\}$/.exec(value);
      if (exact) {
        const key = exact[1];
        if (!(key in values)) return value;
        const replacement = values[key];
        return NUMERIC_PLACEHOLDERS.has(key) ? Number(replacement) : String(replacement);
      }
      return value.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') {
      const next = {};
      for (const [key, item] of Object.entries(value)) next[key] = expand(item);
      return next;
    }
    return value;
  };
  return expand(clone(workflow));
}

/** Collect the node ids whose class is a save/preview sink, for output discovery. */
export function outputNodeIds(workflow) {
  const ids = [];
  for (const [id, node] of Object.entries(workflow ?? {})) {
    const type = node?.class_type;
    if (type === 'SaveImage' || type === 'PreviewImage' || type === 'SaveImageWebsocket') ids.push(id);
  }
  return ids;
}

/** Whether a placeholder set covers every `{{name}}` a workflow uses. */
export function unknownPlaceholders(workflow) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{(\w+)\}\}/g)) found.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(workflow);
  return [...found].filter((name) => !PLACEHOLDERS.includes(name));
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
