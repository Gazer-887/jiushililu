// plan43 S3b 判据单测：shim 目录维护（真临时目录，不用 mock fs）。
// 钉的是四条行为：幂等写入 / 过期清理 / 原件缺失不静默 / 只删我们认识的文件。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentFingerprint, inspectActiveSnapshot, runtimeBinDir, syncRuntimeBin } from '../../src/main/dev-env/runtime-bin'

let root = ''
/** 造一个"可执行文件"（内容无所谓，只要 existsSync 为真） */
const fakeExe = (name: string): string => {
  const p = join(root, 'targets', name)
  mkdirSync(join(root, 'targets'), { recursive: true })
  writeFileSync(p, 'x')
  return p
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jsl-runtime-bin-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('runtimeBinDir', () => {
  it('拼在 userData 下的 runtime-bin', () => {
    expect(runtimeBinDir('C:\\data')).toBe('C:\\data\\runtime-bin')
  })
})

describe('syncRuntimeBin（幂等：反复调用不产生变化）', () => {
  it('首次同步写入 shim，目录自动创建', () => {
    const py = fakeExe('python.exe')
    const r = syncRuntimeBin(root, { python: py }, 'win32')
    expect(existsSync(r.dir)).toBe(true)
    expect(r.written).toBe(1)
    expect(existsSync(join(r.dir, 'python.cmd'))).toBe(true)
  })

  it('★ 第二次同步 written=0（内容未变不重写，避免无谓磁盘写与 mtime 抖动）', () => {
    const py = fakeExe('python.exe')
    syncRuntimeBin(root, { python: py }, 'win32')
    const second = syncRuntimeBin(root, { python: py }, 'win32')
    expect(second.written).toBe(0)
    expect(second.removed).toEqual([])
  })

  it('shim 内容指向原件路径', () => {
    const py = fakeExe('python.exe')
    const r = syncRuntimeBin(root, { python: py }, 'win32')
    const content = readFileSync(join(r.dir, 'python.cmd'), 'utf8')
    expect(content).toContain(py)
    expect(content).toContain('%*')
  })

  it('换了目标 → 重写（内容比对，不是只看存在）', () => {
    const a = fakeExe('py-a.exe')
    const b = fakeExe('py-b.exe')
    syncRuntimeBin(root, { python: a }, 'win32')
    const r = syncRuntimeBin(root, { python: b }, 'win32')
    expect(r.written).toBe(1)
    // shim 名按**语言**定（python），不随原件的文件名变 —— 否则换版本会让 `python` 命令消失
    expect(readFileSync(join(r.dir, 'python.cmd'), 'utf8')).toContain(b)
    expect(existsSync(join(r.dir, 'py-a.cmd'))).toBe(false)
  })

  it('★ python.exe → python3.exe 换版本，`python` 命令照旧可用', () => {
    const a = fakeExe('python.exe')
    const b = fakeExe('python3.exe')
    syncRuntimeBin(root, { python: a }, 'win32')
    const r = syncRuntimeBin(root, { python: b }, 'win32')
    expect(existsSync(join(r.dir, 'python.cmd'))).toBe(true)
    expect(r.removed).toEqual([])
  })
})

describe('syncRuntimeBin（清理：只删我们认识的文件）', () => {
  it('取消选择 → shim 被删除', () => {
    const py = fakeExe('python.exe')
    syncRuntimeBin(root, { python: py }, 'win32')
    const r = syncRuntimeBin(root, {}, 'win32')
    expect(r.removed).toEqual(['python.cmd'])
    expect(existsSync(join(r.dir, 'python.cmd'))).toBe(false)
  })

  it('换了语言 → 旧的删、新的建', () => {
    const py = fakeExe('python.exe')
    const node = fakeExe('node.exe')
    syncRuntimeBin(root, { python: py }, 'win32')
    const r = syncRuntimeBin(root, { node }, 'win32')
    expect(r.removed).toEqual(['python.cmd'])
    expect(existsSync(join(r.dir, 'node.cmd'))).toBe(true)
    expect(existsSync(join(r.dir, 'python.cmd'))).toBe(false)
  })

  it('★ 用户手动放进中转目录的**目录**不被删（不做递归删，那是不可逆动作）', () => {
    const py = fakeExe('python.exe')
    syncRuntimeBin(root, { python: py }, 'win32')
    const dir = runtimeBinDir(root)
    const userDir = join(dir, 'my-stuff')
    mkdirSync(userDir)
    syncRuntimeBin(root, {}, 'win32')
    expect(existsSync(userDir)).toBe(true)
  })

  it('★ **不认识的文件名保留**（白名单删除：中转目录在 userData 下，谁都能往里写东西）', () => {
    // 2026-09-19 改：原实现是"除需要的之外全删"（黑名单式），与模块注释承诺的
    // "只删我们认识的文件名"**正好相反**，且是不可逆动作、与本项目「不做善意越权」冲突。
    // 现改为真白名单：只删由语言规格推导出的 shim 名，其余一律不动。
    const py = fakeExe('python.exe')
    syncRuntimeBin(root, { python: py }, 'win32')
    const foreign = join(runtimeBinDir(root), 'some-other-tool.cmd')
    const foreignTxt = join(runtimeBinDir(root), 'notes.txt')
    writeFileSync(foreign, 'not ours')
    writeFileSync(foreignTxt, 'not ours either')
    const r = syncRuntimeBin(root, { python: py }, 'win32')
    expect(r.removed).not.toContain('some-other-tool.cmd')
    expect(r.removed).not.toContain('notes.txt')
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(foreignTxt)).toBe(true)
  })

  it('★ **我们认识的名字**即使这一轮不需要也会被清（取消选择 = 真撤销）', () => {
    // 白名单按**全部语言**枚举（不只是当前选中项）—— 否则"取消某语言后清掉它的旧 shim"就做不到。
    // 这条钉的正是那个边界：`node.cmd` 这一轮不在 wanted 里，但它**是我们认识的**，故该被清。
    const py = fakeExe('python.exe')
    const node = fakeExe('node.exe')
    syncRuntimeBin(root, { python: py, node }, 'win32')
    const r = syncRuntimeBin(root, { python: py }, 'win32')
    expect(r.removed).toContain('node.cmd')
    expect(existsSync(join(runtimeBinDir(root), 'node.cmd'))).toBe(false)
    expect(existsSync(join(runtimeBinDir(root), 'python.cmd'))).toBe(true)
  })

  it('★ 清理按**内容签名**认自己：规格表外的 id 也能删干净（白名单有洞那版会漏）', () => {
    // 2026-09-19 交叉复查抓出的真分岔：文件名白名单依赖 `selected` 推导，
    // 而清理那一刻 `selected` 已是新一轮的值 ⇒ "上一轮用过、本轮不在 selected 里"的 id
    // 推导不出来，孤儿 shim 永留。内容签名不依赖任何会变的外部状态。
    // 触发面：手改 settings.json / 版本迁移残留 / 将来规格改名。
    const fake = fakeExe('python3.exe')
    const first = syncRuntimeBin(root, { python3: fake }, 'win32')
    expect(first.written).toBe(1)
    expect(existsSync(join(first.dir, 'python3.cmd'))).toBe(true)

    // 关键断言：取消后**必须删得掉**（`python3` 不在 LANGUAGE_SPECS 里）
    const second = syncRuntimeBin(root, {}, 'win32')
    expect(second.removed).toContain('python3.cmd')
    expect(existsSync(join(second.dir, 'python3.cmd'))).toBe(false)
  })

  it('★ 认得出的照删、**认不出的保留**（宁可漏放，不可误杀）', () => {
    const py = fakeExe('python.exe')
    const first = syncRuntimeBin(root, { python: py }, 'win32')
    const dir = first.dir
    // 三种"不是我们写的"：纯文本、长得像但不合的、空文件
    writeFileSync(join(dir, 'user-notes.txt'), 'hello')
    writeFileSync(join(dir, 'looks-like-but-isnt.bat'), '@echo off\r\necho hi\r\n')
    writeFileSync(join(dir, 'empty.cmd'), '')
    const second = syncRuntimeBin(root, {}, 'win32')
    expect(second.removed).toContain('python.cmd')
    for (const keep of ['user-notes.txt', 'looks-like-but-isnt.bat', 'empty.cmd']) {
      expect(existsSync(join(dir, keep))).toBe(true)
    }
  })
})

