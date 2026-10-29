/**
 * Unit tests for host/comfy-client.js.
 *
 * A local `node:http` server on port 0 impersonates the ComfyUI endpoints the
 * client uses, so the suite exercises real sockets without any external network.
 * The WebSocket is a hand-written fake injected through `webSocketFactory`.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { ComfyClient, ComfyError, normalizeBaseUrl } from '../host/comfy-client.js';

/** Memory sizes, spelled as expressions so no bare long literal appears. */
const GIB = 1024 ** 3;
const RAM_TOTAL = 31.16 * GIB;
const RAM_FREE = 8.5 * GIB;
const VRAM_TOTAL = 8 * GIB;
const VRAM_FREE = 3.3 * GIB;

/** Trimmed real response from ComfyUI 0.41.1 `/system_stats`. */
const SYSTEM_STATS = {
  system: {
    os: 'linux',
    ram_total: RAM_TOTAL,
    ram_free: RAM_FREE,
    comfyui_version: '0.41.1',
    required_frontend_version: '1.55.17',
    python_version: '3.13.15 (main, Aug 10 2026, 00:00:00) [GCC 14.3.1 20251022 (Red Hat 14.3.1-4)]',
    pytorch_version: '2.13.0+cu130',
    embedded_python: false,
  },
  devices: [
    {
      name: 'cuda:0 NVIDIA GeForce RTX 4060 Ti : cudaMallocAsync',
      type: 'cuda',
      index: 0,
      vram_total: VRAM_TOTAL,
      vram_free: VRAM_FREE,
      torch_vram_total: 67108864,
      torch_vram_free: 55856720,
    },
  ],
};

/** Real `/models` folder listing (trimmed). */
const MODEL_FOLDERS = ['checkpoints', 'loras', 'vae', 'text_encoders', 'diffusion_models', 'upscale_models'];

/** Real per-folder contents. `loras`/`upscale_models` are empty on this machine. */
const MODELS = {
  checkpoints: ['ltx-video-2b-v0.9.5.safetensors'],
  loras: [],
  vae: ['ae.safetensors'],
  text_encoders: ['qwen_3_4b_fp8_mixed.safetensors', 'ovis_2.5.safetensors', 't5xxl_fp16.safetensors'],
  diffusion_models: ['z_image_turbo_bf16.safetensors', 'ovis_image_bf16.safetensors'],
  upscale_models: [],
};

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

let server;
let baseUrl;
/** Requests the fake server saw, newest last. */
let requests = [];
/** Per-path overrides: (req, body, res) => boolean (handled). */
let overrides = new Map();
let sockets = new Set();

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    });

    const override = overrides.get(url.pathname);
    if (override && override(req, body, res, url)) return;

    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };

    if (url.pathname === '/system_stats') return json(200, SYSTEM_STATS);
    if (url.pathname === '/models') return json(200, MODEL_FOLDERS);
    if (url.pathname.startsWith('/models/')) {
      const folder = decodeURIComponent(url.pathname.slice('/models/'.length));
      if (!(folder in MODELS)) {
        res.writeHead(404);
        return res.end();
      }
      return json(200, MODELS[folder]);
    }
    if (url.pathname === '/queue' && req.method === 'GET') {
      return json(200, { queue_running: [], queue_pending: [] });
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      return json(200, { prompt_id: 'prompt-abc', number: 0, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) return json(200, {});
    if (url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_BYTES.length });
      return res.end(PNG_BYTES);
    }
    if (url.pathname === '/interrupt' || url.pathname === '/queue') {
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    return res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  overrides = new Map();
});

/** Build a client pointed at the fake server. */
function client(options = {}) {
  return new ComfyClient({ baseUrl, logger: () => {}, ...options });
}

