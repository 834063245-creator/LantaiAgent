// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 高级连接配置（2026-09-17）——自定义请求头编辑 + provider 配方导入/导出。
//
// 动机：网关怪癖（如 OpenCode GO 强制 x-opencode-session）此前只能改代码发版，
// 用户拿到 exe 无路可走。本面板把该面交还给用户：手填请求头，或粘贴别人分享的
// 配方 JSON（含 baseUrl/模型/元数据/请求头）。密钥不在此列（权威在凭据库）。

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { formatHeaderLines, parseHeaderLines } from '../../../provider/custom-headers';
import { applyRecipeToProvider, exportProviderRecipe, parseProviderRecipe } from '../../../provider/provider-recipe';
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
  const [recipeMode, setRecipeMode] = useState<'closed' | 'import' | 'export'>('closed');
  const [recipeText, setRecipeText] = useState('');
  const [recipeHint, setRecipeHint] = useState<Hint | null>(null);

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

  /** 导出配方：先落文本框再尝试复制——剪贴板不可用时用户仍能手动全选。 */
  const handleExport = useCallback(async () => {
    const text = exportProviderRecipe(provider);
    setRecipeMode('export');
    setRecipeText(text);
    setRecipeHint(null);
    try {
      await navigator.clipboard.writeText(text);
      setRecipeHint({ tone: 'ok', text: '配方已复制到剪贴板（不含密钥，可安全分享）' });
    } catch {
      setRecipeHint({ tone: 'ok', text: '配方已生成——请在上方文本框手动复制（不含密钥）' });
    }
  }, [provider]);

  /** 导入配方：严格校验整单拒绝；套用时名字与密钥保持本行。 */
  const handleImport = useCallback(() => {
    const result = parseProviderRecipe(recipeText);
    if ('error' in result) {
      setRecipeHint({ tone: 'fail', text: `导入失败：${result.error}` });
      return;
    }
    onChange(applyRecipeToProvider(provider, result.recipe));
    setHeaderText(formatHeaderLines(result.recipe.headers));
    setRecipeHint({
      tone: 'ok',
      text:
        result.recipe.name === provider.name
          ? '配方已套用到本行'
          : `配方来自「${result.recipe.name}」，已套用到本行「${provider.name}」（名字与密钥保持本行）`,
    });
  }, [recipeText, onChange, provider]);

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

      <div className="pp-field">
        <div className="pp-f-label-row">
          <span className="pp-f-label">Provider 配方</span>
          <button
            type="button"
            className="sp-btn-sm"
            title="生成该提供方的非敏感配置 JSON（密钥除外），可复制分享"
            onClick={() => void handleExport()}
          >
            导出
          </button>
          <button
            type="button"
            className="sp-btn-sm"
            title={recipeMode === 'import' ? '收起导入框' : '粘贴别人分享的配方 JSON 并套用到本行'}
            onClick={() => {
              setRecipeMode(recipeMode === 'import' ? 'closed' : 'import');
              setRecipeText('');
              setRecipeHint(null);
            }}
          >
            导入
          </button>
        </div>
        {recipeMode !== 'closed' && (
          <>
            <textarea
              className="sp-input pp-recipe-text"
              rows={8}
              value={recipeText}
              readOnly={recipeMode === 'export'}
              spellCheck={false}
              placeholder={'粘贴配方 JSON（{"format":"lantai-provider-recipe",…}）'}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setRecipeText(e.target.value);
                setRecipeHint(null);
              }}
            />
            <div className="pp-f-hint">
              {recipeMode === 'export'
                ? '配方只含连接配置（baseUrl / 模型 / 请求头 / 元数据），不含 API Key；套用时名字与密钥保持本行。'
                : '套用只改连接配置；名字与 API Key 保持本行不变。'}
            </div>
            {recipeMode === 'import' && (
              <button type="button" className="sp-btn-sm" disabled={!recipeText.trim()} onClick={handleImport}>
                套用到本行
              </button>
            )}
          </>
        )}
        {hintBlock(recipeHint)}
      </div>
    </div>
  );
}
