// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 持久化记忆系统 — 对标 Claude Code MEMORY.md
// 项目记忆: .lantai/memory/*.md + MEMORY.md 索引
// 全局记忆: ~/.lantai/global_memory/*.md + MEMORY.md 索引
// 跨会话、跨 session tab 共享。全局记忆跨所有项目共享。
//
// 记忆置信度体系 (inspired by 初痕 MemoryDirective):
//   fact       — 用户明确要求，过去的确定结论。仅作提醒，不替代代码和约束决策
//   reference  — Agent 发现或用户提过的参考信息（默认级别）
//   background — 用于调整回复风格和语气，不需要在回复中提及
//   suppressed — 不给 LLM 看到
//   Agent 自己主动存的记忆最高只能给 reference。fact 级别只有用户通过 /remember 明确要求时才能使用。
//
// 批 9h-4（2026-09-26）：本件随 `memory-domain` 产物包（原 `agent/memory.ts`）——形状上收内核契约
// `agent/memory-contract.ts`；**事实保存授权旗标改由内核持有**（`agent/memory-impl.ts` 的
// `consumeFactAuthorization`——跨模块一次性状态留内核、产物经宿主桥取用，不造副本状态）。

import { z } from 'zod';
import {
  consumeFactAuthorization,
  defineTool,
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelReadFile,
  kernelReadMemoryBatch,
  kernelWriteFile,
  type MemoryManagerFace,
  type Tool,
} from './host';

// ── 类型 ──

type Confidence = 'fact' | 'reference' | 'background' | 'suppressed';

/** 从 MEMORY.md 索引解析的条目 */
export interface MemoryEntry {
  name: string; // kebab-case slug，如 "user-prefers-concise"
  title: string; // 显示标题，如 "用户偏好简洁回复"
  file: string; // 文件名（含 .md 扩展名）
  description: string; // 索引中的一行摘要
}

/** 完整记忆，含已解析的 frontmatter + 正文 */
export interface MemoryFile {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  confidence: Confidence;
  hit_count: number;
  content: string; // 仅正文（不含 frontmatter）
  raw: string; // 完整文件文本（用于重写时更新元数据）
}

// ── 记忆文件判据 ──

/** frontmatter 正则——**唯一真源**：既是「这是不是一份记忆」的读侧判据
 *  （isMemoryText），也是 parseFrontmatter 的解析入口。 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** 记忆文件判据：必须带 frontmatter。非记忆内容（旧墓碑 `{"deleted":true}`、
 *  手写垃圾、截断档）= 读侧一律当**不存在**——与「文件不在 = 记忆不存在」同一把
 *  尺子。旧实现缺这道闸：墓碑被 parseFrontmatter 的兜底分支判成
 *  confidence='reference' 的「正常记忆」，从而绕开 loadPromptSection 的缺文件容错，
 *  残渣被注入每一个新会话。 */
function isMemoryText(raw: string): boolean {
  return FRONTMATTER_RE.test(raw);
}

// ── 索引写链（同一 MEMORY.md 的读-改-写串行化）──────────────────────
//
// 病灶（2026-09-19 真机事故，2026-09-20 彻查）：索引是**整文件读-改-写**，而工具
// 执行器对同一批调用**立即并发派发**（streaming-executor.addTool；「读并行写串行」
// 只存在于 code_execution 程序体内，主管道无写串行化）。六条 `memory delete` 同批
// 落下（.lantai/sessions/19.ndjson seq=379..384 落在同一毫秒）→ 六个「读索引 → 删
// 自己那行 → 整写回」互相覆盖 → 最后一个写者赢 → 其余五条的索引行复活。
// 写链把「谁最后写」钉成「谁最后被要求写」（同 chat-session.enqueueVolumeWrite）。
// 键 = 索引文件路径；失败不阻断链（下一条照常发起），错误照旧上抛调用方。
const _indexWriteChains = new Map<string, Promise<unknown>>();

function enqueueIndexWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = _indexWriteChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  _indexWriteChains.set(key, next);
  const settle = (): void => {
    if (_indexWriteChains.get(key) === next) _indexWriteChains.delete(key);
  };
  next.then(settle, settle);
  return next;
}

// ── MemoryManager ──