describe('normalizeBaseUrl', () => {
  it('assumes http:// when the scheme is missing', () => {
    assert.equal(normalizeBaseUrl('127.0.0.1:8188'), 'http://127.0.0.1:8188');
    assert.equal(normalizeBaseUrl('example.test:8188/'), 'http://example.test:8188');
  });

  it('keeps http(s) and strips the trailing slash', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
    assert.equal(normalizeBaseUrl('https://gpu.example.com/comfy/'), 'https://gpu.example.com/comfy');
  });

  it('rejects non-http schemes and empty values', () => {
    assert.throws(() => normalizeBaseUrl('ws://127.0.0.1:8188'), { code: 'comfyui/invalid' });
    assert.throws(() => normalizeBaseUrl('ftp://x'), { code: 'comfyui/invalid' });
    assert.throws(() => normalizeBaseUrl(''), { code: 'comfyui/invalid' });
    assert.throws(() => normalizeBaseUrl(null), { code: 'comfyui/invalid' });
  });

  it('exposes the normalized base URL and accepts changes', () => {
    const instance = new ComfyClient({ baseUrl: '127.0.0.1:8188/' });
    assert.equal(instance.baseUrl, 'http://127.0.0.1:8188');
    instance.setBaseUrl('http://localhost:9000/');
    assert.equal(instance.baseUrl, 'http://localhost:9000');
    instance.setAuthToken('secret-token');
    assert.equal(instance.authTokenConfigured, true);
    instance.setAuthToken('');
    assert.equal(instance.authTokenConfigured, false);
  });
});

describe('ComfyClient.setTimeout / setBaseUrl / setAuthToken', () => {
  it('reports and updates the effective timeout', () => {
    const instance = new ComfyClient({ baseUrl, timeoutMs: 1500, logger: () => {} });
    assert.equal(instance.timeoutMs, 1500);
    assert.equal(instance.setTimeout(5000), 5000);
    assert.equal(instance.timeoutMs, 5000);
    // Invalid values are ignored rather than disabling the deadline.
    assert.equal(instance.setTimeout(0), 5000);
    assert.equal(instance.setTimeout(-1), 5000);
    assert.equal(instance.setTimeout(Number.NaN), 5000);
    assert.equal(instance.setTimeout('250'), 250);
    assert.equal(instance.timeoutMs, 250);
  });

  it('applies a shortened timeout to the next request', async () => {
    overrides.set('/system_stats', () => true); // never responds
    const instance = client({ timeoutMs: 5000 });
    instance.setTimeout(5);
    await assert.rejects(() => instance.systemStats(), { code: 'comfyui/timeout' });
  });

  it('retargets the next request after setBaseUrl', async () => {
    const instance = client();
    const first = await instance.systemStats();
    assert.equal(first.ok, true);

    // A dead port makes the redirect observable.
    instance.setBaseUrl('http://127.0.0.1:1');
    assert.equal(instance.baseUrl, 'http://127.0.0.1:1');
    await assert.rejects(() => instance.systemStats(), { code: 'comfyui/offline' });

    // And back again.
    instance.setBaseUrl(`${baseUrl}/`);
    assert.equal(instance.baseUrl, baseUrl);
    assert.equal((await instance.systemStats()).ok, true);
  });

  it('follows setAuthToken for subsequent requests', async () => {
    const instance = client();
    await instance.systemStats();
    assert.equal(requests[0].headers.authorization, undefined);

    instance.setAuthToken('token-one');
    assert.equal(instance.authTokenConfigured, true);
    await instance.systemStats();
    assert.equal(requests[1].headers.authorization, 'Bearer token-one');

    instance.setAuthToken('');
    assert.equal(instance.authTokenConfigured, false);
    await instance.systemStats();
    assert.equal(requests[2].headers.authorization, undefined);
  });

  it('rejects an invalid base URL passed to setBaseUrl', () => {
    const instance = client();
    assert.throws(() => instance.setBaseUrl('ws://127.0.0.1:8188'), { code: 'comfyui/invalid' });
    assert.equal(instance.baseUrl, baseUrl, 'the old URL survives a rejected change');
  });
});

describe('ComfyClient.systemStats', () => {
  it('parses the real response shape', async () => {
    const stats = await client().systemStats();
    assert.equal(stats.ok, true);
    assert.equal(stats.version, '0.41.1');
    assert.equal(stats.comfyuiVersion, '0.41.1');
    assert.equal(stats.devices.length, 1);
    assert.deepEqual(stats.devices[0], {
      name: 'cuda:0 NVIDIA GeForce RTX 4060 Ti : cudaMallocAsync',
      type: 'cuda',
      vramTotal: VRAM_TOTAL,
      vramFree: VRAM_FREE,
    });
  });

  it('throws a coded error for an unexpected payload', async () => {
    overrides.set('/system_stats', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"nonsense":true}');
      return true;
    });
    await assert.rejects(() => client().systemStats(), { code: 'comfyui/invalid' });
  });
});

