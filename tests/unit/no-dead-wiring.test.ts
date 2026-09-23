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

describe('K27：工作区分组只许有一份实现', () => {
  const sidebar = src('renderer/src/components/Sidebar.tsx')
  const shared = src('shared/conversation-group.ts')

  it('侧栏不许再自己数分组 / 自己推展示名（两份规则会漂，漂了没有任何一道闸会红）', () => {
    expect(sidebar).not.toContain('function groupConversations')
    expect(sidebar).not.toContain('new Map<string, ConversationMeta[]>')
    // 展示名推导也只许在 shared 那一处：侧栏自己 split 一次，就又是一份真相
    expect(sidebar).not.toContain('.split(')
  })

  it('阳性对照：撤的是副本不是规则 —— shared 里那份仍在，且侧栏真的 import 它', () => {
    expect(shared).toContain('export function groupByWorkspace')
    expect(shared).toContain('export function workspaceLabel')
    expect(sidebar).toContain("import { groupByWorkspace } from '@shared/conversation-group'")
  })
})

describe('#8 新增 IPC 通道必须四处齐（plan53 片 1 立的规矩）', () => {
  // 少一处 = 那条链在某一端根本没通：界面上按了没反应，且不报错、门禁也抓不到（plan54 同族断链）。
  // `memory:delete` 是**阳性对照** —— 它在本批之前就已经接全，若连它都判不过，那是判据坏了不是代码坏了。
  const gate = readFileSync(join(__dirname, '../../scripts/verify-shot.cjs'), 'utf8')
  for (const { key, literal } of [
    { key: 'memoryDelete', literal: 'memory:delete' },
    { key: 'memoryRestore', literal: 'memory:restore' },
    { key: 'memoryClearArchive', literal: 'memory:clear-archive' },
    // plan53 片 2：审批门的逃生开关。这两个通道一旦少一处，设置页那个格子就是装饰品（点了没反应、不报错）
    // plan44 S2b：截图按引用读，缺任何一处都是"图在盘上、界面永远转圈"
    { key: 'mcpArtifactRead', literal: 'mcp:artifact-read' },
    { key: 'memoryGetApprovalGate', literal: 'memory:get-approval-gate' },
    { key: 'memorySetApprovalGate', literal: 'memory:set-approval-gate' }
  ]) {
    it(`${literal}：常量 / 主进程 handler / preload 桥 / 门禁桩 四处齐`, () => {
      expect(src('shared/ipc.ts')).toContain(`${key}: '${literal}'`)
      expect(src('main/ipc.ts')).toContain(`ipcMain.handle(IPC.${key}`)
      expect(src('preload/index.ts')).toContain(`IPC.${key}`)
      expect(gate).toContain(`'${literal}':`)
    })
  }

  // 通道接全 ≠ 界面上有人按 —— 两个动作各钉一条，少一个就是又一根静默断链
  it('渲染层真的调用过恢复（`restoreMemory`）', () => {
    expect(src('renderer/src/components/MemoryManager.tsx')).toContain('window.api.restoreMemory(')
  })

  it('渲染层真的调用过清空归档（`clearArchivedMemory`，K28）', () => {
    expect(src('renderer/src/components/MemoryManager.tsx')).toContain('window.api.clearArchivedMemory(')
  })

  it('渲染层真的调用过截图读取（`MessageSegments.tsx`，S2b）', () => {
    expect(src('renderer/src/components/MessageSegments.tsx')).toContain('window.api.readMcpArtifact(')
  })

  it('渲染层真的调用过审批门读写（`MemorySettings.tsx`，片 2）', () => {
    const settings = src('renderer/src/components/MemorySettings.tsx')
    expect(settings).toContain('window.api.getMemoryApprovalGate()')
    expect(settings).toContain('window.api.setMemoryApprovalGate(')
  })
})
