// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 启动自愈面（boot recovery，2026-10-29 事故立法）——**「Agent 改自己把界面改没了」的兜底**。
//
// 病灶（实机事故，2026-10-29 19:57）：
//   兰台给自己加了 5 个 faceDeps 键 ⇒ 宿主面指纹 3840339f → d57775e9；
//   它重建了 40 个产物却没重建 exe ⇒ 运行中的 app 触发产物热重载（先拆后拒，
//   现已修为「先验后拆」）⇒ 全部产物缺席 ⇒ 纸壳/案卷首页/任务域一起没了。
//   重启之后：
//     · `auditBoot` 只看**已装载的 fiber**，产物在 manifest 闸就被拒 ⇒ 一个 fiber 都没建
//       ⇒ 审计**全绿**（假绿！）；
//     · `initLogger` 要到 `Workspace.open` 才跑 ⇒ 早于它的失败**一条日志都没有**；
//     · `<App/>` 的 home 槽来自产物 sessions-home ⇒ 渲染出**纯白**。
//   三个面同时哑掉，用户看到的就是「白屏、没日志、没提示」——这就是「僵住」。
//
// 本模块的职责边界（刻意只做判定，不做 IO）：给 `diagnoseBoot` 喂三样事实
//（异常 / 插件记录 / home 槽贡献数），换回一个**可渲染、可行动**的失败面。
// 渲染在 `app/BootRecovery.tsx`（内核组件，零产物依赖），引导在 `main.ts`。
//
// 两条纪律：
//   ① 判定必须是纯函数（测试可穷举，不依赖真实启动）；
//   ② 失败面必须**可行动**——每条建议都得是用户/Agent 能照着做的一步，
//      不写「请联系支持」这种废话。

import type { PluginRecord } from '../state/plugin-store';

/** 失败分类（决定文案与建议；不是错误码，别拿它做分支条件以外的用途）。 */
export type BootFailureKind = 'skew' | 'product' | 'audit' | 'shell' | 'empty-shell' | 'safe-mode';

/** 可直接渲染的启动失败面。 */
export interface BootFailure {
  kind: BootFailureKind;
  /** 一句话结论（标题下第一行——用户只读这一行也该知道怎么回事）。 */
  summary: string;
  /** 逐条证据（插件名 —— 原因 / 异常首行）。 */
  evidence: string[];
  /** 修复步骤（按顺序照做）。 */
  hints: string[];
}

/** 诊断输入——三样事实，全部来自可观测面（不猜）。 */
export interface BootDiagnosisInput {
  /** 引导链抛出的异常（boot 审计 / 壳行 / 未捕获）；null = 没抛。 */
  error: unknown;
  /** plugin-store 里的记录（产物装载结果全在这里——auditBoot 看不见它们）。 */
  records: readonly PluginRecord[];
  /** 壳起来之后 home 槽的贡献数（0 = 主界面没东西可渲染 = 白屏）。 */
  homeViews: number;
  /** 日志路径（仅用于建议文案；缺失就不写这一条）。 */
  logPath?: string | null;
}

/** 产物装载失败记录（error / blocked——disabled 是用户意愿，不算失败）。 */
export function failedProducts(records: readonly PluginRecord[]): PluginRecord[] {
  return records.filter((r) => r.meta?.kind === 'feature' && (r.status === 'error' || r.status === 'blocked'));
}

