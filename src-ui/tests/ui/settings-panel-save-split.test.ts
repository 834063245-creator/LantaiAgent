// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SettingsPanel 保存拆域回归测试（P6/P9）：
// Provider dirty 与全局 dirty 互不牵连；任一保存成功后两个 dirty 一并复位。

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
const mockRpc = vi.fn(async () => 'null');
const mockConfigChanged = vi.fn();

vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('9.0.0') }));
vi.mock('../../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: vi.fn(),
  isMockMode: () => true,
  rpc: (...args: unknown[]) => mockRpc(...args),
  watchFileDragDrop: vi.fn(),
}));
vi.mock('../../src/i18n', () => ({ setLang: vi.fn() }));
vi.mock('../../src/state/agent-config-store', () => ({
  notifyAgentConfigChanged: (...args: unknown[]) => mockConfigChanged(...args),
}));
vi.mock('../../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));

import { SettingsPanel } from '../../src/plugins/builtin/settings-domain/SettingsPanel';
import { loadSettings, saveSettings } from '../../src/settings';

const STORAGE_KEY = 'hologram_settings';
const tick = () => new Promise((r) => setTimeout(r, 50));

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickTab(label: string): void {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('.sp-tab')].find((b) => b.textContent?.includes(label));
  tab?.click();
}

