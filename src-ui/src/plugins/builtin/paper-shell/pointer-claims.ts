// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// pointer-claims — 指针所有权的**裁决账**（2026-11-17 交互原语收口批 C4）。
//
// 病灶（plan §0 第四类，也是前三条共同的根）：画布空白处 `preventDefault`（平移手势）
// 吃掉下游一切 mousedown；于是每个浮在它上面的东西都要自己打一次「怎么不被吃掉」的
// 补丁——2026-08 起同类复发 5 次（`181fd753` / 09-22 Escape / `24d9c168` /
// `ModelSelector` L330 / L436），每次修的都只是当前那个组件。
//
// 裁决（plan §2.3）：**指针事件的归属按层高排序，高层未消费才落到画布。**
// 手势在途 ⇒ 记一笔；画布的 `onCanvasPointerDown` 与之对称记账，高层手势起手前判账。
//
// 为什么是**模块级引用计数**而不是 store：它每个指针事件都要读，进 zustand 会带来
// 无谓重渲染，而它本身不驱动任何 UI（只有「画布要不要让路」这一个消费者，且那个
// 消费者在手势发生的**同一帧**里读它）。归属按 cordis P4 的四级清单归第 3 类
// （键控自清理 / 进程级单例），声明处即可见。
//
// ⚠ 计数必须成对：`claim()` 返回的释放函数是**唯一**出口，重复调用幂等。

let claims = 0;

/** 记一笔「有手势在途」。返回释放函数（幂等；异常路径也要调）。 */
export function claimPointer(): () => void {
  claims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims = Math.max(0, claims - 1);
  };
}

/** 当前是否有手势在途（画布 / 其它底座手势的让路判据）。 */
export function pointerClaimed(): boolean {
  return claims > 0;
}

/** 测试专用：把账清零（避免用例间串味——计数是进程级的）。 */
export function resetPointerClaims(): void {
  claims = 0;
}