describe('ComfyClient.models', () => {
  it('groups by folder and sorts names ascending', async () => {
    const models = await client().models();
    assert.deepEqual(Object.keys(models).sort(), [
      'checkpoints', 'diffusion_models', 'loras', 'text_encoders', 'upscale_models', 'vae',
    ]);
    assert.deepEqual(models.checkpoints, ['ltx-video-2b-v0.9.5.safetensors']);
    assert.deepEqual(models.diffusion_models, [
      'ovis_image_bf16.safetensors', 'z_image_turbo_bf16.safetensors',
    ]);
    assert.deepEqual(models.text_encoders, [
      'ovis_2.5.safetensors', 'qwen_3_4b_fp8_mixed.safetensors', 't5xxl_fp16.safetensors',
    ]);
    assert.deepEqual(models.loras, []);
    assert.deepEqual(models.upscale_models, []);
  });

  it('accepts the documented [{ name }] shape as well as plain strings', async () => {
    overrides.set('/models/checkpoints', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ name: 'b.safetensors' }, { name: 'a.safetensors' }]));
      return true;
    });
    assert.deepEqual((await client().models()).checkpoints, ['a.safetensors', 'b.safetensors']);
  });

  it('returns [] for a folder the server does not have', async () => {
    overrides.set('/models', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(['checkpoints']));
      return true;
    });
    const models = await client().models();
    assert.deepEqual(models.checkpoints, ['ltx-video-2b-v0.9.5.safetensors']);
    assert.deepEqual(models.loras, []);
    assert.deepEqual(models.vae, []);
  });

  it('falls back to per-folder queries when /models fails', async () => {
    overrides.set('/models', (req, body, res) => {
      res.writeHead(500);
      res.end('boom');
      return true;
    });
    const models = await client().models();
    assert.deepEqual(models.vae, ['ae.safetensors']);
  });
});

describe('ComfyClient.queue', () => {
  it('normalizes the array-of-arrays payload', async () => {
    overrides.set('/queue', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        queue_running: [[3, 'run-1', {}, { client_id: 'x' }, ['9']]],
        queue_pending: [[4, 'wait-1', {}, {}, []], [5, 'wait-2', {}, {}, []]],
      }));
      return true;
    });
    const queue = await client().queue();
    assert.deepEqual(queue.running, [{ promptId: 'run-1', number: 3 }]);
    assert.deepEqual(queue.pending, [
      { promptId: 'wait-1', number: 4 },
      { promptId: 'wait-2', number: 5 },
    ]);
  });

  it('returns empty lists for an idle server', async () => {
    assert.deepEqual(await client().queue(), { running: [], pending: [] });
  });
});

