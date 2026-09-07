// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// McpPage — 设置面板「MCP」标签页（skills-mcp-production-plan Commit 6c）。
//
// 管理用户级 `~/.lantai/mcp.json` 的 MCP server 声明（跨项目个人 server）：
//   - 列表：读取并解析 mcp.json（parseUserMcpJson 复用），展示 transport/
//     command/url + 装载失败诊断（skipped）
//   - 新建：表单写 mcp.json（name + transport + command/url + 治理字段可选）
//   - 删除：二次确认制
//
// 通道：kernel fs 读写 ~/.lantai/mcp.json（沙箱读+写豁免——Commit 6c 前置
// 修复已放行）；工具折算与生命周期由 user-mcp.ts 装载承担（main.ts boot 接线）。
//
// 说明：插件级 MCP server（manifest.mcpServers）由「插件」tab 管理；本页只管
// 用户级直配。生效时机：mcp.json 变更后需重启应用重新装载（boot 期读取）。

import { useCallback, useEffect, useState } from 'react';
import { type McpServerDecl, McpServerDeclSchema } from '../../../plugins/types';
import { parseUserMcpJson } from '../../../plugins/user-mcp';
import { kernelReadFile, kernelWriteFile } from '../../../rpc-contract';

/** 用户级 mcp.json 路径（kernelGlobalMemoryDir 推导 ~/.lantai 逻辑在装载侧；
 *  本页经 mock 兼容的固定推导——真实运行时由 user-mcp.resolveUserLantaiDir）。
 *  页面直接拼 ~/.lantai（前端 mock/真实现 kernelGlobalMemoryDir 均返回该父）。
 */
const USER_MCP_PATH = '~/.lantai/mcp.json';

