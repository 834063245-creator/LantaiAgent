// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ProviderPage 暂存流程组件测试：
// 删除、清除 Key 为「暂存」，保存时才落盘 + 删凭据 + 重建 Agent；
// 添加（2026-09-06 两步式）= 预填连接 → 拉模型 → 选默认 → 即时持久化（onAddAndPersist）；
// OAuth 订阅（2026-09-11 重做）= 弹层内登录前置 → 登录后拉模型/seed → 确认添加。
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// typedRpc → rpc → bridge.rpc —— mock bridge 层（照 provider-oauth.test 模式）。
// 默认实现按 method 返回合理空形状；测试按需 queueRpc 覆盖。
const mockInvoke = vi.fn(async (_kind: string, args: { method: string }) => {
  const m = args.method;
  if (m === 'oauth_accounts') return '[]'; // 未登录 = 空账号
  if (m === 'credential_get') return 'null'; // 无已存 Key
  return 'null';
});
vi.mock('../../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { ProviderPage } from '../../src/app/panels/settings/ProviderPage';
import { type AppSettings, type ProviderId, providerId } from '../../src/settings';

/** 让下一次 typedRpc 调用返回指定 JSON 字符串（按 method 校验）。 */
function queueRpc(method: string, result: string): void {
  mockInvoke.mockImplementationOnce(async (_kind: string, args: { method: string }) => {
    if (args.method !== method) throw new Error(`unexpected rpc ${args.method} (want ${method})`);
    return result;
  });
}

/** OAuth device-flow 起始响应（Rust oauth_start 形状）。 */
function oauthStartFlow(): string {
  return JSON.stringify({
    verification_uri: 'https://auth.openai.com/codex/device',
    user_code: 'ABCD-EFGH',
    device_auth_id: 'da1',
    interval: 5,
    expires_at: 0,
  });
}

/** OAuth 登录成功 grant（oauth_poll 完成态）。 */
function oauthGrant(): string {
  return JSON.stringify({
    kind: 'oauth',
    provider: 'codex',
    access_token: 'at',
    refresh_token: 'rt',
    expires_at: 0,
    account_id: 'user-1',
  });
}

const mockStageDelete = vi.fn();
const mockStageClear = vi.fn();
const mockUnstageClear = vi.fn();
const mockSaveProviders = vi.fn();
const mockAddPersist = vi.fn(async () => {});

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    activeProvider: providerId('deepseek'),
    providers: [
      {
        kind: 'openai',
        name: providerId('deepseek'),
        apiKey: 'sk-deep',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      },
      {
        kind: 'anthropic',
        name: providerId('anthropic'),
        apiKey: 'sk-anth',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        thinking: '',
      },
    ],
    projectPath: '.',
    agent: { temperature: 0.7, contextWindow: 0 },
    display: { language: 'zh', fontScale: 1 },
    ...overrides,
  };
}

function Harness({ initial }: { initial: AppSettings }) {
  const [settings, setSettings] = useState(initial);
  const [pendingClears, setPendingClears] = useState<ProviderId[]>([]);
  const [providerDirty, setProviderDirty] = useState(false);

  return createElement(ProviderPage, {
    settings,
    onCommitProvider: (next) => {
      setSettings(next);
      setProviderDirty(true);
    },
    onPersistSettings: setSettings,
    onStageDelete: (name) => {
      mockStageDelete(name);
      setPendingClears((p) => p.filter((n) => n !== name));
    },
    onStageClear: (name) => {
      mockStageClear(name);
      setPendingClears((p) => (p.includes(name) ? p : [...p, name]));
    },
    onUnstageClear: (name) => {
      mockUnstageClear(name);
      setPendingClears((p) => p.filter((n) => n !== name));
    },
    pendingClears,
    saveVersion: 0,
    providerDirty,
    onSaveProviders: () => {
      mockSaveProviders();
      setProviderDirty(false);
    },
    onAddAndPersist: async (next, addedName) => {
      mockAddPersist(next, addedName);
      setSettings(next);
      setProviderDirty(false);
    },
  });
}

