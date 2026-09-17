// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 自定义请求头（连接怪癖的用户可编辑面，2026-09-17）——
// provider 层的新增轴：协议（kind）/ 登录方式（authMode）之外的**请求附加头**。
// 动机：网关怪癖（如 OpenCode GO 强制 x-opencode-session）此前只能靠改代码发版，
// 用户拿到 exe 无路可走；本模块把该面收敛为 ProviderSettings.headers 的可编辑数据。
//
// 纪律（project-constitution 四条）：
//   - 类型边界：写入边界（设置页输入 / 配方导入）校验，加载边界（localStorage）
//     容忍毒化数据——坏条目丢弃 + warn，绝不整份设置崩（同 INVARIANTS #11）。
//   - 单一权威源：apiKey 权威在 credentials.enc；自定义头不得承载凭据覆写——
//     合并序固定「自定义头在前、内核必需头与凭据头在后」（三方言同名处一律内核胜）。
//   - 错误不静默：非法头名/值绝不静默丢弃（编辑面显示原因、导入面整单拒绝）。

/** 自定义请求头条目上限（毒化护栏：localStorage 读取边界同用）。 */
export const MAX_CUSTOM_HEADERS = 32;
/** 单个请求头名长度上限。 */
export const MAX_HEADER_NAME_LENGTH = 128;
/** 单个请求头值长度上限（字节量的宽松代理，与凭据库 4096 护栏同量级）。 */
export const MAX_HEADER_VALUE_LENGTH = 4096;

/** 一行待校验的自定义头（编辑面/导入面的共同形状）。 */
export interface HeaderEntry {
  name: string;
  value: string;
}

/**
 * 校验一行自定义头是否可安全送上 wire。
 * @param entry - 待校验的 name/value。
 * @returns 人可读的失败原因；合法时 null。
 */
export function headerEntryError(entry: HeaderEntry): string | null {
  const name = entry.name.trim();
  if (!name) return '请求头名不能为空';
  if (name.length > MAX_HEADER_NAME_LENGTH) return `请求头名过长（上限 ${MAX_HEADER_NAME_LENGTH} 字符）`;
  if (entry.value.length > MAX_HEADER_VALUE_LENGTH) return `请求头值过长（上限 ${MAX_HEADER_VALUE_LENGTH} 字符）`;
  // 唯一裁决交给 Fetch 自己：头名 token 语法与值的单行字节约束都由它实现，
  // 这里不复制一份必然漂移的正则。
  try {
    new Headers([[name, entry.value]]);
  } catch {
    return `「${name}」不是 Fetch 能发送的请求头（名须为合法 HTTP 字段名，值须为单行文本）`;
  }
  return null;
}

/**
 * 解析编辑面/配方里的「每行一条 `Name: Value`」文本。
 * 空行与 `#` 起始的注释行跳过；同名重复与条目数超限整单报错（错误不静默）。
 * @param text - 多行文本（值内的冒号保留，按第一个冒号切分）。
 * @returns 合法条目表与全部错误（有错误时调用方不得提交）。
 */
export function parseHeaderLines(text: string): { entries: HeaderEntry[]; errors: string[] } {
  const entries: HeaderEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) {
      errors.push(`第 ${index + 1} 行缺少「:」——每行格式为 Name: Value`);
      continue;
    }
    const entry: HeaderEntry = { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
    const reason = headerEntryError(entry);
    if (reason) {
      errors.push(`第 ${index + 1} 行：${reason}`);
      continue;
    }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      errors.push(`第 ${index + 1} 行：请求头「${entry.name}」重复`);
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  if (entries.length > MAX_CUSTOM_HEADERS) {
    errors.push(`请求头过多（${entries.length} 条，上限 ${MAX_CUSTOM_HEADERS} 条）`);
  }
  return { entries, errors: [...new Set(errors)] };
}

/**
 * 把请求头表渲染成编辑面文本（`Name: Value` 每行一条，保序）。
 * @param headers - 已配置的请求头；缺省 = 空文本。
 * @returns 多行文本。
 */
export function formatHeaderLines(headers: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/**
 * 加载边界的容忍清洗（localStorage 毒化数据）：坏条目丢弃并 warn，不整份崩。
 * 与写入边界相反——那里由 {@link headerEntryError} 响亮拒绝，这里是 INVARIANTS #11
 * 「读取容忍毒化数据」的落实。
 * @param raw - 存储里读出的任意值。
 * @param provider - 出错信息里的提供方名（诊断用）。
 * @returns 清洗后的请求头表；无合法条目 = undefined（读侧与「未配置」同语义）。
 */
export function sanitizeProviderHeaders(raw: unknown, provider: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[settings] provider「${provider}」headers 不是对象，已丢弃`);
    return undefined;
  }
  const clean: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      console.warn(`[settings] provider「${provider}」请求头「${name}」的值不是字符串，已丢弃`);
      continue;
    }
    const reason = headerEntryError({ name, value });
    if (reason) {
      console.warn(`[settings] provider「${provider}」请求头「${name}」不合法（${reason}），已丢弃`);
      continue;
    }
    if (count >= MAX_CUSTOM_HEADERS) {
      console.warn(`[settings] provider「${provider}」请求头超过 ${MAX_CUSTOM_HEADERS} 条，超限条目已丢弃`);
      break;
    }
    count += 1;
    clean[name.trim()] = value;
  }
  return count > 0 ? clean : undefined;
}
