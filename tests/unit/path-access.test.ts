import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync as readSrc } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInside, resolveInsideWorkspace, resolvePathInWorkspace, type PathAccess } from '@main/agent/guard'
import { createFileTools } from '@main/agent/tools/file-tools'
import { createSystemTools } from '@main/agent/tools/system-tools'
import { createWorkspaceWriter } from '@main/workspace-write'
import { createCheckpointStore } from '@main/store/checkpoints'
import {
  listWorkspaceDir,
  readAttachment,
  readWorkspaceBinary,
  readWorkspaceFile
} from '@main/workspace-fs'
import type { AgentTool } from '@shared/agent'

// 档位语义落地（plan29 D-089）：**「完全访问」在 Agent 线上真的没有边界，界面线一点没放开。**
//
// 这组用例存在的唯一理由：`resolveInsideWorkspace` 有**两条互不相干的消费线** ——
// 放开 Agent 线时若顺手把界面线也放开，就把一个「权限不足」的问题换成了「**界面越权**」这个
// 更严重的问题，而且是用户从没要求过的能力扩张。判据 3（本文件最后一组）是这条改动
// **唯一的回归闸**：没有它，S1 就是净风险上升。
//
// 编排：临时目录 tmp/{ws,out}，ws 是工作区，out 在工作区**外**且是它的兄弟目录 ——
// 于是 `../out/...` 就是一条真实的越界相对路径（不是构造出来的假情况）。

interface Env {
  ws: string
  out: string
  cleanup: () => void
}

function makeEnv(): Env {
  const base = mkdtempSync(join(tmpdir(), 'jsl-pathaccess-'))
  const ws = join(base, 'ws')
  const out = join(base, 'out')
  mkdirSync(join(ws, 'sub'), { recursive: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(join(ws, 'inner.txt'), 'inside-content\n', 'utf8')
  writeFileSync(join(out, 'secret.txt'), 'const outsideMarker = 1\nsecond line\n', 'utf8')
  writeFileSync(join(out, 'notes.md'), '# 界外笔记\n', 'utf8')
  return {
    ws,
    out,
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true })
      } catch {
        // 忽略
      }
    }
  }
}

const toolOf = (tools: AgentTool[], name: string): AgentTool => {
  const t = tools.find((x) => x.schema.name === name)
  if (!t) throw new Error(`工具缺失：${name}`)
  return t
}

/** Agent 线的一整套工具（按档位给不给策略） */
function agentTools(ws: string, access?: PathAccess): AgentTool[] {
  const writer = createWorkspaceWriter(ws, {
    ...(access ? { pathAccess: access } : {}),
    trash: async () => {}
  })
  return [
    ...createFileTools(writer),
    ...createSystemTools(ws, undefined, 'test', null, access)
  ]
}

const FULL: PathAccess = { allowOutside: true }

// ── 判据 4：默认参数 = 与改动前完全一致（fail-closed） ────────────────────────

