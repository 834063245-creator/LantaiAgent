// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector compact（rework P2-1 + 2026-08-26 数据源重构）：收起态 = 触发器
// （厂商 monogram + 模型名 + 箭头）；选择面 = 各已配置 provider 的「可用模型」
// （ProviderSettings.models，缺省回落 [model]）——配了哪些列哪些，不再倒静态目录。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from '../src/plugins/builtin/compose-dock/ModelSelector';
import { recordDynamicFetchResult } from '../src/provider/catalog';

describe('ModelSelector compact（创作坞触发器形态）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
  });

  it('收起态 = 触发器：厂商 monogram + 人类可读模型名 + 箭头（不再裸露 model id）', () => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    const trigger = container!.querySelector<HTMLButtonElement>('.ms-trigger');
    expect(trigger).not.toBeNull();
    // DSH ProviderIcon 的 monogram 替代：首字大写 chip
    expect(trigger?.querySelector('.ms-provider-mark')?.textContent).toBe('D');
    expect(trigger?.textContent).toContain('DeepSeek V4 Pro'); // 人类可读名，不裸露 model id
    expect(container!.querySelector('.ms-trigger-caret')).not.toBeNull(); // 箭头暗示可展开
    expect(trigger?.title).toContain('deepseek'); // 厂商身份在 title 可见
  });

  it('展开：按 vendor 分组；选择模型触发 onChange', async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    const heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent);
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.some((h) => h?.includes('deepseek'))).toBe(true); // 分组头 = monogram + 厂商名
    const items = container!.querySelectorAll<HTMLButtonElement>('.ms-item');
    expect(items.length).toBeGreaterThan(0);
    act(() => {
      items[0]?.click();
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('B1：已选模型时打开 = 空查询全表（不再预填 id 把列表锁成 1 条）', async () => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro', // 已选模型——原 bug 路径：打开预填 value 进搜索框
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    // 空查询 = 全部已配置 provider 的目录模型（多条，不是按 id 搜出的 1 条）
    const items = container!.querySelectorAll('.ms-item');
    expect(items.length).toBeGreaterThan(1);
  });

  it('B2：compact 只列已配置 provider 的模型（未配置厂商不出现）', async () => {
    // 只配置 deepseek 一家（localStorage 种子）——目录里 openai 家模型不得出现
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [
          {
            kind: 'openai',
            name: 'deepseek',
            apiKey: '',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-pro',
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    const heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent ?? '');
    // B3：无 Key 厂商分组头带「未配置 Key」标注（文本拼接），按包含断言（monogram 前缀）
    expect(heads.some((h) => h.includes('deepseek'))).toBe(true);
    expect(heads.some((h) => h.includes('openai'))).toBe(false); // 未配置厂商被过滤——杜绝写错行 400
  });

  it('B5：vision 模型行带「视」徽标（目录声明 + 覆盖补声明同面亮标）', async () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'p',
        providers: [
          {
            kind: 'openai',
            name: 'p',
            apiKey: '',
            baseUrl: 'https://gateway.example/v1',
            model: 'deepseek-v4-flash-vision-exp',
            models: ['deepseek-v4-flash-vision-exp', 'glm-4v-custom', 'deepseek-v4-pro'],
            modelOverrides: { 'glm-4v-custom': { input: ['text', 'image'] } },
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'p',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    // 目录 seed vision 款：徽标在
    const visionExp = container!.querySelector('[data-key="p/deepseek-v4-flash-vision-exp"]');
    expect(visionExp?.querySelector('.ms-item-vision')?.textContent).toBe('视');
    // 覆盖补声明款（目录外自定义 vision）：同亮（modelInput 合并链）
    const custom = container!.querySelector('[data-key="p/glm-4v-custom"]');
    expect(custom?.querySelector('.ms-item-vision')).not.toBeNull();
    // 纯文本主线：无徽标（不编造能力）
    const plain = container!.querySelector('[data-key="p/deepseek-v4-pro"]');
    expect(plain?.querySelector('.ms-item-vision')).toBeNull();
  });

  it('C5：动态目录拉取失败的厂商分组头标注「目录获取失败」', async () => {
    recordDynamicFetchResult('anthropic', false, '网络错误');
    try {
      // 只配置 anthropic 一家——compact 空查询列出该 vendor 的静态目录模型
      localStorage.setItem(
        'hologram_settings',
        JSON.stringify({
          activeProvider: 'anthropic',
          providers: [
            {
              kind: 'anthropic',
              name: 'anthropic',
              apiKey: '',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-sonnet-4-6',
            },
          ],
          projectPath: '.',
          agent: {},
          display: { language: 'zh', fontScale: 1 },
        }),
      );
      act(() => {
        root?.render(
          createElement(ModelSelector, {
            compact: true,
            value: 'claude-sonnet-4-6',
            providerName: 'anthropic',
            kind: 'anthropic',
            onChange: () => {},
          }),
        );
      });
      act(() => {
        container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
      });
      await act(async () => {});
      const heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent ?? '');
      expect(heads.some((h) => h.includes('anthropic') && h.includes('目录获取失败'))).toBe(true);
    } finally {
      recordDynamicFetchResult('anthropic', true); // 清标记防污染同文件其它用例
    }
  });

  it('DSH 运行中守卫：isStreaming 时点击触发器不打开，回调 onBlocked', async () => {
    const onBlocked = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          isStreaming: true,
          onBlocked,
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    expect(onBlocked).toHaveBeenCalledTimes(1); // 拦截提示（宿主挂 localNotice）
    expect(container!.querySelector('.ms-dropdown')).toBeNull(); // 菜单根本没打开
  });

  it('DSH same-model guard：compact 下再选当前同款不触发 onChange（跨 vendor 同 id 除外）', async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    // 点当前已选同款（deepseek 家 deepseek-v4-pro）→ no-op
    const items = [...container!.querySelectorAll<HTMLButtonElement>('.ms-item')];
    const current = items.find((b) => b.textContent?.includes('deepseek-v4-pro'));
    act(() => {
      current?.click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('只列配置面：同 vendor 未配置的目录模型不出现（不再倒静态目录全集）', async () => {
    // deepseek 只配 models:['deepseek-v4-pro']——目录里同家的 deepseek-v4-flash 不得出现
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [
          {
            kind: 'openai',
            name: 'deepseek',
            apiKey: '',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-pro',
            models: ['deepseek-v4-pro'],
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    const ids = [...container!.querySelectorAll<HTMLButtonElement>('.ms-item')].map((b) => b.textContent ?? '');
    expect(ids.some((t) => t.includes('deepseek-v4-pro'))).toBe(true);
    expect(ids.some((t) => t.includes('deepseek-v4-flash'))).toBe(false); // 目录有、配置没有 → 不出现
  });

  it('同一 provider 配置多个模型：下拉全部列出（同 vendor 多模型）', async () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [
          {
            kind: 'openai',
            name: 'deepseek',
            apiKey: '',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-pro',
            models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    const ids = [...container!.querySelectorAll<HTMLButtonElement>('.ms-item')].map((b) => b.textContent ?? '');
    expect(ids.some((t) => t.includes('deepseek-v4-pro'))).toBe(true);
    expect(ids.some((t) => t.includes('deepseek-v4-flash'))).toBe(true);
    // 两个都在 deepseek 分组下（只有一家）
    const heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent ?? '');
    expect(heads.filter((h) => h.includes('deepseek')).length).toBe(1);
  });

  it('自定义 provider 复用目录模型 id：分组按 provider 名，不落目录厂商（防写错家）', async () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'my-gateway',
        providers: [
          {
            kind: 'openai',
            name: 'my-gateway',
            apiKey: '',
            baseUrl: 'https://gw.example/v1',
            model: 'deepseek-v4-pro',
            models: ['deepseek-v4-pro'],
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'my-gateway',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    // 分组头 = my-gateway（连接身份），目录厂商 deepseek 不出现
    const heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent ?? '');
    expect(heads.some((h) => h.includes('my-gateway'))).toBe(true);
    expect(heads.some((h) => h.includes('deepseek'))).toBe(false);
    // 行内人类名仍来自目录元数据
    const items = [...container!.querySelectorAll<HTMLButtonElement>('.ms-item')].map((b) => b.textContent ?? '');
    expect(items.some((t) => t.includes('DeepSeek V4 Pro'))).toBe(true);
  });

  it('DSH 不可用状态：会话模型所属 provider 已不在配置里 → 触发器 ⚠ + title 提示，仍可打开恢复', async () => {
    // 配置里只有 deepseek；当前 providerName = 已移除的 'ghost'
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [
          {
            kind: 'openai',
            name: 'deepseek',
            apiKey: '',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-pro',
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'ghost-model',
          providerName: 'ghost',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    const trigger = container!.querySelector<HTMLButtonElement>('.ms-trigger');
    expect(trigger?.classList.contains('ms-trigger-unavailable')).toBe(true);
    expect(trigger?.title).toContain('不可用');
    expect(trigger?.querySelector('.ms-trigger-unavail')).not.toBeNull();
    // 仍可打开下拉（从有效配置里恢复）
    act(() => {
      trigger?.click();
    });
    await act(async () => {});
    expect(container!.querySelector('.ms-dropdown')).not.toBeNull();
  });

  it('非 compact（设置面板字段形态）保持平铺：无触发器、无分组头', () => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    expect(container!.querySelector('.ms-trigger')).toBeNull();
    // 聚焦打开后仍是平铺列表（无 .ms-group-head）
    act(() => {
      container!.querySelector<HTMLInputElement>('.ms-input')?.focus();
    });
    expect(container!.querySelectorAll('.ms-group-head').length).toBe(0);
  });
});

describe('ModelSelector 键盘导航（react-aria useComboBox，档位 C）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
  });

  const key = (el: Element, k: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('↑↓ 移动 aria-activedescendant 聚焦项（react-aria 接管键盘导航）', async () => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    const input = container!.querySelector<HTMLInputElement>('.ms-input')!;
    // 打开即自动聚焦当前选中项（react-aria autoFocus 语义——combobox 惯例：焦点落在已选项），
    // aria-activedescendant 指向该项
    const firstActive = container!.querySelector<HTMLElement>('.ms-item.active');
    expect(firstActive).not.toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBe(firstActive?.id);
    // ArrowDown 在最后一项不换行（react-aria 默认 shouldFocusWrap=false）
    act(() => {
      key(input, 'ArrowDown');
    });
    expect(container!.querySelector<HTMLElement>('.ms-item.active')).toBe(firstActive);
    // ArrowUp 移到前一项 → active 跟随移动
    act(() => {
      key(input, 'ArrowUp');
    });
    const prevActive = container!.querySelector<HTMLElement>('.ms-item.active');
    expect(prevActive).not.toBe(firstActive);
    expect(input.getAttribute('aria-activedescendant')).toBe(prevActive?.id);
  });

  it('Enter 选中聚焦项 → onChange（无需鼠标）', async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    const input = container!.querySelector<HTMLInputElement>('.ms-input')!;
    // 打开自动聚焦当前已选项（deepseek-v4-pro）；ArrowUp 到前一项（anthropic 家 claude-sonnet-4-6）
    act(() => {
      key(input, 'ArrowUp');
    });
    act(() => {
      key(input, 'Enter');
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('claude-sonnet-4-6', expect.anything());
  });

  it('自定义模型名：输入无匹配 + Enter → onChange(输入值)（allowsCustomValue 语义）', async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLInputElement>('.ms-input')?.focus();
    });
    const input = container!.querySelector<HTMLInputElement>('.ms-input')!;
    // 输入目录里不存在的名字（目录无此模型 → 无匹配）
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'my-custom-model');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      key(input, 'Enter');
    });
    expect(onChange).toHaveBeenCalledWith('my-custom-model');
  });

  it('Escape 只关闭不提交自定义值（覆盖 react-aria 默认 revert 语义）', async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLInputElement>('.ms-input')?.focus();
    });
    const input = container!.querySelector<HTMLInputElement>('.ms-input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'my-custom-model');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      key(input, 'Escape');
    });
    expect(onChange).not.toHaveBeenCalled(); // Escape = 取消，不提交
  });
});

