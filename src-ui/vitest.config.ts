import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // 默认 node：全量 329 个测试文件里只有 36 个真碰 DOM（实测清单见各文件的
    // `// @vitest-environment jsdom` 头）。2026-09-17 实测同一批 60 个纯逻辑文件：
    // jsdom 墙钟 61-100s（vitest 自报 environment 180.6s / tests 0.59s）vs node
    // 墙钟 18.7s（environment 0.011s / tests 0.44s）——断言只占 0.6%，
    // 99% 的时间是给每个文件现搭一个 jsdom。全量强制 node 环境实测 83s
    // （jsdom 全量 368s）。需要 DOM 的新测试自己加 pragma 头，缺了会红，不会静默。
    environment: 'node',
    globals: true,
    setupFiles: ['tests/setup.ts'],
  },
});