describe('guard 层：默认锁死（判据 4 · 15 处调用点零改动的根据）', () => {
  it('不传第三参 / 传空对象 / 传 allowOutside:false —— 三种都拒绝越界', () => {
    const env = makeEnv()
    try {
      expect(resolvePathInWorkspace(env.ws, '../out/secret.txt')).toBeNull()
      expect(resolvePathInWorkspace(env.ws, '../out/secret.txt', {})).toBeNull()
      expect(resolvePathInWorkspace(env.ws, '../out/secret.txt', { allowOutside: false })).toBeNull()
      expect(resolveInsideWorkspace(env.ws, '../out/secret.txt')).toBeNull()
    } finally {
      env.cleanup()
    }
  })

  it('绝对路径直指界外同样被拒（不是只挡 ../）', () => {
    const env = makeEnv()
    try {
      expect(resolvePathInWorkspace(env.ws, join(env.out, 'secret.txt'))).toBeNull()
      expect(resolveInsideWorkspace(env.ws, join(env.out, 'secret.txt'))).toBeNull()
    } finally {
      env.cleanup()
    }
  })

  it('界内路径照常放行，且 outside 恒为 false', () => {
    const env = makeEnv()
    try {
      const r = resolvePathInWorkspace(env.ws, 'inner.txt')
      expect(r).not.toBeNull()
      expect(r!.outside).toBe(false)
      expect(r!.abs).toBe(join(env.ws, 'inner.txt'))
    } finally {
      env.cleanup()
    }
  })

  it('空串 / 非字符串 → null（不抛错，调用方按"越界"处理）', () => {
    const env = makeEnv()
    try {
      expect(resolvePathInWorkspace(env.ws, '')).toBeNull()
      expect(resolvePathInWorkspace(env.ws, undefined as unknown as string)).toBeNull()
    } finally {
      env.cleanup()
    }
  })

  it('isInside 是纯几何判断：界内 true、界外 false、根本身 true；不做策略', () => {
    const env = makeEnv()
    try {
      expect(isInside(env.ws, env.ws)).toBe(true)
      expect(isInside(env.ws, join(env.ws, 'sub'))).toBe(true)
      expect(isInside(env.ws, env.out)).toBe(false)
    } finally {
      env.cleanup()
    }
  })
})

// ── 判据 2：full-access 下 Agent 线放行，且**越界可见**（决议 2） ──────────────

describe('guard 层：full-access 放行 + 如实标注出界', () => {
  it('界外相对路径 → 放行，outside=true，返回绝对路径', () => {
    const env = makeEnv()
    try {
      const r = resolvePathInWorkspace(env.ws, '../out/secret.txt', FULL)
      expect(r).not.toBeNull()
      expect(r!.outside).toBe(true)
      expect(r!.abs).toBe(join(env.out, 'secret.txt'))
    } finally {
      env.cleanup()
    }
  })

  it('界内路径在这一档下 outside 仍为 false（提示不能变成"处处都提示"）', () => {
    const env = makeEnv()
    try {
      const r = resolvePathInWorkspace(env.ws, 'inner.txt', FULL)
      expect(r!.outside).toBe(false)
      expect(r!.abs).toBe(join(env.ws, 'inner.txt'))
    } finally {
      env.cleanup()
    }
  })

  it('writer.allowsOutside 由策略决定 —— 工具层据此决定提不提示，不再自己重算一遍', () => {
    const env = makeEnv()
    try {
      expect(createWorkspaceWriter(env.ws, { trash: async () => {} }).allowsOutside).toBe(false)
      expect(createWorkspaceWriter(env.ws, { pathAccess: FULL, trash: async () => {} }).allowsOutside).toBe(true)
    } finally {
      env.cleanup()
    }
  })
})

describe('Agent 线 · file-tools 在 full-access 下越界可用（判据 2）', () => {
  it('read_file 越过边界能读到内容，且结果里**带出界提示 + 绝对路径**', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws, FULL), 'read_file').execute({ path: '../out/secret.txt' })
      expect(out).toContain('outsideMarker')
      expect(out).toContain('【工作区外：')
      expect(out).toContain(join(env.out, 'secret.txt'))
    } finally {
      env.cleanup()
    }
  })

  it('write_file 越界能落盘，同样带出界提示', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws, FULL), 'write_file').execute({
        path: '../out/created.txt',
        content: 'written outside\n'
      })
      expect(out).toContain('【工作区外：')
      expect(readFileSync(join(env.out, 'created.txt'), 'utf8')).toBe('written outside\n')
    } finally {
      env.cleanup()
    }
  })

  it('edit 越界能改，盘上内容真的变了', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws, FULL), 'edit').execute({
        path: '../out/secret.txt',
        edits: [{ oldText: 'const outsideMarker = 1', newText: 'const outsideMarker = 2' }]
      })
      expect(out).toContain('【工作区外：')
      expect(readFileSync(join(env.out, 'secret.txt'), 'utf8')).toContain('outsideMarker = 2')
    } finally {
      env.cleanup()
    }
  })

  it('界内行为一字未改：full-access 下读界内文件**不带**越界提示', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws, FULL), 'read_file').execute({ path: 'inner.txt' })
      expect(out).toContain('inside-content')
      expect(out).not.toContain('【工作区外：')
    } finally {
      env.cleanup()
    }
  })

  it('工具描述在这一档下告诉模型"界外也可指定"（否则这套能力要靠它撞错才发现）', () => {
    const env = makeEnv()
    try {
      const locked = toolOf(agentTools(env.ws), 'read_file')
      const free = toolOf(agentTools(env.ws, FULL), 'read_file')
      expect(locked.schema.description).not.toContain('完全访问档')
      expect(free.schema.description).toContain('完全访问档')
    } finally {
      env.cleanup()
    }
  })
})

