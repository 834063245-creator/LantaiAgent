// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 正文行内文件引用的可点组件（2026-11-24 可点判定收紧批；从 renderers.tsx 拆出，
// 守住 paper-renderers 的上帝文件预算）。
//
// 判据：`paper/file-ref` 说这串像本机文件；`file-open` 的 stat 门禁说它确实存在、
// 不是目录、文卷能打开。两者都成立才出可点签；否则保持普通 code / 不可点字面。
// tooltip 只给 stat 回来的真实路径——不再展示拼出来的假路径。

import { openReferencedFile, useOpenableRef } from './file-open';

/** 行内码里的文件引用：**先 stat 核实**再出可点签。
 *  不可开 = 普通 code（不闪链接、不给假路径 tooltip）。 */
export function InlineCodeRef({ text }: { text: string }) {
  const ref = useOpenableRef(text);
  const path = ref.path;
  if (ref.state === 'openable' && path !== null) {
    return (
      <button type="button" className="pp-md-ci pp-md-ci--ref" data-tip={path} onClick={() => openReferencedFile(path)}>
        {text}
      </button>
    );
  }
  return <code className="pp-md-ci">{text}</code>;
}

/** Markdown 链接：外部 URL 照旧走浏览器；本机文件先 stat 核实，开得了才拦导航进文卷。
 *  保留原 href（锚点语义/可访问性）；不可开的本地路径落成不可点的同款字面。 */
export function InlineLinkRef({ href, text }: { href: string; text: string }) {
  const ref = useOpenableRef(href);
  const path = ref.path;
  if (!ref.local) {
    return (
      <a className="pp-md-a" href={href} target="_blank" rel="noreferrer">
        {text}
      </a>
    );
  }
  if (ref.state === 'openable' && path !== null) {
    return (
      <a
        className="pp-md-a"
        href={href}
        data-tip={path}
        onClick={(e) => {
          e.preventDefault();
          openReferencedFile(path);
        }}
      >
        {text}
      </a>
    );
  }
  return <span className="pp-md-a pp-md-a--dead">{text}</span>;
}