describe('ComfyClient.submit', () => {
  const workflow = { 3: { class_type: 'KSampler', inputs: { seed: 1 } } };

  it('posts the workflow and returns the prompt id', async () => {
    const result = await client().submit(workflow, { clientId: 'client-1' });
    assert.deepEqual(result, { promptId: 'prompt-abc', number: 0, nodeErrors: {} });
    const posted = requests.find((entry) => entry.path === '/prompt');
    assert.equal(posted.method, 'POST');
    assert.deepEqual(JSON.parse(posted.body), { prompt: workflow, client_id: 'client-1' });
  });

  it('generates a client id when none is given', async () => {
    await client().submit(workflow);
    const posted = requests.find((entry) => entry.path === '/prompt');
    assert.match(JSON.parse(posted.body).client_id, /^[0-9a-f-]{36}$/);
  });

  it('throws comfyui/invalid when node_errors is non-empty', async () => {
    overrides.set('/prompt', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        prompt_id: 'x',
        number: 0,
        node_errors: {
          9: {
            errors: [{ type: 'required_input_missing', message: 'Required input is missing', details: 'images' }],
            class_type: 'SaveImage',
          },
        },
      }));
      return true;
    });
    await assert.rejects(
      () => client().submit(workflow),
      (error) => {
        assert.ok(error instanceof ComfyError);
        assert.equal(error.code, 'comfyui/invalid');
        assert.match(error.message, /Required input is missing/);
        assert.match(error.message, /SaveImage/);
        return true;
      },
    );
  });

  it('throws comfyui/invalid when the body carries error', async () => {
    overrides.set('/prompt', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'no_prompt', message: 'No prompt provided' }, node_errors: {} }));
      return true;
    });
    await assert.rejects(() => client().submit(workflow), {
      code: 'comfyui/invalid',
    });
  });

  it('surfaces node errors from a 400 as comfyui/invalid', async () => {
    overrides.set('/prompt', (req, body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
        node_errors: { 9: { errors: [{ message: 'Required input is missing', details: 'images' }], class_type: 'SaveImage' } },
      }));
      return true;
    });
    await assert.rejects(() => client().submit(workflow), { code: 'comfyui/invalid' });
  });

  it('rejects a non-object workflow without a request', async () => {
    await assert.rejects(() => client().submit(null), { code: 'comfyui/invalid' });
    await assert.rejects(() => client().submit([]), { code: 'comfyui/invalid' });
    assert.equal(requests.length, 0);
  });

  it('rejects a 200 without prompt_id', async () => {
    overrides.set('/prompt', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return true;
    });
    await assert.rejects(() => client().submit(workflow), { code: 'comfyui/invalid' });
  });
});

describe('ComfyClient error mapping', () => {
  it('maps 401 to comfyui/auth', async () => {
    overrides.set('/system_stats', (req, body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return true;
    });
    await assert.rejects(
      () => client().systemStats(),
      (error) => {
        assert.equal(error.code, 'comfyui/auth');
        assert.equal(error.detail.status, 401);
        assert.match(error.message, /认证失败/);
        return true;
      },
    );
  });

  it('maps 403 to comfyui/auth and 404 to comfyui/not-found', async () => {
    overrides.set('/system_stats', (req, body, res) => {
      res.writeHead(403);
      res.end('forbidden');
      return true;
    });
    await assert.rejects(() => client().systemStats(), { code: 'comfyui/auth' });

    overrides.set('/system_stats', (req, body, res) => {
      res.writeHead(404);
      res.end('nope');
      return true;
    });
    await assert.rejects(() => client().systemStats(), { code: 'comfyui/not-found' });
  });

  it('maps 500 to comfyui/offline', async () => {
    overrides.set('/system_stats', (req, body, res) => {
      res.writeHead(500);
      res.end('Server got itself in trouble');
      return true;
    });
    await assert.rejects(
      () => client().systemStats(),
      (error) => {
        assert.equal(error.code, 'comfyui/offline');
        assert.equal(error.detail.status, 500);
        assert.ok(error.detail.body.includes('trouble'));
        return true;
      },
    );
  });

  it('truncates a long body excerpt to 200 chars', async () => {
    overrides.set('/system_stats', (req, body, res) => {
      res.writeHead(500);
      res.end('x'.repeat(5000));
      return true;
    });
    await assert.rejects(
      () => client().systemStats(),
      (error) => {
        assert.ok(error.detail.body.length <= 200);
        return true;
      },
    );
  });

  it('maps a refused connection to comfyui/offline', async () => {
    // Port 1 on loopback is refused immediately on a normal host.
    const offline = new ComfyClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, logger: () => {} });
    await assert.rejects(
      () => offline.systemStats(),
      (error) => {
        assert.equal(error.code, 'comfyui/offline');
        assert.match(error.message, /无法连接 ComfyUI/);
        return true;
      },
    );
  });

  it('maps a deadline to comfyui/timeout', async () => {
    overrides.set('/system_stats', () => true); // never responds
    const slow = client({ timeoutMs: 60 });
    await assert.rejects(() => slow.systemStats(), { code: 'comfyui/timeout' });
  });

  it('propagates a caller abort as comfyui/canceled', async () => {
    overrides.set('/system_stats', () => true);
    const controller = new AbortController();
    const pending = client({ timeoutMs: 5000 }).systemStats({ signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => pending, { code: 'comfyui/canceled' });
  });
});

