import { describe, expect, it } from 'vitest'
import { userTurnWithMedia } from '../../src/shared/attachment-block'
import { materializeHistory } from '../../src/shared/content-parts'
import { toOpenAIWireMessage } from '../../src/main/providers/openai-agent'
import { toAnthropicAgentMessages } from '../../src/main/providers/anthropic-agent'
import { mapAnthropicMessages } from '../../src/main/providers/anthropic'
import { buildOpenAIChatBody } from '../../src/main/providers/openai'
import type { AgentMessage } from '../../src/shared/agent'
import type { ChatMessage, ModelSettings } from '../../src/shared/ipc'
describe('最终模型协议边界保留媒体、不泄漏本地身份', () => {
  it('模型收到真实图片字节，但四出口的正文marker不带内部ref/localFiles/messageId', async () => {
    const ref = '20261015T020000-0-aabbcc.png'
    const turn = userTurnWithMedia('USER_MESSAGE', [{ path: 'public.png', name: 'public.png', content: '', truncated: false, bytes: 4,
      image: { type: 'image', ref, mime: 'image/png', bytes: 4 }, preview: { assetId: ref, mime: 'image/png', digest: 'a'.repeat(16), draftId: 'internal-draft' } }])
    const raw: ChatMessage = { role: 'user', messageId: 'internal-message', ...turn }
    const materialized = await materializeHistory([raw], async () => Buffer.from('PNG!'))
    const openai = toOpenAIWireMessage(materialized[0] as AgentMessage)
    const anthropic = toAnthropicAgentMessages(materialized as AgentMessage[])
    const plainAnthropic = mapAnthropicMessages([raw])
    const plainOpenai = buildOpenAIChatBody({ model: 'fixture', maxTokens: 32, temperature: null, topP: null, topK: null, reasoningEffort: 'default' } as ModelSettings, [raw], true)
    for (const wire of [openai, anthropic, plainAnthropic, plainOpenai]) {
      const json = JSON.stringify(wire)
      expect(json).not.toContain(ref)
      expect(json).not.toContain('internal-draft')
      expect(json).not.toContain('internal-message')
      expect(json).not.toContain('localFiles')
      expect(json).toContain('public.png')
      expect(json).toContain('USER_MESSAGE')
    }
    expect(JSON.stringify(openai)).toContain('data:image/png;base64,UE5HIQ==')
    expect(JSON.stringify(anthropic)).toContain('UE5HIQ==')
    expect(raw.content).toContain(ref) // 原存档marker依然能为界面定位，未回改历史。
  })
  it('直接Agent序列化也白名单选字段，普通用户正文不因包含ref字样而被改写', () => {
    const raw = { role: 'user' as const, content: 'I wrote ref="my-own-id"', localFiles: [{ assetId: 'DO_NOT_SEND' }], messageId: 'private' }
    const wire = toOpenAIWireMessage(raw)
    expect(wire).toEqual({ role: 'user', content: raw.content })
  })
  it('假文本二进制（NUL探测降级后 content 为空）不给模型正文：三出口均不含二进制哨兵', () => {
    // 附件层已按 NUL 闸降级（content 空、不填 image/video parts）——出站侧不得再冒出正文
    const fake = { name: 'fake.log', path: 'x/fake.log', content: '', truncated: false, bytes: 38,
      preview: { assetId: '20261015T030000-0-dead01.log', digest: 'b'.repeat(16), mime: 'application/octet-stream' } }
    const turn = userTurnWithMedia('NORMAL_USER_TEXT_SENTINEL', [fake])
    const raw: ChatMessage = { role: 'user', messageId: 'internal-message', ...turn }
    const wire = JSON.stringify([toOpenAIWireMessage(raw as AgentMessage), toAnthropicAgentMessages([raw as AgentMessage[]]), mapAnthropicMessages([raw])])
    expect(wire).toContain('NORMAL_USER_TEXT_SENTINEL')
    expect(wire).not.toContain('BINHEAD')
    expect(wire).not.toContain('NULFAKE_BINARY_TAIL_SENTINEL')
    expect(wire).not.toContain('localFiles')
  })
})