export class MemoryManager implements MemoryManagerFace {
  private _projectDirReady = false;
  private _globalDirReady = false;
  private globalDirPath: string | null = null;

  /** 记忆保存后触发（由 workspace 接线 — 扇出到
   *  UI 总线和活跃 Agent 的 notifyMemorySaved）。 */
  onSaved?: (info: { name: string; description?: string; confidence?: string; scope?: string }) => void;

  /** @param projectPath 项目根目录
   *  @param globalPath  全局记忆目录（可选），不传则不启用全局记忆 */
  constructor(
    private projectPath: string,
    globalPath?: string,
  ) {
    this.globalDirPath = globalPath || null;
  }

  private get projectDir(): string {
    return this.projectPath.replace(/\\/g, '/') + '/.lantai/memory';
  }

  /** 解析指定范围的工作目录。 */
  private dirFor(scope: 'project' | 'global'): string {
    if (scope === 'global') {
      if (!this.globalDirPath) throw new Error('全局记忆未启用');
      return this.globalDirPath;
    }
    return this.projectDir;
  }

  /** 返回所有范围（全局优先，若已启用）。 */
  public scopes(): Array<'project' | 'global'> {
    const s: Array<'project' | 'global'> = [];
    if (this.globalDirPath) s.push('global');
    s.push('project');
    return s;
  }

  private indexPath(scope: 'project' | 'global' = 'project'): string {
    return this.dirFor(scope) + '/MEMORY.md';
  }

  private filePath(name: string, scope: 'project' | 'global' = 'project'): string {
    return this.dirFor(scope) + '/' + name + '.md';
  }

  /** 确保读取前 .lantai/memory/ 存在。修复冷启动时
   *  sandbox 拒绝从不存在的父目录读取的问题。 */
  private async ensureDir(scope: 'project' | 'global' = 'project'): Promise<void> {
    if (scope === 'project' && this._projectDirReady) return;
    if (scope === 'global' && this._globalDirReady) return;
    try {
      await kernelCreateDirectory(this.dirFor(scope));
    } catch {
      // 目录可能已存在或创建不可用 — 安全继续
    }
    if (scope === 'project') this._projectDirReady = true;
    else this._globalDirReady = true;
  }

  // ── Prompt 区段缓存 ──

  private _promptSectionCache: string | null = null;
  private _promptSectionCacheTime = 0;

  // ── 索引 ──

  /** 加载指定范围的 MEMORY.md 原始文本。 */
  async loadIndexText(scope: 'project' | 'global' = 'project'): Promise<string> {
    await this.ensureDir(scope);
    try {
      return await kernelReadFile(this.indexPath(scope));
    } catch {
      return '';
    }
  }

  /** 将 MEMORY.md 解析为结构化条目（指定范围）。 */
  async list(scope: 'project' | 'global' = 'project'): Promise<MemoryEntry[]> {
    const text = await this.loadIndexText(scope);
    if (!text.trim()) return [];

    const entries: MemoryEntry[] = [];
    const re = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+[—–-]\s+(.+)$/gm;
    for (const m of text.matchAll(re)) {
      entries.push({
        title: m[1],
        file: m[2],
        name: m[2].replace(/\.md$/, ''),
        description: m[3],
      });
    }
    return entries;
  }

  /** 构建紧凑的索引行（用于添加到 MEMORY.md）。 */
  static formatIndexEntry(entry: MemoryEntry): string {
    return `- [${entry.title}](${entry.file}) — ${entry.description}`;
  }

  // ── 读取 ──

  /** 按名称读取完整记忆文件（不含 .md）。未找到则返回 null；
   *  文件在但不是一份记忆（旧墓碑 / 垃圾 / 截断档）也返回 null——读侧不与坏数据同流。
   *  设置 incrementHit 以追踪回想频率。 */
  async read(name: string, scope: 'project' | 'global' = 'project', incrementHit = false): Promise<MemoryFile | null> {
    await this.ensureDir(scope);
    try {
      const raw = await kernelReadFile(this.filePath(name, scope));
      if (!isMemoryText(raw)) return null;
      const mf = parseFrontmatter(raw);

      if (incrementHit) {
        mf.hit_count = (mf.hit_count || 0) + 1;
        mf.raw = rebuildRaw(mf);
        kernelWriteFile(this.filePath(name, scope), mf.raw).catch((e: unknown) => {
          console.warn(`[memory] hit_count write failed for "${name}":`, e);
        });
      }

      return mf;
    } catch {
      return null;
    }
  }

