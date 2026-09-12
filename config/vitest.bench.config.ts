import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// 基准/测量的**专用配置**（`npm run bench`）
//
// 为什么与单测分开：单测的 `include` 只吃 `tests/unit/**`，而基准跑的是"耗时 + 堆增量"——
// **进 CI 会被机器抖动误判**（这正是本项目那条"耗时不该当主判据"的老教训）。
// 所以基准显式跑、结果落文档；单测里的判据一律用**确定性**的量（字节数 / 文件数 / 调用次数）。
//
// 跑法：npm run bench
const r = (p: string): string => resolve(process.cwd(), p)

export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@main': r('src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.bench.ts'],
    testTimeout: 600_000
  }
})
