# 基准台（vitest bench）— 组合层装配成本

> S6 P3 前置性能门（2026-09-15 立账）。设计件阈值见
> `docs/plans/composition-architecture/designs/S6-per-agent-composition.md` §3.7；
> 首版实测报告见 `docs/plans/composition-architecture/reports/perf-baseline-S6P2.md`。

## 跑法

```powershell
cd src-ui
npm run bench:assembly          # 人读表格（NODE_ENV=test + NODE_OPTIONS=--expose-gc 已钉进脚本）
npm run bench:assembly:json     # 同时落 tests/bench/baseline/assembly-baseline.json
# 对拍历史基线（本机）：
npx vitest bench --dir tests/bench --compare tests/bench/baseline/assembly-baseline.json
```

- **不被 `vitest run` 收**：`vitest.config.ts` 的 `test.include` 只认 `tests/**/*.test.ts(x)`，
  基准文件是 `*.bench.ts` —— 基准与门禁分家，时间噪声不进常态套件。
- 内存探针需要 `--expose-gc`（脚本已带）；直接 `npx vitest bench` 会打印「内存探针跳过」。

## 三种成本台的分工（别混）

| 台 | 位置 | 量什么 | 进红绿吗 |
|---|---|---|---|
| 基准台 | `tests/bench/*.bench.ts` | 时间 / 内存 | ❌ 只报告 |
| 计数台 | `tests/composition-assembly-cost.test.ts` | **结构性事实**（谁被调几次、实例是否同一份） | ✅ 常态套件 |
| 收敛门禁 | `npm run verify:convergence` | 装配**产物字节**（双轨快照） | ✅ |

## 两条纪律（照做，否则数字废）

1. **判据用 `min`（`p75` 次之），不用 `mean`。** 本机 DSH 宿主进程（`dsh web`）自身
   常驻一个核（实测 1.5GB / 1700s+ CPU），`mean` 的 rme 实测可到 **67%**；
   而同一台机器两次跑的 `min` 漂移 **< 5%**（见报告的 A/B 对照表）。
2. **基线不跨机对拍。** `baseline/*.json` 是**本机口径**记录（内含绝对路径），
   换机器只作量级参考；跨机比绝对值没有意义（DSH 的 0.17–1.31MB / 38–135ms
   也是它自己机器上的数）。
