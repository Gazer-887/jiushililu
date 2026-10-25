// 首批安全读写 · 定点回归（R1—R5 + ENOTDIR 分类）
// 走真实工具/写入服务/检查点/注册 IPC handler；只对 node:fs 边界函数定点注入。
// 判据一律落在磁盘字节与报告形状上（详见交还 03/04）。

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createFileTools } from '@main/agent/tools/file-tools'
import { createWorkspaceWriter } from '@main/workspace-write'
import { createCheckpointStore, type CheckpointStore } from '@main/store/checkpoints'
import { canonicalFilePath, contentRevision } from '@main/file-revision'
import { realpathDeepest, resolvePathInWorkspace } from '@main/agent/guard'
import type { AgentTool } from '@shared/agent'

const f = vi.hoisted(() => ({
  /** 传给 realpathSync 的路径若以此前缀开头 → 抛 EACCES（权限不可核） */
  realpathEaccesPrefix: '',
  /** 同上 → 抛 ENOTDIR（中间段不是目录） */
  realpathEnotdirPrefix: '',
  /** 传给 statSync 的路径若以此前缀开头 → 抛 EACCES */
  statEaccesPrefix: '',
  /** 同上 → 抛 ENOTDIR */
  statEnotdirPrefix: '',
  /** 以该路径为**备份来源**的 copyFileSync → 抛带独有标记的错误 */
  failCopySource: '',
  /** 以该路径为目标的 readFile（node:fs/promises）→ 抛 EIO */
  failReadPath: '',
  /** 从第 N 次（1 起）manifest 落盘起持续失败；0 = 不注入 */
  failManifestFrom: 0,
  /** manifest 落盘计数器（每个用例开始时重置） */
  manifestWrites: 0,
  handlers: new Map<string, Function>(),
  root: ''
}))

const BACKUP_MARK = 'TEST_BACKUP_EACCES'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const native = actual.realpathSync.native
  const guard = (p: unknown): void => {
    const s = String(p)
    if (f.realpathEaccesPrefix && s.startsWith(f.realpathEaccesPrefix)) {
      throw Object.assign(new Error('定点注入：真实路径不可核'), { code: 'EACCES' })
    }
    if (f.realpathEnotdirPrefix && s.startsWith(f.realpathEnotdirPrefix)) {
      throw Object.assign(new Error('定点注入：中间段不是目录'), { code: 'ENOTDIR' })
    }
  }
  const realpathSync = Object.assign(
    (path: Parameters<typeof actual.realpathSync>[0], ...args: unknown[]) => {
      guard(path)
      return actual.realpathSync(path, args[0] as never)
    },
    {
      native: (path: string, ...args: unknown[]) => {
        guard(path)
        return native(path, args[0] as never)
      }
    }
  )
  return {
    ...actual,
    realpathSync,
    statSync: (path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (f.statEaccesPrefix && String(path).startsWith(f.statEaccesPrefix)) {
        throw Object.assign(new Error('定点注入：状态不可核'), { code: 'EACCES' })
      }
      if (f.statEnotdirPrefix && String(path).startsWith(f.statEnotdirPrefix)) {
        throw Object.assign(new Error('定点注入：中间段不是目录'), { code: 'ENOTDIR' })
      }
      return actual.statSync(path, rest[0] as never)
    },
    copyFileSync: (source: string, target: string, ...rest: unknown[]) => {
      // 只注入「当前内容 → 检查点备份」这一步（与独审同款故障点）
      if (f.failCopySource && String(source) === f.failCopySource && String(target).includes('files')) {
        throw Object.assign(new Error(`${BACKUP_MARK} 定点注入：当前内容备份被拒`), { code: 'EACCES' })
      }
      return actual.copyFileSync(source, target, rest[0] as number | undefined)
    },
    writeFileSync: (file: string, data: unknown, ...rest: unknown[]) => {
      // manifest 第 N 次起持续失败：用来验"增量落盘失败不得当作已备份""finish 失败继续中止回滚"
      if (String(file).endsWith('manifest.json')) {
        f.manifestWrites += 1
        if (f.failManifestFrom > 0 && f.manifestWrites >= f.failManifestFrom) {
          throw Object.assign(new Error('定点注入：manifest 落盘失败'), { code: 'EACCES' })
        }
      }
      return actual.writeFileSync(file, data, rest[0] as never)
    }
  }
})

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (f.failReadPath && String(path) === f.failReadPath) {
        throw Object.assign(new Error('定点注入：读取被 EIO 打断'), { code: 'EIO' })
      }
      return actual.readFile(path, rest[0] as never)
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

// ─────────────────────────── 通用夹具 ───────────────────────────

const temps: string[] = []
function makeDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `jsl-usw-${tag}-`))
  temps.push(d)
  return d
}
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

