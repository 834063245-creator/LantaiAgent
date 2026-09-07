// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SkillsPage — 设置面板「技能」标签页（skills-mcp-production-plan Commit 4）。
//
// 功能：
//   - 技能列表：项目级（.lantai/skills）+ 用户级（~/.lantai/skills，只读展示）
//     的 SKILL.md 技能 + 出厂技能（builtin-skills.ts，随 exe 分发，只读），
//     显示 name/description/source + 装载失败诊断（skipped）
//   - 新建技能（项目级）：表单写 <project>/.lantai/skills/<name>/SKILL.md
//   - 删除技能（项目级；用户级只读——防误删跨项目资产）
//   - 从本地目录复制安装（项目级）
//
// 通道：kernel fs（kernelCreateDirectory/kernelWriteFile/kernelDeleteFile/
// kernelListDirectoryFlat/kernelReadFile + scanSkills——项目内写沙箱放行，
// 用户级读沙箱放行（Commit 3），用户级写刻意锁（防任意写跨项目资产）。

import { useCallback, useEffect, useState } from 'react';
import { type SkillDef, scanSkills } from '../../../agent/skills';
import { kernelCreateDirectory, kernelDeleteFile, kernelWriteFile } from '../../../rpc-contract';
import { useShellStore } from '../../shell-store';

