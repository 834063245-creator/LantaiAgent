# Adding a File-System Backend（添加 fs 后端）

> 平台契约示例（平台化 Phase 6）。真源：`src/composition/fs-service.ts` + `src/agent/fs-provider.ts`（builtin/rust-fs 默认）。

## 契约

```ts
interface FsProvider {
  id: string;
  execute(action: FsAction, args: Record<string, unknown>, opts: FsCallOptions): Promise<string>;
}
```

- `FsAction`：`read | write | edit | list | glob | mkdir | move | rename | delete | constraints | write_constraints`。
- `FsCallOptions`：`{ dispatch, onProgress?, signal? }`——**dispatch = 强制层派发腰**（命令名→后端 +
  worktree 路由 + meta 透传）；默认 provider 借腰转发 Rust 命令，**替代 provider 可完全忽略它**（自管后端）。
- 经 `ctx.fs.register(def)` 注册（挂 `ctx.effect`）；**后注册胜**。
- 强制层不旁路：权限咽喉 / plan gate / 审计在 executor 管道层，**换 provider 不豁免**（P2-C3 守卫钉死）。

## 最小实现（内存 fs）

```ts
apply(ctx: Context) {
  ctx.effect(() =>
    ctx.fs.register({
      id: 'my/memory-fs',
      execute: async (action, args) => {
        if (action === 'read') return files.get(String(args.filePath)) ?? '(ENOENT)';
        if (action === 'write') { files.set(String(args.filePath), String(args.content)); return '(written)'; }
        return `(memory-fs) ${action}`;
      },
    }),
  'my-memory-fs');
}
```

## 寻址（patch/preset）

```yaml
seam/fs:
  - id: builtin/rust-fs
    disabled: true
```

## 验证

- fs 域 11 个动作全走你的后端（消费面零改动——`fsExecute` 单点）。
- 全部禁用 → `FS_PROVIDER` 响亮报错。
- 测试先例：`tests/fs-seam.test.ts` ④（fake 内存 fs 替换）、`tests/cross-seam-swap.test.ts`。
