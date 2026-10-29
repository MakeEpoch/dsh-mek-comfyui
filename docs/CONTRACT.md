# ComfyUI 插件内部契约（Host ↔ Client）

本文件是 `@dsh/comfyui` 的**唯一接口契约**。Host 与 Client 两半都按它实现；改协议先改这里。

- 插件名：`@dsh/comfyui`，目录 `.`
- Host 入口：`host/index.js`（ESM，Cordis 插件，`export const name/inject/Config/apply`）
- Client 入口：`client/index.js` → 构建产物 `lib/client.js`（CommonJS + `window.__ModuleLoader__.load({id:'@dsh/comfyui',factory})`）
- dsh 版本：`>=0.2.1-rc.2 <0.3.0`

## 1. 数据模型

### Job（一次生成任务）

```ts
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

interface Job {
  id: string;                 // 插件自己的任务 id（uuid）
  promptId: string | null;    // ComfyUI /prompt 返回的 prompt_id
  number: number | null;      // ComfyUI 队列序号
  status: JobStatus;
  prompt: string;
  negative: string;
  presetId: string;
  presetName: string;
  model: string;              // 展示用：实际使用的 checkpoint / unet
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  batch: number;
  createdAt: number;          // epoch ms
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  sessionId: string | null;   // 由哪个会话发起；图库按此隔离（chat 取 agent 会话，侧边栏取所在 tab 会话）
  source: 'chat' | 'ui' | 'api';
  progress: { value: number; max: number; percent: number; node: string | null; label: string } | null;
  images: ImageFile[];
  error: { code: string; message: string } | null;
  favorite: boolean;
}

interface ImageFile {
  id: string;                 // 图库内唯一
  jobId: string;
  filename: string;           // ComfyUI 输出文件名
  subfolder: string;
  width: number;
  height: number;
  bytes: number;
  mediaType: string;          // image/png | image/jpeg | image/webp
  url: string;                // 同源可 GET：/api/dsh-comfyui/image?id=<imageId>
  thumbUrl: string;           // 目前与 url 相同（浏览器侧缩放）
  createdAt: number;
  favorite: boolean;
}
```

`progress.label` 示例：`排队中`、`生成中 4/8`、`解码中`、`已完成`。

### Preset（工作流预设）

```ts
interface Preset {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  mode: 'unet' | 'checkpoint' | 'custom';
  description: string;
  // 默认参数，用于设置页与工具默认值
  defaults: {
    width: number; height: number; steps: number; cfg: number;
    sampler: string; scheduler: string; negative: string; batch: number;
  };
  // 模型选择（mode=unet: unet/clip/clipType/vae；mode=checkpoint: checkpoint）
  models: {
    checkpoint?: string;
    unet?: string;
    clip?: string;
    clipType?: string;        // CLIPLoader 的 type，如 lumina2
    vae?: string;
    lora?: string;
    loraStrength?: number;
  };
  // mode=custom 时的 API 格式工作流（占位符见 §5）
  workflow?: Record<string, unknown> | null;
  // 由 Host 对照 /models 计算，非持久化
  valid?: boolean | null;
  missing?: string[];         // 缺少的模型文件
}
```

### 设置读模型（settings.get）

```ts
interface SettingsReadModel {
  enabled: boolean;
  baseUrl: string;
  authTokenConfigured: boolean;   // token 永不回传
  requestTimeoutSeconds: number;
  generateTimeoutSeconds: number;
  presetId: string;
  width: number; height: number; steps: number; cfg: number;
  sampler: string; scheduler: string; negativePrompt: string; promptPrefix: string;
  seedMode: 'random' | 'fixed';
  seed: number;
  batch: number;
  autoAttachImages: boolean;      // 生成结果作为图片块回传给模型
  autoOpenSidebar: boolean;       // 对话生成完成后自动展开右侧栏
  saveDir: string;                // 本地图库目录（空 = ~/.dsh/comfyui/gallery）
  retentionDays: number;          // 0 = 不自动清理
  maxGalleryItems: number;        // 上限，收藏不清理
  pollIntervalMs: number;         // UI 轮询间隔，1000..10000
  notifyOnComplete: boolean;      // 长任务完成时标记未读
}
```

