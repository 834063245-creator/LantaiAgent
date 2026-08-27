# src/state — zustand 状态层

> 2026-08-19 总线归零（P1 创建本目录）+ ui/ 拆分（P2 迁入 11 领域 store）后的状态层新家，17 文件。

## 分簇

| 簇 | 文件 |
|---|---|
| 注册表原语 | `scoped-store.ts`（`createScopedStore`——面板级 store 都经它建注册表） |
| 领域 store（面板级，scoped） | `messages-store.ts` `session-store.ts` `panel-store.ts` `input-store.ts`（聚合入口 `ui/chat-store.ts`） |
| app 级单例 | `dock-store.ts`（面板开合/简报）`timeline-store.ts` `agent-config-store.ts` `update-store.ts`（应用更新检测/角标） |
| 信号 store（总线退役产物，P1） | `turn-done-store.ts` `goal-store.ts` `ask-store.ts` `workspace-switch-store.ts` |

> 2026-08-27 死码清扫：`overlay-store.ts`（portal 宿主随 UI 大清扫失消费者）、
> `dock-config.ts`（main.ts 薄引导化后注入槽无人写读）删除——可达性闭包零引用。

## 契约

- 新 zustand store（含信号 store）**一律落本目录**，不要落 `ui/`。
- 面板级走 `createScopedStore` 注册表；app 级单例直接 `create`。
- 信号 store 消费端若跨工作区 fire-and-forget，照 INVARIANTS #12 epoch 守卫。
- 跨组件通信规则见 CONVENTIONS §1.3（总线已退役，禁自建事件机制）。
