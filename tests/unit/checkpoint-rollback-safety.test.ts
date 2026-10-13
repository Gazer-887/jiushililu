// 回滚安全 · 定点测试（plan78 修正批 · 2026-10-13）
//
// 三条主反例（单目标备份失败 / 部分失败 / 联接把回滚导向工作区外）来自独审端**未经本实现参与**
// 的独立反例（PLAN/独立审查-主工作流-Codex-20261013/rollback-safety.test.ts 同形构造）：调用**真实注册
// handler** + 真实 agent.checkpoints + 真实磁盘，仅对 node:fs.copyFileSync 注入失败、对目录换真实
// junction —— 不复制回滚算法、不伪造条件。
// 本文件按合同把它们转正为仓库钉，并补齐合同其余最小场景：created 目标备份失败不删除、备份来源
// 联接不纳入、普通 `../` 拒绝、成功路径、退错后再退可复原。断言全部落在**磁盘字节**与 report 形状上。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  root: '',
  failSource: '',
  failRealPath: '',
  failNextManifest: false,
  handlers: new Map<string, Function>()
}))

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const native = actual.realpathSync.native
  const realpath = Object.assign(actual.realpathSync.bind(null), {
    native: (path: string, ...args: unknown[]) => {
      // 只注入「真实路径解析失败」：其余一律走真实解析
      if (f.failRealPath && String(path).startsWith(f.failRealPath)) {
        throw Object.assign(new Error('定点注入：真实路径不可核'), { code: 'EACCES' })
      }
      return native(path, args[0] as never)
    }
  })
  return {
    ...actual,
    realpathSync: realpath,
    copyFileSync: (source: string, target: string, ...rest: unknown[]) => {
      // 只注入「当前内容 → 检查点备份」这一步失败（独审同款故障点）
      if (String(source) === f.failSource && String(target).includes('files')) {
        throw Object.assign(new Error('定点注入：当前内容备份失败'), { code: 'EACCES' })
      }
      return actual.copyFileSync(source, target, rest[0] as number | undefined)
    },
    writeFileSync: (file: string, data: unknown, ...rest: unknown[]) => {
      // 只注入「manifest 落盘失败」：内存有条目也不许冒充可重开的备份
      const p = String(file)
      if (f.failNextManifest && p.endsWith('manifest.json')) {
        f.failNextManifest = false
        throw Object.assign(new Error('定点注入：manifest 落盘失败'), { code: 'EACCES' })
      }
      return actual.writeFileSync(file, data, rest[0] as never)
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => f.root },
  ipcMain: { handle: (key: string, handler: Function) => f.handlers.set(key, handler) },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  clipboard: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {}
    get(key: string) {
      return this.store[key]
    }
    set(key: string, value: unknown) {
      this.store[key] = value
    }
  }
}))

f.root = mkdtempSync(join(tmpdir(), 'jsl-rollback-safety-'))
const { IPC } = await import('@shared/ipc')
const { registerIpcHandlers } = await import('@main/ipc')
const { createAgentContext } = await import('@main/agent/runner')
const { createMemoryStore } = await import('@main/store/memory-store')
const { createPlaybookStore } = await import('@main/store/playbook-store')

let sequence = 0

function setup() {
  f.failSource = ''
  f.failRealPath = ''
  f.failNextManifest = false
  f.handlers.clear()
  const root = join(f.root, `case-${++sequence}`)
  mkdirSync(root)
  const memory = createMemoryStore(join(root, 'memory'), undefined, { ftsPath: null })
  const agent = createAgentContext({
    getWorkspaceRoot: () => root,
    builtinAgentsDir: join(root, 'builtin'),
    userAgentsDir: join(root, 'agents'),
    checkpointDir: join(root, 'checkpoints')
  })
  registerIpcHandlers({
    agent,
    memory,
    userDataDir: root,
    playbook: createPlaybookStore(root),
    trash: async () => {},
    confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: { ask: async () => ({ answered: false as const, reason: 'no-window' as const }), respond: () => false, abortAll: () => {} },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} },
    terminal: {} as never,
    system: { getBlockers: () => [] } as never,
    execEventSink: { append: () => {} },
    network: {} as never
  })
  return { root, store: agent.checkpoints }
}

function seed(h: ReturnType<typeof setup>, changes: Array<{ rel: string; original: string; current: string }>): string {
  const id = h.store.begin(h.root, '定点夹具', 'safety')
  for (const c of changes) {
    const path = join(h.root, c.rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, c.original)
    h.store.record(id, h.root, c.rel, path)
    writeFileSync(path, c.current)
  }
  h.store.finish(id)
  return id
}