## 2. RPC 通道

- 端点：`POST /api/dsh-comfyui`，JSON。
- 请求信封（与 dsh Connection 一致）：
  ```json
  { "type": "client-request", "rpcId": "<string>", "method": "dsh-comfyui",
    "payload": { "method": "<RPC 方法名>", "payload": { } } }
  ```
- 响应信封：
  ```json
  { "type": "server-response", "rpcId": "<same>",
    "result": { "ok": true, "value": <value> } }
  { "type": "server-response", "rpcId": "<same>",
    "result": { "ok": false, "error": { "code": "comfyui/...", "message": "...", "details": {} } } }
  ```
- 浏览器侧统一用 `ctx.connection.rpc.call('/api', 'dsh-comfyui', { method, payload }, signal)`；
  参考 `media-workflow/packages/dsh-media-workflow/src/client.js`。
- 图片二进制：`GET /api/dsh-comfyui/image?id=<imageId>`，返回 `image/png|jpeg|webp`，
  带 `cache-control: private, max-age=31536000, immutable` 与 `x-content-type-options: nosniff`。
  未命中本地库时可带 `&promptId=&filename=&subfolder=&type=output` 回源 ComfyUI `/view`（只允许 output/temp 且校验文件名）。

### 方法清单

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `status.get` | `{}` | `{ connected, baseUrl, version, devices: [{ name, type, vramTotal, vramFree }], queue: { running, pending }, active: Job\|null, jobs: Job[], lastError: {code,message,at}\|null, checkedAt, modelsFetchedAt }` |
| `settings.get` | `{}` | `{ settings: SettingsReadModel, defaults: SettingsReadModel, entryId, revision, readable, reason, presets: Preset[] }` |
| `settings.update` | `{ patch, expectedRevision }` | `{ saved: true, settings }` |
| `settings.reset` | `{ expectedRevision }` | `{ saved: true, settings }` |
| `connection.test` | `{ baseUrl?, authToken? }` | `{ ok, detail, version, devices, error? }` |
| `models.list` | `{ refresh? }` | `{ ok, folders: { checkpoints: string[], diffusion_models: string[], text_encoders: string[], vae: string[], loras: string[], upscale_models: string[] }, fetchedAt, error? }` |
| `presets.list` | `{}` | `{ items: Preset[] }` |
| `presets.get` | `{ id }` | `{ item: Preset }` |
| `presets.save` | `{ id?, name?, mode, workflow?, defaults?, models? }` | `{ item: Preset }` |
| `presets.delete` | `{ id }` | `{ deleted: true }` |
| `queue.get` | `{}` | `{ running: Job[], pending: Job[], active: Job\|null, jobs: Job[], server: { version, devices } }` |
| `queue.cancel` | `{ jobId? }` | `{ canceled: true }`（无 jobId = 取消当前运行） |
| `queue.interrupt` | `{}` | `{ interrupted: true }` |
| `queue.clear` | `{}` | `{ cleared: true }`（清空排队，不动运行中） |
| `jobs.get` | `{ id }` | `{ job: Job }` |
| `jobs.list` | `{ limit?, offset?, status? }` | `{ items: Job[], total }` |
| `generate.start` | `{ prompt, negative?, presetId?, width?, height?, steps?, cfg?, sampler?, scheduler?, seed?, batch?, sessionId? }` | `{ job: Job }`。`sessionId` 记入 `Job.sessionId`，图库按它隔离 |
| `gallery.list` | `{ limit?, offset?, query?, favorite?, status?, sessionId? }` | `{ items: Job[], total }`（仅含 images 的任务）。`sessionId` 省略或空 = 全部；有值 = 只该对话 |
| `gallery.get` | `{ id }` | `{ job: Job }` |
| `gallery.update` | `{ id, favorite }` | `{ job: Job }` |
| `gallery.delete` | `{ ids: string[] }` | `{ deleted: number }` |
| `gallery.stats` | `{ sessionId? }` | `{ count, bytes, favorites, scope: 'session'|'all', all: { count, bytes, favorites } }`。`all` 始终是整库，供「当前对话 N / 全部 M」显示 |
| `gallery.prune` | `{ dryRun? }` | `{ removed, bytes }` |

