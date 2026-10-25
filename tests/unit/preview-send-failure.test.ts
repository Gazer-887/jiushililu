import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/src/store'
afterEach(() => vi.unstubAllGlobals())
describe('失败提交不能消费草稿或持久化未接受的新消息', () => {
  it('真实store的IPC拒绝返回false，恢复原消息，不把失败payload落盘', async () => {
    const save = vi.fn(async () => null)
    vi.stubGlobal('window', { api: { chatSend: async () => { throw new Error('INJECTED_IPC_REJECTION') }, saveConversation: save } })
    const before = [{ role: 'user' as const, content: 'OLD_MESSAGE' }]
    useAppStore.setState({ activeId: 'owned', messages: before, streaming: false, streamError: null, runtimes: {}, conversations: [] })
    const accepted = await useAppStore.getState().sendMessage('NEW_INPUT', { localFiles: [{ assetId: '20261014T120000-0-aabbcc.txt', name: 'draft.txt', mime: 'text/plain', bytes: 5, source: 'draft', draftId: 'still-owned' }] })
    expect(accepted).toBe(false)
    expect(useAppStore.getState().messages).toEqual(before)
    expect(useAppStore.getState().runtimes.owned.messages).toEqual(before)
    expect(save).not.toHaveBeenCalled()
    expect(useAppStore.getState().streamError).toContain('发送失败')
  })
})