afterEach(() => {
  f.realpathEaccesPrefix = ''
  f.realpathEnotdirPrefix = ''
  f.statEaccesPrefix = ''
  f.statEnotdirPrefix = ''
  f.failCopySource = ''
  f.failReadPath = ''
  f.failManifestFrom = 0
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

interface Harness {
  dir: string
  ck: CheckpointStore
  tools: AgentTool[]
  tool: (name: string) => AgentTool
  /** 开一轮检查点（与界面每个写操作各开一轮同形） */
  begin: () => string
  end: () => void
  /** 一轮内跑一段，返回该轮记下的文件变更 */
  run: <T>(body: () => Promise<T>) => Promise<{ result: T; changes: string[] }>
}

/** 真实工具链：file-tools（同一实例 = 同一 revisions Map）+ 写入服务 + 检查点存储 */
function agentLine(tag: string): Harness {
  const dir = makeDir(tag)
  const ck = createCheckpointStore(join(dir, '.checkpoints'))
  let current: string | null = null
  const writer = createWorkspaceWriter(dir, {
    beforeChange: (rel, abs) => {
      if (current) ck.record(current, dir, rel, abs)
    },
    trash: async () => {}
  })
  const tools = createFileTools(writer)
  const tool = (name: string): AgentTool => {
    const t = tools.find((x) => x.schema.name === name)
    if (!t) throw new Error(`工具缺失：${name}`)
    return t
  }
  const begin = (): string => {
    current = ck.begin(dir, '定点夹具', 'usw')
    return current
  }
  const end = (): void => {
    if (current) {
      ck.finish(current)
      current = null
    }
  }
  return {
    dir,
    ck,
    tools,
    tool,
    begin,
    end,
    async run(body) {
      const id = begin()
      try {
        const result = await body()
        end()
        return { result, changes: (ck.get(id)?.changes ?? []).map((c) => c.rel) }
      } finally {
        end()
      }
    }
  }
}

// ───────────────────── R1：读取拒绝 → 同实例 write_file ─────────────────────

it('R1a 超 8MiB 读取被拒：不得据此取得覆盖资格（字节不变）', async () => {
  const h = agentLine('r1a')
  const abs = join(h.dir, 'big.txt')
  writeFileSync(abs, Buffer.alloc(8 * 1024 * 1024 + 1, 0x41))
  const before = sha(abs)

  const read = await h.tool('read_file').execute({ path: 'big.txt' })
  expect(read).toContain('超过 8MB')

  const out = await h.run(async () => {
    const w = h.tool('write_file').execute({ path: 'big.txt', content: '被覆盖' })
    return w
  })
  expect(out.result, '拒绝过的读取不得成为覆盖资格').toContain('错误')
  expect(out.result).toContain('请先用 read_file')
  expect(out.changes, '失败的写入不得留下检查点/产物事实').toEqual([])
  expect(sha(abs), '原字节必须不变').toBe(before)
})

it('R1b 头部 NUL 读取被拒：不得据此取得覆盖资格', async () => {
  const h = agentLine('r1b')
  const abs = join(h.dir, 'bin.dat')
  writeFileSync(abs, Buffer.from([0x41, 0x00, 0x42, 0x43]))
  const before = sha(abs)

  expect(await h.tool('read_file').execute({ path: 'bin.dat' })).toContain('二进制')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'bin.dat', content: '覆盖' }))
  expect(out.result).toContain('请先用 read_file')
  expect(sha(abs)).toBe(before)
})

it('R1c 行窗口越界（2 行文件 offset=100）被拒：不得据此取得覆盖资格', async () => {
  const h = agentLine('r1c')
  const abs = join(h.dir, 'two.txt')
  writeFileSync(abs, 'a\nb\n', 'utf8')
  const before = sha(abs)

  const read = await h.tool('read_file').execute({ path: 'two.txt', offset: 100 })
  expect(read).toContain('超出文件范围')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'two.txt', content: '覆盖' }))
  expect(out.result).toContain('请先用 read_file')
  expect(sha(abs)).toBe(before)
})

it('R1d 读取 IO 失败（EIO 定点注入）：不得取得覆盖资格（防回归）', async () => {
  const h = agentLine('r1d')
  const abs = join(h.dir, 'io.txt')
  writeFileSync(abs, 'IO_BASE', 'utf8')
  const before = sha(abs)

  f.failReadPath = abs
  const read = await h.tool('read_file').execute({ path: 'io.txt' })
  expect(read).toContain('读取失败')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'io.txt', content: '覆盖' }))
  expect(out.result).toContain('请先用 read_file')
  expect(sha(abs)).toBe(before)
})

