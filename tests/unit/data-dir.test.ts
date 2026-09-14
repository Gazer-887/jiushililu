import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DIR_LOCK_FILE,
  LOCATION_FILE,
  MIGRATED_MARKER,
  acquireDirLock,
  bootstrapDataDir,
  nodeFsMigrationFs,
  parseLocationConfig,
  prepareRestoreTarget,
  planMigration,
  releaseDirLock,
  runMigration,
  serializeLocationConfig,
  validateTargetPath,
  writeLocationConfig,
  type BootstrapInput,
  type MigrationFs
} from '@main/store/data-dir-core'

// 数据目录纯逻辑（plan10 C 批 / §2.4 P0-1～P0-6 / §6.2 存储通道判据）。
// 全部跑在临时目录上（注入 dir，**不许动真实用户目录**）；失败注入用"包装真 fs 改写个别方法"，
// 真文件真字节，失败点才人工干预 —— 与 conversations-fs.test.ts 同一套纪律。

const roots: string[] = []

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `jsl-dd-${prefix}-`))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 在目录里放一组"典型 userData"文件：自有数据 + Chromium 缓存 */
function seedUserData(dir: string): void {
  mkdirSync(join(dir, 'conversations'), { recursive: true })
  writeFileSync(join(dir, 'conversations.json'), JSON.stringify({ schemaVersion: 2, conversations: {} }))
  writeFileSync(join(dir, 'conversations', 'abc.json'), JSON.stringify({ id: 'abc' }))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  writeFileSync(join(dir, 'models.json.bak-20260912'), JSON.stringify({}))
  writeFileSync(join(dir, 'logs.txt'), 'log')
  mkdirSync(join(dir, 'agent-workspace'), { recursive: true })
  writeFileSync(join(dir, 'agent-workspace', 'note.md'), '# 工作区')
  // Chromium 侧（不搬）
  mkdirSync(join(dir, 'Cache'), { recursive: true })
  writeFileSync(join(dir, 'Cache', 'big'), 'x'.repeat(1024))
  writeFileSync(join(dir, 'Preferences'), '{}')
  writeFileSync(join(dir, 'DevToolsActivePort'), '9222')
}

const baseInput = (over: Partial<BootstrapInput>): BootstrapInput => ({
  anchorDir: tmpRoot('anchor'),
  defaultUserData: tmpRoot('default'),
  pid: 424242,
  isPidAlive: () => false,
  fs: nodeFsMigrationFs,
  caseInsensitive: process.platform === 'win32',
  warn: () => {},
  ...over
})

describe('location.json 解析（P0-5：损坏绝不抛）', () => {
  it('正常解析两个指针字段', () => {
    const cfg = parseLocationConfig('{"dataDir":"D:/data","pendingDataDir":"E:/new"}')
    expect(cfg.dataDir).toBe('D:/data')
    expect(cfg.pendingDataDir).toBe('E:/new')
  })

  it('损坏 JSON / 非对象 / 空串 → 空配置', () => {
    expect(parseLocationConfig('{oops')).toEqual({})
    expect(parseLocationConfig('"字符串"')).toEqual({})
    expect(parseLocationConfig('')).toEqual({})
    expect(parseLocationConfig(null)).toEqual({})
  })

  it('字段类型不对 → 忽略该字段（不整个作废）', () => {
    const cfg = parseLocationConfig('{"dataDir":123,"pendingDataDir":"ok"}')
    expect(cfg.dataDir).toBeUndefined()
    expect(cfg.pendingDataDir).toBe('ok')
  })

  it('lastEvent 形状不对 → 忽略；形状对 → 保留', () => {
    expect(parseLocationConfig('{"lastEvent":"炸了"}').lastEvent).toBeUndefined()
    const ok = parseLocationConfig('{"lastEvent":{"kind":"ok","text":"完成","at":"2026-09-14"}}')
    expect(ok.lastEvent?.kind).toBe('ok')
  })

  it('序列化-解析往返不丢字段', () => {
    const cfg = parseLocationConfig(serializeLocationConfig({ dataDir: 'D:/x', lastEvent: { kind: 'error', text: '坏了', at: 't' } }))
    expect(cfg.dataDir).toBe('D:/x')
    expect(cfg.lastEvent?.text).toBe('坏了')
  })
})