describe('syncRuntimeBin（原件缺失：不静默）', () => {
  it('★ 选中的可执行文件不在盘上 → 不写 shim，并记进 missing', () => {
    const r = syncRuntimeBin(root, { python: join(root, 'nope', 'python.exe') }, 'win32')
    expect(r.written).toBe(0)
    expect(r.missing).toEqual([{ language: 'python', target: join(root, 'nope', 'python.exe') }])
  })

  it('写一个指向不存在目标的 shim 是**有害**的 —— 这里明确不写', () => {
    const r = syncRuntimeBin(root, { python: join(root, 'gone', 'python.exe') }, 'win32')
    expect(r.entries).toHaveLength(0)
    expect(existsSync(join(r.dir, 'python.cmd'))).toBe(false)
  })

  it('部分缺失：好的照写，坏的进 missing（一件坏不牵连其他）', () => {
    const node = fakeExe('node.exe')
    const r = syncRuntimeBin(root, { node, python: join(root, 'gone', 'python.exe') }, 'win32')
    expect(r.written).toBe(1)
    expect(r.missing.map((m) => m.language)).toEqual(['python'])
  })

  it('原件**曾经存在后来被删** → 下次同步把 shim 一并收回', () => {
    const py = fakeExe('python.exe')
    syncRuntimeBin(root, { python: py }, 'win32')
    rmSync(py, { force: true })
    const r = syncRuntimeBin(root, { python: py }, 'win32')
    expect(existsSync(join(r.dir, 'python.cmd'))).toBe(false)
    expect(r.missing).toHaveLength(1)
  })
})

