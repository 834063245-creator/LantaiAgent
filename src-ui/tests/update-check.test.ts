// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 自动更新机制测试（启动检查 + 角标 + 开关 + 可见性状态机）：
//   1. update-store 状态机：检查中/有更新/已是最新/失败；角标点亮-熄灭-换版本再亮；
//   2. 检查拿到的新版本面（info / source：版本号 / 发布时间 / 更新说明 / 下载来源直链）；
//   3. startDownload：进度累积（有 / 无 Content-Length 两条路径）、失败分阶段、句柄释放；
//   4. installDownloaded：下载与安装分离（finished 后停在"待安装"，用户点安装才装）；
//   5. 壳行 bootUpdateCheck：开关关 = 不检查；开关开 = 延迟后触发一次检查；
//   6. settings.updates.autoCheck 容错读取（旧存储无此节 = 开）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── mock @tauri-apps/plugin-updater：check() 返回值由各用例编排 ──
type MockEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/** 平台条目顺序刻意「无后缀 → nsis → msi」：断言展示面按 NSIS 优先取直链。 */
const RAW_JSON: Record<string, unknown> = {
  version: '1.1.0',
  pub_date: '2026-09-25T14:12:07Z',
  platforms: {
    'windows-x86_64': {
      signature: 'sig-plain',
      url: 'https://api.github.com/repos/o/r/releases/assets/1',
    },
    'windows-x86_64-nsis': {
      signature: 'sig-nsis',
      url: 'https://api.github.com/repos/o/r/releases/assets/2',
    },
    'windows-x86_64-msi': {
      signature: 'sig-msi',
      url: 'https://api.github.com/repos/o/r/releases/assets/3',
    },
  },
};

let mockCheck: () => Promise<MockUpdate | null> = async () => null;

class MockUpdate {
  version: string;
  currentVersion = '1.0.3';
  date = '2026-09-25T14:12:07Z';
  body = '# Changelog\n\n- 修了个 bug';
  rawJson: Record<string, unknown>;
  /** 编排：download 依次回放的事件与可选失败 */
  events: MockEvent[] = [];
  downloadError: Error | null = null;
  installError: Error | null = null;
  installed = false;
  closed = false;

  constructor(version: string, rawJson: Record<string, unknown> = RAW_JSON) {
    this.version = version;
    this.rawJson = rawJson;
  }

  async download(onEvent?: (ev: MockEvent) => void) {
    for (const ev of this.events) onEvent?.(ev);
    if (this.downloadError) throw this.downloadError;
  }

  async install() {
    if (this.installError) throw this.installError;
    this.installed = true;
  }

  async close() {
    this.closed = true;
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
    info: null,
    source: null,
    progress: null,
    errorStage: null,
    pending: null,
  });
  mockCheck = async () => null;
}

