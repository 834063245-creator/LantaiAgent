// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 配方文档（2026-09-24 配方改文件批）——一份 YAML 统管所有 provider：
// 逐节校验（坏节只坏自己）/ 整份不可用不覆盖手稿 / 写盘保住手写注释与排版。

import { describe, expect, it } from 'vitest';
import {
  applyProvidersDoc,
  emptyProvidersDoc,
  FACTORY_PROTOCOLS,
  intentOf,
  isProvidersDocPath,
  mergeIntent,
  PROVIDER_NAME_RE,
  type ProviderIntent,
  parseProvidersDoc,
  parseSection,
  renderSection,
} from '../src/provider/providers-doc';
import { type ProviderSettings, providerId } from '../src/settings';

const intent: ProviderIntent = {
  kind: 'openai',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'claude-opus-4-6'],
  thinking: 'high',
  headers: { 'x-opencode-session': 'sess-1' },
  modelOverrides: { 'deepseek-flash': { contextWindow: 1000000, maxTokens: 384000 } },
};

const DOC = `# 兰台 provider 连接配置
# 手写注释必须留住
opencodego:
  kind: openai               # 协议
  baseUrl: https://opencode.ai/zen/go/v1
  model: deepseek-flash
  models:
    - deepseek-flash
  headers:
    x-opencode-session: sess-1

# 第二家
anthropic-official:
  kind: anthropic
  baseUrl: https://api.anthropic.com
  model: claude-opus-4-6
`;

