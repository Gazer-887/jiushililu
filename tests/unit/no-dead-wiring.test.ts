// plan54 #3 / #4 / #5：三处"看着有、其实不成立"的防线，一律用守卫钉住不许回来。
//
// 强度声明（`AGENTS.md` §八）：这些是**结构守卫**，挡的是"改着改着又加回去 / 又漏掉"，
// 不替代行为测试。每条都配了**阳性对照**，防止有人为了过判据把东西删干净 —— 那等于换了个坏法。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (rel: string): string => readFileSync(join(__dirname, '../../src', rel), 'utf8')

describe('#3 死开关：supportsImages', () => {
  it('模型档案编辑器里不许有「支持图片输入」勾选框（providers 零消费点，勾了等于骗人）', () => {
    expect(src('renderer/src/components/ModelCatalogEditor.tsx')).not.toContain('supportsImages')
  })

  it('阳性对照：撤的是**格子**不是数据 —— 字段仍在 schema 与 store 里（多模态通路落地时直接接上）', () => {
    expect(src('main/schemas.ts')).toContain('supportsImages')
    expect(src('main/store/models.ts')).toContain('supportsImages')
  })
})

describe('#4 通道名单一真相源', () => {
  it('主进程不许发裸字面量 `browser:changed`（改名即静默断，没有一道闸会红）', () => {
    expect(src('main/index.ts')).not.toContain("'browser:changed'")
  })

  it('阳性对照：走的是 `IPC` 常量，且通道仍在共享层定义', () => {
    expect(src('main/index.ts')).toContain('IPC.browserChanged')
    expect(src('shared/ipc.ts')).toContain("browserChanged: 'browser:changed'")
  })
})

describe('#7 单一写口与假注释', () => {
  it('活跃会话只能有一个写口（`setActiveConversationId`），不许再有直接赋值', () => {
    const ipc = src('main/ipc.ts')
    // 全文件只许有**一处**赋值 —— 就是 setter 自己那一行；多一处就说明又开了第二个写口
    const assignments = ipc.split('\n').filter((l) => /^[ \t]+activeConversationId = /.test(l))
    expect(ipc).toContain('setActiveConversationId(input.nextId)')
    expect(assignments.length).toBe(1)
  })

  it('`blockBytes` 那个"写进 inject 事件"的假注释不许回来（inject 事件只记 names）', () => {
    expect(src('main/memory/events.ts')).not.toContain('blockBytes')
    expect(src('main/memory/events.ts')).toContain("kind: 'inject'; conversationId: string | null; names: string[]")
  })
})

describe('#5 假防线：hasAnyWindow', () => {
  it('登记表不许留一个没人调的"有没有窗口"判断（2026-09-13 已把判据改成"主窗口在不在"）', () => {
    expect(src('main/window-registry.ts')).not.toContain('hasAnyWindow')
  })

  it('★ 阳性对照：`activate` 的判据必须仍是 `getMainWindow()` —— 退回"任何窗口"就是那个 macOS 假死 bug', () => {
    const index = src('main/index.ts')
    const at = index.indexOf("app.on('activate'")
    expect(at).toBeGreaterThan(-1)
    expect(index.slice(at, at + 700)).toContain('getMainWindow()')
  })
})
