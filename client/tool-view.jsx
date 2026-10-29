/**
 * Conversation card for the `comfyui_generate` tool call.
 *
 * The slot owner hands over `{ callId, toolName, phase, block, cwd, home,
 * loadImage, openFile, inspect, useDisclosure, renderFactorySlot, t }`. Three stages
 * exist: `preparing` (arguments still streaming), `start` (complete arguments,
 * no result yet), and `result` (a settled node). Every read below is
 * defensive: a missing or differently shaped field degrades to a summary line
 * instead of throwing inside the transcript.
 */
import * as React from 'react';
import { installStyles } from './styles.js';
import { excerpt, formatDuration, formatCount } from './format.js';

/**
 * Read one string argument from the block's lazy argument view.
 *
 * The view is a `PartialArguments` instance (`text(key)` / `value(key)`), but
 * older records and fixtures may expose a plain object, so both are accepted.
 * @param block the current tool block.
 * @param key argument name.
 */
function readArg(block, key) {
  const args = block?.args;
  if (args === null || typeof args !== 'object') return undefined;
  try {
    if (typeof args.text === 'function') {
      const value = args.text(key);
      if (value !== undefined) return value;
      if (typeof args.value === 'function') {
        const other = args.value(key);
        if (other !== undefined && other !== null) return other;
      }
      return undefined;
    }
    if (Object.hasOwn(args, key)) {
      const value = args[key];
      return value === null ? undefined : value;
    }
  } catch {
    // A view over truncated text can refuse a read; treat it as absent.
    return undefined;
  }
  return undefined;
}

/**
 * Read one numeric argument, tolerating strings and absent fields.
 * @param block the current tool block.
 * @param key argument name.
 */
function readNumber(block, key) {
  const value = readArg(block, key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parse the JSON result value the Host records for `comfyui_generate`.
 *
 * CONTRACT §3 says the result value is JSON. In the transcript it arrives as
 * text blocks, possibly wrapped in a fence or prefixed by the envelope lines
 * the renderer writes, so the first balanced object is extracted rather than
 * assuming the whole block is JSON.
 * @param block the settled tool node.
 * @returns the parsed object, or null when nothing usable was found.
 */
export function parseResultValue(block) {
  const content = Array.isArray(block?.content) ? block.content : [];
  const texts = [];
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
  }
  for (const text of texts) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const parsed = tryParse(trimmed);
      if (parsed !== null) return parsed;
    }
    // Scan for the first object that parses on its own.
    for (let start = trimmed.indexOf('{'); start !== -1; start = trimmed.indexOf('{', start + 1)) {
      const candidate = balancedObject(trimmed, start);
      if (candidate === null) continue;
      const parsed = tryParse(candidate);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    }
  }
  return null;
}

/** JSON.parse that answers null instead of throwing. */
function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Extract the balanced `{...}` slice starting at `start`, ignoring braces
 * inside JSON strings.
 * @param text source text.
 * @param start index of the opening brace.
 */
function balancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Normalise the images array from a result value.
 *
 * Each entry is `{ path, url, width, height, filename }` per CONTRACT §3. A
 * non-array or malformed entry is dropped rather than rendered as a broken
 * `<img>`.
 * @param value the parsed result value.
 */
export function readImages(value) {
  const raw = Array.isArray(value?.images) ? value.images : [];
  const images = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' && item.url !== '' ? item.url : '';
    if (url === '') continue;
    images.push({
      url,
      path: typeof item.path === 'string' ? item.path : '',
      filename: typeof item.filename === 'string' ? item.filename : '',
      width: typeof item.width === 'number' ? item.width : undefined,
      height: typeof item.height === 'number' ? item.height : undefined,
    });
  }
  return images;
}

/**
 * Derive the card's display model from the current block.
 * @param block the tool block for this stage.
 */
export function cardModel(block) {
  const prompt = (() => {
    const value = readArg(block, 'prompt');
    return typeof value === 'string' ? value.trim() : '';
  })();
  const width = readNumber(block, 'width');
  const height = readNumber(block, 'height');
  const steps = readNumber(block, 'steps');
  const seed = readNumber(block, 'seed');
  const batch = readNumber(block, 'batch');
  const preset = readArg(block, 'preset');
  const negative = readArg(block, 'negative_prompt');
  return {
    prompt,
    negative: typeof negative === 'string' ? negative.trim() : '',
    width,
    height,
    steps,
    seed,
    batch,
    preset: typeof preset === 'string' ? preset : '',
    result: block?.phase === 'result' ? parseResultValue(block) : null,
  };
}

/**
 * The card itself.
 *
 * Progress has no live stream: while the call is running a client-side timer
 * animates from 0 toward 90% and stops there, so the bar never claims
 * completion before the result lands.
 */
