// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 3D 模型查看器登记（P2 · B9）——**重依赖**：本体在应用 bundle
// （`src-ui/src/app/paper/viewers/model3d.tsx`，three + GLTFLoader/OBJLoader/STLLoader），
// 产物侧只声明认领与读取形态，组件经宿主桥 `loadViewer('model3d')` 取。

import { VIEWER_MODEL_EXTS } from '../../../../paper/viewer-exts';
import type { ViewerDef } from '../viewer-registry';

export const model3dViewer: ViewerDef = {
  id: 'model3d',
  exts: VIEWER_MODEL_EXTS,
  needsBytes: true,
  mimes: {
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    obj: 'model/obj',
    stl: 'model/stl',
  },
  /** 32 MiB：同上（宿主先尺寸预检）。 */
  maxBytes: 32 * 1024 * 1024,
  heavy: 'model3d',
};
