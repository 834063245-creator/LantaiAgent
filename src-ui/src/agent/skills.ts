// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Skill system — loads markdown files from .lantai/skills/<name>/SKILL.md
// Format: YAML frontmatter (name, description) + markdown body.
// Hot-loading: skills are reloaded on every Skill tool call — install a skill
// mid-session and it's immediately available, no restart needed.

import { z } from 'zod';
import type { DirEntry } from '../rpc-contract';
import { typedJsonRpc, typedRpc } from '../rpc-contract';
import type { Tool } from './tool';
import { defineTool } from './tools/define-tool';

export interface SkillDef {
  name: string;
  description: string;
  prompt: string;
}

// ── Frontmatter parser (line-by-line, zero deps) ──

function parseSkillMd(raw: string): { meta: Record<string, string>; body: string } {
  const stripped = raw.replace(/^\s*\d+\t/gm, '');
  const lines = stripped.split('\n');
  if (lines[0]?.trim() !== '---') return { meta: {}, body: stripped };

  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') {
      i++;
      break;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = line
        .slice(colon + 1)
        .trim()
        .replace(/^['"](.*)['"]$/, '$1');
      meta[key] = val;
    }
  }
  return { meta, body: lines.slice(i).join('\n').trim() };
}

// ── Skill loader (pure function, called on every tool invocation) ──

async function loadSkills(projectPath: string): Promise<SkillDef[]> {
  const root = projectPath.replace(/\\/g, '/');
  const dir = `${root}/.lantai/skills`;
  // 形状真源 = Rust utils::DirEntry（is_dir 布尔——旧手写 type 字段名与
  // Rust 不符，曾致全部条目被跳过、项目技能恒不加载，2026-09-01 边界校验批修复）。
  let entries: DirEntry[];
  try {
    entries = await typedJsonRpc('list_directory_flat', { path: dir, is_agent: false });
  } catch {
    return [];
  }

  const skills: SkillDef[] = [];
  for (const e of entries) {
    if (!e.is_dir) continue;
    const fp = `${e.path.replace(/\\/g, '/')}/SKILL.md`;
    try {
      const raw = await typedRpc('read_file_content', { file_path: fp, is_agent: false });
      const { meta, body } = parseSkillMd(raw);
      if (!body) continue;
      skills.push({
        name: e.name,
        description: meta.description || meta.name || e.name,
        prompt: body,
      });
    } catch {
      /* skip broken skills */
    }
  }
  return skills;
}

// ── SkillRegistry — hot-loading skill manager ──

export class SkillRegistry {
  private projectPath: string;
  private _names: string[] = [];

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /** Reload all skills from disk. Called on every Skill tool invocation
   *  and when chat.ts needs skill names for slash commands.
   *  ponytail: no caching — directory listing + file reads for ~5 skills
   *  takes <10ms on any modern FS. Simpler than TTL cache + stale detection. */
  async reload(): Promise<SkillDef[]> {
    const skills = await loadSkills(this.projectPath);
    this._names = skills.map((s) => s.name);
    return skills;
  }

  /** Get current skill names (from last reload). Used by slash command handler. */
  get names(): string[] {
    return this._names;
  }
}

// ── Skill tool factory ──

/** Create the Skill tool backed by a registry that hot-loads on every call. */
export function createSkillTool(registry: SkillRegistry): Tool {
  return defineTool({
    name: 'Skill',
    description:
      'Execute a skill within the main conversation. Skills are predefined workflows stored ' +
      'as markdown files. Install a new skill mid-session — it is immediately available. ' +
      'Call without a skill name to list all available skills. ' +
      'User slash commands like /skill-name are automatically routed here.',
    schema: z.object({
      skill: z.string().trim().describe('Skill name (directory name under .lantai/skills/).'),
      args: z.string().optional().describe('Optional argument string ($ARGUMENTS in skill body).'),
    }),
    readOnly: true,
    execute: async (args) => {
      // Hot-load — ensures newly installed skills are visible immediately
      const skills = await registry.reload();
      const name = args.skill;
      const skillArgs = args.args || '';

      if (!name) {
        return skills.length === 0
          ? 'No skills installed. Create .lantai/skills/<name>/SKILL.md to add one.'
          : `Available skills:\n${skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')}`;
      }

      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return `Skill "${name}" not found. Available: ${skills.map((s) => s.name).join(', ') || 'none'}`;
      }

      return skill.prompt.replace(/\$ARGUMENTS/g, skillArgs);
    },
  });
}