describe('currentFingerprint（供 S3c 判"要不要换会话"）', () => {
  it('同一 userData + 同一选择 → 同指纹', () => {
    const a = currentFingerprint({ python: 'C:\\p\\python.exe' }, root)
    const b = currentFingerprint({ python: 'C:\\p\\python.exe' }, root)
    expect(a).toBe(b)
  })

  it('换了选择 → 指纹变', () => {
    expect(currentFingerprint({ python: 'C:\\a' }, root)).not.toBe(currentFingerprint({ python: 'C:\\b' }, root))
  })

  it('不同 userData（= 不同 shim 目录）→ 指纹变', () => {
    const other = mkdtempSync(join(tmpdir(), 'jsl-other-'))
    try {
      expect(currentFingerprint({ python: 'C:\\a' }, root)).not.toBe(currentFingerprint({ python: 'C:\\a' }, other))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('inspectActiveSnapshot（S3d 状态栏：给的是**事实**，不是意向）', () => {
  it('选中且原件在 → 进 active，injected=true', () => {
    const py = fakeExe('python.exe')
    const s = inspectActiveSnapshot(root, { python: py }, 'win32')
    expect(s.active).toHaveLength(1)
    expect(s.active[0]?.language).toBe('python')
    expect(s.active[0]?.selected).toBe(py)
    expect(s.injected).toBe(true)
  })

  it('★ 选中但原件没了 → 进 failed（附具体原因），**不进 active** —— 不许假装生效', () => {
    const ghost = join(root, 'gone', 'python.exe')
    const s = inspectActiveSnapshot(root, { python: ghost }, 'win32')
    expect(s.active).toHaveLength(0)
    expect(s.failed).toHaveLength(1)
    expect(s.failed[0]?.selected).toBe(ghost)
    expect(s.failed[0]?.reason).toContain('不在')
    expect(s.injected).toBe(false)
  })

  it('未选择 → 全空，injected=false', () => {
    const s = inspectActiveSnapshot(root, {}, 'win32')
    expect(s.active).toEqual([])
    expect(s.failed).toEqual([])
    expect(s.injected).toBe(false)
  })

  it('display 带语言名与文件名（状态栏一行要能读懂）', () => {
    const py = fakeExe('python.exe')
    const s = inspectActiveSnapshot(root, { python: py }, 'win32')
    expect(s.active[0]?.display).toContain('Python')
    expect(s.active[0]?.display).toContain('python.exe')
  })

  it('好坏混装：好的进 active、坏的进 failed，互不牵连', () => {
    const node = fakeExe('node.exe')
    const s = inspectActiveSnapshot(root, { node, python: join(root, 'gone', 'python.exe') }, 'win32')
    expect(s.active.map((a) => a.language)).toEqual(['node'])
    expect(s.failed.map((f) => f.language)).toEqual(['python'])
    // injected 只看"有没有真生效的" —— 有一个能用的就算注入成功
    expect(s.injected).toBe(true)
  })

  it('label 取自 LANGUAGE_SPECS（不自己编语言名）', () => {
    const py = fakeExe('python.exe')
    const s = inspectActiveSnapshot(root, { python: py }, 'win32')
    expect(s.active[0]?.label).toBe('Python')
  })
})

describe('inspectActiveSnapshot（★ 纯读契约：状态栏高频路径不许写盘）', () => {
  // 2026-09-19 加持。起因：原 `inspectActiveSnapshot` 顺带 `syncRuntimeBin`，
  // 而它由**状态栏渲染**驱动（高频）—— 每次刷新都 mkdir + 逐文件比对 + 全目录扫描的同步 IO，
  // 会阻塞 Electron 主进程事件循环 = 所有窗口卡顿。故拆出纯读版本。

  it('★ 不存在的目录**不会被创建**（纯读：调用方只是想看一眼）', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'jsl-s3d-readonly-'))
    try {
      expect(existsSync(runtimeBinDir(fresh))).toBe(false)
      inspectActiveSnapshot(fresh, { python: join(fresh, 'x', 'python.exe') }, 'win32')
      expect(existsSync(runtimeBinDir(fresh))).toBe(false)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('★ 已有 shim **不会被新建或覆盖**（只读，不产生任何写副作用）', () => {
    const py = fakeExe('python.exe')
    // 先造一个"过期内容"的 shim：写盘版会覆盖它，纯读版必须原样留着
    syncRuntimeBin(root, { python: py }, 'win32')
    const shim = join(runtimeBinDir(root), 'python.cmd')
    writeFileSync(shim, 'STALE-CONTENT-SENTINEL')
    const before = readFileSync(shim, 'utf8')

    inspectActiveSnapshot(root, { python: py }, 'win32')

    expect(readFileSync(shim, 'utf8')).toBe(before)
    expect(before).toBe('STALE-CONTENT-SENTINEL')
  })

  it('读结论与"sync 之后的盘上状态"一致（纯读不是"读了个假的"）', () => {
    // 原版是拿"读"与"写盘版"两函数对拍；写盘版已删（零消费者 + 名字误导），
    // 故改为对拍**真正的参照物**：sync 之后盘上该有的 shim 集合。
    const py = fakeExe('python.exe')
    const ghost = join(root, 'gone', 'python.exe')
    const selected = { python: py, node: ghost }
    const readOnly = inspectActiveSnapshot(root, selected, 'win32')
    // 参照：真同步一次，看盘上留下了什么
    const synced = syncRuntimeBin(root, selected, 'win32')
    const onDisk = new Set(synced.entries.map((e) => e.shimName))

    expect(readOnly.active.map((a) => a.language)).toEqual(['python'])
    expect(readOnly.failed.map((f) => f.language)).toEqual(['node'])
    expect(readOnly.injected).toBe(true)
    // 读到的"生效项"必须与盘上真有 shim 的那批一致（这就是纯读可信的判据）
    for (const a of readOnly.active) {
      const shim = a.language === 'python' ? 'python.cmd' : `${a.language}.cmd`
      expect(onDisk.has(shim)).toBe(true)
    }
  })
})
