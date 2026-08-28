# Adding an LLM Adapter（添加 LLM adapter）

> 平台契约示例（平台化 Phase 6）——对齐 DSH `docs/cookbook/adding-an-llm-adapter.md` 的样式。
> 真源：`src/composition/services.ts` 的 `LlmAdapterContribution` + `src/plugins/llm-adapters-plugin.ts`（第一方先例）。

## 契约

```ts
interface LlmAdapterContribution {
  id: string;              // 注册表寻址 id（稳定行标识；建议 '<插件名>/<adapter名>'）
  kind: string;            // 适配的 settings.kind（'anthropic' | 'openai' 或自定义方言）
  create: (rt: ProviderRuntimeArgs) => Provider;
}
```

- 经 `ctx.llm.register(def)` 注册 → disposer（建议挂 `ctx.effect`）；**同 kind 后注册胜**。
- 消费方 `createProvider(settings)` 是单一入口：内部查 `ctx.llm` 注册表、同 kind 后注册胜；
  未命中任何 adapter → `PROVIDER_DIALECT` 响亮报错（不静默跌回旧分支）。
- `Provider` 形状：`name()` + `stream()`（async generator 产 `Chunk`）；形状真源 `src/provider/types.ts`。
- 覆盖内核方言（`builtin/anthropic` / `builtin/openai`）：注册同 kind 即可覆盖（后注册胜）。

## 最小实现

```ts
import { type Context } from '../src/cordis';

export const myAdapterPlugin = {
  name: 'my/adapter',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.llm.register({
          id: 'my/adapter',
          kind: 'openai', // 覆盖 builtin/openai
          create: (rt) => ({
            name: () => rt.name,
            stream: async function* () {
              // 实现方言流式协议……产 Chunk（type: 'text' | 'tool_call' | …）
              yield { type: 'text', text: '…' };
            },
          }),
        }),
      'my-adapter',
    );
  },
};
```

## 替代 provider 的寻址（patch/preset）

```yaml
# 禁掉内置 openai 方言，让 my/adapter 成为唯一 openai 实现
seam/llm:
  - id: builtin/openai
    disabled: true
```

## 验证

- `createProvider({ kind: 'openai', … })` 解析到你的 adapter（同 kind 后注册胜）。
- 未注册 kind → `PROVIDER_DIALECT` 报错（错误不静默宪法）。
- 测试先例：`tests/provider-dialect.test.ts`、`tests/seam-composition.test.ts` ⑥。
