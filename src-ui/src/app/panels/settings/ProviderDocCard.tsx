// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 配置文件卡片（2026-09-24 配方改文件批）——设置页里「配方」这件事的**全部界面**。
//
// 背景（本卡要根治的病灶）：配方此前是设置页里一段剪贴板 JSON，靠「导出/导入」
// 两个按钮搬运——没有落点、不能 diff、agent 碰不到。现在 provider 的连接配置
// 就是一份磁盘 YAML（`~/.lantai/providers.yml`）：复制文件即导入，文件本身即
// 导出，agent 用 fs 工具直接改，改完约 1 秒热生效。
//
// 本卡只做四件事（不再有导入/导出的模态文本框）：
//   1. 亮出路径——让人知道该去改哪个文件；
//   2. 报错点名——手写错了就说是哪一节错在哪（错误不静默，坏节只坏自己）；
//   3. 打开目录 / 重读两个入口（重读是 watcher 之外的第二条路）；
//   4. 没配过时给一个「写骨架」的即时动作（首启空文件也能一眼看懂格式）。

import type React from 'react';
import type { ProviderDocView } from './ProviderDetail';

interface ProviderDocCardProps {
  doc: ProviderDocView;
  /** 当前详情页的 provider 名——错误里属于它的那几条置顶（其余折叠展示）。 */
  myName: string;
  onOpenDir: () => void;
  onReload: () => void;
  msg: string;
}

export function ProviderDocCard({ doc, myName, onOpenDir, onReload, msg }: ProviderDocCardProps) {
  const mine = doc.status.errors.filter((e) => e.name === myName);
  const others = doc.status.errors.filter((e) => e.name !== myName);
  const projectMine = doc.projectErrors.filter((e) => e.name === myName);

  return (
    <div className="pp-card">
      <div className="pp-card-hd">
        <span className="pp-card-title">配置文件</span>
        <span className="pp-rule" />
      </div>

      <div className="pp-field">
        <div className="pp-f-label-row">
          <span className="pp-f-label">provider 配置</span>
          <button type="button" className="sp-btn-sm" title="用系统文件管理器打开所在目录" onClick={onOpenDir}>
            打开目录
          </button>
          <button
            type="button"
            className="sp-btn-sm"
            title="手改过文件后立即重读（改完约 1 秒也会自动生效）"
            onClick={onReload}
          >
            重读
          </button>
        </div>
        <div className="pp-doc-path" title={doc.path || '（还没读到路径）'}>
          {doc.path || (doc.status.loaded ? '配置文件路径不可用' : '装载中…')}
        </div>
        <div className="pp-f-hint">
          人和 agent 都可以直接改这个文件——一行 provider =一个顶层键，键名就是 provider 身份；改完约 1
          秒即生效。密钥不在文件里（权威在本机系统凭据）。
        </div>
      </div>

      {doc.staleHint && (
        <div className="pp-doc-error">
          <b>配置文件刚被（人或 agent）改过，但本页有未保存的改动：</b>
          <div className="pp-f-hint">
            为避免冲掉你正在编辑的内容，面板没有替换。保存或放弃当前改动后即可看到文件里的新配置。
          </div>
        </div>
      )}

      {doc.status.fatal && (
        <div className="pp-doc-error">
          <b>配置文件整份无法解析，运行中仍是上一次可用的配置：</b>
          <div className="pp-doc-error-body">{doc.status.fatal}</div>
          <div className="pp-f-hint">
            修好文件后点上方「重读」（或等约 1 秒）——解析不了时兰台不会写这个文件，你的手稿不会被覆盖。
          </div>
        </div>
      )}

      {(mine.length > 0 || projectMine.length > 0) && (
        <div className="pp-doc-error">
          <b>「{myName}」这一节有问题，本行仍用上一次可用的配置：</b>
          {[...mine, ...projectMine].map((e) => (
            <div key={`${e.name}-${e.message}`} className="pp-doc-error-body">
              {e.message}
            </div>
          ))}
          <div className="pp-f-hint">其余 provider 不受影响；改好这一节即恢复。</div>
        </div>
      )}

      {others.length > 0 && (
        <div className="pp-field">
          <div className="pp-f-label-row">
            <span className="pp-f-label">其它节的问题</span>
            <span className="pp-chip">{others.length} 个</span>
          </div>
          {others.map((e) => (
            <div key={`${e.name}-${e.message}`} className="pp-doc-other" title={e.message}>
              <span className="pp-doc-other-name">{e.name}</span>
              <span className="pp-doc-other-msg">{e.message.split('\n')[0]}</span>
            </div>
          ))}
        </div>
      )}

      {doc.projectFatal && (
        <div className="pp-doc-error">
          <b>本项目的配置文件（.lantai/providers.yml）整份无法解析：</b>
          <div className="pp-doc-error-body">{doc.projectFatal}</div>
        </div>
      )}

      {doc.projectErrors.length > 0 && (
        <div className="pp-field">
          <div className="pp-f-label-row">
            <span className="pp-f-label">本项目配置的节问题</span>
            <span className="pp-chip">{doc.projectErrors.length} 个</span>
          </div>
          {doc.projectErrors.map((e) => (
            <div key={`p-${e.name}-${e.message}`} className="pp-doc-other" title={e.message}>
              <span className="pp-doc-other-name">{e.name}</span>
              <span className="pp-doc-other-msg">{e.message.split('\n')[0]}</span>
            </div>
          ))}
          <div className="pp-f-hint">
            项目级配置（工作区下 .lantai/providers.yml）同 id 覆盖用户级；同 id 的节整节替换。
          </div>
        </div>
      )}

      {msg && <div className="pp-f-hint">{msg}</div>}
    </div>
  );
}
