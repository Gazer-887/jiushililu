import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initLogger } from '@main/log'
import { installFsSyncTrace } from '@main/sync-trace'
import { peekTracedBlocks } from '@main/watchdog'

// 同步 FS 插桩（plan49 A 档）：一处包 node:fs，罩住主进程 110 个同步调用点。
//
// ⚠️ 这里**只测包装逻辑**，不测"真实 node:fs 装得上"：vitest 的 SSR 模块图与生产
// CJS 产物的 require 语义不是同一套（实测在测试环境里一次调用被叠了 4 层包装），
// 拿它得出的结论对产物无效。真实生效性只在构建产物 + 真机启动日志上验，
// 判据见 PLAN/plan49 §11。

type FakeFs = Record<string, unknown>
const TRACED_NAMES = 18
const fake = (): FakeFs => {
  const t: FakeFs = { existsSync: () => true }
  for (const n of [
    'readFileSync',
    'writeFileSync',
    'appendFileSync',
    'copyFileSync',
    'readdirSync',
    'statSync',
    'lstatSync',
    'fstatSync',
    'readlinkSync',
    'realpathSync',
    'mkdirSync',
    'rmSync',
    'renameSync',
    'unlinkSync',
    'openSync',
    'closeSync',
    'readSync',
    'writeSync'
  ]) {
    t[n] = (p: unknown) => `raw:${n}:${String(p ?? '')}`
  }
  return t
}

describe('同步 FS 插桩', () => {
  let dir = ''
  const open = (): void => {
    dir = mkdtempSync(join(tmpdir(), 'jsl-fstrace-'))
    initLogger(dir, 'info')
  }
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('名单内的函数逐个被包，且包裹后调用确实流经 traceSync', () => {
    open()
    const t = fake()
    const before = peekTracedBlocks()
    expect(installFsSyncTrace(t)).toBe(TRACED_NAMES)
    ;(t['readFileSync'] as (p: string) => string)('x')
    expect(peekTracedBlocks()).toBe(before + 1)
  })

  it('行为不变：入参透传、返回值原样、抛错照抛（插桩不许改变语义）', () => {
    open()
    const t = fake()
    installFsSyncTrace(t)
    expect((t['readFileSync'] as (p: string) => string)('a.txt')).toBe('raw:readFileSync:a.txt')
    expect((t['realpathSync'] as (p: string) => string)('/p')).toBe('raw:realpathSync:/p')
    expect((t['copyFileSync'] as (p: string) => string)('src')).toBe('raw:copyFileSync:src')
    const boom: FakeFs = {
      readFileSync: () => {
        throw new Error('ENOENT')
      }
    }
    installFsSyncTrace(boom)
    expect(() => (boom['readFileSync'] as () => void)()).toThrow('ENOENT')
  })

  it('包装保住函数自带属性 —— realpathSync.native 是软链逃逸检测在用的', () => {
    open()
    const t: FakeFs = {}
    const raw = ((p: unknown) => `raw:${String(p)}`) as ((p: unknown) => string) & {
      native?: (p: unknown) => string
    }
    raw.native = (p: unknown) => `native:${String(p)}`
    t['realpathSync'] = raw
    installFsSyncTrace(t)
    const w = t['realpathSync'] as unknown as typeof raw
    // 丢了 .native ⇒ guard.ts 的裸 catch 吞掉 TypeError ⇒ 逃逸检测静默按未解析原路径放行
    expect(typeof w.native).toBe('function')
    expect(w.native!('/x')).toBe('native:/x')
    expect(w('/x')).toBe('raw:/x')
  })

  it('重复安装不双重包装：第二次返回 0，一次调用只计一笔账', () => {
    open()
    const t = fake()
    installFsSyncTrace(t)
    expect(installFsSyncTrace(t)).toBe(0)
    const before = peekTracedBlocks()
    ;(t['readFileSync'] as (p: string) => string)('x')
    expect(peekTracedBlocks()).toBe(before + 1)
  })

  it('属性写不进去时如实返回 0（降级可观测，绝不静默空转）', () => {
    open()
    const t: FakeFs = {}
    Object.defineProperty(t, 'readFileSync', { value: () => 'x', writable: false, configurable: false })
    expect(installFsSyncTrace(t)).toBe(0)
  })

  it('名单外不参与：existsSync 高频且几乎不会慢，包它只是冲刷缓冲', () => {
    open()
    const t = fake()
    const exists = t['existsSync']
    installFsSyncTrace(t)
    expect(t['existsSync']).toBe(exists)
  })

  it('真文件在插桩下读写一致（防包装层吃掉参数）', () => {
    open()
    const work = mkdtempSync(join(tmpdir(), 'jsl-fstrace-fx-'))
    try {
      const t = fake()
      const file = join(work, 'b.txt')
      writeFileSync(file, '中文内容', 'utf8')
      const real = readFileSync
      // 用真实 readFileSync 当被包对象，验证参数（encoding）一路透传
      t['readFileSync'] = real
      installFsSyncTrace(t)
      expect((t['readFileSync'] as (p: string, e: string) => string)(file, 'utf8')).toBe('中文内容')
      expect((t['readFileSync'] as (p: string) => Buffer)(file)).toBeInstanceOf(Buffer)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
