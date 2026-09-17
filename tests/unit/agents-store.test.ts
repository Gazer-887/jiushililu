import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import {
  deleteAgentFile,
  extractUnmanagedFrontmatter,
  isAllowedAgentFile,
  readAgentDefinition,
  saveAgentDefinition,
  serializeAgentDefinition
} from '@main/store/agents-store'
import { loadAgentsFromDir, parseAgentDefinition } from '@main/agent/loader'
import { validateAgentFields } from '@shared/agents'

// agents-store（plan17 G1）：表单 ↔ 文件的往返 CRUD。判据先登记：保存的文件必须能被 loader 原样解析（判据 1）、
// 两端口径一致（判据 2）、按来源路径删除（判据 9）、撞名分级（D3）。

const USER_INPUT = {
  name: 'code-reviewer',
  description: '代码评审专家',
  tools: ['read_file', 'search_files'],
  model: 'deepseek-flash',
  systemPrompt: '只报告可证明的问题，按 P0~P3 分级。'
}

describe('serializeAgentDefinition → loader 往返（判据 1）', () => {
  it('序列化产物能被 parseAgentDefinition 原样解析回同字段', () => {
    const raw = serializeAgentDefinition(USER_INPUT)
    const def = parseAgentDefinition(raw, 'user', '/x/code-reviewer.md', 'label')
    expect(def.name).toBe(USER_INPUT.name)
    expect(def.description).toBe(USER_INPUT.description)
    expect(def.tools).toEqual(USER_INPUT.tools)
    expect(def.model).toBe(USER_INPUT.model)
    expect(def.systemPrompt).toBe(USER_INPUT.systemPrompt)
  })

  it('description 带换行被折成空格（换行会破坏 frontmatter 结构）', () => {
    const raw = serializeAgentDefinition({ ...USER_INPUT, description: '第一行\n第二行' })
    const def = parseAgentDefinition(raw, 'user', '/x/a.md', 'label')
    expect(def.description).toBe('第一行 第二行')
  })
})

describe('validateAgentFields 两端口径（判据 2）', () => {
  it('表单拒的坏 name 与 loader 拒因一致', () => {
    for (const bad of ['UPPER', '带空格 x', '', '-lead', 'a'.repeat(65)]) {
      const viaForm = validateAgentFields({ ...USER_INPUT, name: bad })
      expect(viaForm.ok).toBe(false)
      expect(() =>
        parseAgentDefinition(serializeAgentDefinition({ ...USER_INPUT, name: bad }), 'user', '/x/a.md', 'label')
      ).toThrow()
    }
  })

  it('空 description / 空 systemPrompt 两侧同拒', () => {
    expect(validateAgentFields({ ...USER_INPUT, description: '' }).ok).toBe(false)
    expect(validateAgentFields({ ...USER_INPUT, systemPrompt: '  ' }).ok).toBe(false)
    expect(validateAgentFields(USER_INPUT).ok).toBe(true)
  })
})

describe('isAllowedAgentFile（路径安全）', () => {
  const userDir = join(tmpdir(), 'jsl-agents-store-user')

  it('目录内的绝对 .md 放行；目录外 / 相对路径 / 非 .md 全拒', () => {
    expect(isAllowedAgentFile(join(userDir, 'a.md'), [userDir])).toBe(true)
    expect(isAllowedAgentFile(join(tmpdir(), 'outside.md'), [userDir])).toBe(false)
    expect(isAllowedAgentFile('a.md', [userDir])).toBe(false)
    expect(isAllowedAgentFile(join(userDir, 'a.json'), [userDir])).toBe(false)
    // 穿越伪造：resolve 后不在目录内
    expect(isAllowedAgentFile(join(userDir, '..', 'escape.md'), [userDir])).toBe(false)
  })
})

describe('saveAgentDefinition（撞名分级 + 原子写）', () => {
  it('新建落盘 → loader 能读回同字段（盘上真相）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-save-'))
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(existsSync(res.file)).toBe(true)
    const def = parseAgentDefinition(readFileSync(res.file, 'utf8'), 'user', res.file, 'label')
    expect(def.systemPrompt).toBe(USER_INPUT.systemPrompt)
  })

  it('新建撞用户层同名 = 拒绝（不许静默覆盖别人的自定义 Agent）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-clash-'))
    expect(saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] }).ok).toBe(true)
    const again = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain('已存在同名定义')
  })

  it('新建撞内置名 = 放行并带覆盖提示（D-103：项目级已取消，不再有项目层撞名）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-notice-'))
    const hitBuiltin = saveAgentDefinition(nodeFsAdapter, userDir, { ...USER_INPUT, name: 'planner' }, {
      builtinNames: ['planner']
    })
    expect(hitBuiltin.ok && hitBuiltin.notice).toContain('覆盖内置')
  })

  it('编辑既有文件（带 file）按路径写；越界 file 拒绝', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-edit-'))
    const created = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] })
    if (!created.ok) throw new Error('前置失败')
    const edited = saveAgentDefinition(nodeFsAdapter, userDir, { ...USER_INPUT, file: created.file, systemPrompt: '改过的正文' }, {
      builtinNames: []
    })
    expect(edited.ok).toBe(true)
    expect(readAgentDefinition(nodeFsAdapter, created.file, [userDir], 'user')?.systemPrompt).toBe('改过的正文')

    const outside = saveAgentDefinition(nodeFsAdapter, userDir, { ...USER_INPUT, file: join(tmpdir(), 'evil.md') }, {
      builtinNames: []
    })
    expect(outside.ok).toBe(false)
  })
})