describe('ComfyClient.view', () => {
  it('returns bytes and the content type', async () => {
    const result = await client().view({ filename: 'dsh-test_00001_.png', subfolder: '', type: 'output' });
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.deepEqual(result.bytes, PNG_BYTES);
    assert.equal(result.mediaType, 'image/png');
    const seen = requests.find((entry) => entry.path === '/view');
    assert.deepEqual(seen.query, { filename: 'dsh-test_00001_.png', subfolder: '', type: 'output' });
  });

  it('rejects a traversal filename without a request', async () => {
    await assert.rejects(
      () => client().view({ filename: '../../etc/passwd' }),
      { code: 'comfyui/invalid' },
    );
    assert.equal(requests.length, 0);
  });

  it('rejects a missing filename and a bad type', async () => {
    await assert.rejects(() => client().view({}), { code: 'comfyui/invalid' });
    await assert.rejects(
      () => client().view({ filename: 'x.png', type: 'elsewhere' }),
      { code: 'comfyui/invalid' },
    );
  });

  it('maps a 404 to comfyui/not-found', async () => {
    overrides.set('/view', (req, body, res) => {
      res.writeHead(404);
      res.end();
      return true;
    });
    await assert.rejects(() => client().view({ filename: 'missing.png' }), { code: 'comfyui/not-found' });
  });
});

describe('ComfyClient queue mutations', () => {
  it('POSTs /interrupt', async () => {
    await client().interrupt();
    const posted = requests.find((entry) => entry.path === '/interrupt');
    assert.equal(posted.method, 'POST');
  });

  it('POSTs /queue with clear', async () => {
    await client().clearQueue();
    const posted = requests.find((entry) => entry.path === '/queue');
    assert.equal(posted.method, 'POST');
    assert.deepEqual(JSON.parse(posted.body), { clear: true });
  });

  it('POSTs /queue with delete', async () => {
    const result = await client().deleteQueued(['a', 'b']);
    assert.deepEqual(result, { ok: true, deleted: 2 });
    const posted = requests.find((entry) => entry.path === '/queue');
    assert.deepEqual(JSON.parse(posted.body), { delete: ['a', 'b'] });
  });

  it('skips the request for an empty delete list', async () => {
    assert.deepEqual(await client().deleteQueued([]), { ok: true, deleted: 0 });
    assert.equal(requests.length, 0);
    await assert.rejects(() => client().deleteQueued('nope'), { code: 'comfyui/invalid' });
  });
});

describe('ComfyClient history', () => {
  it('returns the entry keyed by prompt id', async () => {
    overrides.set('/history/abc', (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        abc: {
          prompt: [0, 'abc', {}, { client_id: 'x' }, ['9']],
          outputs: { 9: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } },
          status: { status_str: 'success', completed: true, messages: [] },
          meta: { 9: { node_id: '9' } },
        },
      }));
      return true;
    });
    const entry = await client().history('abc');
    assert.equal(entry.status.status_str, 'success');
    assert.equal(entry.outputs['9'].images[0].filename, 'a.png');
  });

  it('returns null for an unknown prompt', async () => {
    assert.equal(await client().history('nope'), null);
  });

  it('rejects an empty prompt id', async () => {
    await assert.rejects(() => client().history(''), { code: 'comfyui/invalid' });
  });
});

