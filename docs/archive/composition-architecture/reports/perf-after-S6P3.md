# 性能对表 · 组合层装配成本（S6 P3 后）

> ⚠ **已归档（2026-09-16 · 文档面重构 P3）**：所属线（组合架构 S0-S6）**全段竣工**——本件是历史留存，不作现状口径；组合层现状见 [`docs/composition/README.md`](../../../composition/README.md)，插件契约见 [`docs/plugins/README.md`](../../../plugins/README.md)，在办计划入口见 [`docs/plans/README.md`](../../../plans/README.md)。

> 2026-09-15 实测（P3a `e508f093` + P3b `2259c3c3` 落地后）。对照基准 =
> [`perf-baseline-S6P2.md`](perf-baseline-S6P2.md)（P2 后，P3 未动装配路径）。
> 阈值见设计件 §3.7；**判据一律 min（p75 次之），绝对 ms 不进红绿**；本表只报告。
> 台子 = `src-ui/tests/bench/`（`npm run bench:assembly`）；结构性回归由
> `src-ui/tests/composition-assembly-cost.test.ts`（9 例，与机器负载无关）红绿兜底。

## 1. 对表（min 口径，同机）

| 指标 | P2 基线 | **P3 后** | 阈值 | 判定 |
|---|---|---|---|---|
| 全卷挂载 standard（含 prompt 组装） | 4.29ms | **3.56ms** | < +15% | ✅ 无回归 |
| 全卷挂载 minimal | 3.99ms | **3.22ms** | < +15% | ✅ |
| 全卷挂载 standard（prompt 预置：只量装配面） | 2.47ms | **1.96ms** | — | ✅ |
| 建注册表 冷（新通道 apply：建族 + 全量 schema） | 31.53ms | **22.13ms** | < +20% | ✅ 无回归 |
| 建注册表 热（族实例已缓存） | 6.22ms | **5.12ms** | — | ✅ |
| `resolveRoster`（纯函数，零 patch） | 2.3µs | **2.3µs** | — | ✅ |
| `effectiveComposition`（cache 读） | 1.6µs | **1.5µs** | — | ✅ |
| 调用期 · fs 派发全链（owner 命中） | 11.6µs | **11.3µs** | < +10% | ✅ |
| 调用期 · 裸查表 `seamScopeOf` | 87ns | **~77ns** | < 1µs | ✅ |
| 每卷常驻内存（standard 中位） | 0.79MB | **0.79MB** | < +10%（≤0.88MB） | ✅ |
| 三卷并存合计（standard） | 1.57MB | **1.57MB** | ≤1.75MB | ✅ |
| 逐卷边际 | 0.79 / 0.80 | **0.79 / 0.80** | 次卷 ≤1.5× 首卷 | ✅ |

**结论：P3 的激活账、`requires` 判据、exclusive 持有表没有给装配路径带来可测回归**
（各项 min 与 P2 基线同量级，多数轻微更低 = 机器本轮更静的噪声量级；本机 min 漂移 < 5%，
故 3.56 vs 4.29 不作「变快了」的结论，只作「没变慢」）。

## 2. 为什么零成本是构造性的（不是「恰好没量出来」）

| 面 | 为什么免费 |
|---|---|
| 激活账 | 出厂 43 插件**零 `activation` 声明** ⇒ `activationPlan` 恒空 ⇒ 装配期 retain/release 全程 no-op；账是键控 Map，无声明则一次 `Map.get` 都不做 |
| `requires` 判据 | 出厂两轨 patch **无 `requires` 键** ⇒ `missingRequiredPlugins` 在 `requires.length === 0` 时**直接 return**，连 `factoryComposition()` 快照都不触（那是要遍历全部通道贡献的读） |
| exclusive 持有表 | 同上：无声明 ⇒ 无 claims；查表只在 retain 路径上 |
| 新增 service | 第五个组合层 service 在 boot 期构造一次（与既有四 service 同批），不进每卷装配 |

⇒ convergence 双轨零漂移与「装配成本零回归」是**同一个构造性事实**的两面。

## 3. 结构性事实（计数台，进红绿）

`tests/composition-assembly-cost.test.ts` 现有 9 例：① 行工厂每装配恰一次/行 ·
② 内层族缓存 · ③ 行级 `instanceCache` · ④ `noCache` 每装配重创 · ⑤ 新 apply 必重建 ·
⑥ 组合解析零拷贝 · ⑦ seam 查表零拷贝 + 对称清理 · **⑧（P3 新增）每装配每插件恰一次 retain：
N 次装配 ⇒ 账 holders 恰 N、副作用只 start 一次；组合里无它的行 ⇒ 零记账** ·
**⑨（P3 新增）账条目按插件单份（同 holder 不重复计数）+ 陈旧句柄释放幂等（不重复 stop）**。

profile 断言（§7.8 欠账，本批满偿）= `tests/composition-session-count-profile.test.ts`（2 例）：
同一 preset 在 **1 / 2 / 5** 卷下每卷工具面**逐字节一致**（standard 全量面），且并存卷数
**只进激活账**（4 卷并存 ⇒ `holders = 4`、`start` 恰一次；全关 ⇒ `stop` 恰一次）。
**不新增 baseline 快照**（同测试内对拍 ⇒ 零审批成本）。
