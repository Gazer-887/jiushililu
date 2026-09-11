import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolGate, resolveInsideWorkspace } from '@main/agent/guard'
import { createFileTools } from '@main/agent/tools/file-tools'
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

describe('file-tools（文件读写工具）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-agent-'))
  const tools = createFileTools(dir)
  const write = tools[1]!
  const read = tools[0]!

  it('write_file 写入后 read_file 能读回', async () => {
    const msg = await write.execute({ path: 'notes/hello.txt', content: '你好，九十里路' })
    expect(msg).toContain('已写入')
    const content = await read.execute({ path: 'notes/hello.txt' })
    expect(content).toBe('你好，九十里路')
    expect(readFileSync(join(dir, 'notes', 'hello.txt'), 'utf8')).toBe('你好，九十里路')
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
  const tools = createFileTools(join(tmpdir(), 'jsl-loop'))
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
    const loopTools = createFileTools(ws)
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
  it('beforeWrite 在文件真正落盘**之前**被调用，且拿到的是原内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-rec-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), '原始', 'utf8')

    const seen: { rel: string; existing: string | null }[] = []
    const tools = createFileTools(dir, {
      beforeWrite: (rel, abs) => {
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
    const tools = createFileTools(dir, {
      beforeWrite: (_rel, abs) => seen.push(existsSync(abs) ? 'exists' : null)
    })
    await tools[1]!.execute({ path: 'brand-new.md', content: 'x' })

    expect(seen).toEqual([null]) // 写入前确实不存在 → 记录为 created
  })

  it('越界写入时钩子不被调用（拒绝的写入不该留快照）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-rec3-'))
    let called = 0
    const tools = createFileTools(dir, { beforeWrite: () => called++ })
    const msg = await tools[1]!.execute({ path: '../evil.txt', content: 'x' })

    expect(msg).toContain('越出工作区边界')
    expect(called).toBe(0)
  })

  it('不传 recorder 时照常工作（检查点不是写文件的必要条件）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-rec4-'))
    const tools = createFileTools(dir)
    const msg = await tools[1]!.execute({ path: 'ok.txt', content: 'y' })
    expect(msg).toContain('已写入')
  })
})