describe('目标路径校验（P0-2）', () => {
  const source = process.platform === 'win32' ? 'C:\\data' : '/data'

  it('合法兄弟目录通过', () => {
    // 目标也要按平台分支：`D:/app-data` 在 Linux 上不是绝对路径（validateTargetPath 用宿主语义），
    // CI（ubuntu）会因这条写死而红——修法是测试随平台给等价的合法目标，产品语义（Windows）不动
    const target = process.platform === 'win32' ? 'D:/app-data' : '/app-data'
    expect(validateTargetPath(target, source, false).ok).toBe(true)
  })

  it('空串 / 相对路径 → 拒绝', () => {
    expect(validateTargetPath('', source, false).ok).toBe(false)
    expect(validateTargetPath('relative/path', source, false).ok).toBe(false)
  })

  it('目标 = 源 → 拒绝', () => {
    expect(validateTargetPath(source, source, false).ok).toBe(false)
  })

  it('目标在源内部（自嵌套）→ 拒绝', () => {
    expect(validateTargetPath(join(source, 'sub'), source, false).ok).toBe(false)
  })

  it('源在目标内部（把数据目录包进去）→ 拒绝', () => {
    expect(validateTargetPath(join(source, '..'), source, false).ok).toBe(false)
  })

  it('盘根 → 拒绝', () => {
    expect(validateTargetPath(process.platform === 'win32' ? 'C:\\' : '/', source, false).ok).toBe(false)
  })

  it('Windows 大小写不敏感：只差大小写也判同一目录', () => {
    expect(validateTargetPath('c:\\DATA', 'C:\\data', true).ok).toBe(false)
  })

  it('超长路径 → 拒绝', () => {
    const long = join(source, 'x'.repeat(300))
    expect(validateTargetPath(long, source, false).ok).toBe(false)
  })

  it('Windows 非法字符 → 拒绝', () => {
    expect(validateTargetPath(join(source, 'a<b'), source, false).ok).toBe(false)
  })
})

describe('迁移计划（P0-1 排除法）', () => {
  it('Chromium 目录/文件被排除，自有数据全进计划', () => {
    const src = tmpRoot('plan')
    seedUserData(src)
    const plan = planMigration(src, nodeFsMigrationFs)
    const rels = plan.files.map((f) => f.rel)
    expect(rels).toContain('conversations.json')
    expect(rels).toContain('conversations/abc.json') // 计划用 '/' 分隔（与平台无关）
    expect(rels).toContain('settings.json')
    expect(rels).toContain('models.json.bak-20260912')
    expect(rels).toContain('logs.txt')
    expect(rels).toContain('agent-workspace/note.md')
    expect(rels.some((r) => r.startsWith('Cache'))).toBe(false)
    expect(rels).not.toContain('Preferences')
    expect(plan.skipped).toContain('Cache')
    expect(plan.skipped).toContain('Preferences')
    expect(plan.totalBytes).toBeGreaterThan(0)
  })

  it('源目录不存在 → 空计划', () => {
    const plan = planMigration(join(tmpRoot('nope'), 'ghost'), nodeFsMigrationFs)
    expect(plan.files).toEqual([])
  })
})

