// e2e 配置（plan48 · R6 本体收口）。
// 与 `npm test`（vitest 单测）分家：e2e 起真 Electron、要 `npm run build` 先产物，成本与前置都不同。

import { defineConfig } from '@playwright/test'

export default defineConfig({
  // 配置文件在 config/ 下（根目录整洁铁律），故测试目录要往上一级指
  testDir: '../tests/e2e',
  outputDir: '../tmp/playwright-artifacts',

  /**
   * ⚠️ 必须串行。每条用例各起一个 Electron 实例，并发时显示服务器与 CPU 互相抢，
   * 失败归因不出来（本项目 CI 已经因"计时器粒度/排序"这类跨平台抖动吃过教训）。
   */
  fullyParallel: false,
  workers: 1,

  /** 不自动重试：e2e 抖动靠复跑定性，默认重试会把"偶发红"洗成绿的假象 */
  retries: 0,

  timeout: 120_000,
  expect: { timeout: 15_000 },

  reporter: [['list']]
})