describe('readAgentDefinition / deleteAgentFile（按来源路径定位，判据 9）', () => {
  it('按 file 读回；越界返回 null', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-rd-'))
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] })
    if (!res.ok) throw new Error('前置失败')
    expect(readAgentDefinition(nodeFsAdapter, res.file, [userDir], 'user')?.name).toBe('code-reviewer')
    expect(readAgentDefinition(nodeFsAdapter, join(tmpdir(), 'no.md'), [userDir], 'user')).toBeNull()
  })

  it('文件名与 name 脱钩（手改场景）：按 file 仍读得对、删得掉', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-rename-'))
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] })
    if (!res.ok) throw new Error('前置失败')
    // 用户手改文件名（loader 层面 name 不变、文件名变了）——按 name 反推文件名的实现在这里会删错
    const renamed = join(userDir, 'renamed-by-hand.md')
    const raw = readFileSync(res.file, 'utf8')
    rmSync(res.file)
    writeFileSync(renamed, raw, 'utf8')
    expect(readAgentDefinition(nodeFsAdapter, renamed, [userDir], 'user')?.name).toBe('code-reviewer')
    expect(deleteAgentFile(nodeFsAdapter, renamed, userDir).ok).toBe(true)
    expect(existsSync(renamed)).toBe(false)
  })

  it('删除不存在 = 幂等成功；目录被外部删后保存自愈（mkdir 兜底）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-del-'))
    expect(deleteAgentFile(nodeFsAdapter, join(userDir, 'ghost.md'), userDir).ok).toBe(true)

    const wiped = mkdtempSync(join(tmpdir(), 'jsl-agents-wipe-'))
    rmSync(wiped, { recursive: true })
    const res = saveAgentDefinition(nodeFsAdapter, wiped, USER_INPUT, { builtinNames: [] })
    expect(res.ok).toBe(true)
    expect(existsSync(join(wiped, 'code-reviewer.md'))).toBe(true)
  })
})

describe('loadAgentsFromDir（用户层）与目录自举', () => {
  it('目录不存在返回空 entries（不是错误）', () => {
    expect(loadAgentsFromDir(join(tmpdir(), 'jsl-nope'), 'user').entries).toHaveLength(0)
  })
})

// ── 表单保存不得抹掉「表单不管的字段」（plan27）────────────────────────────
// 起因：保存按表单字段全量重写，会把**表单不认识的其他 frontmatter 字段静默抹掉**，
// 而用户不会有任何察觉 —— 这直接违背「MD 是唯一真相源」：改一个字段，不该顺手删掉别人写的其他字段。
//
// ⚠️ 注意 S4 之后的口径变化：`approval` / `executor` 有了表单控件，**转入 MANAGED_KEYS**，
// 所以本组用例改用**真的未知键**来验这条机制（用 approval 验会变成在验一个已经管理的字段）。

describe('extractUnmanagedFrontmatter（保留未知键）', () => {
  it('取出表单管不到的键，丢掉表单管的那些', () => {
    const raw = [
      '---',
      'name: a',
      'description: 描述',
      'tools: [read_file]',
      'model: m',
      'approval: plan',
      'executor: code-executor',
      'notes: 我手写的备注',
      'tags: [x, y]',
      '---',
      '正文'
    ].join('\n')
    expect(extractUnmanagedFrontmatter(raw)).toEqual(['notes: 我手写的备注', 'tags: [x, y]'])
  })

  it('没有 frontmatter / 只有管理键 → 空数组（不抛错）', () => {
    expect(extractUnmanagedFrontmatter('直接是正文')).toEqual([])
    expect(extractUnmanagedFrontmatter('---\nname: a\ndescription: b\n---\n正文')).toEqual([])
  })

  it('认 CRLF（Windows 手改过的文件）', () => {
    const raw = '---\r\nname: a\r\ndescription: b\r\nnotes: 备注\r\n---\r\n正文'
    expect(extractUnmanagedFrontmatter(raw)).toEqual(['notes: 备注'])
  })
})

