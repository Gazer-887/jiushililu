import { describe, expect, it, vi } from 'vitest'
import { runAgentLoop } from '@main/agent/loop'
import { runSubagents } from '@main/agent/scheduler'
import type { AgentTool } from '@shared/agent'
import type { AgentDefinition } from '@main/agent/loader'

const call = (name: string) => ({ id: name, name, arguments: '{}' })
const tool = (name: string, execute: AgentTool['execute']): AgentTool => ({
  schema: { name, description: name, parameters: { type: 'object', properties: {} } }, execute
})
const abortError = () => new DOMException('停止', 'AbortError')

describe('取消必须覆盖实际工具调度', () => {
  it('第一工具取消后不启动第二工具，run_end仍记录', async () => {
    const controller = new AbortController()
    const second = vi.fn(async () => '不应执行')
    const record = vi.fn()
    let count = 0
    const task = runAgentLoop({
      systemPrompt: '', history: [], signal: controller.signal,
      tools: [tool('first', async () => { controller.abort(); return '已完成第一步' }), tool('second', second)],
      chat: async () => ++count === 1 ? { text: '', toolCalls: [call('first'), call('second')] } : { text: '结束', toolCalls: [] },
      execEvents: { record } as never
    })
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(second).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith('run_end', expect.any(Object))
  })
  it('初始已取消时不请求模型', async () => {
    const controller = new AbortController(); controller.abort()
    const chat = vi.fn(async () => ({ text: '', toolCalls: [] }))
    await expect(runAgentLoop({ systemPrompt: '', history: [], tools: [], signal: controller.signal, chat }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(chat).not.toHaveBeenCalled()
  })
  it('工具抛AbortError不当普通失败吞掉', async () => {
    const second = vi.fn(async () => '不应执行')
    let count = 0
    await expect(runAgentLoop({ systemPrompt: '', history: [],
      tools: [tool('first', async () => { throw abortError() }), tool('second', second)],
      chat: async () => ++count === 1 ? { text: '', toolCalls: [call('first'), call('second')] } : { text: '结束', toolCalls: [] }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(second).not.toHaveBeenCalled()
  })
  it('普通工具错误仍回灌，下一工具及独立会话继续', async () => {
    const second = vi.fn(async () => '成功')
    let count = 0
    const result = await runAgentLoop({ systemPrompt: '', history: [],
      tools: [tool('first', async () => { throw new Error('普通工具错误') }), tool('second', second)],
      chat: async () => ++count === 1 ? { text: '', toolCalls: [call('first'), call('second')] } : { text: '结束', toolCalls: [] }
    })
    expect(result.stopReason).toBe('completed'); expect(second).toHaveBeenCalledTimes(1)
    expect((await runAgentLoop({ systemPrompt: '', history: [], tools: [], chat: async () => ({ text: '独立会话', toolCalls: [] }) })).output).toBe('独立会话')
  })
  it('异步模型返回时已取消，不执行其工具', async () => {
    const controller = new AbortController(); const execute = vi.fn(async () => '不应执行')
    await expect(runAgentLoop({ systemPrompt: '', history: [], signal: controller.signal, tools: [tool('write', execute)],
      chat: async () => { await Promise.resolve(); controller.abort(); return { text: '', toolCalls: [call('write')] } }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('父取消后子代理不再派发新作业', () => {
  it('串行作业一取消，作业二不会启动', async () => {
    const controller = new AbortController(); const started: string[] = []
    const definitions: AgentDefinition[] = ['a', 'b'].map((name) => ({ name, description: name, systemPrompt: name, source: 'user', file: name }))
    await expect(runSubagents({ definitions, task: '公共任务', signal: controller.signal, maxConcurrency: 1,
      toolsFor: () => [], chatFactory: (def) => async () => { started.push(def.name); controller.abort(); return { text: '', toolCalls: [] } }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toEqual(['a'])
  })
})