export function GenerateCard(props) {
  const { block, phase, renderFactorySlot, loadImage } = props ?? {};

  // One reference-counted stylesheet for the whole plugin.
  React.useEffect(() => installStyles(), []);

  const stage = typeof phase === 'string' ? phase : block?.phase === 'result' ? 'result' : 'start';
  const model = React.useMemo(() => {
    try {
      return cardModel(block);
    } catch {
      return { prompt: '', negative: '', width: undefined, height: undefined, steps: undefined, seed: undefined, batch: undefined, preset: '', result: null };
    }
  }, [block]);

  const running = stage !== 'result';
  const [creep, setCreep] = React.useState(0);
  const [elapsed, setElapsed] = React.useState(0);
  const startedAt = React.useRef(Date.now());

  // Animate toward 90% while running; stop the timers on settle/unmount.
  React.useEffect(() => {
    if (!running) {
      setCreep(0);
      return undefined;
    }
    startedAt.current = Date.now();
    const step = setInterval(() => {
      setCreep((current) => (current >= 90 ? 90 : Math.min(90, current + Math.max(0.7, (90 - current) * 0.045))));
      setElapsed(Date.now() - startedAt.current);
    }, 500);
    return () => clearInterval(step);
  }, [running]);

  const settled = stage === 'result';
  const failed = settled && block?.isError === true;
  const interrupted = settled && block?.error?.code === 'interrupted';
  const state = !settled ? 'running' : interrupted ? 'stopped' : failed ? 'error' : 'ok';
  const glyph = state === 'ok' ? '✓' : state === 'error' ? '!' : state === 'stopped' ? '⏹' : '◌';
  const stateText = state === 'ok' ? '已完成' : state === 'error' ? '失败' : state === 'stopped' ? '已中止' : stage === 'preparing' ? '准备中' : '生成中';

  const chips = [];
  if (model.width !== undefined && model.height !== undefined) chips.push(`${model.width}×${model.height}`);
  else if (model.width !== undefined) chips.push(`宽 ${model.width}`);
  if (model.steps !== undefined) chips.push(`${model.steps} 步`);
  if (model.batch !== undefined && model.batch > 1) chips.push(`×${model.batch}`);
  if (model.seed !== undefined) chips.push(`seed ${model.seed}`);
  if (model.preset !== '') chips.push(model.preset);

  const result = model.result;
  const images = readImages(result);
  const durationMs = typeof result?.durationMs === 'number' ? result.durationMs : undefined;
  const resultSeed = typeof result?.seed === 'number' ? result.seed : model.seed;
  const message = typeof result?.message === 'string' ? result.message : '';

  const thumbnails = settled && images.length > 0 ? (
    <div className="cfqt-thumbs">
      {images.map((image, index) => (
        <a key={`${image.url}-${index}`} href={image.url} target="_blank" rel="noreferrer" title={image.filename || '打开原图'}>
          <img src={image.url} alt={image.filename || '生成结果'} loading="lazy" decoding="async" />
        </a>
      ))}
    </div>
  ) : null;

  // Reuse the public gallery Factory without claiming the base tool's child
  // slot. Factories are reusable occurrences; child declarations have one
  // global owner. Pass the fallback to the outlet as well: a missing/unloaded
  // Factory is resolved during React rendering, not by this synchronous call.
  const gallery = (() => {
    if (!settled || images.length === 0) return null;
    if (typeof renderFactorySlot !== 'function' || typeof loadImage !== 'function') return thumbnails;
    const attachments = [];
    for (const part of Array.isArray(block?.content) ? block.content : []) {
      if (part !== null && typeof part === 'object' && part.type === 'image' && part.attachment !== null && typeof part.attachment === 'object') attachments.push(part.attachment);
    }
    if (attachments.length === 0) return thumbnails;
    try {
      return renderFactorySlot('conversation.images.content', {
        images: attachments.map((attachment) => ({ attachment })),
        loadImage,
        align: 'start',
      }, { fallback: thumbnails }) ?? thumbnails;
    } catch {
      return thumbnails;
    }
  })();

  const errorText = (() => {
    if (!settled) return '';
    if (interrupted) {
      // A user-driven stop is not a failure; say so plainly.
      const text = result?.error?.message;
      return typeof text === 'string' && text !== '' ? text : '已中止，未生成图片。';
    }
    if (failed) {
      const reason = block?.error?.reason ?? block?.error?.code ?? '';
      const text = result?.error?.message ?? message;
      if (typeof text === 'string' && text !== '') return text;
      return typeof reason === 'string' && reason !== '' ? `调用失败（${reason}）` : '调用失败';
    }
    return '';
  })();

  return (
    <div className="cfqt">
      <div className="cfqt-head">
        <span className="cfqt-glyph" data-state={state} aria-hidden="true">{glyph}</span>
        <span className="cfqt-title">ComfyUI 出图</span>
        <span className="cfqt-state" role="status">{stateText}</span>
      </div>

      {model.prompt !== '' ? <div className="cfqt-prompt">{model.prompt}</div> : null}

      {chips.length > 0 ? (
        <div className="cfqt-chips">
          {chips.map((chip) => <span key={chip} className="cfqt-chip">{chip}</span>)}
        </div>
      ) : null}

      {running ? (
        <div className="cfq-prog">
          <div className="cfq-progTrack" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(creep)} aria-label="生成进度">
            <div className="cfq-progFill" style={{ width: `${Math.round(creep)}%` }} />
          </div>
          <div className="cfq-progMeta">
            <span>{stage === 'preparing' ? '准备参数…' : '生成中…'}</span>
            <span>{formatDuration(elapsed)}</span>
          </div>
        </div>
      ) : null}

      {errorText !== '' ? <div className="cfqt-error">{errorText}</div> : null}

      {gallery}

      {settled && (durationMs !== undefined || resultSeed !== undefined || message !== '') ? (
        <div className="cfqt-foot">
          {durationMs !== undefined ? <span>用时 {formatDuration(durationMs)}</span> : null}
          {resultSeed !== undefined ? <span>seed {formatCount(resultSeed)}</span> : null}
          {images.length > 0 ? <span>{images.length} 张</span> : null}
          {message !== '' && errorText === '' ? <span>{excerpt(message, 60)}</span> : null}
        </div>
      ) : null}

      {settled && images.length === 0 && errorText === '' && message === '' && durationMs === undefined ? (
        <div className="cfq-hint">本次调用没有返回图片。</div>
      ) : null}
    </div>
  );
}
