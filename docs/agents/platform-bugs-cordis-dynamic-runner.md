# 平台缺陷登记：cordis 动态插件注册面在运行期 ctx 上全部失效（2026-09-07 发现；2026-09-08 修复，详见文末「修复状态」）

> 来源：会话实测——演示 cordis 动态插件「拉起 → 注册工具 → 调用」全链路时，注册步骤 100% 失败。
> 性质：兰台平台自身缺陷。发现者（编码 Agent）同时跑在兰台内、工作在兰台源码工作区——
> 缺陷既是本会话宿主运行时问题，也是 `src-ui/src` 里可修的平台源码 bug。
> 目标读者：接手修复的 Agent 窗口。含现象、证据、影响、修复方向、复现材料。

---

## 现象

对 cordis 动态插件执行 `define → run`（经模型工具面 `cordis` 域），**run 恒失败**：

```
[dynamic-runner] ctx.tools 服务不可解析（未挂载或被裁剪）: cannot get property "tools" without inject
```

补 `inject: ['tools']` 声明到插件对象上**无效**（错误不变）。用探测插件把守卫 ctx 的 12 个注册面
（tools / panels / commands / llm / fs / shell / sessionPersistence / graph / subagents / prompts /
renderers / capabilities）逐个访问，**全部报同一个错**，无一可达：

```
PROBE_RESULT:{"reachable":[],"blocked":["tools(... cannot get property \"tools\" without inject)",
"panels(...)", "commands(...)", ... 12 个全灭]}
```

试 `ctx.reflect` 旁路 → 被守卫白名单响亮拒绝（设计上不允许插件绕注册面）。

**影响面**：动态插件（运行时定义、沙箱执行、首激活审批的那套，平台化 Phase 4 · D7）在本会话宿主
**完全无法向宿主贡献任何东西**——注册面是它唯一的贡献通道，通道全断 = 插件只能空跑或失败。
工具面本身（define/run/stop/undefine/inspect 的调度）是通的，断的是**贡献落库**这一步。

---

## 根因（读码定位，含证据链）

### 代码位置

- 守卫 ctx 构造：`src-ui/src/agent/dynamic-runner/sandbox.ts` → `makeGuardedCtx(realCtx, resolverCtx, bag, budget)`
- runner 装配：`src-ui/src/agent/dynamic-runner/dynamic-runner-service.ts` → `DynamicRunnerService extends Service`；
  `run()` 里 `const resolverCtx = this.ctx;`（注释：服务解析面——runner 代解析），
  然后 `this.ctx.plugin({ name: 'dynamic/<id>', apply(realCtx) { makeGuardedCtx(realCtx, resolverCtx, ...) } })`
- cordis 服务解析内核：`src-ui/src/cordis/reflect.ts` → Proxy get 拦截

### 机制链

1. 插件沙箱里只能调 `ctx.tools.register(...)` 等 12 个注册面（守卫代理白名单，设计如此）。
2. 守卫 ctx 的 `register` 实际执行 `resolverCtx[prop].register(def)`——即 **runner 的 ctx（`this.ctx`）上取 tools 服务再调 register**。
3. cordis 的 ctx 是 Proxy（`reflect.ts` 的 `static handler`）。get 拦截逻辑（约 153 行）：

   ```js
   if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)   // 无 runtime：免 inject 直读 store
   return ctx.events.waterfall('internal/get', ctx, prop, error, () => {
     // 有 runtime：沿 fiber 链向上找 impl（fiber.store / fiber.inject）
     // 找不到 → throw error = "cannot get property X without inject"
   })
   ```

4. `runner.run()` 是在**运行期**执行的（被 cordis 工具面调用，宿主 ctx 是 active runtime fiber）。
   此时 resolverCtx（= runner 的 `this.ctx`）访问 `ctx.tools` 走**运行期分支**，需要沿 fiber 链找到 tools 的 impl。
5. 但 `DynamicRunnerService` 从未 `inject(['tools', ...])`，其 ctx 链上也没有 tools 服务的 impl 可达
   （compositionServicesPlugin provide 的 tools 在别的 fiber 链/隔离区，或未被本链解析到）→ **抛 "without inject"**。
