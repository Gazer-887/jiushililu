import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolGate, resolveInsideWorkspace } from '@main/agent/guard'
import { createFileTools } from '@main/agent/tools/file-tools'
import { createWorkspaceWriter, type WorkspaceWriteHooks } from '@main/workspace-write'
import { runAgentLoop } from '@main/agent/loop'
import type { AgentChatResult, AgentMessage } from '@shared/agent'

describe('ToolGate（白名单门控）', () => {
  it('白名单内的工具放行', () => {
    const gate = new ToolGate(['read_file'])
    expect(gate.check('read_file').ok).toBe(true)
  })

  it('白名单外的工具拦截并给出人话原因', () => {
    const gate = new ToolGate(['read_file'])
    const res = gate.check('write_file')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('白名单')
  })
})

describe('resolveInsideWorkspace（路径越界防护）', () => {
  const root = join(tmpdir(), 'jsl-root')

  it('相对路径落在工作区内 → 通过', () => {
    expect(resolveInsideWorkspace(root, 'src/app.ts')).toBe(join(root, 'src', 'app.ts'))
  })

  it('../ 逃逸 → 拒绝', () => {
    expect(resolveInsideWorkspace(root, '../evil.txt')).toBe(null)
  })

  it('绝对路径指向工作区内 → 通过', () => {
    expect(resolveInsideWorkspace(root, join(root, 'a.txt'))).toBe(join(root, 'a.txt'))
  })

  it('绝对路径指向工作区外 → 拒绝（跨平台：root 的父目录 tmpdir 即界外）', () => {
    expect(resolveInsideWorkspace(root, tmpdir())).toBe(null)
  })

  it('空路径 → 拒绝', () => {
    expect(resolveInsideWorkspace(root, '')).toBe(null)
  })
})

/**
 * 测试助手：file-tools 现在接受**统一写入服务**（plan7 批 A2 —— 界面与 Agent 共用一条写入路径）。
 * 这里包一层，免得每处都重复建 writer；trash 默认是个 no-op。
 */
function fileTools(root: string, hooks: Partial<WorkspaceWriteHooks> = {}) {
  return createFileTools(createWorkspaceWriter(root, { trash: async () => {}, ...hooks }))
}

