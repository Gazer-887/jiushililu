// 全局测试收尾（plan28 S2）：凡执行过 run_command 的测试文件都会在 worker 里留下
// 持久 shell 会话。setupFiles 对每个测试文件生效 —— afterAll 在这里注册一次，
// 每个文件跑完都统一清理（杀 shell 子进程 + 关管道），vitest worker 才能正常退出。
// 生产路径的会话由 idle 定时器 + LRU 上限管理（均已 unref，不拽事件循环）。

import { afterAll } from 'vitest'
import { disposeAllShellSessions } from '@main/agent/tools/shell-session'

afterAll(() => {
  disposeAllShellSessions()
})
