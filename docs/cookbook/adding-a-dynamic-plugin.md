# Adding a Dynamic Plugin（运行时定义动态插件）

> 平台契约示例（平台化 Phase 6）。真源：`src/agent/dynamic-runner/`（sandbox.ts 三层防线 + service）+ `src/agent/tools/cordis.ts`（cordis 域工具）。

## 模型工具面（cordis 域）

| 动作 | 语义 |
|---|---|
| `cordis(define)` | 定义不可变包（kind=new/existing、idPrefix、name、purpose、code=纯 JS 工厂体 `return { name?, apply(ctx) }`）——只校验不执行 |
| `cordis(run)` | 激活一个精确包（首激活经用户审批；mode=run/update；失败回滚重挂旧包） |
| `cordis(stop)` | 停用：贡献链式回收 |
| `cordis(undefine)` | 删除插件全部包与审批记录 |
| `cordis(inspect_list)` / `cordis(inspect_self)` | 只读巡检（源码 + 诊断——可重建面） |

## 沙箱三层防线（宿主半）

1. **求值面阴影**：`window`/`fetch`/`document`/`eval`/`Function`/`localStorage`/`Worker`/`require`/`process` 等 23 个危险全局在插件源码内为 undefined；
2. **守卫注册面**：apply 收守卫代理——只暴露 `ctx.effect` 与 12 个可注册 seam 的 `register`（def 形状校验 + 贡献预算 64 条 + 取消后拒绝）；
3. **预算**：源码 ≤256KB / apply ≤10s / 贡献 ≤64 条。

> ⚠️ 边界（R4 如实声明）：浏览器主文档无进程级硬隔离——动态插件沙箱是「协议纪律沙箱」（与 code_execution worker 同定位），安全面 = 实现质量；进程外硬隔离是后续硬化项。

## 最小动态插件源码

```js
return {
  name: 'my-dynamic',
  apply(ctx) {
    ctx.tools.register({ id: 'my/dynamic-tool', factory: () => ({
      name: () => 'my_dynamic_tool',
      description: () => 'dynamic probe',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: () => 'hello from dynamic plugin',
    }) });
  },
};
```

## 验证

- `tests/dynamic-runner.test.ts` 8 用例（求值面阴影 / define 校验 / 主链 / 审批门 / 守卫零残留 / 超时 / 会话隔离 / 回滚）。
- 审批：未授权 + 无 UI 通道 → `APPROVAL_REQUIRED`；拒绝 → `APPROVAL_DENIED`（不得重复请求）。