it('R1e 合法整读 / 合法窗口读之后写入成功（正向出口不能被修死）', async () => {
  const h = agentLine('r1e')
  writeFileSync(join(h.dir, 'ok.txt'), 'L1\nL2\n', 'utf8')
  writeFileSync(join(h.dir, 'win.txt'), 'W1\nW2\n', 'utf8')

  const full = await h.run(async () => {
    expect(await h.tool('read_file').execute({ path: 'ok.txt' })).toContain('L1')
    return h.tool('write_file').execute({ path: 'ok.txt', content: 'L1-fixed\n' })
  })
  expect(full.result).toContain('已写入')
  expect(full.changes, '成功写入才留检查点').toEqual(['ok.txt'])
  expect(readFileSync(join(h.dir, 'ok.txt'), 'utf8')).toBe('L1-fixed\n')

  // 窗口读（不是全文）同样是"被接受的读取"，应当授权覆盖
  const win = await h.run(async () => {
    expect(await h.tool('read_file').execute({ path: 'win.txt', offset: 2, limit: 1 })).toContain('W2')
    return h.tool('write_file').execute({ path: 'win.txt', content: 'W-fixed\n' })
  })
  expect(win.result).toContain('已写入')
  expect(readFileSync(join(h.dir, 'win.txt'), 'utf8')).toBe('W-fixed\n')
})

it('R1f 新建文件不需要读取资格（真不存在的新建不受影响）', async () => {
  const h = agentLine('r1f')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'new.txt', content: 'brand-new\n' }))
  expect(out.result).toContain('已写入')
  expect(readFileSync(join(h.dir, 'new.txt'), 'utf8')).toBe('brand-new\n')
})

// ───────────────────── R2：edit 拒绝 → 同实例 write_file ─────────────────────

it('R2a edit 因超 8MiB 被拒：不得偷存读取资格', async () => {
  const h = agentLine('r2a')
  const abs = join(h.dir, 'big.txt')
  writeFileSync(abs, Buffer.alloc(8 * 1024 * 1024 + 1, 0x41))
  const before = sha(abs)

  const edit = await h.tool('edit').execute({ path: 'big.txt', edits: [{ oldText: 'A', newText: 'B' }] })
  expect(edit).toContain('拒绝处理')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'big.txt', content: '覆盖' }))
  expect(out.result).toContain('请先用 read_file')
  expect(sha(abs)).toBe(before)
})

it('R2b edit 因头部 NUL 被拒：不得偷存读取资格', async () => {
  const h = agentLine('r2b')
  const abs = join(h.dir, 'bin.dat')
  writeFileSync(abs, Buffer.from([0x41, 0x00, 0x42]))
  const before = sha(abs)

  expect(await h.tool('edit').execute({ path: 'bin.dat', edits: [{ oldText: 'A', newText: 'Z' }] })).toContain('二进制')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'bin.dat', content: '覆盖' }))
  expect(out.result).toContain('请先用 read_file')
  expect(sha(abs)).toBe(before)
})

it('R2c edit 读取 IO 失败：不得偷存读取资格（防回归）', async () => {
  const h = agentLine('r2c')
  const abs = join(h.dir, 'io.txt')
  writeFileSync(abs, 'IO_BASE', 'utf8')
  const before = sha(abs)

  f.failReadPath = abs
  expect(await h.tool('edit').execute({ path: 'io.txt', edits: [{ oldText: 'IO_BASE', newText: 'X' }] })).toContain('读取失败')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'io.txt', content: '覆盖' }))
  expect(out.result).toContain('请先用 read_file')
  expect(sha(abs)).toBe(before)
})

it('R2d 精确替换/多处替换照旧；失配与无变化都不生成写成功事实或产物', async () => {
  const h = agentLine('r2d')
  writeFileSync(join(h.dir, 'a.ts'), 'const x = 1\nconst y = 2\n', 'utf8')

  const ok = await h.run(() =>
    h.tool('edit').execute({
      path: 'a.ts',
      edits: [
        { oldText: 'const x = 1', newText: 'const x = 10' },
        { oldText: 'const y = 2', newText: 'const y = 20' }
      ]
    })
  )
  expect(ok.result).toContain('共 2 处替换')
  expect(ok.changes, '成功编辑留检查点').toEqual(['a.ts'])
  expect(readFileSync(join(h.dir, 'a.ts'), 'utf8')).toBe('const x = 10\nconst y = 20\n')

  const editTool = h.tool('edit')
  const missArgs = { path: 'a.ts', edits: [{ oldText: '找不到的内容', newText: 'X' }] }
  const miss = await h.run(() => editTool.execute(missArgs))
  expect(miss.result).toContain('未做任何改动')
  expect(miss.changes, '失配不得留下写事实').toEqual([])
  expect(editTool.takeProducedFiles?.(missArgs), '失配不得伪造产物').toEqual([])

  const sameArgs = { path: 'a.ts', edits: [{ oldText: 'const x = 10', newText: 'const x = 10' }] }
  const same = await h.run(() => editTool.execute(sameArgs))
  expect(same.result).toContain('内容无变化')
  expect(same.changes).toEqual([])
})

