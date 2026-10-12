import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

type Contents = { isDestroyed: () => boolean; getURL: () => string }
type Request = (wc: Contents, permission: string, callback: (allowed: boolean) => void, details: Record<string, unknown>) => void
type Check = (wc: Contents | null, permission: string, origin: string, details: Record<string, unknown>) => boolean
const url = 'file:///public/app/renderer/index.html'

// 红阶段读取现有真实回调，绿阶段读取实际安装函数；不复制权限判据。
async function fixture() {
  let request!: Request; let check!: Check; let ready = true
  const main: Contents = { isDestroyed: () => false, getURL: () => url }
  const session = { setPermissionRequestHandler: (fn: Request) => { request = fn }, setPermissionCheckHandler: (fn: Check) => { check = fn } }
  const source = readFileSync(resolve('src/main/index.ts'), 'utf8')
  if (source.includes('installMediaPermissions(session.defaultSession,')) {
    const path = resolve('src/main/media-permissions.ts')
    const module = await import(path)
    module.installMediaPermissions(session, () => main, url, () => ready)
  } else {
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text
        if (name === 'setPermissionRequestHandler' || name === 'setPermissionCheckHandler') {
          const arrow = node.arguments[0]!
          const code = transformSync(`(${arrow.getText(ast)})`, { loader: 'ts', target: 'node18' }).code
          const fn = runInNewContext(code)
          if (name === 'setPermissionRequestHandler') request = fn as Request
          else check = fn as Check
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)
  }
  expect(request).toBeTypeOf('function'); expect(check).toBeTypeOf('function')
  const ask = (wc: Contents = main, details: Record<string, unknown> = {}) => {
    let allowed: boolean | undefined
    request(wc, 'media', (value) => { allowed = value }, { mediaTypes: ['audio'], requestingUrl: url, isMainFrame: true, ...details })
    return allowed
  }
  const query = (wc: Contents | null = main, details: Record<string, unknown> = {}) => check(wc, 'media', 'file://', { mediaType: 'audio', requestingUrl: url, isMainFrame: true, ...details })
  return { main, request, check, ask, query, disable: () => { ready = false } }
}

describe('实际媒体权限安装与主窗口身份', () => {
  it('主窗口合法语音仍允许，两回调一致', async () => {
    const f = await fixture(); expect(f.ask()).toBe(true); expect(f.query()).toBe(true)
  })
  it('远程view即使伪造相同URL也不允许', async () => {
    const f = await fixture(); const remote = { ...f.main }
    expect(f.ask(remote)).toBe(false); expect(f.query(remote)).toBe(false)
  })
  it('主窗口内远程来源、子frame和未知frame拒绝', async () => {
    const f = await fixture()
    for (const details of [{ requestingUrl: 'https://public.invalid' }, { isMainFrame: false }, { isMainFrame: undefined }, { requestingUrl: undefined }]) {
      expect(f.ask(f.main, details)).toBe(false); expect(f.query(f.main, details)).toBe(false)
    }
  })
  it('语音未配置/披露资格关闭后不再放行', async () => {
    const f = await fixture(); f.disable(); expect(f.ask()).toBe(false); expect(f.query()).toBe(false)
  })
  it('视频、混合媒体、unknown与其他权限拒绝', async () => {
    const f = await fixture()
    expect(f.ask(f.main, { mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(f.query(f.main, { mediaType: 'video' })).toBe(false)
    expect(f.query(f.main, { mediaType: 'unknown' })).toBe(false)
    expect(f.check(f.main, 'geolocation', 'file://', { mediaType: 'audio', requestingUrl: url, isMainFrame: true })).toBe(false)
    expect(f.query(null)).toBe(false)
  })
})
