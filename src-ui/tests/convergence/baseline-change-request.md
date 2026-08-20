# baseline change request — S4-1b：session `preset/selected` 首事件 + minimal preset baseline freeze

- **日期**: 2026-08-20
- **请求 Agent**: S4 执行 Agent（设计件 `docs/plans/composition-architecture/designs/S4-preset-realm-distribution.md` §2.4/§3 批间审批门）
- **涉及快照**: 两项——(a) `session-log` 冻结面扩展（事件 kind 新增）；(b) 新增 `baseline/preset-minimal/`（per-preset 收敛协议首次 freeze）
- **状态**: **已批准（2026-08-20 用户拍板「批准全项」——(a) + (b) 全部实施）**

## 变更内容（两项合一份 CR，按设计件 §3 批表）

### (a) 新事件 kind：`preset/selected`

会话构造（`session/reset` init）时**必发首条** `preset/selected` 事件——首条即
创建时点事实（设计件 §2.4 首事件方案；DSH header 深冻的同构语义位，HoloGram
无 header 概念——SessionLog 仅 events 流）。空白会话期改选 preset → 追加
同名事件；重建时 newest-wins（倒序扫描，照抄 `resolveSessionPreset` 模式，
无 header 兜底——首事件承担该位）。

**reset 语义（设计件三轮复审 §7.1-8）**：被 reset 的会话若中途改选过
preset，reset 重开发出的是**当前生效选择**（重读默认值），不继承被清掉
那个会话的改选。倒序扫描天然安全：`session/reset` 事件本身是段分界，
旧段事件不可能跨边界泄漏。

五项同步（Phase 5 立规的完整清单）：

1. `SESSION_EVENT_KINDS`：加 `'preset/selected'`（封闭枚举扩展）；
2. `SessionEventDataMap`：`'preset/selected': { presetId: string }`（无裸
   对象嵌套——投影面最小化，`deriveMessages` 不消费此 kind）；
3. spec AST 白名单：`specs/phase-5` 的变异入口断言（若首事件经
   `_replaceSession` 后单独 append 则需新入口登记；若并入 init 的
   `_replaceSession` 载荷则白名单不动——实现时按实际路径定，两者都在
   立规框架内）；
4. gate 计数：`gate.mjs` phase-5 T0 的 `this.session.push` 计数（当前恰
   1 次）不因新事件变化（事件走 `_sessionLog.append` 不走 session 数组
   直改）；
5. 差分矩阵：phase-5 spec 补「改选 → reset → 重建用默认」场景（设计件
   §2.4 明示的单测义务）。

### (b) minimal preset 的 convergence baseline freeze

S2 §6 遗留兑现：`tests/convergence/helpers/presets.ts` 登记从**运行时
preset 表**（`src/composition/presets.ts` 的 minimal——禁 browser-desktop/
web 工具行 + graph-hooks capability）派生的 minimal 定义 →

```bash
CONVERGENCE_PRESET=minimal npm run record:convergence   # 生成 baseline/preset-minimal/
```

→ 独立 freeze commit（per-preset 收敛协议的首次全流程实测——standard
快照零漂移全程不受影响，minimal 是新增目录不是改 standard）。

## 为什么变（动机）

「模型可见 ⟺ 已记录」是 DSH 那条纪律的原样移植（设计件 §2.1 表）：
**preset 决定模型看到的 schema/段，必须可重建**。S4-1a 已交付装配机制
（preset → 工具面/prompt/capabilities），但选择事实不进会话日志——
会话恢复后无法对拍「这个会话当时用的什么组合」。minimal freeze 则是
per-preset 前缀缓存语义（S1 §2.2 铺的地基）的首次实数收口。

## 影响面

- **模型可见表面**：零变化（`preset/selected` 不进 deriveMessages 投影，
  不进 system prompt，不进工具 schema——8 个既有 baseline 快照零漂移，
  本 CR 只**新增** `baseline/preset-minimal/` 目录）。
- **session-log 持久化**：每会话多 1..n 条事件（构造 1 条 + 改选追加），
  ndjson 体积影响可忽略；旧会话文件无此 kind——回放器按封闭枚举校验，
  **旧日志回放兼容**（无该事件 = 视为 standard——缺省即当前行为）。
- **不可静默回滚**（设计件 §4）：事件写入真实会话后，回滚需先确认无
  在途会话依赖。

## 前缀缓存影响

无（事件不触模型可见面）。minimal freeze 本身就是前缀缓存 per-preset
语义的守护基建。

## 待人类决定

1. **批准** → S4-1b 开工：实施五项同步 + 差分矩阵场景 + minimal
   record/freeze（独立 commit）；`CONVERGENCE_PRESET=minimal` 的 verify
   进批内门禁。
2. **拒绝事件项、保留 freeze 项** → 只做 (b)（minimal baseline 照 freeze，
   会话记录留未决项——「模型可见 ⟺ 已记录」纪律缺口如实登记）。
3. **整体延期** → S4 以主体六批收口（现状），S4-1b 并入 S5+/V5 前置。
4. **改设计** → 反馈方向（如 data 形状、reset 语义、泛化为 `session/init`
   的触发时机提前）。

---

> **执行注**：S4 主体（S4-0/1a/1.5/2/3/5）已全部落地并每批独立全绿
> （6 commits：`c7e089ff`…`50a1f532`）——本 CR 不阻塞任何已交付能力；
> hello 三通道、热重载、安装通道、preset 装配机制均已在 main。本 CR
> 批准后的 S4-1b 是「会话可重建性 + minimal 收敛实数」的补全批。
