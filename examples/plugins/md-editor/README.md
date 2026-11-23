# md-editor — 软件级插件（第 1 步回归基线）

对位范本：[`../notes-app/`](../notes-app/)（四件套闭环全量）。本插件**只取其中一件**——
窗（件 A）+ 数据地盘（件 B），其余刻意不做，用来当第 1 步实验的**干净载荷**：

> 第 1 步要证的是「一个编辑器形态的软件，能不能以窗的形态住进架阁、开得起来、关得干净」。
> 证的不是编辑器好不好用——所以这里零依赖、无打包、无后端进程、不碰宿主文档。

## 装上看一眼

```
cp -r examples/plugins/md-editor ~/.lantai/plugins/md-editor
```

然后重启兰台 → 顶部「架阁」→ **软件型**页 → 「文卷」。
（装载面 = `~/.lantai/plugins/<name>/`；数据地盘 = `~/.lantai/plugins-data/md-editor/`。）

## 入口形状（硬契约，踩过一次）

`entry.js` 必须 `export default { name, apply }`，且 `name` 与 `manifest.name` 逐字一致。
装载器 `pickPluginObject` 优先取 `default` 导出，`isPluginShape` 只认 `{ name: string, apply: function }`；
只裸导一个 `apply` 会报「插件对象 name (undefined) 与 manifest.name 不一致」——装载失败。
（对位 `notes-app/entry.js` 同款。）

## 0.2.0（批 3）：接上宿主文档

- `md_open(path)` 工具：Agent（或你在对话里）让它**在窗里打开一份宿主文档**——宿主开窗、签发令牌、帧把令牌推进窗；
- 窗凭令牌 `doc.read`，**拿不到路径以外的任何文件系统能力**；
- 保存走 `doc.save` 交单 → 宿主算差分 → **改稿单确认后**才写回磁盘；退回则一个字不写；
- 窗已开着时再 `md_open` 另一份：令牌重签并直接推到同一窗（不重载 iframe）。

## 这一版能做什么

- 在**插件自己的数据地盘**里新建 / 编辑 / 保存 / 删除 `.md`；
- 极简预览（标题 / 粗斜 / 行内码 / 围栏 / 引用 / 链接）；
- `Ctrl/Cmd+S` 保存，脏标记在标题栏左侧；
- 关窗时若有未保存改动，会在页脚提示（不拦截——宿主只广播 `window-closing`）。

## 这一版刻意不做

| 不做 | 为什么 | 留给哪一步 |
|---|---|---|
| ~~打开卷里 / 工作区里的文档~~ | **0.2.0 已接上**：manifest 声明 `app.documents`，Agent 经 `md_open(path)` 让宿主开窗并签发令牌；保存走改稿单（宿主算差分、用户点头才写） | 已交付（批 3） |
| 工具口 / 受治进程 | 与「窗 + 桥 + 生命周期」这条缝无关，只会加噪音 | 需要时（Agent 驱动） |
| Monaco / CodeMirror | 窗内是自包含 HTML、无打包器；引重依赖要先给插件加构建链——那是「重依赖」那条缝 | 第 3 步 |

## 编辑器内核是适配点

`app/index.html` 里的 `mountEditor(el, { onChange, onSave })` 是唯一的内核接口
（`getText` / `setText` / `setReadOnly` / `destroy`）。今天用原生 `textarea`——
中文输入法天然稳、零依赖；将来换 CodeMirror 6 / Monaco **只改这一个函数**，
桥协议、文档逻辑、生命周期一字不动。

## 验收口径（五条，全绿才算这条路走得通）

1. 装：目录出现在 `~/.lantai/plugins/`，架阁「软件型」页能看到「文卷」；
2. 开：点开是一扇窗；关掉进程与内存回收（再开无残留状态）；
3. 取：能在窗内新建并读到自己的文档（数据地盘生效）；
4. 存：改完保存后重开仍在（写到 `~/.lantai/plugins-data/md-editor/`）；
5. 拆：删掉插件目录 / 卸载后，窗、进程、数据目录都不留残渣。

第 3、4 条只覆盖「插件自己的地盘」——**覆盖不到宿主文档**，这是第 2 步的活。
