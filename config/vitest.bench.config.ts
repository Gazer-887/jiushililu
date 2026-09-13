import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// 基准/测量的专用配置（跑法：npm run bench）。
//
// 为什么与单测分开：基准量的是"耗时 + 堆增量"，**进 CI 会被机器抖动误判**（本项目那条
// "耗时不该当主判据"的教训）。基准显式跑、结果落文档；单测里的判据一律用确定性量（字节数 / 文件数 / 调用次数）。
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
