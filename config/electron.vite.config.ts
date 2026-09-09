import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// 本配置位于 config/ 子目录（根目录整洁铁律，见 AGENTS.md 第三节）。
// 用 process.cwd() 锚定项目根：npm 脚本固定从根目录运行，比 __dirname 可靠
//（vite 会把配置文件打包到临时目录执行，__dirname 会失真）。
const r = (p: string): string => resolve(process.cwd(), p)

// WorkBuddy 等 AI 终端宿主会给 node 注入 safe-delete 钩子，vite 的 emptyOutDir
// 批量删除会被拦。设 JSL_NO_EMPTY_OUT_DIR=1 跳过自清空，配合构建前手动清目录。
// 正常终端 / CI 不设此变量，行为不变。
const noEmptyOutDir = process.env['JSL_NO_EMPTY_OUT_DIR'] === '1'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared'), '@main': r('src/main') }
    },
    build: {
      outDir: r('out/main'),
      emptyOutDir: !noEmptyOutDir,
      rollupOptions: { input: { index: r('src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared') }
    },
    build: {
      outDir: r('out/preload'),
      emptyOutDir: !noEmptyOutDir,
      rollupOptions: { input: { index: r('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@shared': r('src/shared'), '@': r('src/renderer/src') }
    },
    build: {
      outDir: r('out/renderer'),
      emptyOutDir: !noEmptyOutDir,
      rollupOptions: { input: { index: r('src/renderer/index.html') } }
    }
  }
})