  // ── Prompt 区段 — 加载到 system prompt ──

  /** 从两个范围加载所有非 suppressed 的记忆并格式化为 system prompt 区段。
   *  全局记忆先加载，项目记忆覆盖（同名时项目优先）。
   *  当记忆数量超过阈值时，应用图感知相关性过滤
   *  只保留最相关的记忆（fact 级别始终包含）。
   *  缓存 5 秒以支持快速会话创建。 */
  async loadPromptSection(graphNodes?: string[]): Promise<string> {
    const now = Date.now();
    if (this._promptSectionCache && now - this._promptSectionCacheTime < 5000) {
      return this._promptSectionCache;
    }

    // 从所有范围收集（全局优先，项目覆盖）。
    // 多条目时使用批量读取以避免 N 次 IPC 往返。
    const allByName = new Map<string, { mf: MemoryFile; scope: string }>();
    for (const scope of this.scopes()) {
      const entries = await this.list(scope);
      if (entries.length === 0) continue;

      // 收集文件路径用于批量读取
      const filePaths = entries.map((e) => this.filePath(e.name, scope));
      let batchResults: Record<string, string | null> = {};

      if (filePaths.length > 1) {
        try {
          batchResults = await kernelReadMemoryBatch(filePaths);
        } catch {
          // 降级为逐个读取
        }
      }

      for (const entry of entries) {
        let mf: MemoryFile | null = null;
        const fp = this.filePath(entry.name, scope);

        if (batchResults[fp] !== undefined) {
          // 使用批量读取结果（非记忆内容 = 不存在——索引行残留不会把垃圾带进注入面）
          const content = batchResults[fp];
          mf = content !== null && isMemoryText(content) ? parseFrontmatter(content) : null;
        } else {
          // 降级为逐个读取
          mf = await this.read(entry.name, scope);
        }

        if (mf && mf.confidence !== 'suppressed') {
          if (!allByName.has(entry.name)) {
            allByName.set(entry.name, { mf, scope });
          }
          // 项目范围覆盖全局（同名）
          if (scope === 'project') {
            allByName.set(entry.name, { mf, scope: 'project' });
          }
        }
      }
    }

    if (allByName.size === 0) {
      const section = '暂无已保存的记忆。用户说"记住..."时保存，说"忘了..."时删除。';
      this._promptSectionCache = section;
      this._promptSectionCacheTime = now;
      return section;
    }

    // ── 图感知相关性过滤 ──
    // 当记忆超过 10 条时，按与当前图节点的相关性排序。
    // fact 级别始终包含；reference/background 竞争剩余名额。
    const MEMORY_LIMIT = 10;
    const allItems = [...allByName.values()];
    const facts = allItems.filter((i) => i.mf.confidence === 'fact');
    const others = allItems.filter((i) => i.mf.confidence !== 'fact');

    let itemsToLoad = allItems;
    if (allItems.length > MEMORY_LIMIT && graphNodes && graphNodes.length > 0) {
      // 对每条非 fact 记忆按与图节点的相关性评分
      const gn = graphNodes ?? [];
      const scored = others.map((item) => ({
        item,
        score: scoreMemoryRelevance(item.mf, gn),
      }));
      scored.sort((a, b) => b.score - a.score);

      // 取前 (MEMORY_LIMIT - facts.length) 条 reference/background + 全部 fact
      const refLimit = Math.max(0, MEMORY_LIMIT - facts.length);
      const topRefs = scored.slice(0, refLimit).map((s) => s.item);
      itemsToLoad = [...facts, ...topRefs];

      // 如果有记忆被过滤掉，记录一下
      const dropped = allItems.length - itemsToLoad.length;
      if (dropped > 0) {
        // ponytail: 静默过滤 — 下方的区段注释已说明
        void dropped;
      }
    }

    // 按置信度分组
    const byConfidence: Record<Confidence, Array<{ mf: MemoryFile; scope: string }>> = {
      fact: [],
      reference: [],
      background: [],
      suppressed: [],
    };

    for (const item of itemsToLoad) {
      const c = item.mf.confidence || 'reference';
      if (c === 'suppressed') continue;
      byConfidence[c].push(item);
    }

    const parts: string[] = [];

    if (itemsToLoad.length < allItems.length && allItems.length > MEMORY_LIMIT) {
      parts.push(`> 📌 记忆库共 ${allItems.length} 条，已按当前图上下文过滤显示 ${itemsToLoad.length} 条最相关的。`);
    }

    if (byConfidence.fact.length > 0) {
      parts.push('### 🔒 铁律 (fact)\n用户明确要求的规则。仅作提醒——Agent 仍需基于代码和约束做决策:\n');
      for (const { mf, scope } of byConfidence.fact) {
        parts.push(formatMemoryLine(mf, scope));
      }
    }

    if (byConfidence.reference.length > 0) {
      parts.push('### 📋 参考 (reference)\nAgent 发现或用户提过的信息。可以参考，引用时带核实语气:\n');
      for (const { mf, scope } of byConfidence.reference) {
        parts.push(formatMemoryLine(mf, scope));
      }
    }

    if (byConfidence.background.length > 0) {
      parts.push('### 🎨 背景 (background)\n用于调整回复风格和语气，不需要在回复中提及:\n');
      for (const { mf, scope } of byConfidence.background) {
        parts.push(formatMemoryLine(mf, scope));
      }
    }

    const section = parts.length > 0 ? parts.join('\n') : '暂无已保存的记忆。';
    this._promptSectionCache = section;
    this._promptSectionCacheTime = now;
    return section;
  }