describe('R3b：settings 保存后下拉可选面即时刷新（新提供方模型立刻可选）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
  });

  const seed = () =>
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [
          {
            kind: 'openai',
            name: 'deepseek',
            apiKey: '',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-pro',
            models: ['deepseek-v4-pro'],
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );

  it('打开的下拉：settings 保存新增 provider+models → 新分组立刻出现（无需重开）', async () => {
    seed();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    // 初始只有 deepseek 分组
    let heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent ?? '');
    expect(heads.some((h) => h.includes('deepseek'))).toBe(true);
    expect(heads.some((h) => h.includes('qwen-token-plan'))).toBe(false);

    // 模拟「添加提供方即时生效」：settings 落盘（含新 provider + models）
    // 复用真实 saveSettings → onSettingsSaved 触发 → 可选面重快照
    const { loadSettings, providerId, saveSettings } = await import('../src/settings');
    const s = loadSettings();
    saveSettings({
      ...s,
      activeProvider: providerId('qwen-token-plan'),
      providers: [
        ...s.providers,
        {
          kind: 'openai',
          name: providerId('qwen-token-plan'),
          apiKey: '',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen3-coder-plus',
          models: ['qwen3-coder-plus', 'qwen3-max'],
        },
      ],
    });
    await act(async () => {});

    // 下拉仍开着：新分组出现，模型可选
    heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent ?? '');
    expect(heads.some((h) => h.includes('qwen-token-plan'))).toBe(true);
    const ids = [...container!.querySelectorAll<HTMLButtonElement>('.ms-item')].map((b) => b.textContent ?? '');
    expect(ids.some((t) => t.includes('qwen3-coder-plus'))).toBe(true);
  });
});
