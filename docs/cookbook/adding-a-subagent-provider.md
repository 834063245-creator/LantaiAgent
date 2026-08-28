# Adding a Subagent Provider（添加子代理 provider）

> 平台契约示例（平台化 Phase 6）。真源：`src/composition/subagent-service.ts` + `src/agent/subagent-provider.ts`（in-process 默认）。

## 契约

```ts
interface SubagentProvider {
  id: string;
  spawn(host: SubAgentSpawnHost, args: SubAgentSpawnArgs): Promise<SubAgentSpawnOutcome>;
}
```

- `SubAgentSpawnArgs`：`{ description, prompt, onProgress?, mode?: 'fork'|'fresh', toolAllowlist?, poolSignal?, asyncMode?, agentIdOverride?, outputSchema? }`。
- `SubAgentSpawnOutcome`：`{ text, err? }`。
- 经 `ctx.subagents.register(def)` 注册（挂 `ctx.effect`）；**后注册胜**为默认 provider。
- 消费方：`Agent.spawnSubAgent` 单点（tool-subagent / blueprint spawn 绑定都经它）。
- 未来 ACP / 远程执行后端经此注册表挂接。

## 最小实现（远程后端替身）

```ts
apply(ctx: Context) {
  ctx.effect(() =>
    ctx.subagents.register({
      id: 'my/remote-subagents',
      spawn: async (_host, args) => {
        const res = await fetch('http://agent-farm:9000/spawn', {
          method: 'POST',
          body: JSON.stringify({ prompt: args.prompt, description: args.description }),
        });
        return { text: await res.text() };
      },
    }),
  'my-remote-subagents');
}
```

## 寻址（patch/preset）

```yaml
# 让 my/remote-subagents 成为默认（禁内置 in-process）
seam/subagents:
  - id: builtin/in-process
    disabled: true
```

## 验证

- `Agent.spawnSubAgent(...)` 路由到你的 provider（后注册胜）。
- 无注册 → `SUBAGENT_PROVIDER` 响亮报错。
- 测试先例：`tests/subagent-seam.test.ts` ③（后注册胜 + dispose 回落）、`tests/cross-seam-swap.test.ts`。
