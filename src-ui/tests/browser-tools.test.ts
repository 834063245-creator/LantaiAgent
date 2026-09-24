import { describe, expect, it, vi } from 'vitest';

// browser 模型族已迁 browser_cap 能力口直呼（R4-2，kernel-capability-d4-handle-
// design.md：builtin.browser 信封退役）——mock typedRpc 捕获直呼路由，其余
// 导出（ToolRegistry 等）保留真实实现
vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  return { ...actual, typedRpc: vi.fn(async () => '{"ok":true}') };
});

import { ToolRegistry } from '../src/agent/tool';
import { createBrowserTools, parseBrowserError } from '../src/plugins/builtin/browser-desktop-domain/browser';
import { convergeRegistry } from '../src/agent/tools/domains';
import { typedRpc } from '../src/rpc-contract';

function buildBrowserRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createBrowserTools()) registry.register(t);
  convergeRegistry(registry);
  return registry;
}

const rpcMock = typedRpc as unknown as ReturnType<typeof vi.fn>;

describe('browser 领域工具注册', () => {
  it('领域工具 browser 可见，细粒度 browser_* 被隐藏', () => {
    const registry = buildBrowserRegistry();
    const visible = registry.schemas().map((s) => s.name);
    expect(visible).toContain('browser');
    expect(visible).not.toContain('browser_inspect');
    expect(visible).not.toContain('browser_launch');
    // 隐藏但可解析（领域工具委托）
    expect(registry.get('browser_inspect')).toBeDefined();
  });

  it('browser 领域 action 覆盖 P1/P2 全清单', () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    const actions = t.actions?.() ?? [];
    for (const a of [
      'launch',
      'kill',
      'sessions',
      'switch_session',
      'targets',
      'attach',
      'new_tab',
      'close_tab',
      'navigate',
      'back',
      'forward',
      'reload',
      'snapshot',
      'content',
      'inspect',
      'report',
      'console',
      'network',
      'network_detail',
      'network_har',
      'screenshot',
      'audit',
      'cookies',
      'click',
      'hover',
      'type',
      'select',
      'upload',
      'dialog',
      'press',
      'scroll',
      'viewport',
      'eval',
      'status',
      'wait',
    ]) {
      expect(actions).toContain(a);
    }
  });

  it('wait 路由到 browser_wait 并透传 selector/ms', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'wait', selector: '#done', ms: 5000 });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_wait', is_agent: true, selector: '#done', ms: 5000 }),
    );
  });

  it('未知 action 返回错误提示', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    const result = await t.execute({ action: 'fly_to_moon' });
    expect(result).toContain('unsupported action');
  });

  it('领域 schema 含 target 判别 + targetId（语义分离）', () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    const schema = t.parameters() as Record<string, any>;
    const props = schema.properties ?? {};
    // target 是 self/外部判别，不是 attach 的目标
    expect(props.target).toBeDefined();
    expect(String(props.target.description)).toContain('self');
    // attach 用 targetId（CDP target id），与 target 判别分离
    expect(props.targetId).toBeDefined();
    expect(String(props.targetId.description)).toContain('CDP target id');
  });
});

