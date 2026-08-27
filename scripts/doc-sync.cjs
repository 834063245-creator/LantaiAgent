// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// doc-sync 门禁（平台化 Phase 3 · D9 目录随段落地）——全部生成物文档的
// 漂移检查入口。逐一生成器跑 --check（重生成内容与已提交文档逐字节对拍），
// 任一漂移即非零退出。用法（src-ui 下）：npm run doc-sync。
//
// 覆盖清单（新生成器在此登记——漏登记 = 目录不受门禁保护）：
//   - model-tool-contract.md（工具面契约，gen-tool-contract-md）
//   - service-catalog.md（ctx 服务目录，gen-service-catalog）
//   - event-catalog.md（事件目录，gen-event-catalog）
//   - open-surface-contract.md 指纹（契约版本化，gen-contract-fingerprint）
// 注：frontend-rpc-contract.md 生成器嵌时间戳，字节对拍不可行——其守护
// 由「生成后同 commit」纪律 + 契约测试承担，不入本门禁。

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_UI = path.join(ROOT, 'src-ui');

const generators = [
  { name: 'model-tool-contract', script: path.join(ROOT, 'scripts', 'gen-tool-contract-md.cjs') },
  { name: 'service-catalog', script: path.join(ROOT, 'scripts', 'gen-service-catalog.cjs') },
  { name: 'event-catalog', script: path.join(ROOT, 'scripts', 'gen-event-catalog.cjs') },
  { name: 'contract-fingerprint', script: path.join(ROOT, 'scripts', 'gen-contract-fingerprint.cjs') },
];

let failed = false;
for (const gen of generators) {
  const res = spawnSync(process.execPath, [gen.script, '--check'], { cwd: SRC_UI, stdio: 'inherit' });
  if ((res.status ?? 1) !== 0) {
    failed = true;
    console.error(`[doc-sync] ${gen.name} 漂移`);
  }
}

if (failed) {
  console.error('[doc-sync] 生成物文档已漂移——逐一生成并同 commit（见上方各生成器提示）');
  process.exit(1);
}
console.log('[ok] doc-sync：全部生成物文档与源码事实一致');