describe('ComfyClient auth', () => {
  it('sends the bearer header when a token is configured', async () => {
    await client({ authToken: 'top-secret-token' }).systemStats();
    const seen = requests.find((entry) => entry.path === '/system_stats');
    assert.equal(seen.headers.authorization, 'Bearer top-secret-token');
  });

  it('omits the header when no token is configured', async () => {
    await client().systemStats();
    const seen = requests.find((entry) => entry.path === '/system_stats');
    assert.equal(seen.headers.authorization, undefined);
  });

  it('does not leak the token into error details', async () => {
    overrides.set('/system_stats', (req, body, res) => {
      res.writeHead(500);
      res.end('Authorization: Bearer top-secret-token failed');
      return true;
    });
    await assert.rejects(
      () => client({ authToken: 'top-secret-token' }).systemStats(),
      (error) => {
        assert.equal(JSON.stringify(error.detail).includes('top-secret-token'), false);
        assert.equal(error.message.includes('top-secret-token'), false);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// WebSocket: a hand-written fake, so no real socket is ever opened.
// ---------------------------------------------------------------------------

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(value) {
    this.onmessage?.({ data: value });
  }

  emitBinary(buffer) {
    this.onmessage?.({ data: buffer });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }

  /** Simulate the server dropping the connection. */
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'dropped' });
  }
}
FakeSocket.instances = [];

/** Build a client whose sockets are fakes; returns the client and the sockets. */
function socketClient(options = {}) {
  FakeSocket.instances = [];
  const instance = new ComfyClient({
    baseUrl,
    logger: () => {},
    webSocketFactory: (url) => new FakeSocket(url),
    reconnectDelays: [5, 5, 5],
    ...options,
  });
  return instance;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('ComfyClient.openSocket', () => {
  it('builds the ws URL with the client id and forwards text frames', () => {
    const client = socketClient();
    const events = [];
    const socket = client.openSocket({ clientId: 'client-1', onEvent: (event) => events.push(event) });
    const fake = FakeSocket.instances[0];
    assert.equal(fake.url, 'ws://127.0.0.1:' + new URL(baseUrl).port + '/ws?clientId=client-1');

    fake.open();
    fake.emit(JSON.stringify({
      type: 'status',
      data: { status: { exec_info: { queue_remaining: 0 } }, sid: 'client-1' },
    }));
    assert.deepEqual(events, [{
      type: 'status',
      data: { status: { exec_info: { queue_remaining: 0 } }, sid: 'client-1' },
    }]);
    socket.close();
    client.dispose();
  });

  it('ignores binary preview frames and unparseable text', () => {
    const client = socketClient();
    const events = [];
    const socket = client.openSocket({ onEvent: (event) => events.push(event) });
    const fake = FakeSocket.instances[0];
    fake.open();
    fake.emitBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fake.emit('not json');
    fake.emit(JSON.stringify({ noType: true }));
    fake.emit(JSON.stringify({ type: 'progress', data: { value: 2, max: 8 } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'progress');
    socket.close();
    client.dispose();
  });

  it('never throws from an event handler into the socket', () => {
    const client = socketClient();
    const socket = client.openSocket({
      onEvent: () => { throw new Error('handler boom'); },
      onOpen: () => { throw new Error('open boom'); },
    });
    const fake = FakeSocket.instances[0];
    assert.doesNotThrow(() => fake.open());
    assert.doesNotThrow(() => fake.emit(JSON.stringify({ type: 'status', data: {} })));
    socket.close();
    client.dispose();
  });

  it('reconnects after a drop and re-emits onOpen', async () => {
    const client = socketClient();
    let opens = 0;
    const socket = client.openSocket({ clientId: 'c1', onOpen: () => { opens += 1; } });
    assert.equal(FakeSocket.instances.length, 1);
    FakeSocket.instances[0].open();
    assert.equal(opens, 1);

    FakeSocket.instances[0].drop();
    await wait(40);
    assert.equal(FakeSocket.instances.length, 2);
    FakeSocket.instances[1].open();
    assert.equal(opens, 2, 'onOpen must fire again after a reconnect');

    socket.close();
    client.dispose();
  });

  it('uses the ?token= query param when a token is configured', () => {
    const client = socketClient({ authToken: 'top-secret-token' });
    const socket = client.openSocket({ clientId: 'c1' });
    const url = new URL(FakeSocket.instances[0].url);
    assert.equal(url.searchParams.get('token'), 'top-secret-token');
    assert.equal(url.searchParams.get('clientId'), 'c1');
    socket.close();
    client.dispose();
  });

  it('uses wss:// for an https base URL', () => {
    FakeSocket.instances = [];
    const client = new ComfyClient({
      baseUrl: 'https://gpu.example.com',
      logger: () => {},
      webSocketFactory: (url) => new FakeSocket(url),
    });
    const socket = client.openSocket({ clientId: 'c1' });
    assert.match(FakeSocket.instances[0].url, /^wss:\/\/gpu\.example\.com\/ws\?/);
    socket.close();
    client.dispose();
  });

  it('close() stops reconnecting and is idempotent', async () => {
    const client = socketClient();
    const socket = client.openSocket({ clientId: 'c1' });
    FakeSocket.instances[0].open();
    socket.close();
    assert.equal(FakeSocket.instances[0].closed, true);

    const count = FakeSocket.instances.length;
    await wait(40);
    assert.equal(FakeSocket.instances.length, count, 'no reconnect after close()');
    assert.doesNotThrow(() => socket.close());
    assert.doesNotThrow(() => socket.close());
    client.dispose();
  });

  it('close() while a reconnect is pending clears the timer', async () => {
    const client = socketClient({ reconnectDelays: [30] });
    const socket = client.openSocket({ clientId: 'c1' });
    FakeSocket.instances[0].drop();
    socket.close();
    const count = FakeSocket.instances.length;
    await wait(80);
    assert.equal(FakeSocket.instances.length, count);
    client.dispose();
  });

  it('caps the backoff delay at the last configured step', async () => {
    const client = socketClient({ reconnectDelays: [5, 5] });
    const socket = client.openSocket({ clientId: 'c1' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = FakeSocket.instances[FakeSocket.instances.length - 1];
      current.drop();
      await wait(30);
    }
    assert.ok(FakeSocket.instances.length >= 4);
    socket.close();
    client.dispose();
  });

  it('keeps a single live socket per client id', async () => {
    // service.js drops its handle in onClose but the client keeps reconnecting;
    // a later ensureSocket() must not leave two reconnecting sockets behind.
    const client = socketClient();
    const first = client.openSocket({ clientId: 'shared' });
    FakeSocket.instances[0].open();

    const second = client.openSocket({ clientId: 'shared' });
    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(FakeSocket.instances[0].closed, true, 'the replaced socket must be closed');

    FakeSocket.instances[1].open();
    FakeSocket.instances[1].drop();
    await wait(30);
    const afterDrop = FakeSocket.instances.length;
    assert.equal(afterDrop, 3, 'exactly one reconnect, not two');

    // Distinct ids stay independent.
    const other = client.openSocket({ clientId: 'other' });
    assert.equal(FakeSocket.instances.length, 4);
    other.close();
    second.close();
    client.dispose();
  });

  it('closes live sockets when the base URL or token changes', async () => {
    const client = socketClient();
    const first = client.openSocket({ clientId: 'c1' });
    FakeSocket.instances[0].open();
    client.setBaseUrl('http://127.0.0.1:1');
    assert.equal(FakeSocket.instances[0].closed, true, 'socket must not follow the old URL');

    const second = client.openSocket({ clientId: 'c1' });
    client.setAuthToken('token-two');
    assert.equal(FakeSocket.instances[1].closed, true, 'socket must not keep stale credentials');

    // A no-op change leaves the socket alone.
    const third = client.openSocket({ clientId: 'c1' });
    client.setBaseUrl('http://127.0.0.1:1');
    client.setAuthToken('token-two');
    assert.equal(FakeSocket.instances[2].closed, false);

    third.close();
    second.close();
    first.close();
    client.dispose();
  });

  it('dispose() closes every open socket and is idempotent', () => {
    const client = socketClient();
    const first = client.openSocket({ clientId: 'a' });
    const second = client.openSocket({ clientId: 'b' });
    client.dispose();
    assert.equal(FakeSocket.instances[0].closed, true);
    assert.equal(FakeSocket.instances[1].closed, true);
    assert.doesNotThrow(() => client.dispose());
    assert.equal(first.clientId, 'a');
    assert.equal(second.clientId, 'b');
  });

  it('tolerates a factory that throws, and still retries', async () => {
    let calls = 0;
    const client = new ComfyClient({
      baseUrl,
      logger: () => {},
      reconnectDelays: [5],
      webSocketFactory: (url) => {
        calls += 1;
        if (calls === 1) throw new Error('factory boom');
        return new FakeSocket(url);
      },
    });
    const socket = client.openSocket({ clientId: 'c1' });
    assert.equal(calls, 1);
    await wait(30);
    assert.equal(calls, 2);
    socket.close();
    client.dispose();
  });
});