错误码用 `comfyui/` 前缀：`comfyui/offline`、`comfyui/auth`、`comfyui/not-found`、`comfyui/invalid`、`comfyui/timeout`、`comfyui/canceled`、`comfyui/model-missing`、`comfyui/node-error`、`comfyui/queue-full`、`comfyui/settings-unavailable`、`comfyui/unknown-method`。

## 3. 模型工具（对话里调用）

Host 在 agent 作用域注册（`ctx.tools.register`，普通 JSON Schema 定义，参考 wechatpad `host/vendor/artifact.js` 的注册方式）。

### `comfyui_generate`

参数：
```
prompt        string  必填
negative_prompt string
preset        string  预设 id（默认取设置里的 presetId）
model         string  覆盖模型的 checkpoint / unet 名
width, height integer
steps         integer
cfg           number
sampler       string
scheduler     string
seed          integer  (-1 = 随机)
batch         integer  1..8
wait          boolean  默认 true；false 时立刻返回 jobId
timeout_seconds integer 默认取设置 generateTimeoutSeconds
```

结果值（JSON，`output.schema`）：
```json
{
  "jobId": "...", "promptId": "...", "status": "succeeded",
  "images": [{ "path": "/abs/path.png", "url": "/api/dsh-comfyui/image?id=...", "width": 1024, "height": 1024, "filename": "..." }],
  "seed": 123, "preset": "zimage-turbo", "durationMs": 12980,
  "message": "生成完成，用时 13.0s"
}
```
`output.render` 返回：
1. 一段文本信封（含 `comfyui-job:<jobId>` 标记行、保存路径、参数摘要）；
2. 若 `autoAttachImages` 且 `ctx.get('attachments')` 可用：为每张图追加 `{ type:'image', attachment: ref }` 内容块。
3. 文本必须明确图片已保存到本地与图库位置。

### `comfyui_status`
参数 `{}`；返回 `{ connected, queue: { running, pending }, active: { jobId, prompt, progress }|null, recent: [{ jobId, status, prompt, createdAt, images }] }`，文本渲染为紧凑摘要。

### `comfyui_cancel`
参数 `{ target?: 'current' | 'all' | '<jobId>' }`；返回 `{ canceled, cleared, interrupted }`。

### `comfyui_models`
参数 `{ refresh?: boolean }`；返回 `{ presets: [{ id, name, valid, missing }], folders: { checkpoints, diffusion_models, text_encoders, vae, loras } }`。

系统提示：Host 通过 `systemPrompt.context({ name:'comfyui:guide', order: 120, required: true, text })`
说明“本机已接入 ComfyUI，可用 comfyui_generate 出图，完成后图片会进入图库与右侧栏”，并列出当前可用预设与默认尺寸。
会话里生成时把 `exec.agent.session.header.id` 记到 `job.sessionId`，`cwd` 用作保存目录的备选。

## 4. Client 注册（槽位）

| 槽位 | 用途 |
| --- | --- |
| `settings.section`（`id:'comfyui'`, `order: 34`, `label:()=> 'ComfyUI'`） | 设置页：连接、模型、预设、生成默认值、图库与存储 |
| `sidebarRightTabs.register({ id:'@dsh/comfyui', kind:'comfyui', title, guide:[{ id:'comfyui', order:18, title, description, icon }] })` | 右侧栏页签与引导卡 |
| `sidebar.right.pane.tab`（key `'@dsh/comfyui'`） | 右侧栏主体：`生成 / 队列 / 图库` 三个内部分段 |
| `tool.call.toolview`（key `'comfyui_generate'`，不声明图片 child slot） | 对话里的生成卡：进度、参数、结果图片；通过 `renderFactorySlot('conversation.images.content', { images, loadImage, align:'start' }, { fallback })` 复用官方画廊 |