6. 守卫 ctx 把这个错误包成 `[dynamic-runner] ctx.tools 服务不可解析...` 响亮抛出，apply 失败 → 插件贡献零落库。

### 为什么测试没拦住（关键）

`src-ui/tests/dynamic-runner.test.ts` 的 8 个用例全在 **无 runtime 的 ctx** 上跑：

```ts
async function booted() {
  const root = new Context();                 // ← 全新 ctx，fiber 无 runtime
  await root.plugin(compositionServicesPlugin);
  await root.plugin(dynamicRunnerPlugin);
  ...
}
```

无 runtime 的 ctx 走 reflect.ts 的 `if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)` ——
**免 inject 直读 store**，所以测试里 `ctx.tools.register(...)` 能通。

**但真实宿主（cordis 工具面 → runner.run()）跑在 active runtime fiber 上**，走的是另一条分支——这条
「运行期 ctx 上经 cordis 工具调 runner」的路径 **没有任何测试覆盖**。缺陷漏网。

---

## 复现（交接用）

### 手工复现（应用内，模型工具面）

1. `cordis(define)`：任意插件包，apply 里 `ctx.tools.register({ id: 'demo/x', factory: () => [...] })`。
2. `cordis(run)`：批准后必得上述 "without inject" 错误。

### 测试复现（新测试应钉住此路径）

在 `tests/dynamic-runner.test.ts` 补一个用例：在 **有 runtime 的 ctx** 上 boot dynamicRunnerPlugin，
再走 runner.run() 注册工具，断言贡献可见。期望当前实现红（抛 without inject），修复后绿。
构造有 runtime 的 ctx 需要查 cordis 的 fiber runtime 激活机制（`ctx.plugin` 后 fiber 何时有 runtime、
以及真实宿主怎么把 BUILTIN_PLUGINS 装到 runtime ctx 上——见 `src-ui/src/plugins/loader.ts` `loadBuiltinPlugins`）。

---

## 修复方向（供接手 Agent 验证，非定案）

问题核心一句话：**守卫 ctx 用 `resolverCtx[prop]` 解析服务，在有 runtime 的 ctx 上会被 cordis 的
inject 拦截；而 cordis 提供了免 inject 的服务读取通道没被用上。**

候选修法（按疑似正确度排序）：

1. **改用免 inject 读取通道**（最可能正解）：
   `makeGuardedCtx` 解析服务时不用 `resolverCtx[prop]`，改用
   `resolverCtx.reflect.get(prop)`（reflect.ts:227 注释明写 "Read a service from the store
   without the inject requirement"——正是为框架内部代解析设计的）。需确认 resolverCtx 的
   reflect 能跨 fiber 读到 tools（即 store 在共享的 root reflect 上）。

2. **runner 声明注入**：`DynamicRunnerService` 构造时把 12 个服务名 inject 到自己 ctx 上，
   使 `this.ctx.tools` 可解析。缺点：守卫面是动态的、插件要哪个服务编译期不可知，
   且 runner 未必真依赖这些服务——语义上是在为「代解析」硬编码依赖清单。

3. **守卫 ctx 直接持有服务引用**：runner 在 run 时把 12 个服务的 register 引用（或懒解析 thunk）
   预先绑到守卫 ctx 上，不经 resolverCtx 的 Proxy 解析。

修复后必须补的测试：上述「运行期 ctx」复现用例；并回归现有 8 用例（它们应继续绿，证明无 runtime
路径不回归）。

---

## 附带观察（可一并查证）

- `docs/plugins/README.md` 与 `docs/cookbook/adding-a-dynamic-plugin.md` 里 `ctx.tools.register`
  的用法示例，在**测试环境（无 runtime）**是通的、在**真实宿主（运行期）**走不通——文档没区分
  这两种 ctx，建议修复后补一句运行期说明。
- cookbook 引用的最小插件样例**没包 `ctx.effect`**，直接 `ctx.tools.register(...)`；测试里也是直调。
  守卫 ctx 的 `register` 会把 disposer 收进 runner 的 bag（stop/失败时逆序回收），所以**直调注册**
  是合法姿势（不是缺 effect 的问题）——这条已排除，勿再往这个方向查。
