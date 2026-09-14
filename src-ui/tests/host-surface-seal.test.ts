// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 宿主面基线封印（保险丝 a′，2026-09-14 立法）——把「本批是否动了宿主面」变成
// 一份可 diff 的基线文件 + 一个当场会红的测试。
//
// 事故复盘（同日乙 批）：宿主面（faceDeps）新增 INK_FAIL / buildTocInkBuckets 两个键，
// 产物按「只换产物」部署进运行中的 exe → face.json 声明的键在旧 exe 里缺席
// → 保险丝 a 开火拒载；又因 S5 已退役 displace 兜底（产物是唯一装载面），
// 结果是 compose-dock **整面缺席**（创作坞 + 目次带一起消失），且作者期无任何信号。
//
// 本封印的契约：
//   1. `src/plugins/host-surface.baseline.json` = 键集（排序）+ 指纹，**改宿主面必须
//      同 commit 更新它**（本用例红即提醒；`npm run gen:host-surface` 重生成）；
//   2. 构建脚本（scripts/build-builtin-plugins.mjs）把指纹写进每个产物 face.json，
//      并**与本批 HEAD 的基线对比**——变了就大字告警「产物热更需重建 exe」；
//   3. 装载器拿产物声明指纹与运行时对拍，报错升级为「产物需宿主面 <a>，当前 exe <b>」。
//
// 生成/更新基线：`npm run gen:host-surface`（= HOST_SURFACE_RECORD=1 跑本文件）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { faceDepsKeys, hostSurfaceFingerprint } from '../src/plugins/builtin/host-modules';

const BASELINE = join(__dirname, '..', 'src', 'plugins', 'host-surface.baseline.json');

interface HostSurfaceBaseline {
  fingerprint: string;
  keys: string[];
}

describe('宿主面基线封印（产物热更 vs 宿主面）', () => {
  it('faceDeps 键集与指纹同基线（改宿主面 → 必须同 commit 重生成基线）', () => {
    const keys = [...faceDepsKeys()].sort();
    const fingerprint = hostSurfaceFingerprint();
    if (process.env.HOST_SURFACE_RECORD === '1') {
      writeFileSync(BASELINE, `${JSON.stringify({ fingerprint, keys }, null, 2)}\n`, 'utf8');
    }
    expect(existsSync(BASELINE), `基线缺失——跑 npm run gen:host-surface 生成 ${BASELINE}`).toBe(true);
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as HostSurfaceBaseline;
    expect(
      baseline.fingerprint,
      '宿主面变了或基线过期：本批触及 faceDeps 面——产物不能只换产物热更（需重建 exe）；' +
        '确认无误后跑 npm run gen:host-surface 更新基线并同 commit 提交，' +
        '构建脚本会据此在构建期告警、装载器据此精确报错',
    ).toBe(fingerprint);
    expect(baseline.keys).toEqual(keys);
  });

  it('指纹稳定且敏感：与键序无关；增/删/改名任一键都换指纹', () => {
    const a = hostSurfaceFingerprint(['alpha', 'beta', 'gamma']);
    expect(hostSurfaceFingerprint(['gamma', 'alpha', 'beta'])).toBe(a); // 排序归一
    expect(hostSurfaceFingerprint(['alpha', 'beta'])).not.toBe(a); // 删键
    expect(hostSurfaceFingerprint(['alpha', 'beta', 'gamma', 'delta'])).not.toBe(a); // 加键
    expect(hostSurfaceFingerprint(['alpha', 'beta', 'gammb'])).not.toBe(a); // 改名
    expect(hostSurfaceFingerprint(['ab', 'c'])).not.toBe(hostSurfaceFingerprint(['a', 'bc'])); // 分隔符
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
