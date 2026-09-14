import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import {
  deleteAgentFile,
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
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [], projectNames: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(existsSync(res.file)).toBe(true)
    const def = parseAgentDefinition(readFileSync(res.file, 'utf8'), 'user', res.file, 'label')
    expect(def.systemPrompt).toBe(USER_INPUT.systemPrompt)
  })

  it('新建撞用户层同名 = 拒绝（不许静默覆盖别人的自定义 Agent）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-clash-'))
    expect(saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [], projectNames: [] }).ok).toBe(true)
    const again = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [], projectNames: [] })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain('已存在同名定义')
  })

  it('新建撞内置名 = 放行并带覆盖提示；撞项目层名 = 放行并带优先级提示', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-notice-'))
    const hitBuiltin = saveAgentDefinition(nodeFsAdapter, userDir, { ...USER_INPUT, name: 'planner' }, {
      builtinNames: ['planner'],
      projectNames: []
    })
    expect(hitBuiltin.ok && hitBuiltin.notice).toContain('覆盖内置')
    const hitProject = saveAgentDefinition(nodeFsAdapter, userDir, { ...USER_INPUT, name: 'scout' }, {
      builtinNames: [],
      projectNames: ['scout']
    })
    expect(hitProject.ok && hitProject.notice).toContain('优先')
  })

  it('编辑既有文件（带 file）按路径写；越界 file 拒绝', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-edit-'))
    const created = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [], projectNames: [] })
    if (!created.ok) throw new Error('前置失败')
    const edited = saveAgentDefinition(nodeFsAdapter, userDir, { ...USER_INPUT, file: created.file, systemPrompt: '改过的正文' }, {
      builtinNames: [],
      projectNames: []
    })
    expect(edited.ok).toBe(true)
    expect(readAgentDefinition(nodeFsAdapter, created.file, [userDir], 'user')?.systemPrompt).toBe('改过的正文')

    const outside = saveAgentDefinition(nodeFsAdapter, userDir, { ...USER_INPUT, file: join(tmpdir(), 'evil.md') }, {
      builtinNames: [],
      projectNames: []
    })
    expect(outside.ok).toBe(false)
  })
})

describe('readAgentDefinition / deleteAgentFile（按来源路径定位，判据 9）', () => {
  it('按 file 读回；越界返回 null', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-rd-'))
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [], projectNames: [] })
    if (!res.ok) throw new Error('前置失败')
    expect(readAgentDefinition(nodeFsAdapter, res.file, [userDir], 'user')?.name).toBe('code-reviewer')
    expect(readAgentDefinition(nodeFsAdapter, join(tmpdir(), 'no.md'), [userDir], 'user')).toBeNull()
  })

  it('文件名与 name 脱钩（手改场景）：按 file 仍读得对、删得掉', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'jsl-agents-rename-'))
    const res = saveAgentDefinition(nodeFsAdapter, userDir, USER_INPUT, { builtinNames: [], projectNames: [] })
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
    const res = saveAgentDefinition(nodeFsAdapter, wiped, USER_INPUT, { builtinNames: [], projectNames: [] })
    expect(res.ok).toBe(true)
    expect(existsSync(join(wiped, 'code-reviewer.md'))).toBe(true)
  })
})

describe('loadAgentsFromDir（用户层）与目录自举', () => {
  it('目录不存在返回空 entries（不是错误）', () => {
    expect(loadAgentsFromDir(join(tmpdir(), 'jsl-nope'), 'user').entries).toHaveLength(0)
  })
})
