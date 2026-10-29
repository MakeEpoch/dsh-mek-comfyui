# ComfyUI · dsh 插件

把本机（或局域网）的 **ComfyUI** 接进 dsh：设置里配置地址与模型，**对话里直接出图**，右侧栏看**队列进度**和**图片库**。

```
你：帮我画一张赛博朋克风格的猫，横版 16:9
dsh：（调用 comfyui_generate）→ 12 秒后返回图片，右侧栏同步出现缩略图
```

## 0.1.1 兼容修复

修复与 dsh `0.2.2-alpha.2` 的 `read-image-toolview` 同时加载时，重复声明 `tool.call.images` 导致客户端注册失败的问题。生成卡改为复用公开的 `conversation.images.content` Factory，不再占有基座图片槽位；画廊/旧版接口不可用时仍显示普通缩略图。

后续 UI 扩展请遵守 [槽位所有权与局部空间约定](docs/UI-COMPOSITION.md)：全局标识用插件前缀，复用内容用 Factory，Factory 内部可替换组件用局部 `slots`；不要把 `scope: 'session'` 当作命名空间。

## 功能

| 能力 | 说明 |
| --- | --- |
| 设置配置 | `设置 → ComfyUI`：服务地址、token、超时、模型清单、工作流预设、生成默认值、图库与存储 |
| 对话调用 | 四个工具：`comfyui_generate` / `comfyui_status` / `comfyui_cancel` / `comfyui_models` |
| 右侧栏 | `生成` / `队列` / `图库` 三个分段：实时进度条、排队管理、画廊式图片库（瀑布流 + 全屏查看器） |
| 图片回传 | 生成完成后图片作为图片块回到对话，模型能直接「看到」自己生成的图 |
| 多预设 | 内置 Z-Image Turbo（分体模型 / BF16）与通用 Checkpoint 流程，支持粘贴 API 格式自定义工作流 |

## 安装

前提：dsh `>=0.2.1-rc.2 <0.3.0`，Node `>=20`，一个可访问的 ComfyUI（`http://127.0.0.1:8188`）。

```bash
cd .
node scripts/build.mjs                      # 构建浏览器端 bundle
node scripts/install-web.mjs --dry-run      # 先看会做什么
node scripts/install-web.mjs                # 打包 → 备份 profile → 安装 → 回读校验
```

然后**刷新页面**即可，不需要重启 dsh web。

原因：base 系 profile 默认启用 HMR（`dsh-base` 里 `hmr` 条目的 `root: []`，即只监听配置不监听源码），而 `dsh web` 经 `profile-boot` 启动时会提供 `profileContext`，HMR 因此是活的。安装写的是 profile 的 `package.json`（依赖 + `dsh.profile.bundles`），HMR 监听到后自动重组宿主，已打开的页面会跟着宿主模块图把新插件的 client bundle 拉下来。插件管理器的 `installBundle` 也是这样返回 `application: "applied"` 而不是 `restart-required`。

**只有在这些情况下才需要重启**：

| 情况 | 为什么 |
| --- | --- |
| profile 里 HMR 被关掉（patch 写了 `id: hmr, disabled: true`，或用了 `--patch` 覆盖） | 没有 HMR 时运行中的组合不会重组，管理器会返回 `restart-required`（`restartReason: no-hmr`） |
| 换掉的是**已经在跑**的同一个包（版本升级或更换安装包） | 旧版本的插件无法在运行中卸载，管理器返回 `restart-required`（`package-moved`） |

安装脚本会把收据写到 `artifacts/dsh-install.json`，并备份 profile 的 `package.json` / lockfile / patch 到 `.plugin-manager/comfyui-backup-*`。

停用与卸载：

```bash
# 1. 从 profile 的 dsh.profile.bundles 里删掉 @dsh/comfyui（否则它会一直尝试加载）
# 2. 再移除依赖
dsh plugin --profile web remove @dsh/comfyui
# 或直接把备份目录里的 package.json / cordis.patch.yml 复制回去
```