describe('file-tools（文件读写工具）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-agent-'))
  const tools = fileTools(dir)
  const write = tools[1]!
  const read = tools[0]!

  it('write_file 写入后 read_file 能读回（**带行号前缀** —— 定位用，不属于文件内容）', async () => {
    const msg = await write.execute({ path: 'notes/hello.txt', content: '你好，九十里路' })
    expect(msg).toContain('已写入')
    const content = await read.execute({ path: 'notes/hello.txt' })
    expect(content).toContain('1|你好，九十里路')
    expect(content).toContain('文件共 1 行')
    expect(readFileSync(join(dir, 'notes/hello.txt'), 'utf8')).toBe('你好，九十里路')
  })

  // ── plan8 R9.1：`read_file` 是"可寻址的窗口读取"，不是"全文倾倒" ──
  //
  // 为什么这几条必须存在：改之前的上限是 **1MB ≈ 262k token**（实测），
  // 也就是说"读一个文件就能吃掉大半个上下文窗口"，而且模型**不知道自己看全了没有**。
  // 这几条钉住的正是那三件事：窗口大小、行号可寻址、"被截了要说出来"。
  it('长文件默认只给前 200 行，且**末尾如实说明还有多少行、下一段怎么取**', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `第 ${i + 1} 行的内容`)
    await write.execute({ path: 'long.txt', content: lines.join('\n') })
    const out = await read.execute({ path: 'long.txt' })

    expect(out.split('\n').filter((l) => /^\d+\|/.test(l))).toHaveLength(200)
    expect(out).toContain('200|第 200 行的内容')
    expect(out).not.toContain('201|')
    // 这三条是"告知"的全部要点：总数、给到哪、怎么继续
    expect(out).toContain('文件共 500 行')
    expect(out).toContain('第 1–200 行')
    expect(out).toContain('后面还有 300 行')
    expect(out).toContain('offset=201')
  })

  it('offset 取中段：**行号是文件的真行号**（不是从 1 重新数）', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `L${i + 1}`)
    await write.execute({ path: 'mid.txt', content: lines.join('\n') })
    const out = await read.execute({ path: 'mid.txt', offset: 101, limit: 3 })
    expect(out).toContain('101|L101')
    expect(out).toContain('103|L103')
    expect(out).not.toContain('100|L100')
    expect(out).toContain('offset=104')
  })

  it('limit 有**硬顶**（模型说"给我十万行"也不行）', async () => {
    await write.execute({ path: 'big.txt', content: Array.from({ length: 3000 }, (_, i) => `r${i}`).join('\n') })
    const out = await read.execute({ path: 'big.txt', limit: 99999 })
    expect(out.split('\n').filter((l) => /^\d+\|/.test(l))).toHaveLength(2000)
  })

  it('offset 超出文件范围 → 明确错误 + 告诉它末尾该用哪个 offset（而不是给空字符串）', async () => {
    await write.execute({ path: 'short.txt', content: 'a\nb\nc' })
    const out = await read.execute({ path: 'short.txt', offset: 99 })
    expect(out).toContain('错误')
    expect(out).toContain('共 3 行')
    expect(out).toContain('offset=1')
  })

  it('**单行超长要掐断**（压缩过的 JS 一行几万字符，"限制行数"根本挡不住它）', async () => {
    const huge = 'x'.repeat(5000)
    await write.execute({ path: 'min.js', content: `${huge}\n结束行` })
    const out = await read.execute({ path: 'min.js' })
    expect(out).toContain('本行共 5000 字符，已掐断')
    expect(out).toContain('2|结束行')
    expect(out.length).toBeLessThan(3000)
  })

  it('**单次读取有绝对预算**（2000 行 × 2000 字符的极端输入不许一次灌进上下文）', async () => {
    // 极端形状：每行 1500 个汉字（不到单行掐断线 2000，所以不会被掐）
    const line = '汉'.repeat(1500)
    await write.execute({ path: 'huge.txt', content: Array.from({ length: 60 }, () => line).join('\n') })
    const out = await read.execute({ path: 'huge.txt', limit: 2000 })
    // 原文 ≈ 60 × 1500 = 9 万汉字 ≈ 9 万 token；单次读取必须收在预算内
    expect(out).toContain('已达单次上限')
    expect(out).toContain('继续读用 offset=')
    const bodyTokens = out.split('\n').reduce((n, l) => n + l.length, 0)
    expect(bodyTokens).toBeLessThan(20_000) // 字符数口径的粗上界（真实估算见 file-tools 的预算）
  })

  it('二进制文件（含 NUL）直接说清楚，别灌一屏替换字符进上下文', async () => {
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]))
    const out = await read.execute({ path: 'bin.dat' })
    expect(out).toContain('二进制')
  })

  it('脏参数（字符串 / 0 / 负数 / 空对象 / null）**回落到默认值**，不炸也不报错', async () => {
    await write.execute({ path: 'clean.txt', content: 'a\nb\nc\nd' })
    // 语义定死在这里：模型给的垃圾参数**不是错误**（它多半只是想"从头读"），
    // 归一成"从第 1 行、默认行数"最省事；真报错只会让它再花一轮来纠正自己。
    for (const bad of ['abc', 0, -5, {}, null, undefined]) {
      const out = await read.execute({ path: 'clean.txt', offset: bad })
      expect(out).toContain('1|a')
    }
    // 小数向下取整（2.7 → 从第 2 行起）；limit 同理
    const out2 = await read.execute({ path: 'clean.txt', offset: 2.7, limit: 2.5 })
    expect(out2).toContain('2|b')
    expect(out2).toContain('3|c')
    expect(out2).not.toContain('4|d')
  })

  it('空文件：不报错、也不编造内容（行号一个都不给）', async () => {
    await write.execute({ path: 'empty.txt', content: '' })
    const out = await read.execute({ path: 'empty.txt' })
    expect(out).toContain('文件共 1 行')
    expect(out).not.toMatch(/\d+\|\S/)
  })

  it('写入越界路径被拒绝', async () => {
    const msg = await write.execute({ path: '../evil.txt', content: 'x' })
    expect(msg).toContain('越出工作区边界')
  })

  it('读取不存在的文件返回错误文本（而非抛异常）', async () => {
    const msg = await read.execute({ path: 'no/such.txt' })
    expect(msg).toContain('错误：读取失败')
  })

  it('缺 content 参数返回错误文本', async () => {
    const msg = await write.execute({ path: 'a.txt' })
    expect(msg).toContain('缺少 content')
  })
})

