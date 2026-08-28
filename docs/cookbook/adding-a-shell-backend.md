# Adding a Shell Backend（添加 shell 后端）

> 平台契约示例（平台化 Phase 6）。真源：`src/composition/shell-service.ts` + `src/agent/shell-provider.ts`（builtin/rust-shell 默认；subprocess 已并入本 seam）。

## 契约

```ts
interface ShellProvider {
  id: string;
  execute(action: ShellAction, args: Record<string, unknown>, opts: ShellCallOptions): Promise<string>;
}
```

- `ShellAction`：`run | output | kill | wait`（执行 + 后台任务族三动词——subprocess 语义并入）。
- `ShellCallOptions`：`{ dispatch, onProgress?, signal? }`（dispatch 腰同 fs——替代 provider 可忽略）。
- 经 `ctx.shell.register(def)` 注册（挂 `ctx.effect`）；**后注册胜**。

## 最小实现（纯记录后端）

```ts
apply(ctx: Context) {
  ctx.effect(() =>
    ctx.shell.register({
      id: 'my/record-shell',
      execute: async (action, args) => {
        if (action === 'run') { log.push(args); return '(queued)'; }
        return `(record-shell) ${action}`;
      },
    }),
  'my-record-shell');
}
```

## 寻址（patch/preset）

```yaml
seam/shell:
  - id: builtin/rust-shell
    disabled: true
```

## 验证

- shell 域四工具（run/output/kill/wait）全走你的后端。
- 全部禁用 → `SHELL_PROVIDER` 响亮报错。
- 测试先例：`tests/shell-seam.test.ts` ④。
