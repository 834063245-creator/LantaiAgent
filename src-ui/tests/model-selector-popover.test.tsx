// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector compact 弹层 UX 收口（2026-09-06 创作坞三毛病返工）：
// - 触发器恒驻：打开时不再被空搜索框顶替（旧形态「当前模型被清空」的视觉
//   错觉根因）——触发 pill 仍显示当前模型；
// - 搜索进弹层：.ms-dropdown = 搜索行（.ms-input）+ 列表滚动区（.ms-listbox）；
// - 外点关闭：document mousedown 兜底（画布空白 mousedown preventDefault 拦
//   blur，react-aria 的 blur 关闭永不触发——实锤 PaperPanel.onCanvasMouseDown）；
// - 触发器再点 = toggle 收起（真实浏览器 mousedown→click 序列，防 blur 竞态）；
// - Escape 收起并回焦触发器；
// - 半截查询不写库：外点/Enter 无匹配的 react-aria commitCustomValue 路径
//   在 compact 下不触发 onChange（弹层取消语义）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from '../src/plugins/builtin/compose-dock/ModelSelector';

describe('ModelSelector compact 弹层 UX 收口（2026-09-06）', () => {
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

  /** 装配 + 点开弹层；props 覆盖 onChange 等回调面。 */
  const openMenu = async (props: { onChange?: (modelId: string, desc?: unknown) => void } = {}) => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
          ...props,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
  };

  it('触发器恒驻：打开后 .ms-trigger 仍在且显示当前模型名（不被空搜索框顶替）', async () => {
    await openMenu();
    const trigger = container!.querySelector<HTMLButtonElement>('.ms-trigger');
    expect(trigger).not.toBeNull(); // 打开态触发器仍在 DOM——不再被输入行整体换掉
    expect(trigger?.textContent).toContain('DeepSeek V4 Pro'); // 当前模型可见——「清空」错觉钉死
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });

  it('搜索进弹层：.ms-dropdown 内 = 搜索行（.ms-input）+ 列表滚动区（.ms-listbox）', async () => {
    await openMenu();
    const dropdown = container!.querySelector('.ms-dropdown');
    expect(dropdown).not.toBeNull();
    expect(dropdown!.querySelector('.ms-input')).not.toBeNull();
    expect(dropdown!.querySelector('.ms-listbox')).not.toBeNull();
    expect(dropdown!.querySelectorAll('.ms-item').length).toBeGreaterThan(0);
  });

  it('外点关闭：容器外 document mousedown → 弹层收起（画布 preventDefault 拦 blur 的兜底路）', async () => {
    await openMenu();
    expect(container!.querySelector('.ms-dropdown')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await act(async () => {});
    expect(container!.querySelector('.ms-dropdown')).toBeNull(); // 菜单收回
  });

  it('容器内 mousedown 不关：点列表项区域（弹层内）不误收', async () => {
    await openMenu();
    act(() => {
      container!.querySelector('.ms-listbox')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await act(async () => {});
    expect(container!.querySelector('.ms-dropdown')).not.toBeNull();
  });

  it('触发器再点 = toggle 收起（真实浏览器 mousedown→click 序列，防 blur 竞态重开）', async () => {
    await openMenu();
    const trigger = container!.querySelector<HTMLButtonElement>('.ms-trigger')!;
    // 真实点击序列：mousedown（触发器 preventDefault 防抢焦）先行
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    act(() => {
      trigger.click();
    });
    await act(async () => {});
    expect(container!.querySelector('.ms-dropdown')).toBeNull(); // 收起而非「关了又开」
    expect(container!.querySelector('.ms-trigger')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape 收起并回焦触发器（combobox 惯例：取消回到收起态控件）', async () => {
    await openMenu();
    const input = container!.querySelector<HTMLInputElement>('.ms-input')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(container!.querySelector('.ms-dropdown')).toBeNull();
    // 回焦走 requestAnimationFrame——flush 后焦点应落在触发器上
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement?.classList.contains('ms-trigger')).toBe(true);
  });

  it('半截查询不写库：输入无匹配 + Enter → 不把查询词当自定义模型 onChange', async () => {
    const onChange = vi.fn();
    await openMenu({ onChange });
    const input = container!.querySelector<HTMLInputElement>('.ms-input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'zzz-no-such-model');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(onChange).not.toHaveBeenCalled(); // 取消语义——弹层内手输不落库
    expect(container!.querySelector('.ms-dropdown')).toBeNull();
  });

  it('半截查询外点也不写库：输入中点外 → 收起且 onChange 不触发', async () => {
    const onChange = vi.fn();
    await openMenu({ onChange });
    const input = container!.querySelector<HTMLInputElement>('.ms-input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'deep');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await act(async () => {});
    expect(onChange).not.toHaveBeenCalled();
    expect(container!.querySelector('.ms-dropdown')).toBeNull();
  });

  it('选择模型照常：点 .ms-item 仍触发 onChange(id, desc) 并收起', async () => {
    const onChange = vi.fn();
    await openMenu({ onChange });
    const items = container!.querySelectorAll<HTMLButtonElement>('.ms-item');
    act(() => {
      items[0]?.click();
    });
    await act(async () => {});
    expect(onChange).toHaveBeenCalled();
    expect(container!.querySelector('.ms-dropdown')).toBeNull();
  });

  it('搜索行有占位符「搜索模型…」（2026-11-08：placeholder 曾被 react-aria 的空串盖掉）', async () => {
    await openMenu();
    const input = container!.querySelector<HTMLInputElement>('.ms-dropdown .ms-input');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('placeholder')).toBe('搜索模型…');
  });

  it('打开即把当前模型滚进视野（首屏不能只露 6px）', async () => {
    // jsdom 无布局，故钉的是**行为接线**：打开后对 .ms-item.selected 调用过
    // scrollIntoView（真机上这一下把当前行从 top=182 / 列表高 188 拉进可视区）。
    // 先种一份「已配置 deepseek + 选中 deepseek-v4-pro」，保证列表里确有 selected 行
    // （默认设置里没有 provider 时列表为空，这条会假绿/假红）。
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
    const spy = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: (arg?: unknown) => void };
    // ⚠ jsdom 的 Element 原型上**没有** scrollIntoView（不是 undefined 覆盖，是压根没有），
    //   所以组件里的 `el?.scrollIntoView?.()` 会静默跳过——必须先 define 再断言，
    //   否则这条测试考的是"函数不存在"，永远绿。
    const had = 'scrollIntoView' in proto;
    const prev = proto.scrollIntoView;
    proto.scrollIntoView = spy;
    try {
      await openMenu();
      await act(async () => {});
      expect(spy).toHaveBeenCalled();
    } finally {
      if (had) proto.scrollIntoView = prev;
      else Reflect.deleteProperty(proto, 'scrollIntoView');
    }
  });

  it('非 compact（设置页字段形态）零改动：无触发器、无 .ms-listbox 包装', () => {
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
    expect(container!.querySelector('.ms-trigger')).toBeNull(); // 字段形态仍直接是输入框
    expect(container!.querySelector('.ms-input-row .ms-input')).not.toBeNull();
    expect(container!.querySelector('.ms-listbox')).toBeNull();
  });
});

// ── 2026-11-12 DSH 两级菜单（用户拍板「去抄一下 dsh 的 UX」）──────────────────
// 模型与思考是**同一枚 pill 的两个维度** ⇒ 根栏两格「模型 / 思考」，点进去才是各自
// 清单。旧形态（2026-11-06 合并 A）把档位表平铺成 n 枚 chip 塞在模型列表底下，用户
// 判「模型思考强度选择这块的 UX 有毛病」：chip 与列表语义无关、档位多时换行、
// 拨完不关弹层。四条行为从用户操作序列写：开 → 进面 → 选/退。
describe('ModelSelector 两级菜单（2026-11-12）', () => {
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

  /** 思考面数据（文案由宿主给——选择器不感知思考语义）。 */
  const THINKING = {
    value: 'high',
    label: '高',
    options: [
      { value: '', label: '自动', hint: '模型自定推理强度' },
      { value: 'low', label: '低', hint: '轻度推理' },
      { value: 'high', label: '高', hint: '深入推理' },
    ],
    onChange: () => {},
  };

  const mount = async (over: Record<string, unknown> = {}) => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
          thinking: THINKING,
          ...over,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
  };

  const clickCell = async (label: string) => {
    const cell = [...container!.querySelectorAll<HTMLButtonElement>('.ms-cell')].find(
      (c) => c.querySelector('.ms-cell-label')?.textContent === label,
    );
    act(() => {
      cell?.click();
    });
    await act(async () => {});
  };

  it('打开落在根栏：两格「模型 / 思考」各读当前值，不铺清单', async () => {
    await mount();
    const cells = [...container!.querySelectorAll<HTMLButtonElement>('.ms-cell')];
    expect(cells.map((c) => c.querySelector('.ms-cell-label')?.textContent)).toEqual(['模型', '思考']);
    expect(cells[0]?.querySelector('.ms-cell-value')?.textContent).toContain('DeepSeek V4 Pro');
    expect(cells[1]?.querySelector('.ms-cell-value')?.textContent).toBe('高');
    expect(container!.querySelector('.ms-listbox')).toBeNull(); // 根栏不铺清单
    expect(container!.querySelector('.ms-input')).toBeNull();
    expect(container!.querySelector('.ms-trigger')?.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('点「模型」进模型面：搜索 + 模型行；返回格回根栏', async () => {
    await mount();
    await clickCell('模型');
    expect(container!.querySelector('.ms-input')).not.toBeNull();
    expect(container!.querySelectorAll('.ms-item').length).toBeGreaterThan(0);
    expect(container!.querySelector('.ms-back')?.textContent).toContain('模型');
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-back')?.click();
    });
    await act(async () => {});
    expect(container!.querySelectorAll('.ms-cell').length).toBe(2);
  });

  it('点「思考」进档位面：竖排清单 + 当前档 aria-checked；选别的档 → onChange + 收起', async () => {
    const onChange = vi.fn();
    await mount({ thinking: { ...THINKING, onChange } });
    await clickCell('思考');
    const rows = [...container!.querySelectorAll<HTMLButtonElement>('.ms-think-item')];
    expect(rows.map((r) => r.querySelector('.ms-item-name')?.textContent)).toEqual(['自动', '低', '高']);
    expect(rows[2]?.getAttribute('aria-checked')).toBe('true');
    expect(rows[0]?.getAttribute('aria-checked')).toBe('false');
    act(() => {
      rows[1]?.click();
    });
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith('low');
    expect(container!.querySelector('.ms-dropdown')).toBeNull(); // 选中即完成
  });

  it('Escape 从钻入面退回根栏（不收起），根栏再 Escape 才收起', async () => {
    await mount();
    await clickCell('思考');
    act(() => {
      container!
        .querySelector<HTMLElement>('.ms-think-item')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(container!.querySelector('.ms-dropdown')).not.toBeNull();
    expect(container!.querySelectorAll('.ms-cell').length).toBe(2);
    act(() => {
      container!
        .querySelector<HTMLElement>('.ms-cell')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(container!.querySelector('.ms-dropdown')).toBeNull();
  });

  it('无思考面（不传 thinking）：打开直接进模型面——单选维度不多一次点击', async () => {
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
    expect(container!.querySelector('.ms-cell')).toBeNull();
    expect(container!.querySelector('.ms-back')).toBeNull();
    expect(container!.querySelector('.ms-input')).not.toBeNull();
    expect(container!.querySelector('.ms-trigger')?.getAttribute('aria-haspopup')).toBe('listbox');
  });
});