describe('parseProvidersDoc', () => {
  it('空文本 = 空文档（合法，不是错误）', () => {
    const doc = parseProvidersDoc('');
    expect(doc.sections).toEqual([]);
    expect(doc.errors).toEqual([]);
    expect(doc.fatal).toBeUndefined();
  });

  it('逐节解析：注释/空行不影响，顺序 = 文件键序', () => {
    const doc = parseProvidersDoc(DOC);
    expect(doc.fatal).toBeUndefined();
    expect(doc.errors).toEqual([]);
    expect(doc.sections.map((s) => s.name)).toEqual(['opencodego', 'anthropic-official']);
    expect(doc.sections[0].intent).toEqual({
      kind: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: 'deepseek-flash',
      models: ['deepseek-flash'],
      headers: { 'x-opencode-session': 'sess-1' },
    });
    expect(doc.sections[1].intent.baseUrl).toBe('https://api.anthropic.com');
  });

  it('YAML 语法错 = fatal（整份不可用；调用方据此回落 + 拒绝覆盖手稿）', () => {
    const doc = parseProvidersDoc('a: [unclosed\n');
    expect(doc.fatal).toBeTruthy();
    expect(doc.sections).toEqual([]);
  });

  it('根不是映射 = fatal（文档形态是顶层键 = provider 名）', () => {
    expect(parseProvidersDoc('- a\n- b\n').fatal).toContain('映射');
    expect(parseProvidersDoc('just a string').fatal).toContain('映射');
  });

  it('坏节只坏自己：其余节照常生效（手写文件的迭代性）', () => {
    const doc = parseProvidersDoc(`${DOC}broken:\n  kind: openai\n  baseUrl: not-a-url\n`);
    expect(doc.sections.map((s) => s.name)).toEqual(['opencodego', 'anthropic-official']);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0].name).toBe('broken');
    expect(doc.errors[0].message).toContain('baseUrl');
  });

  it('节错误点名到字段（缺必填 / 未知字段 / 未知协议 / 非法档位）', () => {
    const doc = parseProvidersDoc(
      [
        'a:',
        '  baseUrl: https://x/v1',
        '  model: m',
        'b:',
        '  kind: openai',
        '  baseUrl: https://x/v1',
        '  model: m',
        '  junk: 1',
        'c:',
        '  kind: 不存在的协议',
        '  baseUrl: https://x/v1',
        '  model: m',
        'd:',
        '  kind: openai',
        '  baseUrl: https://x/v1',
        '  model: m',
        '  thinking: 超高',
      ].join('\n'),
    );
    const byName = Object.fromEntries(doc.errors.map((e) => [e.name, e.message]));
    expect(byName.a).toContain('缺少 kind');
    expect(byName.b).toContain('未知字段「junk」');
    expect(byName.c).toContain('没有对应的协议适配器');
    expect(byName.d).toContain('thinking');
  });

  // 密钥与运行态读数不属本文件（写进去就是明文落盘的误分享面）
  it('apiKey / lastTest / catalog 写进文件 = 点名报错（不静默丢弃）', () => {
    const doc = parseProvidersDoc(
      [
        'leaky:',
        '  kind: openai',
        '  baseUrl: https://x/v1',
        '  model: m',
        '  apiKey: sk-leaked',
        '  lastTest: { status: ok }',
        '  catalog: [m]',
      ].join('\n'),
    );
    expect(doc.sections).toEqual([]);
    const msg = doc.errors[0].message;
    expect(msg).toContain('apiKey');
    expect(msg).toContain('凭据库');
    expect(msg).toContain('lastTest');
    expect(msg).toContain('catalog');
  });

  it('provider 名围栏 + 大小写重复（本机文件名/凭据键不敏感）', () => {
    expect(
      parseProvidersDoc('bad name:\n  kind: openai\n  baseUrl: https://x/v1\n  model: m\n').errors[0].message,
    ).toContain('不合法');
    const dup = parseProvidersDoc(
      'A:\n  kind: openai\n  baseUrl: https://x/v1\n  model: m\na:\n  kind: openai\n  baseUrl: https://x/v1\n  model: m\n',
    );
    expect(dup.sections).toHaveLength(1);
    expect(dup.errors[0].message).toContain('重复');
  });

  it('已知协议集合可注入（ctx.llm adapter 贡献的开放协议）', () => {
    const text = 'x:\n  kind: my-proto\n  baseUrl: https://x/v1\n  model: m\n';
    expect(parseProvidersDoc(text).errors).toHaveLength(1);
    expect(parseProvidersDoc(text, { has: (k) => k === 'my-proto' }).errors).toEqual([]);
  });

  it('出厂协议集：内核两族 + 出厂 responses 方言', () => {
    expect(FACTORY_PROTOCOLS.has('openai')).toBe(true);
    expect(FACTORY_PROTOCOLS.has('anthropic')).toBe(true);
    expect(FACTORY_PROTOCOLS.has('responses')).toBe(true);
    expect(FACTORY_PROTOCOLS.has('nope')).toBe(false);
  });

  it('请求头非法条目点名报错（写入边界严格，沿 custom-headers 同一把尺子）', () => {
    const doc = parseProvidersDoc(
      'a:\n  kind: openai\n  baseUrl: https://x/v1\n  model: m\n  headers:\n    "bad name": v\n',
    );
    expect(doc.errors[0].message).toContain('bad name');
  });

  // 2026-09-24：请求头的校验边界从「localStorage 读取容忍毒化」搬到文件写入边界
  // ——文件是人手写的，写错必须点名（原 settings-provider-headers.test.ts 的
  // 毒化用例在此以**文件形态**重建：坏条目仍被点名，不再静默丢弃）。
  it('请求头：非字符串值 / 整体不是对象 / 值超长都点名报错（原毒化容忍用例的文件形态）', () => {
    const numeric = parseProvidersDoc(
      'a:\n  kind: openai\n  baseUrl: https://x/v1\n  model: m\n  headers:\n    x-num: 42\n',
    );
    expect(numeric.errors[0].message).toContain('x-num');
    const notObject = parseProvidersDoc('a:\n  kind: openai\n  baseUrl: https://x/v1\n  model: m\n  headers: oops\n');
    expect(notObject.errors[0].message).toContain('headers');
    const legal = parseProvidersDoc(
      'a:\n  kind: openai\n  baseUrl: https://x/v1\n  model: m\n  headers:\n    x-ok: v\n    x-empty: ""\n',
    );
    expect(legal.errors).toEqual([]);
    expect(legal.sections[0].intent.headers).toEqual({ 'x-ok': 'v', 'x-empty': '' });
  });

  it('modelOverrides.in 只认 text/image；thinking 只认 canonical 档位', () => {
    const bad = parseSection('a', {
      kind: 'openai',
      baseUrl: 'https://x/v1',
      model: 'm',
      modelOverrides: { m: { input: ['audio'] } },
    });
    expect('errors' in bad && bad.errors.join()).toContain('input');
    const ok = parseSection('a', {
      kind: 'openai',
      baseUrl: 'https://x/v1',
      model: 'm',
      modelOverrides: { m: { thinking: '', input: ['text', 'image'] } },
    });
    expect('intent' in ok && ok.intent.modelOverrides?.m.thinking).toBe('');
  });
});