/** 走**真实注册 handler**（与界面同一入口），不用 store 直调冒充接线 */
function rollbackViaHandler(runId: string, rel?: string) {
  return f.handlers.get(IPC.checkpointRollback)!({}, rel === undefined ? { runId } : { runId, rel }) as Promise<{
    restored: string[]
    deleted: string[]
    failed: Array<{ rel: string; reason: string }>
    rejected: string[]
  }>
}

// ── 独审三条反例（原样转正） ────────────────────────────────────────

it.each([
  { names: [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }] },
  {
    names: [
      { rel: 'a.txt', original: 'ORIGINAL-A', current: 'CURRENT-A' },
      { rel: 'b.txt', original: 'ORIGINAL-B', current: 'CURRENT-B' }
    ]
  }
])('回滚前备份失败不得覆盖失败目标（目标 %j）', async ({ names }) => {
  const h = setup()
  const id = seed(
    h,
    names.map((n) => ({ rel: n.rel, original: n.original, current: n.current }))
  )
  f.failSource = join(h.root, 'a.txt') // a.txt 的当前内容备份失败
  const report = await rollbackViaHandler(id)
  const a = readFileSync(join(h.root, 'a.txt'), 'utf8')
  expect(a, '备份失败的当前内容必须原样保留（不覆盖、不删除）').toBe(names[0]!.current)
  expect(report.failed.some((x) => x.rel === 'a.txt' && x.reason.includes('备份失败')), '失败目标须如实计入报告').toBe(true)
  if (names.length === 2) {
    // b 备份成功 → 允许被恢复；但 a 一个字节都不许动
    expect(readFileSync(join(h.root, 'b.txt'), 'utf8')).toBe('ORIGINAL-B')
    expect(report.restored).toEqual(['b.txt'])
  }
  // 部分/全部失败都不许标"已回滚"徽章（failed 非空 → store 不打 rolledBackAt）
  const run = h.store.get(id)
  expect(run?.rolledBackAt, '有失败项不得打整轮回滚标记').toBeUndefined()
})

