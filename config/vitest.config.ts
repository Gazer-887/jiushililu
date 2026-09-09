import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// npm 脚本一律从项目根运行，故用 process.cwd() 锚定根目录
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
    include: ['tests/unit/**/*.test.ts']
  }
})
