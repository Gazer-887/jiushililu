import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// 本配置位于 config/ 子目录（根目录整洁铁律，见 AGENTS.md 第三节）。
// 用 process.cwd() 锚定项目根：npm 脚本固定从根目录运行，比 __dirname 可靠
//（vite 会把配置文件打包到临时目录执行，__dirname 会失真）。
const r = (p: string): string => resolve(process.cwd(), p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared'), '@main': r('src/main') }
    },
    build: {
      outDir: r('out/main'),
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
      rollupOptions: { input: { index: r('src/renderer/index.html') } }
    }
  }
})
