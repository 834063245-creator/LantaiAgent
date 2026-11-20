// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板式 store 的共享持久化基础设施（TaskBoard、DiscoveryBoard）。
// 处理目录创建、防抖文件 I/O 和生命周期管理（destroy/flush/restore）。

import {
  isKernelFileMissingError,
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelReadFile,
  kernelWriteFile,
} from '../rpc-contract';

/** 规范化项目路径：正斜杠，无尾部斜杠。 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

export interface BoardPersistenceOptions {
  projectPath: string;
  sessionId: string;
  /** .lantai/ 下的子目录名（如 "taskboard"、"discoveries"） */
  dirName: string;
}

/** 管理面板的防抖文件持久化。
 *  面板提供序列化/反序列化钩子；此类处理
 *  目录创建、文件 I/O、flush 防抖和清理。 */
export class BoardPersistence {
  private _projectPath: string;
  private _sessionId: string;
  private _dirName: string;
  private _dirReady = false;
  private _destroyed = false;
  private _flushWarned = false;
  /** 读失败后**禁止落盘**：把「读不出来」当「没有历史」会让下一次 flush 用空表
   *  覆盖盘上仍完好的文件（一次瞬时 IPC 失败 = 整张板清零）。 */
  private _writesBlocked = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 串行写链 — 立即 flush 与防抖 flush 并发时按调用序落盘，后写者赢。 */
  private _writeChain: Promise<void> = Promise.resolve();

  constructor(opts: BoardPersistenceOptions) {
    this._projectPath = opts.projectPath;
    this._sessionId = opts.sessionId;
    this._dirName = opts.dirName;
  }

  get projectPath(): string {
    return this._projectPath;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  get writesBlocked(): boolean {
    return this._writesBlocked;
  }

  /** 调用方在 restore 失败后调用——此后所有 flush 一律丢弃，直到进程重启。 */
  blockWrites(error: unknown): void {
    if (this._writesBlocked) return;
    this._writesBlocked = true;
    this.clearFlushTimer();
    console.warn(`[BoardPersistence] ${this._dirName}/${this._sessionId} 读失败——已停止落盘以免覆盖盘上数据:`, error);
  }

  private get _boardPath(): string {
    return normalizePath(this._projectPath) + '/.lantai/' + this._dirName + '/' + this._sessionId + '.json';
  }

  private async _ensureDir(): Promise<void> {
    if (this._dirReady) return;
    // 后端 create_dir_all 幂等——目录已存在不会报错，任何抛错都是真实失败。
    // 失败时不置 _dirReady：下次 flush 会重试，而不是永久静默丢盘。
    await kernelCreateDirectory(normalizePath(this._projectPath) + '/.lantai/' + this._dirName);
    this._dirReady = true;
  }

  /** 序列化 entries 并写入磁盘。尽力而为 — 永不抛异常，但失败会 warn 留信号。
   *  写入经 _writeChain 串行化：并发 flush（立即 + 防抖）按调用序落盘，避免旧快照后写覆盖新数据。 */
  async flush(data: string): Promise<void> {
    if (!this._projectPath || this._destroyed || this._writesBlocked) return;
    const snapshot = data;
    this._writeChain = this._writeChain.then(async () => {
      try {
        await this._ensureDir();
        await kernelWriteFile(this._boardPath, snapshot);
        this._flushWarned = false;
      } catch (e) {
        // 尽力而为但不静默：每段连续失败只 warn 一次，成功落盘后复位
        if (!this._flushWarned) {
          this._flushWarned = true;
          console.warn(`[BoardPersistence] ${this._dirName}/${this._sessionId} 落盘失败（后续 flush 会重试）:`, e);
        }
      }
    });
    return this._writeChain;
  }

  /** 读取并返回原始文件内容。**文件不存在 → null；其它失败 → throw**。
   *  调用方必须在 throw 时 `blockWrites()`（见上）——两者混为一谈会让空状态覆盖好文件。 */
  async restore(): Promise<string | null> {
    if (!this._projectPath) return null;
    try {
      return await kernelReadFile(this._boardPath);
    } catch (e) {
      if (isKernelFileMissingError(e)) return null;
      throw e;
    }
  }

  /** 调度防抖 flush（2 秒延迟）。回调提供序列化后的数据。 */
  scheduleFlush(getData: () => string): void {
    if (!this._projectPath || this._destroyed || this._writesBlocked) return;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush(getData());
    }, 2000);
  }

  /** 清除 flush 定时器 — destroy 时调用。 */
  clearFlushTimer(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /** 删除持久化文件并标记为已销毁。 */
  async destroy(): Promise<void> {
    if (!this._projectPath) return;
    this._destroyed = true;
    this.clearFlushTimer();
    // 先排空在途写链：已入队的快照会在删除之后落盘，把删掉的板文件原地复活。
    await this._writeChain.catch(() => {});
    try {
      await kernelDeleteFile(this._boardPath);
    } catch {
      /* 尽力而为 */
    }
  }
}