describe('Agent 线 · system-tools 在 full-access 下越界可用（判据 2）', () => {
  it('list_dir 界外目录能列，且带出界提示', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws, FULL), 'list_dir').execute({ path: '../out' })
      expect(out).toContain('【工作区外：')
      expect(out).toContain('secret.txt')
    } finally {
      env.cleanup()
    }
  })

  it('list_dir 界外空目录也带提示（提示不能只挂在"有内容"的分支上）', async () => {
    const env = makeEnv()
    try {
      mkdirSync(join(env.out, 'empty'))
      const out = await toolOf(agentTools(env.ws, FULL), 'list_dir').execute({ path: '../out/empty' })
      expect(out).toContain('【工作区外：')
      expect(out).toContain('空目录')
    } finally {
      env.cleanup()
    }
  })

  it('search_files 界外起点不再报"越出工作区边界"', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws, FULL), 'search_files').execute({
        query: 'outsideMarker',
        path: '../out'
      })
      expect(out).not.toContain('越出工作区边界')
      expect(out).toContain('【工作区外：')
    } finally {
      env.cleanup()
    }
  })
})

describe('Agent 线 · 锁定档下越界仍被拒（判据 1）', () => {
  it('read-only / write 档（不传策略）三个工具一致拒绝，且不泄露界外内容', async () => {
    const env = makeEnv()
    try {
      const tools = agentTools(env.ws) // 不传 = 锁死
      for (const name of ['read_file', 'write_file', 'edit', 'list_dir', 'search_files']) {
        const out = await toolOf(tools, name).execute({ path: '../out/secret.txt', content: 'x', query: 'x', edits: [] })
        expect(out, `${name} 应被拒`).toContain('越出工作区边界')
        expect(out, `${name} 不该泄露内容`).not.toContain('outsideMarker')
      }
    } finally {
      env.cleanup()
    }
  })

  it('界外写入**没有发生**（拒绝不等于"报个错就算了"）', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws), 'write_file').execute({ path: '../out/nope.txt', content: 'x' })
      expect(out).toContain('越出工作区边界')
      expect(() => readFileSync(join(env.out, 'nope.txt'), 'utf8')).toThrow()
    } finally {
      env.cleanup()
    }
  })
})

// ── 判据 3 ★ 回归闸：界面线在 full-access 下仍不能碰工作区外 ────────────────
//
// 这一组是本次改动**唯一的"不得越界"保证**。它测的不是"档位生效了吗"，
// 而是"**档位不该生效的地方，生效了吗**"—— 后者一旦失守就是界面越权。
// 注意：界面线**根本没有接收档位的通道**（各自直接调 `resolveInsideWorkspace`），
// 所以下面这些函数连"传了 full-access 会怎样"都问不出来 —— 这正是设计意图，测试把它钉住。