describe('三段式迁移（P0-1/P0-2/P0-3）', () => {
  it('正常迁移：目标树齐全、逐文件哈希一致、源目录原样保留、完成标记落盘', () => {
    const src = tmpRoot('m-src')
    const dst = join(tmpRoot('m-dst'), 'newdata')
    seedUserData(src)
    const srcBefore = readdirSync(src).sort()

    const report = runMigration(src, dst, nodeFsMigrationFs, { caseInsensitive: process.platform === 'win32' })

    expect(report.ok).toBe(true)
    expect(report.filesCopied).toBe(6)
    // 目标内容一致（逐文件字节比对）
    expect(readFileSync(join(dst, 'conversations', 'abc.json'), 'utf8')).toBe('{"id":"abc"}')
    expect(readFileSync(join(dst, 'agent-workspace', 'note.md'), 'utf8')).toBe('# 工作区')
    expect(existsSync(join(dst, MIGRATED_MARKER))).toBe(true)
    // 源目录原样保留（P0-1：天然回退点）
    expect(readdirSync(src).sort()).toEqual(srcBefore)
    // 无暂存残留
    expect(existsSync(`${dst}.migrating`)).toBe(false)
  })

  it('AGENTS 红线：计划非空时复制结果不许为空（计数/字节断言）', () => {
    const src = tmpRoot('empty-src')
    const dst = join(tmpRoot('empty-dst'), 'newdata')
    const stagingPrefix = `${dst}.migrating`
    // 注入：copyFileSync 吞掉第 3 个起的文件；readFileSync 把"暂存里缺失的文件"骇成源内容
    // —— 骗过逐文件哈希校验，让**计数闸**（计划数 ≠ 复制数）成为唯一能抓住它的那道闸
    let copies = 0
    const brokenFs: MigrationFs = {
      ...nodeFsMigrationFs,
      copyFileSync: (from, to) => {
        copies += 1
        if (copies > 2) return // 前两个拷，后面全吞
        nodeFsMigrationFs.copyFileSync(from, to)
      },
      readFileSync: (path) => {
        const s = String(path)
        if (s.startsWith(stagingPrefix) && !nodeFsMigrationFs.existsSync(s)) {
          return nodeFsMigrationFs.readFileSync(join(src, s.slice(stagingPrefix.length)))
        }
        return nodeFsMigrationFs.readFileSync(path)
      },
      fsyncFileSync: (path) => {
        if (!nodeFsMigrationFs.existsSync(path)) return // 缺失文件不 fsync（配合上面的吞拷贝）
        nodeFsMigrationFs.fsyncFileSync(path)
      }
    }
    seedUserData(src)
    const report = runMigration(src, dst, brokenFs, { caseInsensitive: process.platform === 'win32' })
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('不完整')
    expect(existsSync(dst)).toBe(false) // 没切换
  })

  it('幂等：目标已有完成标记 → 直接成功不再动', () => {
    const src = tmpRoot('idem-src')
    const dst = join(tmpRoot('idem-dst'), 'newdata')
    seedUserData(src)
    runMigration(src, dst, nodeFsMigrationFs, { caseInsensitive: process.platform === 'win32' })
    // 第二次源里多了一个文件 —— 有标记就不再迁（幂等）
    writeFileSync(join(src, 'later.json'), '{}')
    const again = runMigration(src, dst, nodeFsMigrationFs, { caseInsensitive: process.platform === 'win32' })
    expect(again.ok).toBe(true)
    expect(existsSync(join(dst, 'later.json'))).toBe(false)
  })

  it('目标目录非空 → 拒绝迁入（保护用户已有文件），源完好', () => {
    const src = tmpRoot('nn-src')
    const dstBase = tmpRoot('nn-dst')
    const dst = join(dstBase, 'occupied')
    seedUserData(src)
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'user-file.txt'), '用户的重要文件')
    const report = runMigration(src, dst, nodeFsMigrationFs, { caseInsensitive: process.platform === 'win32' })
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('保护已有文件')
    expect(readFileSync(join(dst, 'user-file.txt'), 'utf8')).toBe('用户的重要文件')
    expect(existsSync(join(src, 'conversations.json'))).toBe(true)
  })

  it('源 JSON 损坏 → 拒绝迁移（半迁移比不迁移更糟），源完好', () => {
    const src = tmpRoot('bad-src')
    const dst = join(tmpRoot('bad-dst'), 'newdata')
    seedUserData(src)
    writeFileSync(join(src, 'broken.json'), '{oops')
    const report = runMigration(src, dst, nodeFsMigrationFs, { caseInsensitive: process.platform === 'win32' })
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('broken.json')
    expect(existsSync(join(src, 'conversations.json'))).toBe(true)
    expect(existsSync(dst)).toBe(false)
  })

  it('目标磁盘空间不足 → 拒绝（P0-2 剩余空间 ≥ 源×2）', () => {
    const src = tmpRoot('disk-src')
    const dst = join(tmpRoot('disk-dst'), 'newdata')
    seedUserData(src)
    const tightFs: MigrationFs = { ...nodeFsMigrationFs, freeBytes: () => 1 }
    const report = runMigration(src, dst, tightFs, { caseInsensitive: process.platform === 'win32' })
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('空间')
    expect(existsSync(dst)).toBe(false)
  })

  it('目标不可写（mkdir 失败）→ 拒绝 + 删暂存 + 源完好（P0-3 全套动作）', () => {
    const src = tmpRoot('ro-src')
    const dst = join(tmpRoot('ro-dst'), 'newdata')
    seedUserData(src)
    const roFs: MigrationFs = {
      ...nodeFsMigrationFs,
      mkdirSync: (p, o) => {
        if (String(p).endsWith('.migrating')) throw new Error('EACCES: permission denied')
        nodeFsMigrationFs.mkdirSync(p, o)
      }
    }
    const report = runMigration(src, dst, roFs, { caseInsensitive: process.platform === 'win32' })
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('不可写')
    expect(existsSync(`${dst}.migrating`)).toBe(false)
    expect(existsSync(join(src, 'conversations.json'))).toBe(true)
  })

  it('空计划（全新安装首次选目录）→ empty 成功直切', () => {
    const src = tmpRoot('fresh-src')
    mkdirSync(src, { recursive: true })
    mkdirSync(join(src, 'Cache'), { recursive: true }) // 只有 Chromium 缓存 = 没有自有数据
    const dst = join(tmpRoot('fresh-dst'), 'newdata')
    const report = runMigration(src, dst, nodeFsMigrationFs, { caseInsensitive: process.platform === 'win32' })
    expect(report.ok).toBe(true)
    expect(report.empty).toBe(true)
    expect(existsSync(join(dst, MIGRATED_MARKER))).toBe(true)
  })

  it('自嵌套目标 → 拒绝', () => {
    const src = tmpRoot('nest-src')
    seedUserData(src)
    const report = runMigration(src, join(src, 'sub'), nodeFsMigrationFs, { caseInsensitive: process.platform === 'win32' })
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('内部')
  })
})

