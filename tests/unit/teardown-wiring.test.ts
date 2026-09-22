// 退出清理清单的接线守卫（plan54 断链 #1）。
//
// 为什么是**结构守卫**而不是行为测试：`teardownAll` 定义在 `index.ts` 的 `app.whenReady()` 闭包里，
// 没有导出、也起不了真 app（单测环境无 Electron 二进制，CI 更甚）。
// 强度声明：这类守卫挡的是**改着改着漏掉一项**，不替代行为测试 ——
// "dispose 真的把 shell 收干净"由 `shell-session.test.ts` 钉，这里只钉**它到底有没有被挂进退出通路**。
//
// ⚠️ 本文件的由来：`disposeAllShellSessions` 此前**只被测试自己调用**（`runtime-injection.test.ts` 的
// afterAll 清理），线上退出通路里根本没有它 —— 正是 K14–K17 那族"测到了但线上不走那条路"。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')

/** 取 `const teardownAll = (): void => { … }` 的函数体（到下一个顶格 `}` 前） */
function teardownBody(): string {
  const start = indexSrc.indexOf('const teardownAll = ()')
  if (start === -1) return ''
  const rest = indexSrc.slice(start)
  const end = rest.indexOf('\n  }')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('退出清理清单（teardownAll）', () => {
  it('守卫前提：`teardownAll` 取得到，且两个退出事件都挂它', () => {
    const body = teardownBody()
    // 守卫自己也要能红：取不到函数体就等于后面全在空转
    expect(body.length).toBeGreaterThan(50)
    expect(indexSrc).toContain("app.on('window-all-closed', teardownAll)")
    expect(indexSrc).toContain("app.on('before-quit', teardownAll)")
  })

  it('常驻 shell 必须在清理清单里（它自己注释承诺"不留没人管的 shell"）', () => {
    expect(teardownBody()).toContain('disposeAllShellSessions()')
  })

  it('清理清单不许被改小：原有五项一个都不能掉', () => {
    const body = teardownBody()
    for (const disposer of [
      'confirm.abortAll',
      'ask.abortAll',
      'background.killAll',
      'terminal.killAll',
      'system.dispose'
    ]) {
      expect(body).toContain(disposer)
    }
  })

  it('import 必须真的存在（只写调用不 import 会在运行期炸）', () => {
    expect(indexSrc).toMatch(/import\s*\{[^}]*disposeAllShellSessions[^}]*\}\s*from\s*'\.\/agent\/tools\/shell-session'/)
  })
})
