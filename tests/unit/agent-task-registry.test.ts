import { expect, it } from 'vitest'
import { createAgentTaskRegistry } from '@main/agent-task-registry'

it('运行闸、重复停止与全局退出不混淆任务身份', () => {
  const registry = createAgentTaskRegistry()
  const a = registry.start(1, 'A', 'A会话')
  expect(() => registry.start(1, '重复任务', 'A会话')).toThrow()
  const b = registry.start(2, 'B', 'B会话')
  expect(registry.stop(1, a.id)).toBe(true)
  expect(registry.stop(1, a.id)).toBe(true)
  expect(b.controller.signal.aborted).toBe(false)
  expect(registry.list(1)).toHaveLength(1)
  expect(registry.list(2)).toHaveLength(1)
  registry.abortAll()
  expect(b.controller.signal.aborted).toBe(true)
  expect(registry.list(2)[0].status).toBe('stopping')
  registry.finish(a.id, 'cancelled')
  const next = registry.start(1, '下一轮')
  expect(next.controller.signal.aborted).toBe(false)
})

it('停止只认所属窗口和当前任务，旧身份不能停新任务', () => {
  const registry = createAgentTaskRegistry()
  const task = registry.start(1, '任务', 'chat')
  expect(registry.stop(2, task.id)).toBe(false)
  expect(registry.stop(1, task.id)).toBe(true)
  expect(task.controller.signal.aborted).toBe(true)
  registry.finish(task.id, 'cancelled')
  const next = registry.start(1, '新任务', 'chat')
  expect(registry.stop(1, task.id)).toBe(false)
  expect(next.controller.signal.aborted).toBe(false)
  expect(registry.list(2)).toHaveLength(0)
  expect(registry.list(1)[0]!.status).toBe('cancelled')
})