describe('回退准备（回退默认 = 反向迁移的前置）', () => {
  it('默认目录里的旧自有数据挪进 restore-backup-*，location.json 与 Chromium 目录不动', () => {
    const def = tmpRoot('restore')
    seedUserData(def)
    writeFileSync(join(def, LOCATION_FILE), '{"lastEvent":{"kind":"ok","text":"x","at":"t"}}')

    const { moved } = prepareRestoreTarget(def, nodeFsMigrationFs)

    expect(moved).toContain('conversations.json')
    expect(moved).toContain('settings.json')
    expect(moved).toContain('agent-workspace')
    // 顶层自有条目全部挪走
    const left = readdirSync(def).filter((n) => !n.startsWith('restore-backup-'))
    expect(left).toContain('Cache')
    expect(left).toContain('Preferences')
    expect(left).toContain(LOCATION_FILE)
    // 挪走的数据在备份目录里，内容完好
    const backup = readdirSync(def).find((n) => n.startsWith('restore-backup-'))!
    expect(readFileSync(join(def, backup, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })
})

describe('数据目录锁（与 R13 单实例锁是两把锁）', () => {
  it('首抢成功，锁文件带 pid；释放后可再抢', () => {
    const dir = tmpRoot('lock1')
    mkdirSync(dir, { recursive: true })
    const r1 = acquireDirLock(dir, 111, nodeFsMigrationFs, () => true)
    expect(r1.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, DIR_LOCK_FILE), 'utf8'))).toMatchObject({ pid: 111 })
    releaseDirLock(r1.ok ? r1.lock : { path: '', fd: 0 }, nodeFsMigrationFs)
    const r2 = acquireDirLock(dir, 222, nodeFsMigrationFs, () => true)
    expect(r2.ok).toBe(true)
    if (r2.ok) releaseDirLock(r2.lock, nodeFsMigrationFs)
  })

  it('持有者活着 → 拒绝并说明原因', () => {
    const dir = tmpRoot('lock2')
    mkdirSync(dir, { recursive: true })
    const r1 = acquireDirLock(dir, 333, nodeFsMigrationFs, () => true)
    expect(r1.ok).toBe(true)
    const r2 = acquireDirLock(dir, 444, nodeFsMigrationFs, (pid) => pid === 333)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain('333')
    if (r1.ok) releaseDirLock(r1.lock, nodeFsMigrationFs)
  })

  it('陈锁自愈：持有者进程已死 → 删锁重抢成功', () => {
    const dir = tmpRoot('lock3')
    mkdirSync(dir, { recursive: true })
    const r1 = acquireDirLock(dir, 555, nodeFsMigrationFs, () => true)
    expect(r1.ok).toBe(true)
    if (r1.ok) nodeFsMigrationFs.closeSync(r1.lock.fd) // 模拟崩溃：不释放，只关句柄
    const r2 = acquireDirLock(dir, 666, nodeFsMigrationFs, () => false) // 555 进程已不存在
    expect(r2.ok).toBe(true)
    if (r2.ok) releaseDirLock(r2.lock, nodeFsMigrationFs)
  })

  it('锁内容损坏（读不出 pid）→ 当陈锁自愈', () => {
    const dir = tmpRoot('lock4')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, DIR_LOCK_FILE), '不是 JSON')
    const r = acquireDirLock(dir, 777, nodeFsMigrationFs, () => true)
    expect(r.ok).toBe(true)
    if (r.ok) releaseDirLock(r.lock, nodeFsMigrationFs)
  })
})

