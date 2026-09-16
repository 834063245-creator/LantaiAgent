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
import {
  type BundledEngineInfo,
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  setBundledEngineEnabled,
} from '../../../plugins/bundled-engine';
import { type McpServerDecl, McpServerDeclSchema } from '../../../plugins/types';
import { isUserMcpMissingError, parseUserMcpJson, resolveUserMcpJsonPath } from '../../../plugins/user-mcp';
import { kernelReadFile, kernelWriteFile } from '../../../rpc-contract';
import { describeReceipt, useBundledEngineStore } from '../../../state/bundled-engine-store';

/** 展示用标签（人看的写法）。**实际读写一律用 `resolveUserMcpJsonPath()` 的绝对路径**：
 *  字面量 `~` 曾因 fs 层不展开波浪号而让本页读写全链路静默失败（2026-09-13 修，见
 *  docs/plans/office-cli-integration-plan.md §5 坑账）——不再赌波浪号。 */
const USER_MCP_LABEL = '~/.lantai/mcp.json';

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
      // 读现有 mcp.json → 追加新条目 → 写回（**绝对路径**：不赌 fs 层认 `~`）
      let servers: McpServerDecl[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      const path = await resolveUserMcpJsonPath();
      if (!path) {
        onError('无法推导 ~/.lantai 位置（kernelGlobalMemoryDir 失败）');
        return;
      }
      try {
        const raw = await kernelReadFile(path);
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
      await kernelWriteFile(path, JSON.stringify({ mcpServers: map }, null, 2) + '\n');
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
      <div className="sp-section-title">新建 server（用户级 {USER_MCP_LABEL}）</div>
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

/** 随包图谱引擎（engine-bundled-mcp-distribution，2026-09-16）——方案乙：
 *  引擎随安装包分发，但**默认不接**（尊重 2026-09-09 图谱工具面退役决策）。
 *
 *  本区块是**三态同屏**（2026-09-16 用户实机报「说是默认关，但开关在哪呢」后改）：
 *    ① 探测态——引擎二进制在不在（显示实路径）；未探测到也**保留开关**（置灰 +
 *       写明它该在哪），不让开关凭空消失；
 *    ② 开关态——启用 / 未启用 + 生效时机。开关原先排在本页最底部（用户级 server
 *       列表与新建表单之后），从页首扫下去看不见 ⇒ 已整体置顶（见 McpPage）；
 *    ③ 回执态——本工作区**实际**接线结果（读 `state/bundled-engine-store`）。
 *       拨了开关必须看得见结果：此前 wiring 结果只进 console，用户侧无从查证。 */
function BundledEngineSection() {
  const [info, setInfo] = useState<BundledEngineInfo | null>(null);
  const [enabled, setEnabled] = useState(isBundledEngineEnabled());
  const [probing, setProbing] = useState(true);
  /** 接线回执（workspace.ts 写；本区块只读）——见 state/bundled-engine-store。 */
  const receipt = useBundledEngineStore();

  useEffect(() => {
    let alive = true;
    void probeBundledEngine()
      .then((i) => {
        if (alive) setInfo(i);
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 订阅外部变更（多面板一致性）——本组件自持 state，订阅只为同步自己
  useEffect(() => onBundledEnginePrefChanged(() => setEnabled(isBundledEngineEnabled())), []);

  return (
    <div className="sp-section">
      <div className="sp-section-title">随包图谱引擎</div>
      <div className="sp-hint" style={{ marginBottom: 10 }}>
        兰台安装包内含 <code>hologram-engine.exe</code>（代码依赖图分析，MCP server 形态）。 启用后打开工作区，Agent
        工具面会出现图谱相关工具（图查询 / 影响面 / LSP 解析等）。
      </div>
      {/* ① 探测 */}
      {probing ? (
        <div className="sp-hint">探测中…</div>
      ) : info?.available ? (
        <div className="sp-field">
          <div className="sp-hint-sub" style={{ wordBreak: 'break-all' }}>
            已检测到：<code>{info.path}</code>
          </div>
        </div>
      ) : (
        <div className="sp-hint-sub">
          未检测到引擎二进制——它须与 <code>lantai.exe</code> 同目录（开发态可先{' '}
          <code>cargo build -p hologram-engine --release</code>，或用环境变量 <code>LANTAI_ENGINE_EXE</code>
          指定）。也可在下方「新建 server」里手动指向任意位置的引擎。
        </div>
      )}

      {/* ② 开关（未探测到时置灰但仍在场——不让开关凭空消失） */}
      <label className="sp-hint-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!info?.available}
          onChange={(e) => {
            setBundledEngineEnabled(e.target.checked);
            setEnabled(e.target.checked);
          }}
        />
        <span>启用随包图谱引擎</span>
      </label>

      {/* ③ 回执：本工作区实际接上了没有（拨了开关必须看得见结果） */}
      <div className="sp-hint-sub" style={{ marginTop: 6 }}>
        接线回执：{describeReceipt(receipt, enabled)}
      </div>

      <div className="sp-hint-sub" style={{ marginTop: 6 }}>
        生效时机：下次打开工作区（每个工作区按各自的根启动一个引擎进程；离开工作区即停）。
        {enabled && ' 引擎首次分析较慢，可用引擎自带的状态查询看进度。'}
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
      const path = await resolveUserMcpJsonPath();
      if (!path) {
        setServers([]);
        setSkipped([]);
        setMessage({ kind: 'err', text: '无法推导 ~/.lantai 位置（kernelGlobalMemoryDir 失败）' });
        return;
      }
      let raw: string;
      try {
        raw = await kernelReadFile(path);
      } catch (e) {
        // 读失败**不再吞**（2026-09-13）：文件不存在 = 首次配置（正常空态）；
        // 其它失败（沙箱拒绝 / 路径形态不被认）必须可见——否则"读被拒"看起来就是
        // "没配置"，面板长期显示空（实测踩坑：fs 层曾不展开 `~`，本面板读写全链路失败）。
        const msg = e instanceof Error ? e.message : String(e);
        setServers([]);
        setSkipped([]);
        if (!isUserMcpMissingError(msg)) {
          setMessage({ kind: 'err', text: `读取 ${path} 失败：${msg}` });
        }
        return;
      }
      const skippedList: Array<{ name: string; reason: string }> = [];
      const list = parseUserMcpJson(raw, skippedList);
      setServers(list);
      setSkipped(skippedList);
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
        const path = await resolveUserMcpJsonPath();
        if (!path) {
          setMessage({ kind: 'err', text: '无法推导 ~/.lantai 位置（kernelGlobalMemoryDir 失败）' });
          return;
        }
        await kernelWriteFile(path, JSON.stringify({ mcpServers: map }, null, 2) + '\n');
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
      {/* 随包图谱引擎区块**置顶**（2026-09-16 用户实机报缺陷后改）：它原先排在
          用户级 server 列表与新建表单之后，从页首扫下去看不见——用户直接问
          「说是默认关，但开关在哪呢」。随包引擎是宿主自有能力，排在本页首位。 */}
      <BundledEngineSection />

      <div className="sp-section">
        <div className="sp-section-title">用户级 MCP server（{servers.length}）</div>
        <div className="sp-hint" style={{ marginBottom: 10 }}>
          配置存 <code>{USER_MCP_LABEL}</code>——跨项目个人 server（裸命令走 PATH）。插件声明的 MCP server
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