describe('applyProvidersDoc', () => {
  it('首写：空文本建出骨架 + 节头注释', () => {
    const text = applyProvidersDoc('', { opencodego: intent });
    expect(text).toContain('opencodego:');
    expect(text).toContain('键名即 provider 身份');
    expect(parseProvidersDoc(text).sections[0].intent).toEqual(intent);
  });

  it('**保住手写注释与排版**：只动变更的叶子', () => {
    const next = applyProvidersDoc(DOC, {
      opencodego: { ...intent, baseUrl: 'https://new.example/v1' },
      'anthropic-official': parseProvidersDoc(DOC).sections[1].intent,
    });
    // 注释逐字活着（行内注释照样在；`yaml` 会把注释前的空白归一成单空格——
    // 与 DSH settings-file 记录的限制同款：阵列内的注释、改动标量的行内注释会随值走）
    expect(next).toContain('# 兰台 provider 连接配置');
    expect(next).toContain('# 手写注释必须留住');
    expect(next).toContain('kind: openai # 协议');
    expect(next).toContain('# 第二家');
    expect(next).toContain('baseUrl: https://new.example/v1');
    // 没被改的字段逐字保留（不是整份重新序列化）
    expect(next).toContain('baseUrl: https://api.anthropic.com');
    // 往返：改完再解析 = 新意图
    const back = parseProvidersDoc(next);
    expect(back.errors).toEqual([]);
    expect(back.sections[0].intent.baseUrl).toBe('https://new.example/v1');
  });

  it('已有手稿只补变更：文件头不会被再加一层（不重复注水）', () => {
    const once = applyProvidersDoc('', { a: intent });
    const twice = applyProvidersDoc(once, { a: intent, b: intent });
    expect(twice.match(/兰台 provider 连接配置/g)).toHaveLength(1);
  });

  it('补丁里没有的 provider = 从文件里删掉（UI 删行 = 删节）', () => {
    const next = applyProvidersDoc(DOC, { opencodego: intent });
    expect(next).not.toContain('anthropic-official');
    expect(parseProvidersDoc(next).sections.map((s) => s.name)).toEqual(['opencodego']);
  });

  it('补丁里没有的字段 = 从该节删掉（设置页清空请求头 = 文件里那节没了）', () => {
    const { headers: _h, thinking: _t, ...bare } = intent;
    const next = applyProvidersDoc(DOC, { opencodego: bare });
    const back = parseProvidersDoc(next);
    expect(back.errors).toEqual([]);
    expect(back.sections[0].intent.headers).toBeUndefined();
    expect(back.sections[0].intent.thinking).toBeUndefined();
    expect(back.sections[0].intent.models).toEqual(['deepseek-flash', 'claude-opus-4-6']);
  });

  it('非映射旧值（手写笔误）整节替换，不抛', () => {
    const next = applyProvidersDoc('a: 这不是映射\n', { a: intent });
    expect(parseProvidersDoc(next).sections[0].intent).toEqual(intent);
  });

  it('手稿解析不了 ⇒ 原样返回（写盘方据此拒绝覆盖）', () => {
    const broken = 'a: [unclosed\n';
    expect(applyProvidersDoc(broken, { a: intent })).toBe(broken);
  });

  it('序列整值替换（YAML 语义）+ modelMeta 空对象不写', () => {
    const next = applyProvidersDoc(DOC, {
      opencodego: { ...intent, models: ['only-one'], modelMeta: {} },
    });
    expect(next).toContain('- only-one');
    expect(next).not.toContain('- deepseek-flash\n  headers');
    expect(next).not.toContain('modelMeta');
  });

  it('emptyProvidersDoc：可被解析（空文档）+ 带格式说明头 + 写出密钥纪律', () => {
    const text = emptyProvidersDoc();
    expect(text).toContain('最小例子');
    const doc = parseProvidersDoc(text);
    expect(doc.fatal).toBeUndefined();
    expect(doc.sections).toEqual([]);
    // 文件头自己必须把「密钥不进这里」说清楚（那是这份文件最重要的一条规矩）
    expect(text).toContain('凭据库');
  });

  // 首启写骨架这一步：文件头 + 例子注释都要在——否则「文件能被人手写」这条
  // 就只剩一句口号（用户打开文件只看到一行 `{}`）
  it('首写落盘的文件自带格式说明头（人打开就知道能写什么）', () => {
    const text = applyProvidersDoc('', { opencodego: intent });
    expect(text).toContain('# 兰台 provider 连接配置');
    expect(text).toContain('# my-gateway:');
    expect(text).toContain('#   kind: openai');
    // 且立即自洽：写出去就能解析回同一份意图
    const back = parseProvidersDoc(text);
    expect(back.errors).toEqual([]);
    expect(back.sections[0].intent).toEqual(intent);
  });

  it('renderSection：单节片段可直接贴进文件（往返等价）', () => {
    const snippet = renderSection('opencodego', intent);
    const doc = parseProvidersDoc(snippet);
    expect(doc.errors).toEqual([]);
    expect(doc.sections[0]).toEqual({ name: 'opencodego', intent });
  });
});