describe('saveAgentDefinition 编辑既有文件时保留未知键（plan27）', () => {
  it('界面只改 description → 手写的未知键原样保住', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-preserve-'))
    const file = join(userDir, 'custom.md')
    writeFileSync(
      file,
      '---\nname: custom\ndescription: 老描述\ntools: [read_file]\nnotes: 我手写的备注\n---\n老正文',
      'utf8'
    )

    const res = saveAgentDefinition(
      nodeFsAdapter,
      userDir,
      { name: 'custom', description: '新描述', tools: ['read_file'], systemPrompt: '新正文', file },
      { builtinNames: [] }
    )
    expect(res.ok).toBe(true)

    const def = parseAgentDefinition(readFileSync(file, 'utf8'), 'user', file, 'label')
    expect(def.description).toBe('新描述') // 表单管的字段确实被改了
    expect(def.systemPrompt).toBe('新正文')
    expect(readFileSync(file, 'utf8')).toContain('notes: 我手写的备注') // ← 未知键一个都没丢
  })

  it('表单管的字段**以表单为准**（保住未知键不能反过来把用户的修改吞掉）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-managed-'))
    const file = join(userDir, 'x.md')
    writeFileSync(file, '---\nname: x\ndescription: 旧\ntools: [read_file]\nnotes: 备注\n---\n正文', 'utf8')

    saveAgentDefinition(
      nodeFsAdapter,
      userDir,
      { name: 'x', description: '新', tools: ['read_file', 'search_files'], systemPrompt: '正文', file },
      { builtinNames: [] }
    )
    const def = parseAgentDefinition(readFileSync(file, 'utf8'), 'user', file, 'label')
    expect(def.tools).toEqual(['read_file', 'search_files']) // 表单新加的 search_files 生效
    expect(readFileSync(file, 'utf8')).toContain('notes: 备注') // 未知键仍保住
  })

  it('新建（没有 file）时不引入任何野生字段', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-fresh-'))
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const def = parseAgentDefinition(readFileSync(res.file, 'utf8'), 'user', res.file, 'label')
    expect(def.approval).toBeUndefined()
    expect(def.executor).toBeUndefined()
  })
})

describe('plan27 S4：approval / executor 的表单往返', () => {
  it('勾了计划批准 → 落盘写 approval: plan 与 executor，loader 解析得回', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-pa-'))
    const res = saveAgentDefinition(
      nodeFsAdapter,
      userDir,
      { ...USER_INPUT, approval: 'plan', executor: 'code-executor' },
      { builtinNames: [] }
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const def = parseAgentDefinition(readFileSync(res.file, 'utf8'), 'user', res.file, 'label')
    expect(def.approval).toBe('plan')
    expect(def.executor).toBe('code-executor')
  })

  it('编辑往返：改一行 description 再保存，approval / executor **不会丢**（S4 的核心风险）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-pa-rt-'))
    const file = join(userDir, 'my-planner.md')
    writeFileSync(file, '---\nname: my-planner\ndescription: 旧\ntools: [read_file]\n---\n正文', 'utf8')

    // 第一次：勾上批准（表单读回时会带 approval，编辑时原样提交）
    const first = saveAgentDefinition(
      nodeFsAdapter,
      userDir,
      { name: 'my-planner', description: '旧', tools: ['read_file'], systemPrompt: '正文', file, approval: 'plan', executor: 'code-executor' },
      { builtinNames: [] }
    )
    expect(first.ok).toBe(true)

    // 第二次：只改 description，**照常带上**从表单读回的 approval/executor
    const again = saveAgentDefinition(
      nodeFsAdapter,
      userDir,
      {
        name: 'my-planner',
        description: '新',
        tools: ['read_file'],
        systemPrompt: '正文',
        file,
        approval: 'plan',
        executor: 'code-executor'
      },
      { builtinNames: [] }
    )
    expect(again.ok).toBe(true)
    const def = parseAgentDefinition(readFileSync(file, 'utf8'), 'user', file, 'label')
    expect(def.description).toBe('新')
    expect(def.approval).toBe('plan')
    expect(def.executor).toBe('code-executor')
    // 关键：**不能写两行**（approval 若既在管理键里、又被当未知键保留，就会重复）
    const raw = readFileSync(file, 'utf8')
    expect(raw.match(/^approval:/gm) ?? []).toHaveLength(1)
    expect(raw.match(/^executor:/gm) ?? []).toHaveLength(1)
  })

  it('不勾批准 → 不写 approval / executor（零影响，老定义不受干扰）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-pa-off-'))
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const raw = readFileSync(res.file, 'utf8')
    expect(raw).not.toContain('approval:')
    expect(raw).not.toContain('executor:')
  })

  it('取不到效的 approval 字面量不落盘（写个认不出的值比不写更坏）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-pa-bad-'))
    const res = saveAgentDefinition(
      nodeFsAdapter,
      userDir,
      // @ts-expect-error 故意传一个非法值：模拟渲染进程被篡改 / 老版本界面
      { ...USER_INPUT, approval: 'always' },
      { builtinNames: [] }
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(readFileSync(res.file, 'utf8')).not.toContain('approval:')
  })
})
