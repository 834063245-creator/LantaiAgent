# Adding a Session-Persistence Backend（添加会话持久化后端）

> 平台契约示例（平台化 Phase 6）。真源：`src/composition/session-persistence-service.ts` + `src/agent/sessions-provider.ts`（builtin/rust-sessions 默认）。

## 契约

```ts
interface SessionPersistenceProvider {
  id: string;
  execute(action: SessionPersistAction, args: Record<string, unknown>): Promise<string>;
}
```

- `SessionPersistAction`：`read | write | append | appendLog | mkdir | delete`。
- **无腰设计**：本 seam 的调用方是基础设施（agent-store），args 为 snake_case RPC 参数直传，
  不带 `_agent_id` 等 meta——替代后端直接自管存储（SQLite / 远程会话仓）。
- 经 `ctx.sessionPersistence.register(def)` 注册（挂 `ctx.effect`）；**后注册胜**。
- 消费面：`agent-store.ts` 单一权威源（会话状态文件 + NDJSON 增量 + 事件日志 + 索引 + 删档全覆盖）。

## 最小实现（内存会话仓）

```ts
apply(ctx: Context) {
  ctx.effect(() =>
    ctx.sessionPersistence.register({
      id: 'my/memory-sessions',
      execute: async (action, args) => {
        if (action === 'write') { store.set(String(args.path), String(args.content)); return 'ok'; }
        if (action === 'read') return store.get(String(args.path)) ?? '{}';
        return '(memory-sessions) ' + action;
      },
    }),
  'my-memory-sessions');
}
```

## 寻址（patch/preset）

```yaml
seam/sessionPersistence:
  - id: builtin/rust-sessions
    disabled: true
```

## 验证

- AgentStore 全 CRUD 走你的后端（零消费面改动——`sessionExecute` 单点）。
- 全部禁用 → `SESSION_PERSISTENCE_PROVIDER` 响亮报错。
- 测试先例：`tests/sessions-seam.test.ts`。
