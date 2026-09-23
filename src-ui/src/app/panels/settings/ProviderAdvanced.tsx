// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 高级连接配置（2026-09-17；2026-09-24 配方改文件批收敛）——自定义请求头编辑。
//
// 动机：网关怪癖（如 OpenCode GO 强制 x-opencode-session）此前只能改代码发版，
// 用户拿到 exe 无路可走。本面板把该面交还给用户：手填请求头。
//
// ⚡ 2026-09-24：本面板原先还挂「配方导入/导出」两个按钮（cut/paste 剪贴板 JSON）
// ——已整批退役。provider 的连接配置现在就是一份磁盘 YAML
// （`~/.lantai/providers.yml`）：复制文件即导入、文件本身即导出、agent 直接改，
// 见邻居 `ProviderDocCard`。请求头也写在那份文件的 `headers:` 段里（本面板是它的
// 图形化编辑面）。密钥不在此列（权威在凭据库）。

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { formatHeaderLines, parseHeaderLines } from '../../../provider/custom-headers';
import type { ProviderSettings } from '../../../settings';

interface ProviderAdvancedProps {
  provider: ProviderSettings;
  /** 提交整行回填（请求头 / 配方套用）；名字与密钥由调用方保持本行值。 */
  onChange: (next: ProviderSettings) => void;
}

/** 一行提示（ok/fail 两调）。 */
type Hint = { tone: 'ok' | 'fail'; text: string };

export function ProviderAdvanced({ provider, onChange }: ProviderAdvancedProps) {
  const saved = useMemo(() => formatHeaderLines(provider.headers), [provider.headers]);
  const [headerText, setHeaderText] = useState(saved);
  const [headerHint, setHeaderHint] = useState<Hint | null>(null);

  // 每次渲染重算（纯函数，行数有上限）——编辑期实时显示错误，不提交坏数据
  const parsed = useMemo(() => parseHeaderLines(headerText), [headerText]);
  const dirty = headerText !== saved;

  /** 提交请求头文本：有错误一律不提交（错误不静默）。 */
  const commitHeaders = useCallback(() => {
    if (!dirty) return;
    if (parsed.errors.length > 0) {
      setHeaderHint({ tone: 'fail', text: `未保存：${parsed.errors[0]}` });
      return;
    }
    const headers = Object.fromEntries(parsed.entries.map((e) => [e.name, e.value]));
    onChange({ ...provider, headers: parsed.entries.length > 0 ? headers : undefined });
    setHeaderHint({
      tone: 'ok',
      text: parsed.entries.length > 0 ? `已保存 ${parsed.entries.length} 条请求头` : '已清空请求头',
    });
  }, [dirty, parsed, onChange, provider]);

  const hintBlock = (hint: Hint | null, cls = 'pp-f-hint') =>
    hint && <div className={cls}>{hint.tone === 'fail' ? `✕ ${hint.text}` : hint.text}</div>;

  return (
    <div className="pp-card">
      <div className="pp-card-hd">
        <span className="pp-card-title">高级（连接怪癖）</span>
        <span className="pp-rule" />
      </div>

      <div className="pp-field">
        <div className="pp-f-label-row">
          <label className="pp-f-label" htmlFor="pd-headers">
            自定义请求头
          </label>
          <button
            type="button"
            className="sp-btn-sm"
            title={dirty ? '保存请求头到本提供方' : '没有未保存的改动'}
            disabled={!dirty}
            onClick={commitHeaders}
          >
            保存
          </button>
        </div>
        <textarea
          id="pd-headers"
          className="sp-input pp-headers-text"
          rows={Math.max(2, Math.min(8, headerText.split('\n').length + 1))}
          value={headerText}
          placeholder={'每行一条：Name: Value\n# 注释行忽略；如 x-opencode-session: <稳定的会话 id>'}
          spellCheck={false}
          autoComplete="off"
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
            setHeaderText(e.target.value);
            setHeaderHint(null);
          }}
          onBlur={commitHeaders}
        />
        {parsed.errors.length > 0 ? hintBlock({ tone: 'fail', text: parsed.errors.join('；') }) : hintBlock(headerHint)}
        {parsed.errors.length === 0 && !headerHint && (
          <div className="pp-f-hint">
            三方言请求（对话 / 预热 /
            模型目录）都会带上；内核必需头与凭据头（Authorization、x-api-key）由兰台生成，不可在此覆写。
          </div>
        )}
      </div>
    </div>
  );
}