### 4.1 所有权与命名空间

- `children` 是**全局槽位声明**，不是“引用已有槽位”；同名声明即使挂在不同的 toolview key 下、`kind/scope` 完全相同，也会冲突。`tool.call.images` 由基座 `read-image-toolview` 拥有，本插件不得再次声明或借用其 `renderSlot` 权限。
- 共享 UI 用公开的 **Factory**：renderer 为普通槽位组件提供 `renderFactorySlot`，调用 `conversation.images.content` 不需要声明 `children`，也不需要导入基座私有 React 组件。
- 画廊没有注册时由 Factory outlet 渲染 `fallback`；旧 renderer 未提供 `renderFactorySlot`、没有附件/授权 loader 或同步调用失败时，生成卡退回插件自有缩略图，不影响设置页和侧栏注册。
- 插件确实需要新增全局槽位/Factory 时，用 `@dsh/comfyui.*` 作为命名前缀，并集中声明一次。给现有公共槽位贡献内容只使用 `name` + `key/id`，不要把该槽位再次写进 `children`。
- `scope: 'root' | 'session' | 'session-maybe'` 控制数据绑定与生命周期，**不是槽位名的命名空间**。可复用 Factory 内部的可替换组件应声明在 Factory 的 `slots` 中，通过 `useFactorySlot`/调用者的 `options.slots` 选择；它们属于 Factory 局部空间，不是全局 `children`。

详细示例与边界见 [UI-COMPOSITION.md](UI-COMPOSITION.md)。

- 右侧栏打开方式：`ctx.sidebarRight.openTab('comfyui')`；生成完成且 `autoOpenSidebar` 时可调用。
- 侧边栏数据刷新：可见时按 `pollIntervalMs` 轮询 `status.get` + `queue.get`；页面隐藏或未展开时停止轮询（`document.visibilityState`）。
- 客户端不直连 ComfyUI，所有请求走 RPC；图片全部经 `/api/dsh-comfyui/image`。

## 5. 自定义工作流占位符（presets.save / mode='custom'）

API 格式（ComfyUI「Save (API Format)」）JSON，字符串值可写：

`{{prompt}} {{negative}} {{width}} {{height}} {{seed}} {{steps}} {{cfg}} {{sampler}} {{scheduler}} {{batch}} {{denoise}} {{model}}`

规则：字符串值**完全等于**占位符时按目标类型替换（数字变 number）；占位符出现在更长字符串里则按字符串替换。

## 6. 存储

```
~/.dsh/comfyui/
  config.json       插件自有设置（原子写，损坏回退默认值）
  presets.json      自定义预设
  index.json        图库索引（Job 数组，按 createdAt 倒序，上限 maxGalleryItems，收藏不裁）
  gallery/          <jobId>/<filename> 本地图片副本
  logs/comfyui.log  诊断日志（不记录 token / 完整 prompt）
```

`saveDir` 非空时图库目录改用该目录（`<saveDir>/`），仍写 `config.json` 于 `~/.dsh/comfyui/`。

## 7. 行为约定

- Host 启动失败不得带崩 dsh：设置页与右侧栏仍可用，用 `status.get` 报告错误。
- 所有资源用 `ctx.effect` 登记清理；WebSocket、定时器、轮询都必须在卸载时停止。
- 队列真实进度来自 ComfyUI `/ws?clientId=<id>`（`progress` / `executing` / `executed` / `execution_error` / `execution_start` / `execution_success`），WS 不可用时退化为轮询 `/queue` + `/history/<promptId>`。
- 同一时间只允许一个 ComfyUI 生成在跑（单 GPU）；并发提交进入本地排队，逐条下发。
- 取消当前任务：先 `/interrupt`，再 `/queue` DELETE；清空排队：`/queue` `{ "clear": true }`（不打断运行中）。
- 生成结果：任务成功后把输出图下载到本地图库，再从 `/history` 元数据补 width/height。
- 日志带 `[comfyui]` 前缀，写文件失败不影响功能。