  // ── 写入 ──

  /** 保存记忆（创建或更新）。同时更新 MEMORY.md 索引。
   *  更新时保留已有的 hit_count。置信度默认为 'reference'。
   *  返回值 = 给回执用的派生读数（新建还是更新 / 正文字符数 / 落点路径，2026-09-16
   *  反馈回路审计：回执此前只有"已保存"+名称回显，模型无法核对入库结果）。 */
  async save(
    name: string,
    description: string,
    type: 'user' | 'feedback' | 'project' | 'reference',
    content: string,
    confidence: Confidence = 'reference',
    scope: 'project' | 'global' = 'project',
  ): Promise<{ created: boolean; bytes: number; path: string }> {
    let hitCount = 0;
    const existing = await this.read(name, scope);
    if (existing) {
      hitCount = existing.hit_count || 0;
    }
    const created = !existing;

    const mf: MemoryFile = {
      name,
      description,
      type,
      confidence,
      hit_count: hitCount,
      content,
      raw: '',
    };
    const frontmatter = rebuildRaw(mf);

    await kernelWriteFile(this.filePath(name, scope), frontmatter);

    const title = description.length > 40 ? description.slice(0, 39) + '…' : description;
    await this.upsertIndex(title, name + '.md', description, scope);

    this._promptSectionCache = null;
    return { created, bytes: content.length, path: this.filePath(name, scope) };
  }