describe('意图 ↔ 完整行', () => {
  it('intentOf 剥掉身份/密钥/运行态读数；mergeIntent 反向补齐', () => {
    const row: ProviderSettings = {
      ...intent,
      name: providerId('opencodego'),
      apiKey: 'sk-secret',
      lastTest: { status: 'ok', latencyMs: 1, at: 2 },
      catalog: ['deepseek-flash'],
    };
    const bare = intentOf(row);
    expect(bare).toEqual(intent);
    expect('apiKey' in bare).toBe(false);
    expect('lastTest' in bare).toBe(false);
    expect('catalog' in bare).toBe(false);
    expect('name' in bare).toBe(false);
    expect(mergeIntent(row.name, bare, { apiKey: row.apiKey, lastTest: row.lastTest, catalog: row.catalog })).toEqual(
      row,
    );
  });

  it('provider 名围栏与 AddProviderSheet 同一把尺子', () => {
    expect(PROVIDER_NAME_RE.test('my-gateway_1')).toBe(true);
    expect(PROVIDER_NAME_RE.test('中文名')).toBe(false);
    expect(PROVIDER_NAME_RE.test('has space')).toBe(false);
  });

  it('isProvidersDocPath：只认 .yml / .yaml', () => {
    expect(isProvidersDocPath('C:/Users/x/.lantai/providers.yml')).toBe(true);
    expect(isProvidersDocPath('C:/Users/x/.lantai/providers.yaml')).toBe(true);
    expect(isProvidersDocPath('C:/Users/x/.lantai/providers.json')).toBe(false);
  });
});