- dynamic-runner 工具族（`src/agent/tools/cordis.ts` 的 `createCordisTools`）全仓库**无调用点**、
  dynamic-runner 目录下**无测试**（测试在 `src-ui/tests/dynamic-runner.test.ts`）——装配路径
  与测试路径分离，是本次漏网的结构性原因。

## 修复状态

**✅ 已修复（2026-09-08 修复窗口，同日修复）。**

### 根因核实（比上文「机制链」更精确一层的分岔点）

测试为什么绿、生产为什么红——分岔点不在「测试 ctx 无 runtime」，而在**消费单点的形态**：

- **生产消费单点** = `activeDynamicRunner()`（cordis 工具面 `requireRunner()` 同源，`dynamic-runner-service.ts` 模块级 `_activeRunner`）——**裸服务实例**。方法内 `this.ctx` = runner 自身 fiber 的 ctx（`fiber.runtime` 非空）→ `resolverCtx[prop]` 走内核运行期分支（沿 fiber 链找 impl）→ runner 无 inject 声明、组合层服务的 impl 又在**兄弟 fiber** 的 store 上（链式上溯只经父链，永不到兄弟）→ 恒抛 "without inject"。
- **测试消费点** = `root.dynamicRunner` —— cordis **traceable 绑定**（`getTraceable`/`createTraceable`，utils.ts）把方法内 `this.ctx` 重绑到「取用方 ctx」（root，root fiber 无 runtime）→ 走内核免 inject 分支（`ctx.reflect.get(prop, false)` 直读 store）→ **恰好绕开缺陷**。8 用例全绿是绑定形态的红利，不是覆盖了生产路径——「为什么测试没拦住」一节的直接答案。

### 修复（候选 1 落地）

`makeGuardedCtx`（sandbox.ts）服务解析由 `resolverCtx[prop]` 改为 **`resolverCtx.reflect.get(prop)`**——内核免 inject 读取通道（reflect.ts `ReflectService.get`，文档注释明写 "Read a service from the store without the inject requirement"，正是为框架内部代解析设计的面）。直读根 store，无 runtime 的 root / 有 runtime 的 runner fiber 两种宿主形态恒同路解析；`strict` 默认语义（提供方 fiber 非 ACTIVE 不解析）正确拒递半拆服务。`run()` 与 `mount()`（回滚重挂）两条路径同源修复。守卫面其余语义（白名单 / 形状校验 / 预算 / 取消拒绝 / 响亮报错）零改动。

### 回归钉死

`tests/dynamic-runner.test.ts` 用例 **⑨**：经 `activeDynamicRunner()`（生产真路径——裸实例，`this.ctx` 为有 runtime 的 fiber ctx）`run` 注册工具贡献，断言贡献可见。修复前实测红（完整复现 `[dynamic-runner] ctx.tools 服务不可解析…: cannot get property "tools" without inject`），修复后绿；①-⑧ 继续全绿（traceable 绑定路径不回归）。

### 同族排查

全仓扫「Service 内 `this.ctx.<service>` / `ctx['<service>']` 属性解析兄弟服务」：**零命中**——动态 runner 是唯一例（依赖集编译期不可知才需要代解析；常规插件/产物一律 `inject` 声明由内核从 fiber store 解析，不走此形）。

### 附带观察处置

- 「工具族全仓库无调用点」**已过期**：S5 产物通道后 cordis 域工具经第一方产物插件 `src-ui/src/plugins/builtin/cordis-domain` 装配（`inject: ['tools']` + noCache 每装配重收 `rowCtx.ui` 审批通道），并经 `builtin/host-modules.ts` 进插件宿主桥 mods 面。
- 文档运行期说明已补：`docs/plugins/README.md` §6 与 `docs/cookbook/adding-a-dynamic-plugin.md` 各补一段——守卫 ctx ≠ 真实 cordis ctx，服务解析经 runner 免 inject 代解析（两种宿主形态恒通），动态插件不需要也不存在 inject 声明面。
- 最小插件样例不包 `ctx.effect` 直调 `register`：维持原判——合法姿势（守卫把 disposer 收进 runner 的 bag，stop/失败/undefine 逆序回收），非缺陷。