// ───────────────────────── R3：同 mtime 异内容 ─────────────────────────

it('R3 同 mtime 异内容：旧版本提交冲突且保留人工字节；重新合法读取后提交成功', async () => {
  const h = agentLine('r3')
  const abs = join(h.dir, 'same.txt')
  writeFileSync(abs, 'AAAA\n', 'utf8')
  // mtime 归整到整秒（NTFS 记 100ns 精度，utimes 只有毫秒 —— 不归整就无法构造"完全相等"）
  const whole = Math.floor(Date.now() / 1000) * 1000
  utimesSync(abs, new Date(whole), new Date(whole))
  const mtime0 = statSync(abs).mtimeMs

  expect(await h.tool('read_file').execute({ path: 'same.txt' })).toContain('AAAA')

  // 等长外部改写 + 精确回拨 mtime：mtime 无法单独替代内容版本
  writeFileSync(abs, 'BBBB\n', 'utf8')
  utimesSync(abs, new Date(mtime0), new Date(mtime0))
  const mtime1 = statSync(abs).mtimeMs
  expect(mtime1, '本钉前提：mtime 必须精确相等，否则拦的是 mtime 变化，实验无效').toBe(mtime0)

  // 冲突沿既有通路**上抛**（FileConflictError → Agent 暂停 / 界面 conflict），不是回一句错误文本
  const conflictRun = h.begin()
  await expect(
    h.tool('write_file').execute({ path: 'same.txt', content: 'AGENT\n' }),
    '同 mtime 异内容必须以内容版本拦下'
  ).rejects.toThrow('文件已变更')
  h.end()
  expect(
    (h.ck.get(conflictRun)?.changes ?? []).map((c) => c.rel),
    '冲突不得留下检查点/产物事实'
  ).toEqual([])
  expect(readFileSync(abs, 'utf8'), '人工字节必须原样保留').toBe('BBBB\n')

  // 重新合法读取 → 同一实例内提交成功
  expect(await h.tool('read_file').execute({ path: 'same.txt' })).toContain('BBBB')
  const ok = await h.run(() => h.tool('write_file').execute({ path: 'same.txt', content: 'AGENT\n' }))
  expect(ok.result).toContain('已写入')
  expect(readFileSync(abs, 'utf8')).toBe('AGENT\n')
})

// ───────────────────── R4：路径解析与错误分类 ─────────────────────

it('R4a realpath 报 EACCES：不得当"不存在"继续上溯放行', async () => {
  const dir = makeDir('r4a')
  mkdirSync(join(dir, 'perm'))
  writeFileSync(join(dir, 'perm', 'x.txt'), 'PERM_CONTENT', 'utf8')
  f.realpathEaccesPrefix = join(dir, 'perm')

  expect(() => realpathDeepest(join(dir, 'perm', 'x.txt')), '真实路径不可核必须抛错').toThrow()
  expect(resolvePathInWorkspace(dir, 'perm/x.txt'), '不可核的路径必须拒绝（fail-closed）').toBeNull()
})

it('R4b 工具层给"不可核"独立分类（不冒充越界），且不读不写', async () => {
  const h = agentLine('r4b')
  mkdirSync(join(h.dir, 'perm'))
  const abs = join(h.dir, 'perm', 'x.txt')
  writeFileSync(abs, 'PERM_CONTENT', 'utf8')
  const before = sha(abs)
  f.realpathEaccesPrefix = join(h.dir, 'perm')

  const read = await h.tool('read_file').execute({ path: 'perm/x.txt' })
  expect(read, '不得把权限失败当"文件不存在"或"越界"').toContain('无法确认')
  expect(read).not.toContain('PERM_CONTENT')
  const write = await h.run(() => h.tool('write_file').execute({ path: 'perm/x.txt', content: '覆盖' }))
  expect(write.result).toContain('无法确认')
  expect(sha(abs)).toBe(before)
})

it('R4c canonicalFilePath 遇 EACCES：必须抛错，不得把不可核目录当"未存在尾部"', async () => {
  const dir = makeDir('r4c')
  mkdirSync(join(dir, 'perm'))
  writeFileSync(join(dir, 'perm', 'a.txt'), 'x', 'utf8')
  f.statEaccesPrefix = join(dir, 'perm')

  expect(() => canonicalFilePath(join(dir, 'perm', 'a.txt')), '不可核身份不得返回可信 key').toThrow()
})