`dsh plugin` 只把参数转发给 pnpm，**不会**维护 `dsh.profile.bundles`；安装脚本会替你补上这一项，卸载时则需要手工处理，顺序不能反（先删 bundle 再删依赖，否则加载会报错）。

## 配置

打开 `设置 → ComfyUI`：

1. **连接** —— 地址默认 `http://127.0.0.1:8188`；ComfyUI 开了 `--enable-api-key` 或前面有反代鉴权时填 token。点「测试连接」确认版本与显卡。
2. **模型** —— 自动读取 ComfyUI 的 `checkpoints / diffusion_models / text_encoders / vae / loras`。预设缺少模型时会直接标红。
3. **预设** —— 选默认预设；也可以粘贴 ComfyUI「Save (API Format)」导出的 JSON 建自定义预设（占位符见下）。
4. **生成默认值** —— 尺寸、步数、CFG、采样器、负面提示词、种子模式、批量、是否把图片回传对话。
5. **图库与存储** —— 图片目录（可指向大盘或 NAS）、按天保留、条数上限。

### 自定义工作流占位符

把 API 格式工作流里的字段写成占位符即可被替换：

`{{prompt}}` `{{negative}}` `{{width}}` `{{height}}` `{{seed}}` `{{steps}}` `{{cfg}}` `{{sampler}}` `{{scheduler}}` `{{batch}}` `{{denoise}}` `{{model}}`

字符串**整体**等于占位符时按数字/字符串类型替换；嵌在长字符串里按文本替换（例如 `"dsh-{{seed}}"`）。

## 用法

### 对话里

直接说「画一张……」。模型会调用 `comfyui_generate`，默认**等待结果**并把图片路径 + 图片本身返回。也可以要求它「先提交，稍后看进度」，这时走 `wait:false` + `comfyui_status`。

### 右侧栏

会话右上角展开右侧栏 → 选 `ComfyUI`（或从引导卡进入）：

- **生成**：写提示词、调参数、直接出图；进行中的任务有进度条与「取消」。
- **队列**：运行中的任务、排队列表、最近 20 条历史；可中断、取消、清空排队。
- **图库**：**画廊模式** + **按对话隔离**。默认只看**当前对话**生成的图片，顶部开关一键切到**全部**（开关状态会记住）。按原始宽高比铺成瀑布流（16:9、9:16、方图各自正确，不裁成方块），点任意一张进入全屏查看器：`←`/`→` 跨任务翻页并首尾环绕、`Esc` 关闭、支持收藏 / 下载 / 删除、显示完整提示词与参数。搜索、仅看收藏、加载更多在两种范围下都可用。

### 图库按对话隔离

图库默认显示**当前对话**的图片：在对话 A 里打开右侧栏，看到的就是 A 里生成的图，不会被 B 的图干扰。想找「上次那张」就切到**全部**。

- 记录归属：对话里生成时用 agent 的会话 id；在右侧栏「生成」里出图，用该侧边栏所在对话的会话 id。
- 顶部开关 `当前对话 | 全部`，右侧显示 `本对话 4 组 · 5.1 MB / 全部 6`，切到全部时显示 `6 组 · 5.1 MB`。
- 选择记在 `localStorage['dsh-comfyui:gallery-scope']`，刷新后保持。
- 没有绑定对话时（例如全局视图）自动退回「全部」，不会显示一个空图库让人误以为图丢了。
- 升级前的历史图片没有归属，只出现在「全部」里，不会被隐藏或删除。

### 图片库位置

默认 `~/.dsh/comfyui/gallery/<任务id>/<文件名>`，索引在 `~/.dsh/comfyui/index.json`。
收藏的图片**永不**被保留策略清理。配置 `saveDir` 可整体换盘。

## 架构