it('真实目录换成联接后，回滚不得写进工作区外', async () => {
  const h = setup()
  const id = seed(h, [{ rel: 'sub/a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const outside = join(f.root, `outside-${sequence}`)
  mkdirSync(outside)
  writeFileSync(join(outside, 'a.txt'), 'OUTSIDE_PRIVATE')
  renameSync(join(h.root, 'sub'), join(h.root, 'sub-original'))
  symlinkSync(outside, join(h.root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir')

  const report = await rollbackViaHandler(id)
  expect(readFileSync(join(outside, 'a.txt'), 'utf8'), '工作区外目标必须保持原样').toBe('OUTSIDE_PRIVATE')
  // 联接目标在「回滚前备份」层就被拒（更早一道防线）：不得被覆盖/删除，且如实计入报告（failed 带原因）
  expect(
    report.failed.some((x) => x.rel === 'sub/a.txt' && x.reason.includes('备份')),
    '联接目标应如实计入报告'
  ).toBe(true)
  const run = h.store.get(id)
  expect(run?.rolledBackAt, '有失败项不得打整轮回滚标记').toBeUndefined()
})

// ── 合同其余最小场景 ────────────────────────────────────────────────

it('当前备份失败时，原本轮**新建**（将被删除）的目标也不许被删', async () => {
  const h = setup()
  // 同一轮两个目标：keep.txt（modified，备份成功）＋ new.txt（Agent 新建后、当前内容备份失败）
  const id = h.store.begin(h.root, '定点夹具', 'safety')
  writeFileSync(join(h.root, 'keep.txt'), 'K0')
  h.store.record(id, h.root, 'keep.txt', join(h.root, 'keep.txt'))
  writeFileSync(join(h.root, 'keep.txt'), 'K1')
  const abs = join(h.root, 'new.txt')
  writeFileSync(abs, 'AGENT_CREATED') // Agent 新建后 record：此刻存在 → modified（备份的是当前内容）
  h.store.record(id, h.root, 'new.txt', abs)
  h.store.finish(id)

  f.failSource = abs // 让 new.txt 的当前内容备份失败
  const report = await rollbackViaHandler(id)
  expect(existsSync(abs), '备份失败的新建目标不得被删除').toBe(true)
  expect(readFileSync(abs, 'utf8')).toBe('AGENT_CREATED')
  expect(report.failed.some((x) => x.rel === 'new.txt')).toBe(true)
  expect(report.deleted, '不得把备份失败的目标当成 created 删掉').not.toContain('new.txt')
  expect(readFileSync(join(h.root, 'keep.txt'), 'utf8'), '备份成功的目标照常恢复').toBe('K0')
})

it('备份来源若是外部联接，不得把外部内容纳入检查点', () => {
  const h = setup()
  const outside = join(f.root, `outside-src-${sequence}`)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_CONTENT')
  // 工作区里的目录被换成指向外部的**目录联接**（Windows junction，与独审反例同款构造）
  const linkDir = join(h.root, 'linkdir')
  symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir')

  const id = h.store.begin(h.root, '定点夹具', 'safety')
  h.store.record(id, h.root, 'linkdir/secret.txt', join(linkDir, 'secret.txt'))
  h.store.finish(id) // 先收尾，让下面的 manifest 篡改走**盘上**读取路径
  const run = h.store.get(id)
  expect(run?.changes.some((c) => c.rel === 'linkdir/secret.txt'), '联接目标不得进检查点（备份来源越界）').toBe(false)

  // 退一步：即使 manifest 被人工塞入该目标，真实路径核也应在回滚时拒绝
  const manifestPath = join(h.store.dir, id, 'manifest.json')
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { changes: Array<Record<string, unknown>> }
  m.changes.push({ rel: 'linkdir/secret.txt', kind: 'modified', beforeBytes: 0, backup: '0.bin' })
  writeFileSync(manifestPath, JSON.stringify(m), 'utf8')
  const report = h.store.rollback(id)
  expect(report.rejected, '人工塞入的联接目标必须在回滚时被拒').toContain('linkdir/secret.txt')
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('OUTSIDE_CONTENT')
})

it('成功路径：备份成功的目标照常恢复，且可"退错后再退"复原', async () => {
  const h = setup()
  const id = seed(h, [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const report = await rollbackViaHandler(id)
  expect(report.restored).toEqual(['a.txt'])
  expect(report.failed).toEqual([])
  expect(report.rejected).toEqual([])
  expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('ORIGINAL')

  // 回滚前的自动备份轮存在（退错了还能再退）
  const runs = h.store.list()
  const backupRun = runs.find((r) => r.agent === '界面：回滚前的自动备份')
  expect(backupRun, '回滚前必须留下自动备份轮').toBeTruthy()
  const r2 = await rollbackViaHandler(backupRun!.runId)
  expect(r2.failed).toEqual([])
  expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('CURRENT')
})

it('备份轮 manifest 落盘失败（begin 时即失败）：直接抛错，不拿内存条目冒充', () => {
  const h = setup()
  const id = seed(h, [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  f.failNextManifest = true // snapshotCurrent 内部第一次 manifest 落盘失败
  // begin 的 flush 失败 → 整个备份请求失败上抛，而不是"内存有轮次、盘上没有"地冒充
  expect(() => h.store.snapshotCurrent(id, undefined, '界面：回滚前的自动备份', 'ui')).toThrow('manifest 落盘失败')
  // 失败上浮 ⇒ 界面会拿到错误提示；当前内容一个字节不动
  expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('CURRENT')
})

it('目标文件已不在：restore 仍合法恢复（建目录 + 写回）', () => {
  const h = setup()
  const id = seed(h, [{ rel: 'deep/nested/a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  // 用户把整个目录删了 —— 回滚应能把它恢复出来（而非报"父目录不存在"）
  rmSync(join(h.root, 'deep'), { recursive: true, force: true })
  const report = h.store.rollback(id)
  expect(report.restored).toEqual(['deep/nested/a.txt'])
  expect(readFileSync(join(h.root, 'deep/nested/a.txt'), 'utf8')).toBe('ORIGINAL')
})

it('manifest 含 `../` 的目标：回滚必须拒绝且外部一个字节不动', () => {
  const h = setup()
  const outside = join(f.root, `outside-eviltest-${sequence}`)
  mkdirSync(outside)
  writeFileSync(join(outside, 'evil.txt'), 'EXTERNAL_KEEP')
  const id = h.store.begin(h.root, '定点夹具', 'safety')
  h.store.finish(id) // 先落一个空 manifest
  const manifestPath = join(h.store.dir, id, 'manifest.json')
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { changes: Array<Record<string, unknown>> }
  m.changes.push({ rel: '../evil.txt', kind: 'modified', beforeBytes: 0, backup: '0.bin' })
  writeFileSync(manifestPath, JSON.stringify(m), 'utf8')

  const report = h.store.rollback(id)
  expect(report.rejected, '`../` 目标必须被拒').toContain('../evil.txt')
  expect(readFileSync(join(outside, 'evil.txt'), 'utf8')).toBe('EXTERNAL_KEEP')
})

// ── 增量独审定点（备份源联接 / 解析失败降级 / 拒绝也标完成） ─────────────

it('定点·**真 created 前提**：record 时不存在（断 kind=created），当前备份失败不得删除', async () => {
  const h = setup()
  const abs = join(h.root, 'created.txt')
  const id = h.store.begin(h.root, '定点夹具', 'safety')
  h.store.record(id, h.root, 'created.txt', abs) // 此刻不存在 → created
  expect(h.store.get(id)?.changes[0]?.kind, '本钉前提：必须是真 created').toBe('created')
  writeFileSync(abs, 'NEW_CURRENT') // Agent 之后才创建
  h.store.finish(id)

  f.failSource = abs // 回滚前备份这个当前内容时失败
  const report = await rollbackViaHandler(id)
  expect(readFileSync(abs, 'utf8'), '备份失败的新建目标不得被删除').toBe('NEW_CURRENT')
  expect(report.deleted, '不得把备份失败的目标当成 created 删掉').toEqual([])
  expect(report.failed[0]?.rel).toBe('created.txt')
})

it('定点·检查点 files 目录被换成外部联接，不得以外部内容恢复目标', async () => {
  const h = setup()
  const id = seed(h, [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const backupDir = join(h.store.dir, id, 'files')
  const outside = join(f.root, `backup-outside-${sequence}`)
  mkdirSync(outside)
  writeFileSync(join(outside, '0.bin'), 'EXTERNAL_BACKUP_CANARY')
  renameSync(backupDir, backupDir + '-original')
  symlinkSync(outside, backupDir, process.platform === 'win32' ? 'junction' : 'dir')

  const report = await rollbackViaHandler(id)
  expect(readFileSync(join(h.root, 'a.txt'), 'utf8'), '越界备份源必须拒绝，目标仍为当前版').toBe('CURRENT')
  expect(report.restored, '不得从外部备份源恢复').toEqual([])
  expect(report.failed.some((x) => x.rel === 'a.txt'), '须如实计入 failed').toBe(true)
  expect(h.store.get(id)?.rolledBackAt, '不得标整轮已回滚').toBeUndefined()
})

it('定点·真实路径解析报 EACCES 必须拒绝（不得退化为字符串比较放行联接）', async () => {
  const h = setup()
  const id = seed(h, [{ rel: 'sub/a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const outside = join(f.root, `realpath-outside-${sequence}`)
  mkdirSync(outside)
  writeFileSync(join(outside, 'a.txt'), 'OUTSIDE_KEEP')
  renameSync(join(h.root, 'sub'), join(h.root, 'sub-original'))
  symlinkSync(outside, join(h.root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir')
  f.failRealPath = join(h.root, 'sub') // sub 及其子路径的真实路径解析一律 EACCES

  const report = await rollbackViaHandler(id)
  expect(readFileSync(join(outside, 'a.txt'), 'utf8'), '真实路径不可核时必须保护外部文件').toBe('OUTSIDE_KEEP')
  expect(report.restored, '解析失败不得放行').toEqual([])
  expect(report.failed.length + report.rejected.length, '须如实计入').toBeGreaterThan(0)
})

it('定点·只有 rejected 的回滚不得标整轮已回滚（store 层门位，不经早期排除）', () => {
  const h = setup()
  const id = seed(h, [{ rel: 'sub/a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const outside = join(f.root, `reject-outside-${sequence}`)
  mkdirSync(outside)
  writeFileSync(join(outside, 'a.txt'), 'OUTSIDE_KEEP')
  renameSync(join(h.root, 'sub'), join(h.root, 'sub-original'))
  symlinkSync(outside, join(h.root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir')

  const report = h.store.rollback(id) // 直接调 store：门位不许靠 IPC 早层排除遮住
  expect(report.rejected).toEqual(['sub/a.txt'])
  expect(report.restored).toEqual([])
  expect(h.store.get(id)?.rolledBackAt, '存在拒绝目标时不能冒称整轮完成').toBeUndefined()
  expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('OUTSIDE_KEEP')
})