/** server 卡片。 */
function McpServerCard({
  server,
  onDelete,
  busy,
  confirming,
}: {
  server: McpServerDecl;
  onDelete: (name: string) => void;
  busy: boolean;
  confirming: boolean;
}) {
  const isStdio = server.transport === 'stdio';
  return (
    <div className="sp-lsp-card">
      <span className="sp-lsp-card-icon" style={{ color: 'var(--pass)' }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--f-mono)' }}>MCP</span>
      </span>
      <div className="sp-lsp-card-body">
        <div className="sp-lsp-card-header">
          <span className="lang-name">{server.name}</span>
          <span className="lang-status" style={{ color: 'var(--ink-2)' }}>
            {isStdio ? 'stdio' : 'http'}
            {server.lifecycle ? ` · ${server.lifecycle}` : ''}
          </span>
        </div>
        <div className="sp-lsp-card-meta">
          <code>{isStdio ? `${server.command} ${(server.args ?? []).join(' ')}` : server.url}</code>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            type="button"
            className="sp-btn-sm pp-btn-danger"
            disabled={busy}
            onClick={() => onDelete(server.name)}
          >
            {confirming ? '确认删除？' : '删除'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 新建 server 表单。 */
function NewMcpServerForm({ onSaved, onError }: { onSaved: () => void; onError: (text: string) => void }) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    const n = name.trim();
    if (!n) {
      onError('server 名不能为空');
      return;
    }
    if (transport === 'stdio' && !command.trim()) {
      onError('stdio server 需要 command');
      return;
    }
    if (transport === 'http' && !url.trim()) {
      onError('http server 需要 url');
      return;
    }
    setBusy(true);
    try {
      // 读现有 mcp.json → 追加新条目 → 写回
      let servers: McpServerDecl[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      try {
        const raw = await kernelReadFile(USER_MCP_PATH);
        servers = parseUserMcpJson(raw, skipped);
      } catch {
        // 无 mcp.json = 首次配置——从空开始
      }
      const rawEntry =
        transport === 'stdio'
          ? {
              name: n,
              transport: 'stdio' as const,
              command: command.trim(),
              args: args.split(/\s+/).filter((a) => a.length > 0),
            }
          : { name: n, transport: 'http' as const, url: url.trim() };
      const parsed = McpServerDeclSchema.safeParse(rawEntry);
      if (!parsed.success) {
        onError(
          'server 声明非法: ' +
            parsed.error.issues.map((i) => (i.path.join('.') || '(root)') + ': ' + i.message).join('; '),
        );
        return;
      }
      const newEntry = parsed.data;
      if (servers.some((s) => s.name === n)) {
        onError(`server "${n}" 已存在——先删除再重建`);
        return;
      }
      servers.push(newEntry);
      // 映射形态写出（对齐 .mcp.json.example 的 { mcpServers: {<name>: {...}} }）
      const map = Object.fromEntries(
        servers.map((s) => {
          const { name: sn, ...rest } = s;
          return [sn, rest];
        }),
      );
      // kernelWriteFile 自动建父目录（write_text_cap create_dir_all）——不显式建
      await kernelWriteFile(USER_MCP_PATH, JSON.stringify({ mcpServers: map }, null, 2) + '\n');
      setName('');
      setCommand('');
      setArgs('');
      setUrl('');
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [name, transport, command, args, url, onSaved, onError]);

  return (
    <div className="sp-section">
      <div className="sp-section-title">新建 server（用户级 ~/.lantai/mcp.json）</div>
      <div className="sp-field">
        <input
          className="sp-input"
          placeholder="server 名（如 dataflow）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="sp-field">
        <select
          className="sp-input"
          value={transport}
          onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
        >
          <option value="stdio">stdio（子进程）</option>
          <option value="http">http（URL 直连）</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <>
          <div className="sp-field">
            <input
              className="sp-input"
              placeholder="command（如 npx、node，裸名走 PATH）"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>
          <div className="sp-field">
            <input
              className="sp-input"
              placeholder="args（空格分隔，可选）"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </div>
        </>
      ) : (
        <div className="sp-field">
          <input
            className="sp-input"
            placeholder="url（如 https://mcp.example.com/v1）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      )}
      <button type="button" className="sp-btn-sm" disabled={busy} onClick={() => void save()}>
        添加
      </button>
      <div className="sp-hint-sub" style={{ marginTop: 6 }}>
        生效时机：保存后重启应用（boot 期读 mcp.json 折算工具；或改插件式重载）。
      </div>
    </div>
  );
}

/** MCP 标签页（用户级 server 管理）。 */
export function McpPage() {
  const [servers, setServers] = useState<McpServerDecl[]>([]);
  const [skipped, setSkipped] = useState<Array<{ name: string; reason: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await kernelReadFile(USER_MCP_PATH);
      const skippedList: Array<{ name: string; reason: string }> = [];
      const list = parseUserMcpJson(raw, skippedList);
      setServers(list);
      setSkipped(skippedList);
    } catch {
      // 无 mcp.json = 无用户级 server（首次配置）
      setServers([]);
      setSkipped([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDelete = useCallback(
    async (name: string) => {
      if (confirmName !== name) {
        setConfirmName(name);
        return;
      }
      setConfirmName(null);
      setBusyName(name);
      setMessage(null);
      try {
        const next = servers.filter((s) => s.name !== name);
        const map = Object.fromEntries(
          next.map((s) => {
            const { name: sn, ...rest } = s;
            return [sn, rest];
          }),
        );
        await kernelWriteFile(USER_MCP_PATH, JSON.stringify({ mcpServers: map }, null, 2) + '\n');
        await reload();
        setMessage({ kind: 'ok', text: `已删除 server ${name}` });
      } catch (e) {
        setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusyName(null);
      }
    },
    [servers, reload, confirmName],
  );

  return (
    <>
      <div className="sp-section">
        <div className="sp-section-title">用户级 MCP server（{servers.length}）</div>
        <div className="sp-hint" style={{ marginBottom: 10 }}>
          配置存 <code>~/.lantai/mcp.json</code>——跨项目个人 server（裸命令走 PATH）。插件声明的 MCP server
          在「插件」页管理。工具折算 = <code>plugin/user/mcp/&lt;server&gt;</code>，patch/preset 可禁用。
        </div>
        {loading && <div className="sp-hint">读取中…</div>}
        {servers.length === 0 && !loading && (
          <div className="sp-hint">暂无用户级 server。下方添加，或手写 ~/.lantai/mcp.json。</div>
        )}
        {servers.map((s) => (
          <McpServerCard
            key={s.name}
            server={s}
            onDelete={handleDelete}
            busy={busyName === s.name}
            confirming={confirmName === s.name}
          />
        ))}
      </div>

      {skipped.length > 0 && (
        <div className="sp-section">
          <div className="sp-section-title">装载失败（已跳过）</div>
          {skipped.map((s) => (
            <div key={s.name} className="sp-lsp-card-err">
              <code>{s.name}</code>: {s.reason}
            </div>
          ))}
        </div>
      )}

      {message && (
        <div style={message.kind === 'err' ? undefined : { color: 'var(--pass)', marginBottom: 8 }}>
          {message.kind === 'err' ? (
            <div className="pp-error-banner">
              <span className="pp-error-text">{message.text}</span>
            </div>
          ) : (
            message.text
          )}
        </div>
      )}

      <NewMcpServerForm
        onSaved={() => {
          setMessage({ kind: 'ok', text: '已保存——重启后生效' });
          void reload();
        }}
        onError={(text) => setMessage({ kind: 'err', text })}
      />
    </>
  );
}