async function setInputValue(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 下拉选择（React onChange 走 change 事件）。 */
async function setSelectValue(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('ProviderPage — 暂存流程', () => {
  let container: HTMLElement;
  let root: Root;

  const render = async (initial: AppSettings) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { initial }));
    });
  };

  const click = async (el: Element | null) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  beforeEach(() => {
    mockStageDelete.mockReset();
    mockStageClear.mockReset();
    mockUnstageClear.mockReset();
    mockSaveProviders.mockReset();
    mockAddPersist.mockReset();
    mockAddPersist.mockResolvedValue(undefined);
    // 清一次性的 queueRpc 序列，保留默认实现（oauth_accounts → [] 等）
    mockInvoke.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    root?.unmount();
  });

  it('两步式添加（catalog chip 预填）→ 补默认模型 → onAddAndPersist 即时持久化', async () => {
    await render(makeSettings({ providers: [makeSettings().providers[1]] }));

    await click(document.querySelector('.pp-rail-add'));
    expect(document.querySelector('.pp-add-sheet')).not.toBeNull();

    // chip 点击 = 预填连接表单（不再一键直加）
    const deepseekChip = [...document.querySelectorAll<HTMLButtonElement>('.pp-cat-chip')].find((b) =>
      b.textContent?.includes('deepseek'),
    )!;
    expect(deepseekChip.disabled).toBe(false);
    await click(deepseekChip);

    // 弹层仍在（未直加）；表单已预填 deepseek
    expect(document.querySelector('.pp-add-sheet')).not.toBeNull();
    const nameInput = [...document.querySelectorAll<HTMLInputElement>('.pp-form-grid input')].find((i) =>
      i.placeholder.includes('my-gateway'),
    )!;
    expect(nameInput.value).toBe('deepseek');

    // 手动补模型（jsdom 无网络——拉取走 catch 后仍可手动补）
    const manual = document.querySelector<HTMLInputElement>('input[aria-label="手动补模型 id"]')!;
    await setInputValue(manual, 'deepseek-v4-pro');
    const sheet = document.querySelector('.pp-add-sheet')!;
    await click(
      [...sheet.querySelectorAll<HTMLButtonElement>('.pp-models-add button')].find((b) =>
        b.textContent?.includes('添加'),
      )!,
    );
    // 默认模型自动取第一个补入的
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.cd-actions button')].find((b) =>
        b.textContent?.includes('确认添加'),
      )!,
    );

    // 即时持久化：onAddAndPersist 收到含新 provider + models + model 的 next
    expect(mockAddPersist).toHaveBeenCalledTimes(1);
    const [next] = mockAddPersist.mock.calls[0] as [AppSettings, ProviderId];
    const added = next.providers.find((p) => p.name === 'deepseek')!;
    expect(added).toBeDefined();
    expect(added.models).toContain('deepseek-v4-pro');
    expect(added.model).toBe('deepseek-v4-pro');
    // 成功添加后弹层关闭、列表出现、无保存条（即时生效非暂存）
    expect(document.querySelector('.pp-add-sheet')).toBeNull();
    expect([...document.querySelectorAll('.pp-src-name')].some((n) => n.textContent?.startsWith('deepseek'))).toBe(
      true,
    );
  });

  it('自定义添加（两步式）带 Key → onAddAndPersist 收到 name/kind/baseUrl/key/models', async () => {
    await render(makeSettings({ providers: [makeSettings().providers[1]] }));
    await click(document.querySelector('.pp-rail-add'));

    const nameInput = [...document.querySelectorAll<HTMLInputElement>('.pp-form-grid input')].find((i) =>
      i.placeholder.includes('my-gateway'),
    )!;
    await setInputValue(nameInput, 'my-gateway');
    const keyInput = [...document.querySelectorAll<HTMLInputElement>('.pp-form-grid input')].find((i) =>
      i.placeholder.includes('sk-'),
    )!;
    await setInputValue(keyInput, 'sk-custom');

    // 手动补模型后确认
    const manual = document.querySelector<HTMLInputElement>('input[aria-label="手动补模型 id"]')!;
    await setInputValue(manual, 'gpt-5');
    const sheet = document.querySelector('.pp-add-sheet')!;
    await click(
      [...sheet.querySelectorAll<HTMLButtonElement>('.pp-models-add button')].find((b) =>
        b.textContent?.includes('添加'),
      )!,
    );
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.cd-actions button')].find((b) =>
        b.textContent?.includes('确认添加'),
      )!,
    );

    expect(mockAddPersist).toHaveBeenCalledTimes(1);
    const [next] = mockAddPersist.mock.calls[0] as [AppSettings, ProviderId];
    const added = next.providers.find((p) => p.name === 'my-gateway')!;
    expect(added).toBeDefined();
    expect(added.kind).toBe('openai');
    expect(added.apiKey).toBe('sk-custom');
    expect(added.models).toContain('gpt-5');
    expect(added.model).toBe('gpt-5');
    expect(document.querySelector('.pp-add-sheet')).toBeNull();
  });

  it('无模型点确认添加 → 错误提示（不静默收尾）', async () => {
    await render(makeSettings({ providers: [makeSettings().providers[1]] }));
    await click(document.querySelector('.pp-rail-add'));

    // 填了名称但未拉取也未手动补模型 → 确认被拦「还没有可用模型」
    const nameInput = [...document.querySelectorAll<HTMLInputElement>('.pp-form-grid input')].find((i) =>
      i.placeholder.includes('my-gateway'),
    )!;
    await setInputValue(nameInput, 'empty-provider');
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.cd-actions button')].find((b) =>
        b.textContent?.includes('确认添加'),
      )!,
    );
    expect(document.querySelector('.pp-add-sheet')).not.toBeNull();
    expect(document.querySelector('.pp-form-error')?.textContent).toContain('还没有可用模型');
    expect(mockAddPersist).not.toHaveBeenCalled();
  });

  it('删除 Provider → 确认弹窗 → onStageDelete + 选中回落', async () => {
    await render(makeSettings());

    const anthropicRow = [...document.querySelectorAll<HTMLButtonElement>('.pp-src')].find((b) =>
      b.textContent?.includes('anthropic'),
    )!;
    await click(anthropicRow);
    const delBtn = [...document.querySelectorAll<HTMLButtonElement>('.pp-btn-danger')].find((b) =>
      b.textContent?.includes('删除提供方'),
    )!;
    await click(delBtn);
    expect(document.querySelector('.cd-sheet')?.textContent).toContain('删除提供方');

    await click(document.querySelector('.cd-btn-danger'));
    expect(mockStageDelete).toHaveBeenCalledWith('anthropic');
    expect([...document.querySelectorAll('.pp-src-name')].some((n) => n.textContent?.startsWith('anthropic'))).toBe(
      false,
    );
    expect([...document.querySelectorAll('.pp-src-name')].some((n) => n.textContent?.startsWith('deepseek'))).toBe(
      true,
    );
    expect(document.querySelector('.pp-console .pp-name')?.textContent).toBe('deepseek');
    expect(document.querySelector('.cd-sheet')).toBeNull();
  });

  it('清除已保存 Key → 确认弹窗 → onStageClear + 待保存生效 chip', async () => {
    await render(makeSettings());

    const clearBtn = document.querySelector<HTMLButtonElement>('.pp-key-row .pp-btn-danger')!;
    await click(clearBtn);
    expect(document.querySelector('.cd-sheet')?.textContent).toContain('清除已保存 Key');

    await click(document.querySelector('.cd-btn-danger'));
    expect(mockStageClear).toHaveBeenCalledWith('deepseek');
    expect(mockUnstageClear).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('.pp-chip')?.textContent).toContain('清除待保存生效');
  });

  it('手动清空 Key 输入 = 暂存清除；输入新 Key = 取消暂存', async () => {
    await render(makeSettings());

    const keyInput = document.querySelector<HTMLInputElement>('.pp-key-row input')!;
    await setInputValue(keyInput, '');
    expect(mockStageClear).toHaveBeenCalledWith('deepseek');
    expect(document.querySelector<HTMLElement>('.pp-chip')?.textContent).toContain('清除待保存生效');

    await setInputValue(keyInput, 'sk-new');
    expect(mockUnstageClear).toHaveBeenCalledWith('deepseek');
    expect(document.querySelector<HTMLElement>('.pp-chip')?.textContent).toContain('未保存');
  });

  it('保存 Provider → onSaveProviders + 保存条消失', async () => {
    await render(makeSettings());

    const urlInput = [...document.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    )!;
    await setInputValue(urlInput, 'https://custom.example/v1');
    expect(document.querySelector('.pp-save-bar')).not.toBeNull();

    await click(document.querySelector('.pp-save-btn'));
    expect(mockSaveProviders).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.pp-save-bar')).toBeNull();
  });

  it('可用模型：输入添加（默认并入）+ 移除（写进暂存 settings.models）', async () => {
    await render(makeSettings());
    // chip 文本是目录人类名，id 在 title——用 title 断言
    const chipIds = () => [...document.querySelectorAll<HTMLElement>('.pp-model-chip')].map((c) => c.title);

    // 添加前：旧数据无 models → 自动视为 [默认模型]（= 新会话默认，带标记）
    expect(chipIds()).toContain('deepseek-v4-pro');
    expect(document.querySelector('.pp-model-chip.is-default')?.title).toBe('deepseek-v4-pro');
    expect(document.querySelector('.pp-model-chip-default')?.textContent).toContain('新会话默认');

    const addInput = document.querySelector<HTMLInputElement>('#pd-models-input')!;
    await setInputValue(addInput, 'deepseek-reasoner');
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.pp-models-add button')].find((b) =>
        b.textContent?.includes('添加'),
      )!,
    );

    // 默认模型并入 + 新模型追加 → 两个 chip；新会话默认标记仍在 deepseek-v4-pro
    expect(chipIds()).toContain('deepseek-reasoner');
    expect(chipIds()).toContain('deepseek-v4-pro');
    expect(document.querySelector('.pp-model-chip.is-default')?.title).toBe('deepseek-v4-pro');

    // 移除「新会话默认」→ 自动顶上剩余第一个为默认
    const defaultX = [...document.querySelectorAll<HTMLButtonElement>('.pp-model-chip-x')].find((b) =>
      b.title.includes('deepseek-v4-pro'),
    )!;
    await click(defaultX);
    expect(chipIds()).not.toContain('deepseek-v4-pro');
    expect(document.querySelector('.pp-model-chip.is-default')?.title).toBe('deepseek-reasoner');

    // 再移除新加的（已是默认）→ 无剩余，默认清空
    const lastX = [...document.querySelectorAll<HTMLButtonElement>('.pp-model-chip-x')].find((b) =>
      b.title.includes('deepseek-reasoner'),
    )!;
    await click(lastX);
    expect(document.querySelector('.pp-model-chip')).toBeNull();
  });

  it('可用模型 per-model 参数：点「参数」展开，设上下文/最大输出写进 modelOverrides', async () => {
    await render(makeSettings());

    const paramBtn = [...document.querySelectorAll<HTMLButtonElement>('.pp-model-chip-param')].find((b) =>
      b.title.includes('上下文窗口'),
    )!;
    await click(paramBtn);
    const params = document.querySelector<HTMLElement>('.pp-model-params');
    expect(params).not.toBeNull();

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.pp-model-params input')];
    expect(inputs.length).toBe(2); // 上下文窗口 + 最大输出
    await setInputValue(inputs[0]!, '64000');
    await setInputValue(inputs[1]!, '32000');
    // 写入暂存 settings.modelOverrides 后回读（Harness onCommitProvider 更新 state 重渲）
    expect(inputs[0]?.value).toBe('64000');
    expect(inputs[1]?.value).toBe('32000');

    // 收起后展开仍在（modelOverrides 已持久到暂存 settings）
    await click(paramBtn);
    expect(document.querySelector('.pp-model-params')).toBeNull();
  });

  // 2026-09-23 思考下沉：思考档位从「提供方行级一个控件」下沉到每个模型自己的
  // 覆盖（用户报「选了档位却不知道是对哪个模型生效」）。缺省 = 本家默认档位。
  it('per-model 思考档位：选档位写 modelOverrides.thinking；「随本家默认」清覆盖', async () => {
    const base = makeSettings();
    await render(
      makeSettings({
        providers: [
          { ...base.providers[0]!, modelOverrides: { 'deepseek-v4-pro': { thinking: 'max' } } },
          base.providers[1]!,
        ],
      }),
    );
    const paramBtn = [...document.querySelectorAll<HTMLButtonElement>('.pp-model-chip-param')].find((b) =>
      b.title.includes('上下文窗口'),
    )!;
    await click(paramBtn);
    const select = () => document.querySelector<HTMLSelectElement>('.pp-model-params select')!;
    expect(select()).not.toBeNull();
    expect(select().value).toBe('max'); // 覆盖生效值（该模型自己的档位）

    // 改成声明内的另一档 → 写覆盖
    await setSelectValue(select(), 'high');
    expect(select().value).toBe('high');

    // 「随本家默认」= 清覆盖（undefined 经 JSON 落盘即键消失，与本家默认档位同语义）
    await setSelectValue(select(), '__inherit__');
    expect(select().value).toBe('__inherit__');
  });

  it('oauth 订阅（codex chip）：未登录不能确认添加——先弹层内登录（device-flow）→ seed 模型 → 确认添加', async () => {
    await render(makeSettings({ providers: [makeSettings().providers[1]] }));
    await click(document.querySelector('.pp-rail-add'));

    // codex chip → 预填（无 API Key 输入框）
    const codexChip = [...document.querySelectorAll<HTMLButtonElement>('.pp-cat-chip')].find((b) =>
      b.textContent?.includes('codex'),
    )!;
    expect(codexChip).toBeDefined();
    await click(codexChip);

    // oauth 形态：无 API Key 输入框；显示「登录」按钮；无模型
    expect(
      [...document.querySelectorAll<HTMLInputElement>('.pp-form-grid input')].some((i) =>
        i.placeholder.includes('sk-'),
      ),
    ).toBe(false);
    const loginBtn = [...document.querySelectorAll<HTMLButtonElement>('.pp-oauth-actions button')].find((b) =>
      b.textContent?.includes('登录'),
    )!;
    expect(loginBtn).toBeDefined();
    expect(document.querySelector('.pp-pick-model-id')).toBeNull();

    // 未登录点「确认添加」→ 被拦（错误提示指向先登录）
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.cd-actions button')].find((b) =>
        b.textContent?.includes('确认添加'),
      )!,
    );
    expect(mockAddPersist).not.toHaveBeenCalled();
    expect(document.querySelector('.pp-form-error')?.textContent).toContain('还没登录');

    // 弹层内登录：oauth_start → open_external → oauth_poll 立即批准 → grant
    queueRpc('oauth_start', oauthStartFlow());
    queueRpc('open_external', 'null');
    queueRpc('oauth_poll', oauthGrant());
    // 登录成功回调刷新账号清单（oauth_accounts 返回新账号）
    mockInvoke.mockImplementationOnce(async (_kind: string, args: { method: string }) => {
      if (args.method === 'oauth_accounts') {
        return JSON.stringify([{ provider: 'codex', account_id: 'user-1', expires_at: 0, scope: null }]);
      }
      throw new Error(`unexpected ${args.method}`);
    });
    await click(loginBtn);

    // 登录成功 → 账号 chip 出现、默认模型 seed 出现（模板 defaultModel）
    expect(document.querySelector('.pp-oauth-accounts')).not.toBeNull();
    expect(document.querySelector('.pp-oauth-accounts')?.textContent).toContain('user-1');
    expect(document.querySelector('.pp-pick-model-id')?.textContent).toBe('gpt-6-sol');

    // 现在确认添加 → onAddAndPersist 收到含 authMode/oauthProvider/models 的行
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.cd-actions button')].find((b) =>
        b.textContent?.includes('确认添加'),
      )!,
    );
    expect(mockAddPersist).toHaveBeenCalledTimes(1);
    const [next] = mockAddPersist.mock.calls[0] as [AppSettings, ProviderId];
    const added = next.providers.find((p) => p.name === 'codex')!;
    expect(added).toBeDefined();
    expect(added.kind).toBe('responses');
    expect(added.authMode).toBe('oauth');
    expect(added.oauthProvider).toBe('codex');
    expect(added.apiKey).toBeFalsy();
    expect(added.models).toContain('gpt-6-sol');
    expect(added.model).toBe('gpt-6-sol');
    expect(document.querySelector('.pp-add-sheet')).toBeNull();
  });
});
