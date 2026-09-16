import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// npm 脚本一律从项目根运行，故用 process.cwd() 锚定根目录（比 __dirname 稳）
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
    // plan25 S2：tests/evals/ 是**场景级回归**（故事化、跨模块、断言端态），
    // 与 tests/unit 的函数级单测分层 —— 目录分开，扫描一起进
    include: ['tests/unit/**/*.test.ts', 'tests/evals/**/*.test.ts'],
    // plan28 S2：run_command 走持久 shell 会话后，凡执行过命令的测试文件都会留下
    // 会话实例 —— 每个文件收尾统一清理（杀子进程 + 关管道），vitest worker 才能正常退出
    setupFiles: [r('tests/setup/shell-session-cleanup.ts')]
  }
})
