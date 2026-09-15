# 白纸壳（paper-shell）——纸壳前端工程

> **本目录阅读顺序**：① 本 README（现状与规则）→ ② [`r5-polish-backlog.md`](r5-polish-backlog.md)（剩余工作逐项清单——**最常看**）→ ③ [`taste-ledger.md`](taste-ledger.md)（视觉决定账本——新会话开工前必读，翻案需显式理由）→ ④ [`walkthrough.md`](walkthrough.md)/[`interviews/`](interviews/)（历史访谈，按需）→ ⑤ [`HISTORY.md`](HISTORY.md)（V0-V5 施工史档案）。
> **代码入口**：`src-ui/src/paper/README.md`（块模型/转译/画布数学分层说明 + 拍板决定映射）。

> 立项：2026-08-20 · 状态：**V5 竣工（2026-08-22 深夜）——纸壳（注疏案卷工作台）是唯一主界面；当前段 = R5 打磨环**
> 设计契约：`docs/design/lantai-design-spec.md` + 黄金样本 `prototype/lantai.html`（视觉真相的唯一准绳）
> 结构工程：[`paper-panel-split-plan.md`](../../archive/paper-shell/paper-panel-split-plan.md)（2026-09-06 立项当日竣工——PaperPanel 3253 行巨型组件按域拆 16 个 hook 文件，纯行为保持机械批，JSX 尾逐字节对拍 430/431 行一致）

## 现状一句话

旧观测台前端已整体拆除（详见总控 [`../README.md`](../README.md) 与 [`HISTORY.md`](HISTORY.md) V5 节）。纸壳是产品的全部用户面；剩余工作全部在 [`r5-polish-backlog.md`](r5-polish-backlog.md) 的 B 段（审美循环）与 C 段（产品化/拆除欠账）。

## 本工程的性质（写给所有 agent——先校准预期）

前端不是「定稿后照抄」的流水线，本体是**高频沟通-修改-测试循环**（用户模糊反馈 → agent 出候选 → 用户再判）。规则：给循环上纪律而不是消灭它——一环一维、对照反馈（并排 A|B，禁「更好一点」）、决定记账本、止损（每维 ≤3 环）。**推进节奏由用户对话带宽决定，agent 不催促、不跳过人判环节。**完整防发散协议见 [`HISTORY.md`](HISTORY.md) V4 节。

方法论分工：发明视觉=人（agent 只在原型里一次性做）；转录视觉=agent 强项（只许转录契约，不许现场发明）；骨架工程=agent；共同创作循环=人机各半（工程本体）。

## R5 打磨环（当前段）

- **对照物**：黄金样本 `prototype/lantai.html`（vision 会话用 `D:\tmp\r5-vision\` 管线截图对照；非 vision 会话以 DOM 计算样式对拍代偿——2026-08-22 首轮已过，渲染面无回归）。
- **A 段（转录缺口）**：✅ 已清账。
- **B 段（审美开放项）**：5 维单维循环，待 vision 模型会话（见 backlog）。
- **C 段（产品化涌出 + V5 拆除欠账 C8-C14）**：见 backlog——按「谁判断」分了层（纯转录 agent 自主 / 交互形态用户拍板）。

## 铁律（活规则，历史细节见 HISTORY）

- 原型代码不进生产；视觉只从设计契约转录。
- 测量镜像纪律：`paper/measure.ts` + `ui/pretext-cache.ts` 的字体/行高/内边距常数必须随渲染 CSS 同步改（两处一起动，否则布局漂移）。
- 纸壳的面板/命令贡献走组合层通道（paper-plugin / renderer-service），不自建旁路。
- 纸面板贡献形状：`paper/paper-plugin.ts`（id `paper`，side:null 全屏，unmountOnClose——「关卷」回案卷首页）。
- 已判死的视觉决定不复活；翻案在 taste-ledger 显式立账。
