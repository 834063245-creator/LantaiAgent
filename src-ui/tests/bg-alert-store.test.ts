// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// bg-alert-store 守护（R5 D5，拍板 C）：
//   - 同 id 失败态延续不刷新（「每次进入失败态弹一次」的账面基础）；
//   - 成功解除（clear）后再失败重新弹；
//   - 单槽语义：新失败源覆盖旧失败源，clear 只清同 id。
// StatusLine 消费面（警告档 + 一次性提示条）依赖这三条语义。

import { beforeEach, describe, expect, it } from 'vitest';
import { useBgAlertStore } from '../src/state/bg-alert-store';

describe('bg-alert-store（R5 D5 后台失败警报）', () => {
  beforeEach(() => {
    useBgAlertStore.setState({ bgAlert: null });
  });

  it('进入失败态设置警报', () => {
    useBgAlertStore.getState().pushBgAlert('canvas-save', '画布状态落盘失败');
    expect(useBgAlertStore.getState().bgAlert).toEqual({ id: 'canvas-save', msg: '画布状态落盘失败' });
  });

  it('同 id 失败态延续不刷新——失败态期间不重复弹', () => {
    useBgAlertStore.getState().pushBgAlert('canvas-save', '第一次');
    useBgAlertStore.getState().pushBgAlert('canvas-save', '第二次不应覆盖');
    expect(useBgAlertStore.getState().bgAlert?.msg).toBe('第一次');
  });

  it('成功解除（clear）后再失败重新弹', () => {
    useBgAlertStore.getState().pushBgAlert('canvas-save', '第一次');
    useBgAlertStore.getState().clearBgAlert('canvas-save');
    expect(useBgAlertStore.getState().bgAlert).toBeNull();
    useBgAlertStore.getState().pushBgAlert('canvas-save', '第二次');
    expect(useBgAlertStore.getState().bgAlert?.msg).toBe('第二次');
  });

  it('单槽：新失败源覆盖旧失败源，clear 只清同 id', () => {
    useBgAlertStore.getState().pushBgAlert('canvas-save', '落盘失败');
    useBgAlertStore.getState().pushBgAlert('restore-open', '恢复失败');
    expect(useBgAlertStore.getState().bgAlert?.id).toBe('restore-open');
    useBgAlertStore.getState().clearBgAlert('canvas-save');
    expect(useBgAlertStore.getState().bgAlert?.id).toBe('restore-open');
    useBgAlertStore.getState().clearBgAlert('restore-open');
    expect(useBgAlertStore.getState().bgAlert).toBeNull();
  });
});