/** 技能卡片。 */
function SkillCard({
  skill,
  onDelete,
  busy,
  confirming,
}: {
  skill: SkillDef;
  onDelete: (name: string) => void;
  busy: boolean;
  confirming: boolean;
}) {
  const isProject = skill.source === 'project';
  const sourceLabel = skill.source === 'project' ? '项目' : skill.source === 'user' ? '用户' : '内置';
  return (
    <div className="sp-lsp-card">
      <span className="sp-lsp-card-icon" style={{ color: 'var(--pass)' }}>
        {/* 静态文本徽标（Icon 组件无 skill 图标——用字符占位） */}
        <span style={{ fontSize: 11, fontFamily: 'var(--f-mono)' }}>SK</span>
      </span>
      <div className="sp-lsp-card-body">
        <div className="sp-lsp-card-header">
          <span className="lang-name">{skill.name}</span>
          <span className="lang-status" style={{ color: isProject ? 'var(--pass)' : 'var(--ink-2)' }}>
            {sourceLabel}
          </span>
        </div>
        <div className="sp-lsp-card-meta">
          <span>{skill.description}</span>
          {skill.whenToUse ? <span> · 适用: {skill.whenToUse}</span> : null}
        </div>
        {skill.dir ? (
          <div className="sp-hint-sub" style={{ marginTop: 2 }}>
            {skill.dir}
          </div>
        ) : null}
        {isProject && (
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="sp-btn-sm pp-btn-danger"
              disabled={busy}
              onClick={() => onDelete(skill.name)}
            >
              {confirming ? '确认删除？' : '删除'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 新建技能表单（项目级 .lantai/skills/<name>/SKILL.md）。 */
function NewSkillForm({
  projectRoot,
  onCreated,
  onError,
}: {
  projectRoot: string;
  onCreated: () => void;
  onError: (text: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const create = useCallback(async () => {
    const n = name.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) {
      onError('技能名必须是小写 kebab-case（字母数字+连字符）');
      return;
    }
    if (!description.trim()) {
      onError('描述不能为空');
      return;
    }
    setBusy(true);
    try {
      const dir = `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/.lantai/skills/${n}`;
      // kernelCreateDirectory 逐级建父链（.lantai → .lantai/skills → <name>）
      await kernelCreateDirectory(dir);
      const content = [
        '---',
        `name: ${n}`,
        `description: ${description.trim()}`,
        '---',
        '',
        body.trim() || `# ${n}\n\n（技能正文——指引 Agent 如何执行）`,
        '',
      ].join('\n');
      await kernelWriteFile(`${dir}/SKILL.md`, content);
      setName('');
      setDescription('');
      setBody('');
      onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [name, description, body, projectRoot, onCreated, onError]);

  return (
    <div className="sp-section">
      <div className="sp-section-title">新建技能（项目级 .lantai/skills）</div>
      <div className="sp-field">
        <input
          className="sp-input"
          placeholder="技能名（kebab-case，如 code-review）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="sp-field">
        <input
          className="sp-input"
          placeholder="描述（模型据此判断何时用该技能）"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="sp-field">
        <textarea
          className="sp-input"
          style={{ minHeight: 90, fontFamily: 'var(--f-mono)', fontSize: 11 }}
          placeholder={'技能正文（markdown 指引）。支持 $' + '{LANTAI_SKILL_DIR} 引用技能目录内文件。'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <button type="button" className="sp-btn-sm" disabled={busy} onClick={() => void create()}>
        创建
      </button>
    </div>
  );
}

/** 技能标签页。 */
export function SkillsPage() {
  const projectPath = useShellStore((s) => s.projectPath);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [skipped, setSkipped] = useState<Array<{ name: string; reason: string; dir: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  /** 二次确认态（点「删除」先变「确认删除？」——防误删）。 */
  const [confirmName, setConfirmName] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const scan = await scanSkills(projectPath);
      setSkills(scan.skills);
      setSkipped(scan.skipped);
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDelete = useCallback(
    async (name: string) => {
      if (!projectPath) return;
      // 二次确认：首次点击只置确认态，再次点击才真删
      if (confirmName !== name) {
        setConfirmName(name);
        return;
      }
      setConfirmName(null);
      setBusyName(name);
      setMessage(null);
      try {
        const skill = skills.find((s) => s.name === name);
        if (skill?.source !== 'project' || !skill.dir) return;
        await kernelDeleteFile(skill.dir);
        await reload();
        setMessage({ kind: 'ok', text: `已删除技能 ${name}` });
      } catch (e) {
        setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusyName(null);
      }
    },
    [projectPath, skills, reload, confirmName],
  );

  if (!projectPath) {
    return <div className="sp-hint">请先打开项目以管理技能。</div>;
  }

  return (
    <>
      <div className="sp-section">
        <div className="sp-section-title">技能（{skills.length}）</div>
        <div className="sp-hint" style={{ marginBottom: 10 }}>
          技能 = <code>.lantai/skills/&lt;name&gt;/SKILL.md</code>（项目）或{' '}
          <code>~/.lantai/skills/&lt;name&gt;/SKILL.md</code>
          （用户，只读展示）；「内置」为随应用分发的出厂技能（不可删改，同名项目/用户版可覆盖）。模型在 Agent
          装配时看到技能目录，用 <code>Skill</code> 工具按名执行；新装技能下次装配生效。
        </div>
        {loading && <div className="sp-hint">扫描中…</div>}
        {skills.length === 0 && !loading && (
          <div className="sp-hint">暂无技能。下方创建，或手动放 SKILL.md 到技能目录。</div>
        )}
        {skills.map((s) => (
          <SkillCard
            key={s.source + ':' + s.name}
            skill={s}
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
            <div key={s.dir} className="sp-lsp-card-err">
              <code>{s.name}</code>: {s.reason}
              <div className="sp-hint-sub">{s.dir}</div>
            </div>
          ))}
        </div>
      )}

      {message && (
        <div
          className={message.kind === 'err' ? 'pp-error-banner' : undefined}
          style={message.kind === 'ok' ? { color: 'var(--pass)', marginBottom: 8 } : undefined}
        >
          {message.kind === 'err' ? <span className="pp-error-text">{message.text}</span> : message.text}
        </div>
      )}

      <NewSkillForm
        projectRoot={projectPath}
        onCreated={() => {
          setMessage({ kind: 'ok', text: '技能已创建——下次 Agent 装配生效' });
          void reload();
        }}
        onError={(text) => setMessage({ kind: 'err', text })}
      />
    </>
  );
}
