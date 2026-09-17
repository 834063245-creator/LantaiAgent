// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 自动更新检测机制测试（启动检查 + 角标 + 开关）：
//   1. update-store 状态机：检查中/有更新/无更新/失败；角标点亮-熄灭-换版本再亮；
//   2. downloadAndInstall 全流程（重查 → 进度 → 完成）；
//   3. 壳行 bootUpdateCheck：开关关 = 不检查；开关开 = 延迟后触发一次检查；
//   4. settings.updates.autoCheck 容错读取（旧存储无此节 = 开）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── mock @tauri-apps/plugin-updater：check() 返回值由各用例编排 ──
let mockCheck: () => Promise<MockUpdate | null> = async () => null;
let mockInstallEvents: Array<{ event: string }> = [];

class MockUpdate {
  version: string;
  constructor(version: string) {
    this.version = version;
  }
  async downloadAndInstall(onEvent?: (ev: { event: string }) => void) {
    for (const ev of mockInstallEvents) onEvent?.(ev);
  }
}

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: () => mockCheck(),
}));

import { useUpdateStore } from '../src/state/update-store';

/** 每用例重置 store 初态与 mock 行为。 */
function resetStore() {
  useUpdateStore.setState({
    status: 'idle',
    version: null,
    message: '',
    badgeDismissed: false,
  });
  mockCheck = async () => null;
  mockInstallEvents = [];
}

/** 角标可见性派生（SessionsHome/PaperPanel 消费同一表达式）。 */
const badgeVisible = () => {
  const s = useUpdateStore.getState();
  return s.status === 'available' && !s.badgeDismissed;
};

describe('update-store 状态机', () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('检查 → 有新版本：available + 版本号 + 角标亮', async () => {
    mockCheck = async () => new MockUpdate('10.5.0');
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    const s = useUpdateStore.getState();
    expect(s.status).toBe('available');
    expect(s.version).toBe('10.5.0');
    expect(s.message).toContain('10.5.0');
    expect(badgeVisible()).toBe(true);
  });

  it('检查 → 已是最新：done + 无角标', async () => {
    mockCheck = async () => null;
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    const s = useUpdateStore.getState();
    expect(s.status).toBe('done');
    expect(s.message).toBe('已是最新版本');
    expect(badgeVisible()).toBe(false);
  });

  it('自动检查失败：error 态 + console.warn 留痕 + 角标不亮', async () => {
    mockCheck = async () => {
      throw new Error('network down');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useUpdateStore.getState().checkForUpdates(); // manual 缺省 false
    const s = useUpdateStore.getState();
    expect(s.status).toBe('error');
    expect(s.message).toContain('network down');
    expect(badgeVisible()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('[update] 启动自动检查失败:', expect.stringContaining('network down'));
  });

  it('手动检查失败：error 态 + 不额外 console.warn', async () => {
    mockCheck = async () => {
      throw new Error('offline');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    expect(useUpdateStore.getState().status).toBe('error');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('角标语义：markBadgeSeen 熄灭 → 同版本重查保持熄灭 → 新版本重新亮起', async () => {
    mockCheck = async () => new MockUpdate('10.5.0');
    await useUpdateStore.getState().checkForUpdates();
    expect(badgeVisible()).toBe(true);
    // 打开设置面板 = 用户已看（SettingsPanel mount 调 markBadgeSeen）
    useUpdateStore.getState().markBadgeSeen();
    expect(badgeVisible()).toBe(false);
    // 同版本重查（手动）：已看过 → 不再打扰
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    expect(useUpdateStore.getState().version).toBe('10.5.0');
    expect(badgeVisible()).toBe(false);
    // 新版本出现 → 重新点亮
    mockCheck = async () => new MockUpdate('10.6.0');
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    expect(useUpdateStore.getState().version).toBe('10.6.0');
    expect(badgeVisible()).toBe(true);
  });

  it('downloadAndInstall：重查拿句柄 → 进度回调 → done', async () => {
    mockCheck = async () => new MockUpdate('10.5.0');
    mockInstallEvents = [{ event: 'Started' }, { event: 'Finished' }];
    await useUpdateStore.getState().downloadAndInstall();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('done');
    expect(s.message).toBe('下载完成，下次启动生效');
  });

  it('downloadAndInstall：重查无更新 → error（更新信息已过期）', async () => {
    mockCheck = async () => null;
    await useUpdateStore.getState().downloadAndInstall();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('error');
    expect(s.message).toBe('更新信息已过期');
  });
});

describe('壳行 bootUpdateCheck（shell/rows/update-check.ts）', () => {
  beforeEach(() => {
    vi.resetModules();
    resetStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开关开：延迟后触发一次自动检查（fake timers）', async () => {
    vi.useFakeTimers();
    let checkCalls = 0;
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ updates: { autoCheck: true } }),
      autoUpdateCheckEnabled: () => true,
    }));
    vi.doMock('../src/state/update-store', () => ({
      useUpdateStore: {
        getState: () => ({
          checkForUpdates: () => {
            checkCalls += 1;
            return Promise.resolve();
          },
        }),
      },
    }));
    const { bootUpdateCheck } = await import('../src/shell/rows/update-check');
    bootUpdateCheck();
    expect(checkCalls).toBe(0); // boot 立即返回（不阻塞引导序）
    await vi.advanceTimersByTimeAsync(8000);
    expect(checkCalls).toBe(1); // 8s 延迟让位冷启动
  });

  it('开关关（settings.updates.autoCheck=false）：不检查', async () => {
    vi.useFakeTimers();
    let checkCalls = 0;
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ updates: { autoCheck: false } }),
      autoUpdateCheckEnabled: () => false,
    }));
    vi.doMock('../src/state/update-store', () => ({
      useUpdateStore: {
        getState: () => ({
          checkForUpdates: () => {
            checkCalls += 1;
            return Promise.resolve();
          },
        }),
      },
    }));
    const { bootUpdateCheck } = await import('../src/shell/rows/update-check');
    bootUpdateCheck();
    await vi.advanceTimersByTimeAsync(60000);
    expect(checkCalls).toBe(0);
  });
});

describe('settings.updates.autoCheck 容错读取', () => {
  beforeEach(() => {
    vi.resetModules();
    // 前组 doMock('../src/settings') 残留会劫持本组动态 import——显式解除
    vi.doUnmock('../src/settings');
  });

  it('旧存储无此节 = 开（缺省 true）', async () => {
    const { autoUpdateCheckEnabled } = await import('../src/settings');
    expect(autoUpdateCheckEnabled({} as never)).toBe(true);
    expect(autoUpdateCheckEnabled({ updates: {} } as never)).toBe(true);
    expect(autoUpdateCheckEnabled({ updates: { autoCheck: true } } as never)).toBe(true);
    expect(autoUpdateCheckEnabled({ updates: { autoCheck: false } } as never)).toBe(false);
  });
});