```
浏览器                                   Host (Node)
┌──────────────────────────┐            ┌────────────────────────────┐
│ 设置页 / 右侧栏 / 工具卡   │            │ host/index.js  插件入口      │
│ client/rpc.js            │  POST      │ host/rpc.js    RPC + 图片路由 │
│  → ctx.connection.rpc    │ ─────────► │ host/service.js 任务状态机    │
│                          │  /api/     │ host/comfy-client.js HTTP+WS │
│  <img src=…/image?id=…>  │  dsh-      │ host/gallery.js 图库落盘      │
│                          │  comfyui   │ host/presets.js 工作流构建    │
└──────────────────────────┘            │ host/tools.js   模型工具      │
                                        └───────────┬────────────────┘
                                                    │ HTTP + WebSocket
                                              ┌─────▼─────┐
                                              │  ComfyUI  │
                                              └───────────┘
```

关键设计决定：

- **插件自带一层队列**。单卡只能跑一个图；让 ComfyUI 排一堆没上下文的 prompt 会导致进度无法归属、对话侧无法取消。所以 Host 持有 `jobs`，一次只下发一个。
- **进度走 WebSocket**（`/ws?clientId=` 的 `progress` / `progress_state` / `executing` / `executed` / `execution_*`），WS 断了自动退化为轮询 `/queue` + `/history/<promptId>`。
- **图片不经过 RPC**，走独立的 `GET /api/dsh-comfyui/image`，可被浏览器缓存、可直接 `<img>`。
- **模型工具默认同步等待**，因为「要一张图」应该在同一轮拿到图；`wait:false` 保留异步场景。
- **失败隔离**：ComfyUI 挂了、索引损坏、Settings 服务缺失都只降级并记录，不阻断插件激活——设置页正是修这些问题的地方。

完整接口契约见 [docs/CONTRACT.md](docs/CONTRACT.md)。

## 开发

```bash
node scripts/build.mjs          # 构建 lib/client.js
node --test tests/*.test.mjs    # 单元测试（不需要 ComfyUI）
node --test tests/host-live.test.mjs   # 端到端：真机生成一张图
```

`tests/host-live.test.mjs` 会先探测 `http://127.0.0.1:8188`，探测不到就跳过；可用 `COMFYUI_TEST_URL=http://host:8188` 指向别的实例。

| 测试 | 覆盖 |
| --- | --- |
| `config.test.mjs` | 配置归一化、越界收敛、地址解析、token 不回显 |
| `presets.test.mjs` | 工作流构建、CFG≤1 的零条件分支、LoRA 插入、占位符替换 |
| `comfy-client.test.mjs` | HTTP 契约、鉴权、错误码、WebSocket 重连与二进制帧 |
| `gallery.test.mjs` | 索引原子写、并发保存、路径穿越拒绝、保留策略 |
| `service.test.mjs` | 任务状态机、串行下发、取消、WS 事件映射、超时、外部取消 |
| `rpc.test.mjs` | 信封校验、方法白名单、图片路由的内容类型与 404 |
| `tools.test.mjs` | 工具 schema、附件回传、渲染信封、取消与超时 |
| `client.test.mjs` | 发布 bundle 的客户端注册、与 `read_image` 双向加载/卸载共存、Factory 画廊及缺失回退（轻量 React/registry double，不需要浏览器） |
| `format.test.mjs` | 浏览器端纯函数 |
| `host-live.test.mjs` | **真机端到端**：提交 → 进度 → PNG 落盘 → 图库可寻址 |

## 已知限制

- 单实例：一个插件实例连一个 ComfyUI，一次跑一个图。多卡/多实例不在本期范围。
- 自定义工作流按 API 格式原样提交，不做节点级校验；工作流不合法时 ComfyUI 的错误会原样回显。
- 生成超时只结束**等待**，不会取消 ComfyUI 上的任务（取消请用 `comfyui_cancel` 或右侧栏的「中断」）。
- 图片库索引是单文件 JSON，按任务存；十万级图片会需要换成 SQLite。
- 视频/音频工作流可以跑通（输出节点不限 `SaveImage`），但图库只按图片展示。

## License

MIT
