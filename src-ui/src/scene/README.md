# src/scene — 星图类型层（渲染面已退役）

> 2026-08-19 ui/ 拆分 P2 迁入（graph.ts 本体 + 21 graph-* + gpu-layout，23 文件）。
> **2026-08-22 C13 休眠层 sweep：22 个 Three.js 渲染文件整体删除**——V5 拆除后
> starGraph 恒 null、bundle 无 three，本目录仅存 `graph-types.ts` 纯类型模块
> （GraphNode/GraphEdge/GraphJSON/GraphDiffJson/CommunityData + StarGraph 兼容形状）。
> `ui/graph.ts` re-export shim 指向本类型模块（冻结文件 chat-stream 的 type import 走此层）。

## 要点

- 数据面照旧服务 Agent 工具：workspace 的 graphData 分页装载 + graph-updated
  + runCheck 简报注入与渲染面无关（见 shell/runtime.ts 注释）。
- `StarGraph` 已降级为兼容形状（getNodeNames/focusNode 签名保留），勿在其上堆方法；
  重建渲染层时另起新模块定义完整类。
- 图谱数据结构变更走引擎侧（engine/）+ workspace 装载链，不经本目录。