describe('★ 界面线：档位管不着它（判据 3 · 回归闸）', () => {
  it('listWorkspaceDir 界外仍被拒', async () => {
    const env = makeEnv()
    try {
      const r = await listWorkspaceDir(env.ws, '../out')
      expect(r.ok).toBe(false)
      expect(r.entries).toEqual([])
      expect(r.error).toContain('越出工作区边界')
    } finally {
      env.cleanup()
    }
  })

  it('readWorkspaceFile 界外仍被拒', async () => {
    const env = makeEnv()
    try {
      const r = await readWorkspaceFile(env.ws, '../out/secret.txt')
      expect(r.ok).toBe(false)
    } finally {
      env.cleanup()
    }
  })

  it('readWorkspaceBinary 界外仍被拒', async () => {
    const env = makeEnv()
    try {
      const r = await readWorkspaceBinary(env.ws, '../out/secret.txt')
      expect(r.ok).toBe(false)
    } finally {
      env.cleanup()
    }
  })

  it('readAttachment：**相对**越界路径仍抛错（绝对路径放行是拖拽那条线的既定语义，与本档位无关）', async () => {
    const env = makeEnv()
    try {
      // 越界这一步就抛了，够不到图片落盘 ⇒ 第三参给临时 userData 即可（不许指向工作区，免得看着像在往仓库里写）
      const userData = join(env.out, 'userData')
      await expect(readAttachment(env.ws, '../out/secret.txt', userData)).rejects.toThrow('越出了工作区')
    } finally {
      env.cleanup()
    }
  })
})

// ── 判据 3 的结构性守卫：界面线源码里**不该出现**策略符号 ────────────────────
//
// 行为断言只能覆盖"我知道的那几个入口"。策略一旦被顺手带进界面线，最可能的样子是
// **一个新的调用点**，行为断言看不见它。所以再补一道源码级守卫：界面线各模块里
// 不许出现 `PathAccess` / `resolvePathInWorkspace` / `allowOutside` / `pathAccess`。
// 反向验证：同一断言在 `guard.ts` / Agent 线上应当**命中**，否则说明读取本身失效、守卫是空的。

const UI_LINE_FILES = [
  'src/main/workspace-fs.ts',
  'src/main/ipc.ts',
  'src/main/office-preview.ts',
  'src/main/preview-protocol.ts',
  'src/main/store/git-info.ts'
]
const POLICY_SYMBOLS = ['PathAccess', 'resolvePathInWorkspace', 'allowOutside', 'pathAccess']

describe('★ 界面线源码里不许出现路径策略符号（判据 3 · 结构性）', () => {
  it('界面线五个模块：一个策略符号都没有', () => {
    for (const rel of UI_LINE_FILES) {
      const src = readSrc(join(process.cwd(), rel), 'utf8')
      for (const sym of POLICY_SYMBOLS) {
        expect(src.includes(sym), `${rel} 里不该出现 ${sym}`).toBe(false)
      }
    }
  })

  it('反向验证：同样的检查在 Agent 线上**必须命中**（否则上面那条是空断言）', () => {
    const guardSrc = readSrc(join(process.cwd(), 'src/main/agent/guard.ts'), 'utf8')
    expect(guardSrc).toContain('PathAccess')
    expect(guardSrc).toContain('allowOutside')
    const writerSrc = readSrc(join(process.cwd(), 'src/main/workspace-write.ts'), 'utf8')
    expect(writerSrc).toContain('pathAccess')
  })

  it('反向验证：界面线文件确实被读到了（不是"读了个空文件"导致的全绿）', () => {
    for (const rel of UI_LINE_FILES) {
      const src = readSrc(join(process.cwd(), rel), 'utf8')
      expect(src.length, `${rel} 读出来是空的`).toBeGreaterThan(500)
      expect(src).toContain('resolveInsideWorkspace')
    }
  })
})

// ── 互补裁决：Agent 线**只走**带策略的那个函数 ──────────────────────────────
//
// 上面证明了「界面线拿不到策略」。这一组证明**背面**：Agent 线不再有第二个入口。
// 留着旧入口的后果不是安全漏洞（那个版本 fail-closed，更严），而是**静默的半失灵** ——
// 完全访问档下新加的某个工具仍然被锁在工作区内，用户只会觉得"这个档位有时候好用有时候不好用"，
// 而根因藏在一个 import 里。所以让"Agent 线不许调无策略版本"变成一条会红的断言。

