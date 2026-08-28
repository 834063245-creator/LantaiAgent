# Adding a Graph Backend（添加图分析后端）

> 平台契约示例（平台化 Phase 6）。真源：`src/composition/graph-service.ts` + `src/agent/graph-provider.ts`（builtin/rust-graph 默认）。

## 契约

```ts
interface GraphProvider {
  id: string;
  invoke(tool: string, args: Record<string, unknown>): Promise<unknown>;
}
```

- `tool` = engine 分析工具名（动态 schema 面：symbols / neighbors / impact / preflight / cycles / …）。
- 经 `ctx.graph.register(def)` 注册（挂 `ctx.effect`）；**后注册胜**。
- 消费面：hologram 域 holoExec（`graphExecute` 单点）。
- 范围注记：`dataflow_save`/`dataflow_query` 为 .lantai/dataflow 落盘 RPC，非分析查询——保持直连。

## 最小实现（远程分析后端）

```ts
apply(ctx: Context) {
  ctx.effect(() =>
    ctx.graph.register({
      id: 'my/remote-graph',
      invoke: async (tool, args) => {
        const res = await fetch('http://graph-svc:9000/' + tool, {
          method: 'POST', body: JSON.stringify(args),
        });
        return res.json();
      },
    }),
  'my-remote-graph');
}
```

## 寻址（patch/preset）

```yaml
seam/graph:
  - id: builtin/rust-graph
    disabled: true
```

## 验证

- hologram 域全部 engine 分析动作走你的后端。
- 全部禁用 → `GRAPH_PROVIDER` 响亮报错。
- 测试先例：`tests/graph-seam.test.ts`。