  /** 按名称删除记忆——**真删**：索引行与记忆文件一并从盘上抹除。
   *  返回 true = 索引行 / 文件至少清掉一样；false = 两处都不存在。
   *
   *  2026-09-20 墓碑退役（与全仓同款的权威翻转；先例：会话卷 Phase 3b、
   *  board-persistence、goal-manager、message-store 早改真删）：旧实现把记忆文件
   *  改写成 16 字节 `{"deleted":true}` 了事——文件不死，而且因为「文件在 = 照索引
   *  读」绕开了 loadPromptSection 的缺文件容错，残渣被注入**每一个**新会话的记忆库段。
   *  删除必须让文件消失：「文件不在 = 记忆不存在」。
   *  索引整文件读-改-写经 enqueueIndexWrite 串行化——同批并发删除各自读同一份索引
   *  再整写回，最后一个写者会复活别人删掉的行（2026-09-19 真机事故形状）。 */
  async delete(name: string, scope: 'project' | 'global' = 'project'): Promise<boolean> {
    const removedIndexLine = await enqueueIndexWrite(this.indexPath(scope), async () => {
      let index = await this.loadIndexText(scope);
      if (!index.trim()) return false;

      const pattern = new RegExp(`^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(name)}\\.md\\)\\s+[—–-]\\s+.+$\\n?`, 'm');
      if (!pattern.test(index)) return false;

      index = index
        .replace(pattern, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (index) index += '\n';

      await kernelWriteFile(this.indexPath(scope), index);
      return true;
    });

    // 真删文件：先探存在性（读得到 = 在），再删。`fs_cap delete` 对缺失路径会抛错，
    // 故不盲删；真删失败**上抛不吞**（错误不静默——写入/持久化失败必须可见）。
    // 探针自身读失败一律当「不在」（多数情况确实如此——这条记忆本就没文件）；
    // 万一真是故障导致文件残留，它也进不了注入面与列表（读侧判据兜底），不会复活成记忆。
    let existed = true;
    try {
      await kernelReadFile(this.filePath(name, scope));
    } catch {
      existed = false;
    }
    if (existed) await kernelDeleteFile(this.filePath(name, scope));

    this._promptSectionCache = null;
    return removedIndexLine || existed;
  }

  private async upsertIndex(
    title: string,
    file: string,
    description: string,
    scope: 'project' | 'global' = 'project',
  ): Promise<void> {
    // 与 delete 共用同一条索引写链：save 与 delete 并发时也不再互相覆盖。
    await enqueueIndexWrite(this.indexPath(scope), async () => {
      let index = await this.loadIndexText(scope);
      const newLine = `- [${title}](${file}) — ${description}`;

      const pattern = new RegExp(
        `^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(file.replace(/\.md$/, ''))}\\.md\\)\\s+[—–-]\\s+.+$`,
        'm',
      );
      if (pattern.test(index)) {
        index = index.replace(pattern, newLine);
      } else {
        index = index.trimEnd();
        if (index) index += '\n';
        index += newLine + '\n';
      }

      await kernelWriteFile(this.indexPath(scope), index);
    });
  }
}

// ── Frontmatter 解析 ──

function parseFrontmatter(raw: string): MemoryFile {
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (!fmMatch) {
    return {
      name: 'unknown',
      description: '',
      type: 'reference',
      confidence: 'reference',
      hit_count: 0,
      content: raw,
      raw,
    };
  }

  const fm = fmMatch[1];
  const body = fmMatch[2].trim();

  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || 'unknown';
  const desc = (fm.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '';
  // ponytail: 同时接受缩进格式（在 metadata: 下）和顶层格式
  const typeRaw = (fm.match(/^\s*type:\s*(.+)$/m) || [])[1]?.trim() || 'reference';
  const type = (['user', 'feedback', 'project', 'reference'] as const).includes(typeRaw as MemoryFile['type'])
    ? (typeRaw as MemoryFile['type'])
    : 'reference';
  const confRaw = (fm.match(/^\s*confidence:\s*(.+)$/m) || [])[1]?.trim() || 'reference';
  const confidence = (['fact', 'reference', 'background', 'suppressed'] as const).includes(confRaw as Confidence)
    ? (confRaw as Confidence)
    : 'reference';
  const hitCountRaw = (fm.match(/^\s*hit_count:\s*(\d+)$/m) || [])[1];
  const hit_count = hitCountRaw ? parseInt(hitCountRaw, 10) : 0;

  return { name, description: desc, type, confidence, hit_count, content: body, raw };
}

function rebuildRaw(mf: MemoryFile): string {
  return [
    '---',
    `name: ${mf.name}`,
    `description: ${mf.description}`,
    'metadata:',
    `  type: ${mf.type}`,
    `  confidence: ${mf.confidence}`,
    `  hit_count: ${mf.hit_count}`,
    '---',
    '',
    mf.content,
  ].join('\n');
}

// ── 辅助函数 ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function formatMemoryLine(m: MemoryFile, scope?: string): string {
  const body = m.content.length > 120 ? m.content.slice(0, 119) + '…' : m.content;
  const tag = scope === 'global' ? ' [全局]' : '';
  return `- **${m.description}**${tag} — ${body}`;
}

/** 评估记忆与当前图上下文的相关性。
 *  分数越高 = 越可能与用户正在做的事相关。
 *  ponytail: 对图节点名做简单子串匹配 — 无需 LLM 调用。 */
function scoreMemoryRelevance(mf: MemoryFile, graphNodes: string[]): number {
  let score = 0;
  const haystack = (mf.description + ' ' + mf.content + ' ' + mf.name).toLowerCase();

  for (const node of graphNodes) {
    const lower = node.toLowerCase();
    // 节点名精确匹配记忆内容
    if (haystack.includes(lower)) {
      score += 3;
      // 文件名部分匹配（/ 或 \ 后的最后一段）→ 更强信号
      const filePart = lower.split(/[/\\]/).pop() || '';
      if (filePart && filePart !== lower && haystack.includes(filePart)) {
        score += 2;
      }
    } else {
      // 部分词匹配
      const parts = lower.split(/[/\\:.#_-]/);
      for (const part of parts) {
        if (part.length > 2 && haystack.includes(part)) {
          score += 1;
        }
      }
    }
  }

  // 加权: 最近被回想的记忆可能更相关
  score += Math.min(mf.hit_count, 5);

  return score;
}

// ── Agent 工具 ──

/** 创建记忆操作的 Agent 工具。所有工具都基于指定的 MemoryManager。
 *  批 9h-4：入参取**内核契约面** `MemoryManagerFace`（工具行材料经 `composition/tool-rows.ts`
 *  把工作区建好的实例交进来；实现只需面里的 8 个成员）。 */
export function createMemoryTools(mm: MemoryManagerFace): Tool[] {
  return [
    defineTool({
      name: 'hologram_memory_list',
      description:
        '列出所有已保存的记忆及其置信度和所属范围（项目/全局）。保存新记忆前，先调用此工具检查是否已有类似记忆——已有则用 hologram_memory_save 更新而非新建。',
      schema: z.object({}),
      readOnly: true,
      execute: async () => {
        const sections: string[] = [];
        // 先显示全局，再显示项目
        const allScopes = mm.scopes?.() || ['project'];
        for (const scope of allScopes) {
          const entries = await mm.list(scope);
          if (entries.length === 0) continue;
          const label = scope === 'global' ? '🌐 全局记忆' : '📁 项目记忆';
          const rows: string[] = [];
          for (const e of entries) {
            const mf = await mm.read(e.name, scope);
            // 索引行残留（旧墓碑 / 文件已删 / 垃圾档）= 不列：列表不得把不存在的
            // 记忆报成活的（2026-09-20 彻查副产物——旧实现照索引回显标题摘要）。
            if (!mf) continue;
            const conf = mf.confidence || 'reference';
            const confTag = { fact: '[fact]', reference: '[ref]', background: '[bg]', suppressed: '[sup]' }[conf];
            const hit = mf.hit_count ? ` · 回想${mf.hit_count}次` : '';
            rows.push(`- ${confTag} **${e.title}** (\`${e.name}\`)${hit} — ${e.description}`);
          }
          if (rows.length === 0) continue;
          sections.push(`### ${label}`);
          sections.push(...rows);
        }
        return sections.length > 0 ? sections.join('\n') : '暂无已保存的记忆。';
      },
    }),
    defineTool({
      name: 'hologram_memory_read',
      description: '读取一条已保存记忆的完整内容。需要回忆具体事实、用户偏好或过往决策时使用。每次读取会记录回想次数。',
      schema: z.object({
        name: z.string().describe('记忆名称（不含 .md 扩展名），从 hologram_memory_list 获取'),
        scope: z
          .enum(['project', 'global'])
          .optional()
          .describe('记忆范围。project=当前项目，global=跨所有项目共享。默认从 list 中看到的范围推断。'),
      }),
      readOnly: true,
      execute: async (args) => {
        const name = args.name;
        const scope = args.scope || 'project';
        const mf = await mm.read(name, scope, true);
        if (!mf) return `未找到记忆 "${name}"。用 hologram_memory_list 查看所有记忆。`;
        const confLabels: Record<Confidence, string> = {
          fact: '🔒 铁律 — 用户明确要求。仅作提醒，不替代代码决策',
          reference: '📋 参考 — 可以参考，引用时带核实语气',
          background: '🎨 背景 — 用于调整风格，无需在回复中提及',
          suppressed: '🚫 已抑制',
        };
        const scopeLabel = scope === 'global' ? ' [全局]' : ' [项目]';
        return [
          `## ${mf.description || mf.name}${scopeLabel}`,
          `类型: ${mf.type}`,
          `置信度: ${confLabels[mf.confidence] || mf.confidence}`,
          `回想次数: ${mf.hit_count}`,
          '',
          mf.content,
        ].join('\n');
      },
    }),
    defineTool({
      name: 'hologram_memory_save',
      description:
        '保存或更新一条记忆。保守使用——只记代码库查不到且未来会话忘了会出错的东西。\n\n' +
        '置信度级别:\n' +
        '- reference (默认) — Agent 自己发现的信息最高只能给此级别\n' +
        '- fact — 仅用户通过 /remember 命令明确要求时才能使用\n' +
        '- background — 仅影响风格/语气\n' +
        '- suppressed — 已废弃，不再给 LLM 看到\n\n' +
        '记忆范围 (scope):\n' +
        '- project (默认) — 仅当前项目可见，适合架构决策、项目约定\n' +
        '- global — 跨所有项目可见，适合用户偏好、编码风格、个性\n\n' +
        '先 hologram_memory_list 检查是否已有类似记忆——已有则更新而非新建。',
      schema: z.object({
        name: z.string().describe('简短的 kebab-case 名称（只含小写字母数字和连字符），如 "user-prefers-concise"'),
        description: z.string().describe('一句话摘要，用于快速判断是否相关'),
        type: z
          .enum(['user', 'feedback', 'project', 'reference'])
          .describe('记忆类型: user=用户画像, feedback=用户反馈/要求, project=项目决策/进展, reference=外部参考'),
        confidence: z
          .enum(['fact', 'reference', 'background', 'suppressed'])
          .optional()
          .describe('置信度。Agent 自己最高只能给 reference。fact 只有用户明确要求时才能用。默认: reference'),
        content: z
          .string()
          .describe('记忆正文。对于 feedback/project 类型，应包含 **Why:** 和 **How to apply:** 段落。'),
        scope: z
          .enum(['project', 'global'])
          .optional()
          .describe(
            '记忆范围。project=仅当前项目，global=跨所有项目共享。用户偏好/编码风格 → global；架构决策/项目约定 → project。默认: project',
          ),
      }),
      execute: async (args) => {
        let confidence = args.confidence || 'reference';
        let factDowngraded = false;
        const authorized = consumeFactAuthorization();
        if (confidence === 'fact') {
          if (authorized) {
            // /remember 已授权 — fact 通过
          } else {
            confidence = 'reference';
            factDowngraded = true;
          }
        }
        const scope = args.scope || 'project';
        const saved = await mm.save(args.name, args.description, args.type, args.content, confidence, scope);
        // H1: 通知 workspace 以扇出（UI 总线 + 活跃 Agent 注入）
        mm.onSaved?.({
          name: args.name,
          description: args.description,
          confidence,
          scope,
        });
        const downgradeNote = factDowngraded ? ' (注意: fact 级别需用户授权，已自动降为 reference)' : '';
        const scopeNote = scope === 'global' ? ' [全局]' : '';
        const kindNote = saved.created ? '新建' : '更新（保留原 hit_count）';
        return (
          `已保存记忆 "${args.name}" (${confidence})${scopeNote}：${kindNote}，正文 ${saved.bytes} 字符 → ${saved.path}。${downgradeNote}` +
          '要核对/回读用 memory(list)（看 confidence/hit）或 memory(read)（读正文）。'
        );
      },
    }),
    defineTool({
      name: 'hologram_memory_delete',
      description: '删除一条已保存的记忆。当用户要求忘记某条信息，或某条记忆已过时/错误时使用。',
      schema: z.object({
        name: z.string().describe('要删除的记忆名称（不含 .md 扩展名）'),
        scope: z.enum(['project', 'global']).optional().describe('记忆范围。默认: project'),
      }),
      execute: async (args) => {
        const name = args.name;
        const scope = args.scope || 'project';
        const ok = await mm.delete(name, scope);
        return ok
          ? `已删除记忆 "${name}"。`
          : `未找到记忆 "${name}"，可能已被删除。用 hologram_memory_list 查看当前记忆列表。`;
      },
    }),
  ];
}