const AGENT_LINE_FILES = [
  'src/main/agent/tools/file-tools.ts',
  'src/main/agent/tools/system-tools.ts',
  'src/main/workspace-write.ts'
]

describe('Agent 线只走 resolvePathInWorkspace（不允许再有第二个入口）', () => {
  it('三个 Agent 线模块里**没有任何** resolveInsideWorkspace(...) 调用', () => {
    for (const rel of AGENT_LINE_FILES) {
      const src = readSrc(join(process.cwd(), rel), 'utf8')
      expect(src.includes('resolveInsideWorkspace('), `${rel} 仍在调无策略版本`).toBe(false)
      expect(src, `${rel} 应改用带策略版本`).toContain('resolvePathInWorkspace')
    }
  })
})

// ── 一处**不对称**，以及它的免责说明 ────────────────────────────────────────
//
// 检查点自己保留着工作区边界（`store/checkpoints.ts` 里那条 `target.startsWith(root+sep)`）——
// 界外目标**一条都不记**。这是**有意**的：回滚由界面触发，让界面能写工作区外就等于界面越权。
// 于是 full-access 下出现一个不对称：**能改，但退不回来**。
//
// 不对称本身可以接受（"无边界"是用户自己选的档位），**沉默不行**。
// 这一组把两件事都钉住：① 回滚确实不覆盖界外（上游事实）② 写入结果**说清了这件事**（我们的补救）。

describe('★ 界外写入不在回滚覆盖内 —— 结果里必须说清', () => {
  it('上游事实：检查点对界外目标一条都不记（不是漏写，是刻意保留的界面线边界）', () => {
    const env = makeEnv()
    const ckDir = mkdtempSync(join(tmpdir(), 'jsl-ck-'))
    try {
      const store = createCheckpointStore(ckDir)
      const runId = store.begin(env.ws, '测试', 'c1')
      store.record(runId, env.ws, 'inner.txt', join(env.ws, 'inner.txt'))
      store.record(runId, env.ws, '../out/secret.txt', join(env.out, 'secret.txt'))
      const run = store.get(runId)
      expect(run).not.toBeNull()
      expect(run!.changes.map((c) => c.rel)).toEqual(['inner.txt'])
      store.finish(runId)
    } finally {
      rmSync(ckDir, { recursive: true, force: true })
      env.cleanup()
    }
  })

  it('补偿：full-access 下写界外文件，结果里带「不在本轮回滚覆盖范围内」', async () => {
    const env = makeEnv()
    try {
      const writer = createWorkspaceWriter(env.ws, { pathAccess: FULL, trash: async () => {} })
      const msg = await writer.write('../out/newfile.txt', 'x\n')
      expect(msg).toContain('已写入')
      expect(msg).toContain('不在本轮回滚覆盖范围内')
      expect(readFileSync(join(env.out, 'newfile.txt'), 'utf8')).toBe('x\n')
    } finally {
      env.cleanup()
    }
  })

  it('界内写入**不带**这句（提示若能处处出现就等于噪音，用户会学会无视它）', async () => {
    const env = makeEnv()
    try {
      const writer = createWorkspaceWriter(env.ws, { pathAccess: FULL, trash: async () => {} })
      const msg = await writer.write('inner.txt', 'y\n')
      expect(msg).toContain('已写入')
      expect(msg).not.toContain('不在本轮回滚覆盖范围内')
    } finally {
      env.cleanup()
    }
  })

  it('工具层的结果里也带得到这句（writer 的说明会顺着 write_file 一路回到模型与用户眼前）', async () => {
    const env = makeEnv()
    try {
      const out = await toolOf(agentTools(env.ws, FULL), 'write_file').execute({
        path: '../out/viaTool.txt',
        content: 'z\n'
      })
      expect(out).toContain('不在本轮回滚覆盖范围内')
      expect(out).toContain('【工作区外：')
    } finally {
      env.cleanup()
    }
  })
})
