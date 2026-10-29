# UI 组合：所有权、命名空间与 Factory 局部空间

适用：`@dsh/comfyui`，按 dsh `0.2.2-alpha.2` 的实际 SlotCore / renderer 接口核对。

## 三种操作不要混用

| 目的 | 正确操作 | 是否创建全局名字 |
| --- | --- | --- |
| 给宿主已有位置贡献 UI | `slots.inject(name, () => slots.register({ name, key/id, ... }, Component))` | 否；在已有槽位内登记一个贡献 |
| 为自己拥有的位置声明扩展点 | 注册条目的 `children: { '@dsh/comfyui.some-position': spec }` | 是；一个名字只能有一个声明所有者 |
| 在多个位置复用同一种 UI | 通过组件 props 的 `renderFactorySlot(factoryName, inputProps, options)` | 否；使用已经注册的 Factory 创建独立 occurrence |

`key` / `id` 区分父槽位中的贡献，不会给其 `children` 自动加前缀。`priority` 决定同一个位置的贡献选择，不能解决子槽位的重复声明。

## 本次修复

旧生成卡与基座 read_image 条目都声明了 `tool.call.images`。SlotCore 的声明表按完整字符串索引；第二个声明失败，不考虑外层 toolview key 是否不同，也不会因为 spec 一致就合并。

现在的生成卡不再声明图片 child slot，而是直接复用公开画廊：

```jsx
renderFactorySlot('conversation.images.content', {
  images: attachments.map((attachment) => ({ attachment })),
  loadImage,                 // 保留宿主提供的授权 loader
  align: 'start',
}, { fallback: thumbnails });
```

这也是官方附件呈现插件使用的共享画廊 Factory。Factory 自己拥有 locale 与展示依赖，调用者提供图片引用、授权 loader、布局参数即可；不需要跨包导入私有组件，也不应该重新注册同名 Factory。

`fallback` 必须传给 Factory outlet。调度函数返回的是 React 元素：Factory 未安装或被卸载的事实在后续渲染时才解析，只在外层 `try/catch` 并不能处理它。旧 renderer 没有该接口时，本插件直接使用缩略图。

## “空间”具体有哪些

### 1. 全局名字：插件前缀约定，不是自动隔离

新建全局 Slot 或 Factory 时使用完整插件前缀，例如：

```text
@dsh/comfyui.generate-card
@dsh/comfyui.generate-card.actions
```

这些仍是全局名字，前缀只是避免包之间意外重名的约定。一个名字集中声明一次。不要声明 `tool.*`、`conversation.*` 等宿主已经拥有的扩展点；给它们贡献内容不等于取得声明权。

对于宿主协议要求的 key（例如 `comfyui_generate` 必须对应工具名），保持协议值，不要机械加前缀。

### 2. `scope`：数据与生命周期，不是名字空间

`root`、`session`、`session-maybe` 决定标准 props、会话绑定与 store/组件生命周期。两个 `session` 声明并不是“每个会话有一张独立声明表”，不能用它允许重复全局名字。

### 3. Factory 的 `slots`：真正的局部组件位置

需要对复用组件开放局部定制时，使用 Factory 的 `slots`，而不是 `children`。示意：

```jsx
// 整个插件生命周期内只注册一次 Factory。
ctx.slots.registerFactory({
  name: '@dsh/comfyui.generate-card',
  scope: 'root',
  slots: { actions: { scope: 'root' } },
}, function Card({ useFactorySlot }) {
  const Actions = useFactorySlot('actions', DefaultActions);
  return <section><Actions /></section>;
});

// 在 renderer 提供的组件 props 中使用：每次调用是独立 occurrence。
renderFactorySlot('@dsh/comfyui.generate-card', {}, {
  slots: { actions: CustomActions },
});
```

`actions` 只在该 Factory 内解析，可以与其他 Factory 的同名局部位置共存，调用者可以针对每个 occurrence 单独选择组件。组件引用由调用者传入，不需要把所有内部按钮都登记为全局扩展点。

注意：Factory 的 **name** 仍然全局唯一；Factory 的 **children** 仍然声明全局槽位。只有 Factory 的 **slots** 是这里说的局部空间。

## 回归检查清单

1. 与基座 `read_image` 两种加载顺序都能注册；各自卸载/重载不删除对方的声明或贡献。
2. 插件全局扩展点全部带自身前缀，且每个名字只有一个声明所有者。
3. 共享画廊只能引用公开 Factory，不重复声明基座 `tool.call.images`。
4. 没有 Factory / 没有授权 loader / 没有附件时仍显示缩略图。
5. 卸载清理设置页、侧栏、工具卡与事件监听，不留下半注册 UI。

自动回归见 [client.test.mjs](../tests/client.test.mjs)，它执行发布 bundle 并用严格声明所有权的 registry double 覆盖上述客户端契约；真实 SlotCore 与浏览器验收需另行执行，不能由 double 测试代替。