describe('启动编排 bootstrapDataDir（P0-3/P0-5 全套）', () => {
  it('无配置：用默认目录，不产生 location.json', () => {
    const input = baseInput({})
    const out = bootstrapDataDir(input)
    expect(out.activeDir).toBe(input.defaultUserData)
    expect(out.custom).toBe(false)
    expect(out.migrated).toBeNull()
    expect(existsSync(join(input.anchorDir, LOCATION_FILE))).toBe(false)
    expect(out.lockFailed).toBeNull()
  })

  it('JSL_DATA_DIR 环境变量最高优先：直达该目录，不读不写 location.json', () => {
    const envDir = join(tmpRoot('env'), 'datadir')
    const input = baseInput({ envDataDir: envDir })
    writeFileSync(join(input.anchorDir, LOCATION_FILE), '{"dataDir":"C:/should-be-ignored"}')
    const out = bootstrapDataDir(input)
    expect(out.activeDir).toBe(envDir)
    expect(out.envOverride).toBe(true)
    expect(existsSync(join(envDir, DIR_LOCK_FILE))).toBe(true)
  })

  it('pending 迁移成功：activeDir = 新目录、location.json 写 dataDir 清 pending、原目录保留', () => {
    const input = baseInput({})
    seedUserData(input.defaultUserData)
    const target = join(tmpRoot('fwd'), 'newdata')
    writeFileSync(join(input.anchorDir, LOCATION_FILE), JSON.stringify({ pendingDataDir: target }))

    const out = bootstrapDataDir(input)

    expect(out.activeDir).toBe(target)
    expect(out.custom).toBe(true)
    expect(out.migrated?.ok).toBe(true)
    expect(existsSync(join(target, 'conversations.json'))).toBe(true)
    // 原目录保留（回退点）
    expect(existsSync(join(input.defaultUserData, 'conversations.json'))).toBe(true)
    // location.json：dataDir = target，pending 已清
    const cfg = parseLocationConfig(readFileSync(join(input.anchorDir, LOCATION_FILE), 'utf8'))
    expect(cfg.dataDir).toBe(target)
    expect(cfg.pendingDataDir).toBeUndefined()
    expect(cfg.lastEvent?.kind).toBe('ok')
  })

  it('幂等：迁移完成后第二次启动不再迁移，直接生效', () => {
    const input = baseInput({})
    seedUserData(input.defaultUserData)
    const target = join(tmpRoot('idem2'), 'newdata')
    writeFileSync(join(input.anchorDir, LOCATION_FILE), JSON.stringify({ pendingDataDir: target }))
    bootstrapDataDir(input)

    // 第二次启动：location.json 里只有 dataDir
    const out = bootstrapDataDir(input)
    expect(out.activeDir).toBe(target)
    expect(out.migrated).toBeNull()
    // 数据没有搬第二次的痕迹：lastEvent 还是第一次那条
    const cfg = parseLocationConfig(readFileSync(join(input.anchorDir, LOCATION_FILE), 'utf8'))
    expect(cfg.lastEvent?.text).toContain('迁移')
  })

  it('迁移失败（目标非空）：不切换 + 老目录继续 + lastEvent 记原因 + pending 清掉不无限重试', () => {
    const input = baseInput({})
    seedUserData(input.defaultUserData)
    const target = join(tmpRoot('fail'), 'occupied')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'something.txt'), '已占用')
    writeFileSync(join(input.anchorDir, LOCATION_FILE), JSON.stringify({ pendingDataDir: target }))

    const out = bootstrapDataDir(input)

    expect(out.activeDir).toBe(input.defaultUserData) // P0-3：老目录继续
    expect(out.migrated?.ok).toBe(false)
    expect(out.warnings[0]).toContain('失败')
    const cfg = parseLocationConfig(readFileSync(join(input.anchorDir, LOCATION_FILE), 'utf8'))
    expect(cfg.pendingDataDir).toBeUndefined() // 不无限重试
    expect(cfg.lastEvent?.kind).toBe('error')
    expect(cfg.dataDir).toBeUndefined()
  })

  it('回退默认：旧数据挪 aside → 反向迁移成功 → dataDir 清除、回默认目录', () => {
    const input = baseInput({})
    // 现状：已自定义在 customDir
    const customDir = join(tmpRoot('cust'), 'custom')
    seedUserData(customDir)
    writeFileSync(join(input.anchorDir, LOCATION_FILE), JSON.stringify({ dataDir: customDir }))
    // 默认目录里还有老数据（迁移时源保留）
    seedUserData(input.defaultUserData)

    // 用户点了"恢复默认位置" → pendingDataDir = 默认目录
    writeFileSync(
      join(input.anchorDir, LOCATION_FILE),
      JSON.stringify({ dataDir: customDir, pendingDataDir: input.defaultUserData })
    )
    const out = bootstrapDataDir(input)

    expect(out.activeDir).toBe(input.defaultUserData)
    expect(out.migrated?.ok).toBe(true)
    expect(out.movedAside.length).toBeGreaterThan(0) // 旧数据被挪进 restore-backup
    // 迁回的数据是**自定义目录里的最新数据**
    expect(readFileSync(join(input.defaultUserData, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    const cfg = parseLocationConfig(readFileSync(join(input.anchorDir, LOCATION_FILE), 'utf8'))
    expect(cfg.dataDir).toBeUndefined()
  })

  it('指针指向不可用目录：回退默认 + 指针保留 + lastEvent 记原因（P0-5 绝不启动失败）', () => {
    const input = baseInput({})
    // 造一个"无法创建"的路径：在文件路径下再建子目录必然失败
    writeFileSync(join(input.anchorDir, 'afile'), 'x')
    const brokenPointer = join(input.anchorDir, 'afile', 'child')
    writeFileSync(join(input.anchorDir, LOCATION_FILE), JSON.stringify({ dataDir: brokenPointer }))
    const out = bootstrapDataDir(input)
    expect(out.activeDir).toBe(input.defaultUserData)
    expect(out.warnings.length).toBeGreaterThan(0)
    const cfg = parseLocationConfig(readFileSync(join(input.anchorDir, LOCATION_FILE), 'utf8'))
    // 指针保留：用户修好目录后下次启动自动恢复
    expect(cfg.dataDir).toBe(brokenPointer)
    expect(cfg.lastEvent?.kind).toBe('error')
  })

  it('location.json 损坏 → 全部走默认，绝不抛（P0-5）', () => {
    const input = baseInput({})
    writeFileSync(join(input.anchorDir, LOCATION_FILE), '{损坏的 JSON')
    const out = bootstrapDataDir(input)
    expect(out.activeDir).toBe(input.defaultUserData)
    expect(out.custom).toBe(false)
  })

  it('数据目录锁失败：返回 lockFailed，不在这里退出（处置权在入口）', () => {
    const input = baseInput({ isPidAlive: () => true })
    // 预先用"别人"的 pid 占锁
    mkdirSync(input.defaultUserData, { recursive: true })
    writeFileSync(join(input.defaultUserData, DIR_LOCK_FILE), JSON.stringify({ pid: 999999 }))
    const out = bootstrapDataDir(input)
    expect(out.lock).toBeNull()
    expect(out.lockFailed).toContain('999999')
  })
})

describe('location.json 原子写', () => {
  it('写后无 .tmp 残留，内容可解析', () => {
    const anchor = tmpRoot('atomic')
    writeLocationConfig(anchor, { dataDir: 'D:/x' }, nodeFsMigrationFs)
    const files = readdirSync(anchor)
    expect(files).toContain(LOCATION_FILE)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(() => JSON.parse(readFileSync(join(anchor, LOCATION_FILE), 'utf8'))).not.toThrow()
  })
})