describe('browser 动作路由（统一走 Rust CDP）', () => {
  it('snapshot 路由到 browser_snapshot 并透传参数', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'snapshot', scope: '#main', maxResults: 50 });
    // 工具面 maxResults（camelCase）由 browserCapCall 顶层映射为口键 max_results
    // （BROWSER_CAP_SNAKE_KEYS——bridge.rpc() 转换不再承担工具参数翻译）
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_snapshot', scope: '#main', max_results: 50 }),
    );
  });

  it('self=true 透传 self 标记（webview 只读会话由 Rust 路由）', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'inspect', target: 'self', selector: '.card' });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_inspect', target: 'self', selector: '.card' }),
    );
  });

  it('console/network/screenshot/audit 路由到对应 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'console', limit: 10 });
    await t.execute({ action: 'network', limit: 5 });
    await t.execute({ action: 'network_detail', requestId: 'r1' });
    await t.execute({ action: 'network_har', limit: 50 });
    await t.execute({ action: 'screenshot' });
    await t.execute({ action: 'audit', limit: 20 });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_console', limit: 10 }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_network', limit: 5 }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_network_detail', request_id: 'r1' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_network_har', limit: 50 }),
    );
    expect(rpcMock).toHaveBeenCalledWith('browser_cap', expect.objectContaining({ action: 'browser_screenshot' }));
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_audit', limit: 20 }),
    );
  });

  it('click/type 路由并透传 selector（支持 ref 编号）', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'click', selector: '37' });
    await t.execute({ action: 'type', selector: '12', text: 'hello', replace: true });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_click', selector: '37' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_type', selector: '12', text: 'hello', replace: true }),
    );
  });

  it('navigate/content/select 路由到新增 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'navigate', url: 'https://example.com' });
    await t.execute({ action: 'content', scope: '#main', format: 'markdown', maxChars: 2000 });
    await t.execute({ action: 'select', selector: '42', value: 'option-a' });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_navigate', url: 'https://example.com' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_content', scope: '#main', format: 'markdown', max_chars: 2000 }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_select', selector: '42', value: 'option-a' }),
    );
  });

  it('profile/proxy 与 sessions/switch_session/cookies 路由到第五批 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'launch', profile: 'work', proxy: 'socks5://127.0.0.1:1080', proxyBypass: 'localhost' });
    await t.execute({ action: 'connect', port: 9223, session: 'work' });
    await t.execute({ action: 'sessions' });
    await t.execute({ action: 'switch_session', session: 'personal' });
    await t.execute({ action: 'cookies', op: 'list', urls: ['https://example.com'] });
    await t.execute({ action: 'cookies', op: 'set', name: 'sid', value: 'x', domain: '.example.com' });
    await t.execute({ action: 'cookies', op: 'delete', name: 'sid', url: 'https://example.com' });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({
        action: 'browser_launch',
        profile: 'work',
        proxy: 'socks5://127.0.0.1:1080',
        proxy_bypass: 'localhost',
      }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_connect', port: 9223, session: 'work' }),
    );
    expect(rpcMock).toHaveBeenCalledWith('browser_cap', expect.objectContaining({ action: 'browser_sessions' }));
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_switch_session', session: 'personal' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_cookies', op: 'list', urls: ['https://example.com'] }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({
        action: 'browser_cookies',
        op: 'set',
        name: 'sid',
        value: 'x',
        domain: '.example.com',
      }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_cookies', op: 'delete', name: 'sid', url: 'https://example.com' }),
    );
  });

  it('launch headless/windowSize 与 network_detail 路由到新增 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'launch', headless: true, windowSize: { width: 800, height: 600 } });
    await t.execute({ action: 'network_detail', requestId: 'r-1' });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_launch', headless: true, window_size: { width: 800, height: 600 } }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_network_detail', request_id: 'r-1' }),
    );
  });

  it('viewport 路由到 browser_viewport 并透传 DPR/mobile', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'viewport', width: 800, height: 600, deviceScaleFactor: 2, mobile: true });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({
        action: 'browser_viewport',
        width: 800,
        height: 600,
        device_scale_factor: 2,
        mobile: true,
      }),
    );
  });

  it('tab/dialog/upload/hover/组合键/截图参数路由到新增 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'new_tab', url: 'https://example.com' });
    await t.execute({ action: 'close_tab', targetId: 'tab-1' });
    await t.execute({ action: 'hover', selector: '17' });
    await t.execute({ action: 'dialog', accept: true, promptText: 'ok' });
    await t.execute({ action: 'upload', files: ['C:/tmp/a.txt'], selector: '#file' });
    await t.execute({ action: 'press', key: 'a', modifiers: ['ctrl'] });
    await t.execute({ action: 'screenshot', fullPage: true });
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_new_tab', url: 'https://example.com' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_close_tab', target_id: 'tab-1' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_hover', selector: '17' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_dialog', accept: true, prompt_text: 'ok' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_upload', files: ['C:/tmp/a.txt'], selector: '#file' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_press', key: 'a', modifiers: ['ctrl'] }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_screenshot', full_page: true }),
    );
  });
});

describe('结构化错误 code（2026-08-15 收口）', () => {
  it('parseBrowserError 解析 [CODE] 前缀，无前缀返回 null', () => {
    const parsed = parseBrowserError(
      '[CDP_REF_STALE] 目标不存在或已失效（37）——页面可能已变化，请重新 browser(snapshot)',
    );
    expect(parsed).toEqual({
      code: 'CDP_REF_STALE',
      message: '目标不存在或已失效（37）——页面可能已变化，请重新 browser(snapshot)',
    });
    expect(parseBrowserError('普通权限错误文案')).toBeNull();
    expect(parseBrowserError('')).toBeNull();
  });

  it('Rust 错误经领域工具透传时 code 保留、模型可读', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    rpcMock.mockRejectedValueOnce(
      new Error('[CDP_REF_STALE] 目标不存在或已失效（37）——页面可能已变化，请重新 browser(snapshot)'),
    );
    const result = await t.execute({ action: 'click', selector: '37' });
    expect(result).toContain('[browser] click 失败 [CDP_REF_STALE]:');
    expect(result).toContain('请重新 browser(snapshot)');
    // 无 code 的旧错误回退原文（不丢信息）
    rpcMock.mockRejectedValueOnce(new Error('legacy error'));
    const result2 = await t.execute({ action: 'click', selector: '37' });
    expect(result2).toBe('[browser] click 失败: legacy error');
  });
});