it('R4d 界外联接改向：读取/写入被拒，界外哨兵字节不变', async () => {
  const h = agentLine('r4d')
  const outside = makeDir('r4d-out')
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SENTINEL', 'utf8')
  symlinkSync(outside, join(h.dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const before = sha(join(outside, 'secret.txt'))

  expect(resolvePathInWorkspace(h.dir, 'link/secret.txt')).toBeNull()
  const read = await h.tool('read_file').execute({ path: 'link/secret.txt' })
  expect(read).toContain('越出工作区边界')
  expect(read).not.toContain('OUTSIDE_SENTINEL')
  const write = await h.run(() => h.tool('write_file').execute({ path: 'link/secret.txt', content: 'overwrite' }))
  expect(write.result).toContain('越出工作区边界')
  expect(sha(join(outside, 'secret.txt')), '界外哨兵一个字节都不许动').toBe(before)
})

it('R4e 界内稳定联接（别名同目标）不被一律禁用，且共享同一 canonical 身份', async () => {
  const h = agentLine('r4e')
  mkdirSync(join(h.dir, 'folder'))
  writeFileSync(join(h.dir, 'folder', 'same.txt'), 'ALIAS_BASE', 'utf8')
  symlinkSync(join(h.dir, 'folder'), join(h.dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')

  const viaAlias = resolvePathInWorkspace(h.dir, 'alias/same.txt')
  expect(viaAlias, '界内稳定联接不该被补反例一并禁用').not.toBeNull()
  expect(viaAlias!.outside).toBe(false)
  expect(canonicalFilePath(join(h.dir, 'alias', 'same.txt'))).toBe(canonicalFilePath(join(h.dir, 'folder', 'same.txt')))
})

it('R4f 提交等待中的身份变化（目录被换成界外联接）：安全拒绝，界外哨兵不变', async () => {
  const dir = makeDir('r4f')
  const outside = makeDir('r4f-out')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'a.txt'), 'ORIGINAL', 'utf8')
  writeFileSync(join(outside, 'a.txt'), 'OUTSIDE_SENTINEL', 'utf8')
  const writer = createWorkspaceWriter(dir, {
    beforeChange: () => {
      renameSync(join(dir, 'sub'), join(dir, 'sub-old'))
      symlinkSync(outside, join(dir, 'sub'), process.platform === 'win32' ? 'junction' : 'dir')
    },
    trash: async () => {}
  })

  // 身份在"写前回调"之后被换掉：必须安全拒绝（身份冲突或边界拒绝都算拒绝，关键是一个字节都不许落）
  let refused = ''
  try {
    await writer.write('sub/a.txt', 'NEW', contentRevision('ORIGINAL'))
  } catch (err) {
    refused = (err as Error).message
  }
  expect(refused, '身份变化必须被拒绝，不得放行写入').toMatch(/文件已变更|越出工作区边界/)
  expect(readFileSync(join(outside, 'a.txt'), 'utf8'), '界外哨兵一个字节都不许动').toBe('OUTSIDE_SENTINEL')
  expect(readFileSync(join(dir, 'sub-old', 'a.txt'), 'utf8'), '原目标也不得被改').toBe('ORIGINAL')
})

it('R4g 真不存在的新建仍然成立（ENOENT 上溯不得被修死）', async () => {
  const h = agentLine('r4g')
  const out = await h.run(() => h.tool('write_file').execute({ path: 'deep/nest/new.txt', content: 'NEW\n' }))
  expect(out.result).toContain('已写入')
  expect(readFileSync(join(h.dir, 'deep', 'nest', 'new.txt'), 'utf8')).toBe('NEW\n')
})

// ──────────────── R4 补：ENOTDIR 不属于"待创建尾部"（定点注入 + 真实路径反例） ────────────────

it('R4h realpath 报 ENOTDIR：不得上溯成待创建尾部，真实工具拒绝且哨兵不变', async () => {
  const h = agentLine('r4h')
  mkdirSync(join(h.dir, 'nd'))
  const sentinel = join(h.dir, 'nd', 'x.txt')
  writeFileSync(sentinel, 'ND_SENTINEL', 'utf8')
  const before = sha(sentinel)
  f.realpathEnotdirPrefix = join(h.dir, 'nd')

  expect(() => realpathDeepest(sentinel), 'ENOTDIR 必须上抛').toThrow()
  expect(resolvePathInWorkspace(h.dir, 'nd/x.txt'), 'ENOTDIR 不得被当成未建尾部放行').toBeNull()
  const read = await h.tool('read_file').execute({ path: 'nd/x.txt' })
  expect(read).toContain('无法确认')
  expect(read, '不得泄露哨兵内容').not.toContain('ND_SENTINEL')
  const write = await h.run(() => h.tool('write_file').execute({ path: 'nd/x.txt', content: 'overwrite' }))
  expect(write.result).toContain('无法确认')
  expect(write.changes, '拒绝不得留下写事实').toEqual([])
  expect(sha(sentinel), '哨兵字节不变').toBe(before)
})

it('R4i canonicalFilePath 遇 ENOTDIR：必须抛错，且写入被拒、哨兵不变', async () => {
  const dir = makeDir('r4i')
  mkdirSync(join(dir, 'nd'))
  const sentinel = join(dir, 'nd', 'a.txt')
  writeFileSync(sentinel, 'ND_SENTINEL', 'utf8')
  const before = sha(sentinel)
  f.statEnotdirPrefix = join(dir, 'nd')

  expect(() => canonicalFilePath(sentinel), 'ENOTDIR 不得返回看似可信的 key').toThrow()
  const writer = createWorkspaceWriter(dir, { trash: async () => {} })
  await expect(writer.write('nd/a.txt', 'overwrite', contentRevision('ND_SENTINEL'))).rejects.toThrow()
  expect(sha(sentinel), '哨兵字节不变').toBe(before)
})

it('R4j 真实路径反例：父级是普通文件时读写均被拒，原文件字节不变', async () => {
  const h = agentLine('r4j')
  const asFile = join(h.dir, 'plain.txt')
  writeFileSync(asFile, 'PLAIN_FILE', 'utf8')
  const before = sha(asFile)

  // 平台差异如实记录：Windows 对"文件之下的路径"报 ENOENT，POSIX 报 ENOTDIR；两者都必须被拒
  let code = 'none'
  try {
    statSync(join(asFile, 'sub'))
  } catch (err) {
    code = (err as NodeJS.ErrnoException).code ?? 'unknown'
  }
  console.log(`R4J_PLATFORM_CODE=${code}`)

  const read = await h.tool('read_file').execute({ path: 'plain.txt/sub/x.txt' })
  expect(read, '读取不得成功').toContain('错误')
  expect(read).not.toContain('PLAIN_FILE')
  const write = await h.run(() => h.tool('write_file').execute({ path: 'plain.txt/sub/x.txt', content: 'X' }))
  expect(write.result, '写入不得成功').toContain('错误')
  expect(write.changes, '失败写入不得在检查点里留下事实（虚假 created）').toEqual([])
  expect(() => canonicalFilePath(join(asFile, 'sub')), 'canonical 身份也不得把普通文件当祖先').toThrow()
  expect(existsSync(join(asFile, 'sub')), '不得在文件之下造出目录').toBe(false)
  expect(sha(asFile), '原文件字节不变').toBe(before)
})

// ──────────────── R5：回滚前备份失败原因必须在收尾后仍可用（真实 handler + 真实磁盘） ────────────────

f.root = mkdtempSync(join(tmpdir(), 'jsl-usw-r5-'))
const { IPC } = await import('@shared/ipc')
const { registerIpcHandlers } = await import('@main/ipc')
const { createAgentContext } = await import('@main/agent/runner')
const { createMemoryStore } = await import('@main/store/memory-store')
const { createPlaybookStore } = await import('@main/store/playbook-store')

let seq = 0
function r5setup(): {
  root: string
  store: CheckpointStore
  tools: AgentTool[]
  tool: (name: string) => AgentTool
  /** 用真实工具链开一轮（beforeChange → 同一 store），供"失败创建"反例使用 */
  begin: () => string
  end: () => void
} {
  f.handlers.clear()
  const root = join(f.root, `case-${++seq}`)
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
  let current: string | null = null
  const writer = createWorkspaceWriter(root, {
    beforeChange: (rel, abs) => {
      if (current) agent.checkpoints.record(current, root, rel, abs)
    },
    trash: async () => {}
  })
  const tools = createFileTools(writer)
  return {
    root,
    store: agent.checkpoints,
    tools,
    tool: (name: string) => {
      const found = tools.find((x) => x.schema.name === name)
      if (!found) throw new Error(`工具缺失：${name}`)
      return found
    },
    begin: () => (current = agent.checkpoints.begin(root, '定点夹具', 'usw')),
    end: () => {
      if (current) {
        agent.checkpoints.finish(current)
        current = null
      }
    }
  }
}

function r5seed(h: { root: string; store: CheckpointStore }, changes: Array<{ rel: string; original: string; current: string }>): string {
  const id = h.store.begin(h.root, '定点夹具', 'usw')
  for (const c of changes) {
    const abs = join(h.root, c.rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, c.original, 'utf8')
    h.store.record(id, h.root, c.rel, abs)
    writeFileSync(abs, c.current, 'utf8')
  }
  h.store.finish(id)
  return id
}

function rollbackViaHandler(runId: string): Promise<{
  restored: string[]
  deleted: string[]
  failed: Array<{ rel: string; reason: string }>
  rejected: string[]
}> {
  return f.handlers.get(IPC.checkpointRollback)!({}, { runId }) as never
}

it('R5a 单目标备份失败：snapshotCurrent.failed 与 IPC 报告都保留可辨识原因', async () => {
  const h = r5setup()
  const id = r5seed(h, [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const abs = join(h.root, 'a.txt')

  f.failCopySource = abs
  const pre = h.store.snapshotCurrent(id, undefined, '界面：回滚前的自动备份', 'ui')
  expect(pre.preRunId, '一条都没备份成必须返回 null').toBeNull()
  expect(pre.failed, '失败目标须逐项带原因').toHaveLength(1)
  expect(pre.failed[0]!.reason, '收尾后仍要能取到具体原因（不是通用兜底文案）').toContain(BACKUP_MARK)
  expect(readFileSync(abs, 'utf8'), '失败目标不得被覆盖').toBe('CURRENT')

  const report = await rollbackViaHandler(id)
  expect(report.failed.some((x) => x.rel === 'a.txt' && x.reason.includes(BACKUP_MARK)), 'IPC 结果同样要保留可辨识原因').toBe(true)
  expect(readFileSync(abs, 'utf8'), '失败目标不得被覆盖/删除').toBe('CURRENT')
  expect(h.store.get(id)!.rolledBackAt, '有失败项不得打整轮回滚标记').toBeUndefined()
})

it('R5b 混合成功/失败目标：失败目标原样保留、成功目标照常恢复，原因逐项可辨', async () => {
  const h = r5setup()
  const id = r5seed(h, [
    { rel: 'a.txt', original: 'ORIGINAL-A', current: 'CURRENT-A' },
    { rel: 'b.txt', original: 'ORIGINAL-B', current: 'CURRENT-B' }
  ])
  f.failCopySource = join(h.root, 'a.txt')

  const report = await rollbackViaHandler(id)
  expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('CURRENT-A')
  expect(readFileSync(join(h.root, 'b.txt'), 'utf8'), '备份成功的目标照常恢复').toBe('ORIGINAL-B')
  expect(report.restored).toEqual(['b.txt'])
  expect(report.failed.some((x) => x.rel === 'a.txt' && x.reason.includes(BACKUP_MARK))).toBe(true)
  expect(h.store.get(id)!.rolledBackAt).toBeUndefined()
})

it('R5c created 目标当前备份失败：不得被当作 created 删掉', async () => {
  const h = r5setup()
  const abs = join(h.root, 'created.txt')
  const id = h.store.begin(h.root, '定点夹具', 'usw')
  h.store.record(id, h.root, 'created.txt', abs) // 此刻不存在 → created
  writeFileSync(abs, 'NEW_CURRENT', 'utf8')
  h.store.finish(id)

  f.failCopySource = abs
  const report = await rollbackViaHandler(id)
  expect(existsSync(abs), '备份失败的新建目标不得被删除').toBe(true)
  expect(readFileSync(abs, 'utf8')).toBe('NEW_CURRENT')
  expect(report.deleted).toEqual([])
  expect(report.failed.some((x) => x.rel === 'created.txt' && x.reason.includes(BACKUP_MARK))).toBe(true)
})

it('R5d manifest 增量/收尾落盘失败：继续中止回滚，不拿内存条目冒充可重开', async () => {
  const h = r5setup()
  const id = r5seed(h, [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const abs = join(h.root, 'a.txt')
  // 第 2 次落盘起失败：备份轮 begin 的 manifest（第 1 次）成功，record 的增量与 finish 的收尾都失败
  f.manifestWrites = 0
  f.failManifestFrom = 2

  expect(() => h.store.snapshotCurrent(id, undefined, '界面：回滚前的自动备份', 'ui'), 'manifest 失败必须中止').toThrow(
    'manifest'
  )
  expect(readFileSync(abs, 'utf8'), '中止前不得覆盖/删除目标').toBe('CURRENT')
  expect(h.store.get(id)!.rolledBackAt, '未回滚不得留完成标记').toBeUndefined()
})

it('R5e 正常无故障回滚：恢复成功、备份轮可从磁盘重开核对，退错再退仍成立', async () => {
  const h = r5setup()
  const id = r5seed(h, [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }])

  const report = await rollbackViaHandler(id)
  expect(report).toMatchObject({ restored: ['a.txt'], failed: [], rejected: [] })
  expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('ORIGINAL')

  // 备份轮不是内存幻影：换一个 store 实例（= 重启后）仍能读到 manifest
  const reopened = createCheckpointStore(join(h.root, 'checkpoints'))
  const backupRun = reopened.list().find((r) => r.agent === '界面：回滚前的自动备份')
  expect(backupRun, '回滚前必须留下可从磁盘重开的备份轮').toBeTruthy()
  expect(reopened.get(backupRun!.runId)!.changes.map((c) => c.rel)).toEqual(['a.txt'])

  const again = await rollbackViaHandler(backupRun!.runId)
  expect(again.failed).toEqual([])
  expect(readFileSync(join(h.root, 'a.txt'), 'utf8'), '退错再退应回到 CURRENT').toBe('CURRENT')
})

// ──────────────── SW-REV-01/02：失败创建的检查点事实 / manifest begin 失败 ────────────────

it('SW-REV-01 失败创建不得遗留虚假 created：父级合法化后的人工文件经真实回滚不被删除', async () => {
  const h = r5setup()
  const asFile = join(h.root, 'plain.txt')
  writeFileSync(asFile, 'PLAIN_FILE', 'utf8')

  // ① 一次真实工具写入：父级是普通文件 → 失败，且本轮检查点不得留下任何变更
  const runId = h.begin()
  const write = await h.tool('write_file').execute({ path: 'plain.txt/sub/x.txt', content: 'X' })
  h.end()
  expect(write, '写入必须失败').toContain('错误')
  expect(h.store.get(runId)!.changes, '失败写入不得留下 created').toEqual([])

  // ② 合法变化：父级换成真目录，随后人工在同一路径创建文件（合成数据）
  rmSync(asFile)
  mkdirSync(join(h.root, 'plain.txt', 'sub'), { recursive: true })
  const human = join(h.root, 'plain.txt', 'sub', 'x.txt')
  writeFileSync(human, 'HUMAN_LATER', 'utf8')
  const humanSha = sha(human)

  // ③ 经真实注册 handler 回滚那一"旧轮"：不得把后来的人工文件当本轮产物删掉
  const report = await rollbackViaHandler(runId)
  expect(report.deleted, '不得报告删除了本轮从未创建的文件').toEqual([])
  expect(report.restored).toEqual([])
  expect(existsSync(human), '人工文件必须仍在').toBe(true)
  expect(sha(human), '人工文件字节不变').toBe(humanSha)

  // ④ 重开检查点核对同一事实
  const reopened = createCheckpointStore(join(h.root, 'checkpoints'))
  expect(reopened.get(runId)!.changes, '重开后旧轮仍应没有变更').toEqual([])
  expect(existsSync(human) && sha(human) === humanSha, '重开后人工文件仍在且字节不变').toBe(true)
})

it('SW-REV-02 manifest begin 失败：真实 handler 抛可辨识错误、目标与旧轮状态不变', async () => {
  const h = r5setup()
  const id = r5seed(h, [{ rel: 'a.txt', original: 'ORIGINAL', current: 'CURRENT' }])
  const abs = join(h.root, 'a.txt')
  const before = sha(abs)
  const runsBefore = h.store.list().length

  // 种子记录完成后再重置计数：让备份轮 begin 的第一次 manifest 落盘失败
  f.manifestWrites = 0
  f.failManifestFrom = 1
  // handler 在 begin 处同步抛错（渲染层收到的是失败的 IPC 调用）；两种形态都要能被判据抓住
  let thrown = ''
  try {
    await rollbackViaHandler(id)
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err)
  }
  expect(thrown, 'begin 失败必须中止回滚且原因可辨识').toContain('manifest')

  expect(existsSync(abs), '目标必须仍存在').toBe(true)
  expect(sha(abs), '目标字节不变').toBe(before)
  expect(readFileSync(abs, 'utf8'), '目标内容不变').toBe('CURRENT')
  expect(h.store.get(id)!.rolledBackAt, '不得打整轮回滚标记').toBeUndefined()
  expect(h.store.list().length, '不得留下"已备份"的新轮次').toBe(runsBefore)

  // 注入清理后：正常回滚 / 重开核 manifest / 退错再退仍成立
  f.failManifestFrom = 0
  const report = await rollbackViaHandler(id)
  expect(report).toMatchObject({ restored: ['a.txt'], failed: [], rejected: [] })
  expect(readFileSync(abs, 'utf8')).toBe('ORIGINAL')
  const reopened = createCheckpointStore(join(h.root, 'checkpoints'))
  const backup = reopened.list().find((r) => r.agent === '界面：回滚前的自动备份')
  expect(backup, '注入清理后备份轮应可从磁盘重开').toBeTruthy()
  const again = await rollbackViaHandler(backup!.runId)
  expect(again.failed).toEqual([])
  expect(readFileSync(abs, 'utf8'), '退错再退应回到 CURRENT').toBe('CURRENT')
})