/** 宿主面偏斜判据：消息里带指纹闸/键集闸的具名原因（loader 两闸文案）。 */
export function isSkewError(record: PluginRecord): boolean {
  const text = record.error ?? '';
  return text.includes('宿主面版本偏斜') || text.includes('宿主面缺键');
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 证据列表（截断到 `limit` 条，余数如实记账——不静默丢）。 */
function evidenceOf(records: readonly PluginRecord[], limit = 12): string[] {
  const out = records.slice(0, limit).map((r) => r.name + ' —— ' + (r.error ?? r.status));
  if (records.length > limit)
    out.push('…另有 ' + (records.length - limit) + ' 条同类失败（完整清单见插件设置页 / ui.log）');
  return out;
}

/** 纯判定：给定事实 ⇒ 启动失败面。返回 null = 一切正常（可以继续渲染 App）。
 *
 *  ⚡ 因果优先序（2026-10-29 事故复盘）：**产物失败 > 引导异常 > 首帧空壳**。
 *  反过来的话，「产物被拒 ⇒ bootShell 连带抛错」会报成「壳行抛错」，用户顺着
 *  异常栈去改壳代码，而真凶是 exe 与产物不同源——诊断面必须先把根因摆第一。 */
export function diagnoseBoot(input: BootDiagnosisInput): BootFailure | null {
  const bad = failedProducts(input.records);
  const logHint = input.logPath ? ['日志：' + input.logPath] : [];
  const errLine = input.error != null ? ['（引导链同时报错：' + errText(input.error).split('\n')[0] + '）'] : [];

  // ① 出厂产物装载失败（根因层）：分「宿主面偏斜」与「其它」——前者是 2026-10-29
  //    那类事故，给出重建指引就够；后者要用户看具体插件。
  if (bad.length > 0) {
    const skew = bad.length > 0 && bad.every(isSkewError);
    return {
      kind: skew ? 'skew' : 'product',
      summary: skew
        ? '产物与 exe 不同源（宿主面指纹对不上）——' + bad.length + ' 个出厂产物被拒载'
        : bad.length + ' 个出厂产物装载失败',
      evidence: [...evidenceOf(bad), ...errLine],
      hints: skew
        ? [
            '这批改动动了宿主面（faceDeps）⇒ 产物必须与 exe 同源重建，只重建 dist-plugins 一定被拒',
            '重建 exe：双击 build.cmd（等价 cargo tauri build），或 cargo build --release -p lantai 只出 exe',
            ...logHint,
          ]
        : [
            '先看上面每个产物的原因（多半是 manifest / face.json / 入口导出形状）',
            '重建成物：npm --prefix src-ui run build（会自动重建 40 个内置产物）',
            '改过宿主面 ⇒ 还必须重建 exe（build.cmd）',
            ...logHint,
          ],
    };
  }

  // ② 引导链抛错：boot 审计（fail-loud）优先于其它异常——它带逐 fiber 清单。
  if (input.error != null) {
    const msg = errText(input.error);
    const isAudit = msg.includes('[boot-gate]');
    return {
      kind: isAudit ? 'audit' : 'shell',
      summary: isAudit ? '内核插件没有全部装载成功（boot 审计 fail-loud）' : '壳行引导过程中抛错，界面没能起来',
      evidence: msg.split('\n').slice(0, 14),
      hints: isAudit
        ? [
            '按上面列出的插件名逐个排查（内核 13 件 = src-ui/src/plugins/service-plugins.ts）',
            '改过 src-ui/src/** 内核面 ⇒ 必须重建 exe（build.cmd）——只重建 dist-plugins 不会生效',
            ...logHint,
          ]
        : ['异常原文见上；改过前端代码 ⇒ npm --prefix src-ui run build 后再重建 exe（build.cmd）', ...logHint],
    };
  }

  // ③ 壳起来了但主界面空：home 槽（案卷首页）没有任何贡献 = 用户看到白屏。
  //    这是「假绿审计」的兜底——auditBoot 只看 fiber，产物缺席它看不见。
  if (input.homeViews === 0) {
    return {
      kind: 'empty-shell',
      summary: '壳引导完成，但主界面没有任何内容可渲染（案卷首页缺席）',
      evidence: ['home 槽贡献数 = 0（sessions-home / paper-shell 属 required 出厂产物）'],
      hints: [
        '多半是产物被拒载或贡献通道空——看设置 › 插件 的失败清单',
        '重建：npm --prefix src-ui run build（产物）＋ build.cmd（exe，改过宿主面时必须）',
        ...logHint,
      ],
    };
  }

  return null;
}

/** 强制安全模式（本次启动跳过全部产物装载，只出诊断面）。 */
export type SafeModeRequest = { forced: true; reason: 'user' | 'attempts' } | { forced: false; reason: null };

/** 安全模式的判定面（纯函数；存储读写留在 main.ts，便于测试）。 */
export function safeModeRequest(attempts: number, stored: boolean, maxAttempts = 2): SafeModeRequest {
  if (stored) return { forced: true, reason: 'user' };
  if (attempts > maxAttempts) return { forced: true, reason: 'attempts' };
  return { forced: false, reason: null };
}

/** 安全模式的说明面（进 BootFailure，让用户知道「为什么这次什么都没有」）。 */
export function safeModeFailure(reason: 'user' | 'attempts', attempts: number): BootFailure {
  return {
    kind: 'safe-mode',
    summary:
      reason === 'user'
        ? '安全模式：本次启动跳过了全部出厂产物装载'
        : '安全模式：连续 ' + attempts + ' 次启动都没到首帧，已自动跳过产物装载',
    evidence: [
      '产物装载被跳过（dist-plugins 未参与本次启动）——这是刻意的：先让界面能出来，再谈修',
      '退出方式：点「退出安全模式并重新加载」；若仍失败，按下面建议重建',
    ],
    hints: [
      '改过宿主面（faceDeps）⇒ 重建 exe：build.cmd',
      '只改过插件源码 ⇒ npm --prefix src-ui run build 后重新加载界面',
      '连续失败计数存在 localStorage，退出安全模式时会清零',
    ],
  };
}