describe('SettingsPanel — 保存拆域', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    mockInvoke.mockReset();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('null');
    mockConfigChanged.mockReset();
    localStorage.clear();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(createElement(SettingsPanel));
    await tick();
  });

  afterEach(() => {
    root?.unmount();
  });

  it('Provider tab 隐藏全局保存按钮，编辑后出现独立保存条', async () => {
    expect(document.querySelector('.sp-footer .sp-btn-save')).toBeNull();

    const urlInput = [...document.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    )!;
    setInputValue(urlInput, 'https://custom.example/v1');
    await tick();

    expect(document.querySelector('.pp-save-bar')).not.toBeNull();
    expect(document.querySelector('.sp-footer .sp-btn-save')).toBeNull();
  });

  it('保存 Provider：落盘 + 重建 Agent + 保存条消失', async () => {
    const urlInput = [...document.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    )!;
    setInputValue(urlInput, 'https://custom.example/v1');
    await tick();

    document.querySelector<HTMLButtonElement>('.pp-save-btn')!.click();
    await tick();

    expect(document.querySelector('.pp-save-bar')).toBeNull();
    // ⚡ 2026-09-24 配方改文件批 + 2026-09-23 真机事故回归：provider 的**意图**
    // （baseUrl 等）权威在 `~/.lantai/providers.yml`；但本用例里 RPC mock 回 'null'
    // ⇒ 文件通道**未确认可用** ⇒ 意图**必须原样留在本机**（那是用户唯一的配置
    // 来源——剥掉就等于「配好的 provider 凭空消失」）。
    // 文件确认接管之后才剥，那条契约在 tests/providers-store.test.ts 里钉。
    // 「保存了没」的判据 = 保存条消失 + settings-saved 广播（下面两条）。
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.providers.find((p: any) => p.name === 'deepseek').baseUrl).toBe('https://custom.example/v1');
    expect(mockConfigChanged).toHaveBeenCalledTimes(1);
    expect(mockConfigChanged).toHaveBeenCalledWith('settings-saved');
  });

  it('Provider dirty 不点亮全局保存；Provider 保存后全局保存仍禁用', async () => {
    const urlInput = [...document.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    )!;
    setInputValue(urlInput, 'https://custom.example/v1');
    await tick();

    clickTab('Agent');
    await tick();
    const globalSave = document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!;
    expect(globalSave).not.toBeNull();
    expect(globalSave.disabled).toBe(true); // 全局 dirty 未亮

    clickTab('Provider');
    await tick();
    expect(document.querySelector('.pp-save-bar')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.pp-save-btn')!.click();
    await tick();
    expect(document.querySelector('.pp-save-bar')).toBeNull();

    clickTab('Agent');
    await tick();
    expect(document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!.disabled).toBe(true);
  });

  it('全局保存只由非 Provider tab 的 dirty 点亮，保存后两域一并复位', async () => {
    clickTab('Agent');
    await tick();
    const save = document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!;
    expect(save.disabled).toBe(true);

    // 模型参数区（全局上下文窗口/深度思考）与图谱引擎开关均已拆除（图谱功能
    // 全量退役，2026-09-09）——改用「关于」页的启动时自动检查更新开关触发非
    // Provider tab 的 dirty（同一 commit → markDirty 路径）。
    clickTab('关于');
    await tick();
    const autoUpdateToggle = [...document.querySelectorAll<HTMLInputElement>('.sp-checkbox-label input')].find((i) =>
      i.closest('.sp-section')?.textContent?.includes('启动时自动检查更新'),
    )!;
    autoUpdateToggle.click();
    await tick();
    expect(save.disabled).toBe(false);

    save.click();
    await tick();
    expect(save.disabled).toBe(true);
    expect(mockConfigChanged).toHaveBeenCalledTimes(1);
    expect(mockConfigChanged).toHaveBeenCalledWith('settings-saved');
  });

  it('F3：全局保存不覆盖期间由预设选择器改过的 composition.preset', async () => {
    // 1) 预设选择器把选择落盘（= selectPreset 的写盘效果；此处直写盘面，
    //    免得为一条保存管道回归去架工具通道腰——本用例的对象是保存管道）
    saveSettings({ ...loadSettings(), composition: { preset: 'minimal' } });
    // 2) 面板是在此之前挂载的（挂载期快照里仍是 standard）→ 触发一次全局保存
    clickTab('关于');
    await tick();
    const autoUpdateToggle = [...document.querySelectorAll<HTMLInputElement>('.sp-checkbox-label input')].find((i) =>
      i.closest('.sp-section')?.textContent?.includes('启动时自动检查更新'),
    )!;
    autoUpdateToggle.click();
    await tick();
    document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!.click();
    await tick();
    // 3) 选择不被回退（旧行为：整个挂载期快照写盘 → 静默回到 standard，重启即失效）
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).composition.preset).toBe('minimal');
  });

  /* ── 边缘滚动（2026-09-17 立为原生功能）：设置面板写面 ──
   * 行为真源在 paper-shell 插件域（策略读面见 tests/edge-scroll.test.ts）；
   * 本用例只考「面板写出的字段 = 读侧认得的字段」，含同节字段互不冲掉的回归。 */

  /** 画布区两枚开关（按**标签文本**定位——同节两枚 checkbox，按 section 文本会串台）。 */
  const toggleByLabel = (text: string): HTMLInputElement | null =>
    [...document.querySelectorAll<HTMLInputElement>('.sp-checkbox-label input')].find((i) =>
      i.closest('label')?.textContent?.includes(text),
    ) ?? null;
  const edgeToggle = (): HTMLInputElement => toggleByLabel('拖拽到边缘时自动滚屏')!;
  /** 悬停即滚档（总开关开着才出现）。 */
  const hoverToggle = (): HTMLInputElement | null => toggleByLabel('指针停在边缘也滚');
  const edgeRange = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('input[name="edgeScrollSensitivity"]');
  const edgeReadout = (): string | undefined =>
    edgeRange()?.closest('.sp-slider-row')?.querySelector('.sp-slider-end')?.textContent ?? undefined;
  const setSelectValue = (el: HTMLSelectElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const storedCanvas = (): {
    wheelMode?: string;
    edgeScroll?: { enabled: boolean; sensitivity: number; hover?: boolean };
  } => JSON.parse(localStorage.getItem(STORAGE_KEY)!).canvas;

  it('画布·边缘滚动：缺省全开（总开关 + 悬停）+ 基准 1.0x；调灵敏度/悬停/总开关都写进 canvas.edgeScroll', async () => {
    clickTab('显示');
    await tick();
    expect(edgeToggle().checked).toBe(true); // 旧存储无此字段 = 开（读侧容错口径）
    expect(edgeRange()).not.toBeNull();
    expect(edgeReadout()).toBe('1.0x');
    expect(hoverToggle()?.checked).toBe(true); // 悬停即滚缺省开（2026-09-17 翻案，见 edge-scroll.ts 注）

    setInputValue(edgeRange()!, '1.6');
    await tick();
    expect(edgeReadout()).toBe('1.6x');
    hoverToggle()!.click(); // 缺省开 → 显式关掉（考「关得掉且落盘」）
    await tick();
    expect(hoverToggle()?.checked).toBe(false);

    document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!.click();
    await tick();
    expect(storedCanvas().edgeScroll).toEqual({ enabled: true, sensitivity: 1.6, hover: false });

    // 关掉总开关：滑杆、悬停档与说明一并退场（开关本身仍在，供再次打开）
    edgeToggle().click();
    await tick();
    expect(edgeRange()).toBeNull();
    expect(hoverToggle()).toBeNull();
    document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!.click();
    await tick();
    expect(storedCanvas().edgeScroll).toEqual({ enabled: false, sensitivity: 1.6, hover: false });
  });

  it('画布·同节字段互不冲掉：改滚轮行为后 edgeScroll 仍在（展开 canvas 的连带修复）', async () => {
    // ⚠ 面板 state 是挂载期快照（F3 用例的对象）——故本用例全程走 UI 写入，
    //   不在挂载后直写盘面（那写的是盘的现值，面板看不见）。
    clickTab('显示');
    await tick();
    setInputValue(edgeRange()!, '1.5');
    await tick();
    document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!.click();
    await tick();
    expect(storedCanvas().edgeScroll).toEqual({ enabled: true, sensitivity: 1.5, hover: true });

    setSelectValue(document.querySelector<HTMLSelectElement>('#sp-canvas-wheel')!, 'zoom');
    await tick();
    document.querySelector<HTMLButtonElement>('.sp-footer .sp-btn-save')!.click();
    await tick();
    // 旧行为：滚轮行为整体替换 canvas → 刚存的 edgeScroll 被抹掉
    expect(storedCanvas().wheelMode).toBe('zoom');
    expect(storedCanvas().edgeScroll).toEqual({ enabled: true, sensitivity: 1.5, hover: true });
    expect(edgeReadout()).toBe('1.5x');
  });
});