/** 等一轮微任务（closeQuietly 是 fire-and-forget，断言前要让它落地）。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

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

  it('检查 → 有新版本：available + 版本面（版本号 / 发布时间 / 说明 / 来源直链）+ 角标亮', async () => {
    mockCheck = async () => new MockUpdate('1.1.0');
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    const s = useUpdateStore.getState();
    expect(s.status).toBe('available');
    expect(s.version).toBe('1.1.0');
    expect(s.message).toContain('1.1.0');
    expect(badgeVisible()).toBe(true);
    expect(s.info?.currentVersion).toBe('1.0.3');
    expect(s.info?.date).toBe('2026-09-25T14:12:07Z');
    expect(s.info?.notes).toContain('Changelog');
    // 来源：NSIS 条目优先（本机实际走 NSIS 通道），带签名
    expect(s.source?.url).toContain('/releases/assets/2');
    expect(s.source?.host).toBe('api.github.com');
    expect(s.source?.signed).toBe(true);
  });

  it('检查 → 已是最新：up-to-date + 无角标（不再是含糊的 done）', async () => {
    mockCheck = async () => null;
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    const s = useUpdateStore.getState();
    expect(s.status).toBe('up-to-date');
    expect(s.message).toBe('已是最新版本');
    expect(s.info).toBeNull();
    expect(badgeVisible()).toBe(false);
  });

  it('来源面：清单里没有 url / 坏 url 时降级为未知，不抛', async () => {
    mockCheck = async () => new MockUpdate('1.1.0', { platforms: { 'windows-x86_64-nsis': {} } });
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    expect(useUpdateStore.getState().source).toEqual({ url: null, host: null, signed: false });

    mockCheck = async () => new MockUpdate('1.1.0', { platforms: { 'windows-x86_64-nsis': { url: 'not a url' } } });
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    const s = useUpdateStore.getState();
    expect(s.source?.url).toBe('not a url');
    expect(s.source?.host).toBeNull();
  });

  it('自动检查失败：error（阶段=check）+ console.warn 留痕 + 角标不亮', async () => {
    mockCheck = async () => {
      throw new Error('network down');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useUpdateStore.getState().checkForUpdates(); // manual 缺省 false
    const s = useUpdateStore.getState();
    expect(s.status).toBe('error');
    expect(s.errorStage).toBe('check');
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
    mockCheck = async () => new MockUpdate('1.1.0');
    await useUpdateStore.getState().checkForUpdates();
    expect(badgeVisible()).toBe(true);
    // 打开设置面板 = 用户已看（SettingsPanel mount 调 markBadgeSeen）
    useUpdateStore.getState().markBadgeSeen();
    expect(badgeVisible()).toBe(false);
    // 同版本重查（手动）：已看过 → 不再打扰
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    expect(useUpdateStore.getState().version).toBe('1.1.0');
    expect(badgeVisible()).toBe(false);
    // 新版本出现 → 重新点亮
    mockCheck = async () => new MockUpdate('1.2.0');
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    expect(useUpdateStore.getState().version).toBe('1.2.0');
    expect(badgeVisible()).toBe(true);
  });

  it('重查换句柄：旧句柄被释放（Rust 资源表不泄漏）', async () => {
    const first = new MockUpdate('1.1.0');
    mockCheck = async () => first;
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    expect(useUpdateStore.getState().pending).toBe(first);

    const second = new MockUpdate('1.1.0');
    mockCheck = async () => second;
    await useUpdateStore.getState().checkForUpdates({ manual: true });
    await flush();

    expect(useUpdateStore.getState().pending).toBe(second);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });
});

describe('update-store 下载 / 安装分离', () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('startDownload：进度累积（有 Content-Length）→ 停在待安装，不自动装', async () => {
    const update = new MockUpdate('1.1.0');
    update.events = [
      { event: 'Started', data: { contentLength: 1000 } },
      { event: 'Progress', data: { chunkLength: 400 } },
      { event: 'Progress', data: { chunkLength: 600 } },
      { event: 'Finished' },
    ];
    mockCheck = async () => update;

    await useUpdateStore.getState().startDownload();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('downloaded');
    expect(update.installed).toBe(false); // 用户没点安装 ⇒ 不许装
    expect(s.progress?.totalBytes).toBe(1000);
    expect(s.progress?.downloadedBytes).toBe(1000);
    expect(s.progress?.percent).toBe(100);
  });

  it('startDownload：服务端不给 Content-Length → percent 保持 null（不知道总量就不假装知道）', async () => {
    const update = new MockUpdate('1.1.0');
    update.events = [
      { event: 'Started', data: {} },
      { event: 'Progress', data: { chunkLength: 300 } },
      { event: 'Progress', data: { chunkLength: 200 } },
      { event: 'Finished' },
    ];
    mockCheck = async () => update;

    await useUpdateStore.getState().startDownload();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('downloaded');
    expect(s.progress?.totalBytes).toBeNull();
    expect(s.progress?.percent).toBeNull();
    expect(s.progress?.downloadedBytes).toBe(500);
  });

  it('startDownload：重查无更新 → error（阶段=download，句柄清空）', async () => {
    mockCheck = async () => null;
    await useUpdateStore.getState().startDownload();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('error');
    expect(s.errorStage).toBe('download');
    expect(s.message).toContain('更新信息已过期');
    expect(s.pending).toBeNull();
  });

  it('startDownload：中断失败 → error（阶段=download）且已下载读数保留（面板据此说清续传限制）', async () => {
    const update = new MockUpdate('1.1.0');
    update.events = [
      { event: 'Started', data: { contentLength: 1000 } },
      { event: 'Progress', data: { chunkLength: 512 } },
    ];
    update.downloadError = new Error('connection reset');
    mockCheck = async () => update;

    await useUpdateStore.getState().startDownload();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('error');
    expect(s.errorStage).toBe('download');
    expect(s.message).toContain('connection reset');
    expect(s.progress?.downloadedBytes).toBe(512);
    expect(s.pending).toBe(update); // 句柄留着：重试可复用（虽仍需整包重下）
  });

  it('installDownloaded：拉起安装程序 → done；失败 → error（阶段=install，已下载读数与句柄保留）', async () => {
    const update = new MockUpdate('1.1.0');
    update.events = [{ event: 'Started', data: { contentLength: 10 } }, { event: 'Finished' }];
    mockCheck = async () => update;
    await useUpdateStore.getState().startDownload();

    update.installError = new Error('installer blocked');
    await useUpdateStore.getState().installDownloaded();
    let s = useUpdateStore.getState();
    expect(s.status).toBe('error');
    expect(s.errorStage).toBe('install');
    expect(s.message).toContain('installer blocked');
    expect(s.pending).toBe(update);
    expect(s.progress?.downloadedBytes).toBe(0);

    update.installError = null;
    await useUpdateStore.getState().installDownloaded();
    s = useUpdateStore.getState();
    expect(update.installed).toBe(true);
    expect(s.status).toBe('done');
  });

  it('installDownloaded：句柄已失效 → error（阶段=install），不静默', async () => {
    await useUpdateStore.getState().installDownloaded();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('error');
    expect(s.errorStage).toBe('install');
    expect(s.message).toContain('句柄已失效');
  });
});

describe('壳行 bootUpdateCheck（§4-9 起随 settings-domain 包：settings-domain/update-check.ts）', () => {
  beforeEach(() => {
    vi.resetModules();
    resetStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开关开：延迟后触发一次自动检查（fake timers）', async () => {
    let checkCalls = 0;
    // 部分 mock：随包后 update-check 经包内 ./host 取值，而该桥会连带取用 settings 的多个
    // 真实出口（PROVIDER_PROTOCOL_DEFAULTS 等）⇒ 只覆盖这两函数、其余保留真身。
    // 随包后本单元只经包内宿主桥取 settings / 更新台账两个面 ⇒ 直接 mock 桥
    // （mock 内核路径会让桥的其余取用面连带进来，重且易卡）。
    vi.doMock('../src/plugins/builtin/settings-domain/host', () => ({
      loadSettings: () => ({ updates: { autoCheck: true } }),
      autoUpdateCheckEnabled: () => true,
      useUpdateStore: {
        getState: () => ({
          checkForUpdates: () => {
            checkCalls += 1;
            return Promise.resolve();
          },
        }),
      },
    }));
    const { bootUpdateCheck } = await import('../src/plugins/builtin/settings-domain/update-check');
    // 随包后 import 链更重（经包内 ./host）——fake timers 必须在 import 之后开，否则 import 卡死
    vi.useFakeTimers();
    bootUpdateCheck();
    expect(checkCalls).toBe(0); // boot 立即返回（不阻塞引导序）
    await vi.advanceTimersByTimeAsync(8000);
    expect(checkCalls).toBe(1); // 8s 延迟让位冷启动
  });

  it('开关关（settings.updates.autoCheck=false）：不检查', async () => {
    let checkCalls = 0;
    // 部分 mock：随 update-check 经包内 ./host 取值，而该桥会连带取用 settings 的多个
    // 真实出口（PROVIDER_PROTOCOL_DEFAULTS 等）⇒ 只覆盖这两函数、其余保留真身。
    vi.doMock('../src/plugins/builtin/settings-domain/host', () => ({
      loadSettings: () => ({ updates: { autoCheck: false } }),
      autoUpdateCheckEnabled: () => false,
      useUpdateStore: {
        getState: () => ({
          checkForUpdates: () => {
            checkCalls += 1;
            return Promise.resolve();
          },
        }),
      },
    }));
    const { bootUpdateCheck } = await import('../src/plugins/builtin/settings-domain/update-check');
    // 随包后 import 链更重（经包内 ./host）——fake timers 必须在 import 之后开，否则 import 卡死
    vi.useFakeTimers();
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