describe('runAgentLoop（主循环）', () => {
  const tools = fileTools(join(tmpdir(), 'jsl-loop'))
  const systemPrompt = '你是九十里路内核'

  it('模型直接给答案（无工具调用）→ completed', async () => {
    const calls: AgentMessage[][] = []
    const result = await runAgentLoop({
      systemPrompt,
      history: [{ role: 'user', content: '你好' }],
      tools,
      chat: async (messages) => {
        calls.push(messages)
        return { text: '你好！我是九十里路内核。', toolCalls: [] } satisfies AgentChatResult
      }
    })
    expect(result.stopReason).toBe('completed')
    expect(result.output).toBe('你好！我是九十里路内核。')
    expect(result.rounds).toBe(1)
    // 首条消息 = system + user
    expect(calls[0]![0]!.role).toBe('system')
    expect(calls[0]![1]!.content).toBe('你好')
  })

  it('工具调用 → 结果回灌 → 最终答案', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'jsl-loop-'))
    writeFileSync(join(ws, 'file.txt'), '密码是 42', 'utf8')
    const loopTools = fileTools(ws)
    let round = 0
    const seen: AgentMessage[] = []
    const result = await runAgentLoop({
      systemPrompt,
      history: [{ role: 'user', content: '读取 file.txt 并告诉我密码' }],
      tools: loopTools,
      chat: async (messages) => {
        seen.push(messages[messages.length - 1]!)
        round++
        if (round === 1) {
          return {
            text: null,
            toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'file.txt' }) }]
          }
        }
        return { text: '密码是 42。', toolCalls: [] }
      }
    })
    expect(result.stopReason).toBe('completed')
    expect(result.output).toBe('密码是 42。')
    expect(result.rounds).toBe(2)
    // 第二轮模型看到的最后一条是 tool 结果
    expect(seen[1]!.role).toBe('tool')
    expect(seen[1]!.content).toContain('密码是 42')
  })

  it('未知工具被回灌错误文本，模型可自行纠正', async () => {
    let round = 0
    const lastToolResult: { content: string } = { content: '' }
    const result = await runAgentLoop({
      systemPrompt,
      history: [{ role: 'user', content: '删除全世界的文件' }],
      tools,
      chat: async (messages) => {
        round++
        if (round === 1) {
          return {
            text: null,
            toolCalls: [{ id: 'c1', name: 'delete_world', arguments: '{}' }]
          }
        }
        const toolMsg = messages[messages.length - 1]!
        lastToolResult.content = toolMsg.content ?? ''
        return { text: '没有这个工具，我无能为力。', toolCalls: [] }
      }
    })
    expect(lastToolResult.content).toContain('未知工具')
    expect(result.stopReason).toBe('completed')
  })

  it('超预算 → max-rounds 停止', async () => {
    let round = 0
    const result = await runAgentLoop({
      systemPrompt,
      history: [{ role: 'user', content: '跑圈' }],
      tools,
      maxRounds: 3,
      chat: async () => {
        round++
        return { text: `第 ${round} 轮`, toolCalls: [{ id: `c${round}`, name: 'read_file', arguments: '{"path":"x"}' }] }
      }
    })
    expect(result.stopReason).toBe('max-rounds')
    expect(result.rounds).toBe(3)
  })

  it('模型吐非法 JSON 参数 → 以 __raw 回灌而非崩溃', async () => {
    let round = 0
    let toolSaw: Record<string, unknown> = {}
    const probe = tools[0]!
    const spyTool = { schema: probe.schema, execute: async (args) => { toolSaw = args; return 'ok' } }
    const result = await runAgentLoop({
      systemPrompt,
      history: [{ role: 'user', content: 'x' }],
      tools: [spyTool],
      chat: async () => {
        round++
        if (round === 1) {
          return { text: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{oops' }] }
        }
        return { text: 'done', toolCalls: [] }
      }
    })
    expect(result.output).toBe('done')
    expect(toolSaw['__raw']).toBe('{oops')
  })
})

describe('write_file 与检查点的接缝（plan8 R4）', () => {
  // 这条规则是回滚正确性的基石：**快照必须发生在写入之前**。
  // 顺序若反了，快照存下的就是"已被改过的内容"，回滚等于没退。
  it('beforeChange 在文件真正落盘**之前**被调用，且拿到的是原内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-rec-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), '原始', 'utf8')

    const seen: { rel: string; existing: string | null }[] = []
    const tools = fileTools(dir, {
      beforeChange: (rel, abs) => {
        // 钩子被调用时，磁盘上还应该是**旧内容**
        seen.push({ rel, existing: existsSync(abs) ? readFileSync(abs, 'utf8') : null })
      }
    })
    const write = tools[1]!
    await write.execute({ path: 'a.txt', content: '新内容' })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.rel).toBe('a.txt')
    expect(seen[0]!.existing).toBe('原始') // ← 关键断言：钩子看到的是改之前
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('新内容')
  })

  it('新建文件时钩子也能拿到（此时磁盘上还不存在）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-rec2-'))
    const seen: (string | null)[] = []
    const tools = fileTools(dir, {
      beforeChange: (_rel, abs) => seen.push(existsSync(abs) ? 'exists' : null)
    })
    await tools[1]!.execute({ path: 'brand-new.md', content: 'x' })

    expect(seen).toEqual([null]) // 写入前确实不存在 → 记录为 created
  })

  it('越界写入时钩子不被调用（拒绝的写入不该留快照）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-rec3-'))
    let called = 0
    const tools = fileTools(dir, { beforeChange: () => called++ })
    const msg = await tools[1]!.execute({ path: '../evil.txt', content: 'x' })

    expect(msg).toContain('越出工作区边界')
    expect(called).toBe(0)
  })

  it('不传快照钩子时照常工作（检查点不是写文件的必要条件）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-rec4-'))
    const tools = fileTools(dir)
    const msg = await tools[1]!.execute({ path: 'ok.txt', content: 'y' })
    expect(msg).toContain('已写入')
  })
})
