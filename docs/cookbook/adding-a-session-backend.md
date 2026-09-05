# Adding a Session-Persistence Backend（添加会话持久化后端）

> 平台契约示例（平台化 Phase 6；会话持久化 seam 动作面重设计 C 定案 2026-09-05）。
> 真源：`src/composition/session-persistence-service.ts` + `src/plugins/builtin/sessions-builtin/`
> （builtin/rust-sessions 默认，经 kernel* 具名 helper 转发）。

## 契约

```ts
interface SessionPersistenceProvider {
  id: string;
  execute(action: SessionPersistAction, args: Record<string, unknown>): Promise<string>;
}
```

- `SessionPersistAction`：**四动作会话语义**（会话卷——非 fs 语义动作）：
  - `read_volume {root, id}` → 卷 JSON 串或 `'null'`（缺失/坏文件判空）；
  - `list_volumes {root}` → 文件名 JSON 数组（provider 侧滤目录；保留名如
    `_active.json` 不过滤——消费方各自 parse id / 墓碑判别）；
  - `save_volume {root, id, data}`（data = 快照 JSON 串）→ `'null'`；
  - `delete_volume {root, id}` → `'null'`（语义动作：默认 provider 墓碑重写
    `deleted:true`——消费方过滤契约依赖此形态；SQLite provider 可真删）。
- **root = 会话根目录**（`{ws}/.lantai/sessions`——消费方拼接，path 不进接口）。
- **provider 存取不透明 JSON 串**：StoredSession 形状（含 deleted 字段）留在消费方
  `ui/chat-session.ts`，不进 seam 契约。
- **无腰设计**：本 seam 的调用方是基础设施（产品会话持久化），args 为 snake_case
  参数直传，不带 `_agent_id` 等 meta——替代后端直接自管存储（SQLite / 远程会话仓）。
- 经 `ctx.sessionPersistence.register(def)` 注册（挂 `ctx.effect`）；**后注册胜**。
- 消费面：`chat-session.ts` / `chat-core.ts`（会话卷 CRUD 全链——插件注册
  SessionPersistenceProvider 即接管产品会话持久化）。

## 最小实现（内存会话仓）

```ts
apply(ctx: Context) {
  ctx.effect(() =>
    ctx.sessionPersistence.register({
      id: 'my/memory-sessions',
      execute: async (action, args) => {
        if (action === 'save_volume') {
          store.set(`${String(args.root)}/${String(args.id)}.json`, String(args.data));
          return 'null';
        }
        if (action === 'read_volume') {
          return store.get(`${String(args.root)}/${String(args.id)}.json`) ?? 'null';
        }
        if (action === 'list_volumes') {
          return JSON.stringify([...store.keys()].map((k) => k.split('/').pop()));
        }
        if (action === 'delete_volume') {
          store.delete(`${String(args.root)}/${String(args.id)}.json`);
          return 'null';
        }
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

- 产品会话卷持久化全走你的后端（零消费面改动——`sessionExecute` 单点；
  chat-session/chat-core 已全链接线）。
- 全部禁用 → `SESSION_PERSISTENCE_PROVIDER` 响亮报错。
- 测试先例：`tests/sessions-seam.test.ts`（③ fake provider 端到端路由 =
  承诺可执行证明；④ default provider 对 kernel-fs 内存盘 roundtrip）。
