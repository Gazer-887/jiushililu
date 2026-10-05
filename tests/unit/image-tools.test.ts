// B2 K52 单测（plan57「再看这张图」工具通路）：落盘读回 / 丢失降级 / 装配与白名单。
// 外加 strip 生命周期（转交只出示一轮）。变异先行：缺注册 / 删降级分支 / 去 strip 各红一条，还原绿。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageTools } from '@main/agent/tools/image-tools'
import { allowedToolsFor, createAllTools } from '@main/agent/runner'
import { runAgentLoop, stripForwardedImageParts } from '@main/agent/loop'
import type { AgentMessage } from '@shared/agent'

let dir: string
const REF = '20250918T003000-0-abcdef.png'
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsl-view-image-'))
  mkdirSync(join(dir, 'attachments'), { recursive: true })
  writeFileSync(join(dir, 'attachments', REF), BYTES)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('view_image（plan57 K52 B2）', () => {
  it('ref 落盘读回：文本＋图片引用＋转交位（mime/字节对上）', async () => {
    const [tool] = createImageTools({ root: dir })
    expect(tool.schema.name).toBe('view_image')
    const out = await tool.execute({ ref: REF })
    if (typeof out === 'string') throw new Error('期望结构体，得到纯文本')
    expect(out.text).toContain(REF)
    expect(out.images).toEqual([{ name: REF, mime: 'image/png', bytes: BYTES.length }])
    expect((out.forwardImagesToModel ?? []).map((f) => f.mime)).toEqual(['image/png'])
    expect((out.forwardImagesToModel ?? []).map((f) => f.ref)).toEqual([REF])
    const roundTrip = (out.forwardImagesToModel ?? []).map((f) =>
      Buffer.from(f.base64, 'base64').equals(BYTES)
    )
    expect(roundTrip).toEqual([true])
  })

  it('ref 丢失 → 人话降级（D-146 C：抛错，不卡死会话）', async () => {
    const [tool] = createImageTools({ root: dir })
    const out = await tool.execute({ ref: '20250918T003000-0-999999.png' })
    expect(typeof out).toBe('string')
    if (typeof out !== 'string') throw new Error('unreachable')
    expect(out).toContain('找不回来')
  })

  it('装配表含名＋白名单纯读（只读档也拿得到；无根不下发）', () => {
    const tools = createAllTools(process.cwd(), { attachmentsRoot: dir })
    const names = tools.map((t) => t.schema.name)
    expect(names).toContain('view_image')
    expect(allowedToolsFor('read-only', ['view_image'], names)).toContain('view_image')
    const bare = createAllTools(process.cwd(), {})
    expect(bare.map((t) => t.schema.name)).not.toContain('view_image')
  })
})

describe('stripForwardedImageParts（转交只出示一轮）', () => {
  it('摘掉图片块、留正文，返回摘数；无块返回 0（幂等）', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '看看这张图' },
      {
        role: 'tool',
        content: 'x',
        tool_call_id: '1',
        parts: [{ type: 'image', mime: 'image/png', base64: 'AAA', ref: 'r.png' }]
      }
    ]
    expect(stripForwardedImageParts(messages)).toBe(1)
    expect(messages[1].parts).toBeUndefined()
    expect(messages[1].content).toContain('x')
    expect(stripForwardedImageParts(messages)).toBe(0)
  })
})

describe('fake 走通（plan57 K52 B2 的门禁形态：假模型＋真工具＋真循环）', () => {
  it('旧轮 marker → 模型调 view_image → 下轮请求带图块（mime/ref/字节对上）', async () => {
    const [tool] = createImageTools({ root: dir })
    const snapshots: Array<Array<{ mime: string; ref: string; ok: boolean }>> = []
    let calls = 0
    const result = await runAgentLoop({
      systemPrompt: 't',
      history: [{ role: 'user', content: '再看这张图' }],
      tools: [tool],
      maxRounds: 5,
      chat: async (messages) => {
        calls++
        snapshots.push(
          messages.flatMap((m) =>
            m.role === 'tool'
              ? (m.parts ?? [])
                  .filter((p) => p.type === 'image')
                  .map((p) => ({
                    mime: p.mime,
                    ref: (p as { ref: string }).ref,
                    ok: Buffer.from((p as { base64: string }).base64, 'base64').equals(BYTES)
                  }))
              : []
          )
        )
        if (calls === 1) {
          return {
            text: null,
            toolCalls: [{ id: 'c1', name: 'view_image', arguments: JSON.stringify({ ref: REF }) }]
          }
        }
        return { text: 'done', toolCalls: [] }
      }
    })
    expect(result.output).toBe('done')
    // 第一轮无图块（工具还没调），第二轮带图块且内容对 —— 出境点唯一且可断言
    expect(snapshots.length).toBe(2)
    expect(snapshots[0]).toEqual([])
    expect(snapshots[1].map((s) => s.mime)).toEqual(['image/png'])
    expect(snapshots[1].map((s) => s.ref)).toEqual([REF])
    expect(snapshots[1].map((s) => s.ok)).toEqual([true])
  })
})
