// 切片 1 · 原生浏览器默认与公共能力 —— 纯策略层单测（先红后绿；修正批 A 收紧动作边界）。
//
// 覆盖合同反例：缺字段/旧 true/旧 false/坏值/显式值的迁移判定；角色未声明浏览器时
// 公共能力的注入与收窄；只读档硬上限；原生关停时「工具表与装配一致剔除」；外部 MCP 不受影响；
// 以及修正 A：已知提交/未知作用控件/拖拽不吃站点浏览许可（独审实证红转绿）。
import { describe, expect, it } from 'vitest'

// 被测纯函数（实现后方可 import）
import { resolveAgentToolNames } from '@main/agent/runner'
import { BROWSER_TOOL_NAMES } from '@main/agent/tools/browser-tools'

const NAMES = [
  'read_file',
  'write_file',
  'list_dir',
  'search_files',
  'run_command',
  'check_command',
  'kill_command',
  ...BROWSER_TOOL_NAMES
]

describe('resolveAgentToolNames：原生公共能力注入', () => {
  it('角色未声明浏览器（detail-planner 式声明）+ 原生开 + 可写档 → 公共浏览器能力注入', () => {
    const names = resolveAgentToolNames('write', ['read_file', 'list_dir', 'search_files'], NAMES, true)
    for (const b of BROWSER_TOOL_NAMES) expect(names, `应注入 ${b}`).toContain(b)
    expect(names).toContain('read_file')
    expect(names, '不扩大其他工具白名单').not.toContain('write_file')
    expect(names, '不擅自下发命令工具').not.toContain('run_command')
  })

  it('内核默认（未声明）+ 原生开 → 浏览器公共注入，但高危工具仍不白送（plan6 D4 不变）', () => {
    const names = resolveAgentToolNames('write', undefined, NAMES, true)
    expect(names).toContain('read_file')
    expect(names, '高危工具不因原生注入白送').not.toContain('run_command')
    for (const b of BROWSER_TOOL_NAMES) expect(names).toContain(b)
  })

  it('原生关（显式关闭）→ 工具表与装配一致剔除浏览器，避免「表有工具装空」', () => {
    const names = resolveAgentToolNames('write', undefined, NAMES, false)
    for (const b of BROWSER_TOOL_NAMES) expect(names, `剔除 ${b}`).not.toContain(b)
    expect(names).toContain('read_file')
  })

  it('只读档 → 仅只读浏览器子集（硬上限，不借公共注入越权）', () => {
    const names = resolveAgentToolNames('read-only', undefined, NAMES, true)
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_read_page')
    expect(names, '只读档不得注入点击').not.toContain('browser_click')
    expect(names, '只读档不得注入输入').not.toContain('browser_type')
    expect(names, '只读档不得注入任意脚本').not.toContain('browser_eval_script')
  })

  it('角色显式声明浏览器子集 → 不收缩其声明，也不超注入', () => {
    const names = resolveAgentToolNames('write', ['read_file', 'browser_navigate'], NAMES, true)
    expect(names).toContain('browser_navigate')
    for (const b of BROWSER_TOOL_NAMES) expect(names).toContain(b)
  })
})

// ── 切片 2 · 任务授权门位（plan79 §3.3；修正批 A 收紧分类） ─────────────
import {
  classifyBrowserAction,
  TaskAuthorizer,
  type BrowserActionContext,
  type ConfirmFn
} from '@main/browser-policy'

const ACT = (tool: string, args: Record<string, unknown> = {}): BrowserActionContext => ({
  tool,
  args,
  agent: 'code-executor',
  site: 'http://127.0.0.1:8111'
})

/** 普通输入框的目标事实（宿主读脚本产出形状） */
const FIELD = { target: '#msg', targetInfo: { field: true, desc: 'input[text]' } }
/** 提交按钮的目标事实 */
const SUBMIT = { target: '#go', targetInfo: { submit: true, desc: 'button[submit]', formAction: 'http://x.test/submit', formMethod: 'post' } }

const stubConfirm = (answer: boolean): ConfirmFn & { calls: Array<Record<string, unknown>> } => {
  const calls: Array<Record<string, unknown>> = []
  const fn = (async (req: Record<string, unknown>) => {
    calls.push(req)
    return answer
  }) as ConfirmFn & { calls: Array<Record<string, unknown>> }
  fn.calls = calls
  return fn
}

describe('动作分类（classifyBrowserAction）', () => {
  it('只读动作免确认：read_page/snapshot/console/network/wait/tabs(list)', () => {
    for (const t of ['browser_read_page', 'browser_snapshot', 'browser_console', 'browser_network', 'browser_wait']) {
      expect(classifyBrowserAction(t, {}), t).toBe('readonly')
    }
    expect(classifyBrowserAction('browser_tabs', { action: 'list' })).toBe('readonly')
  })

  it('高危动作恒需确认：任意脚本 / 上传 / 弹窗 accept / Enter 提交', () => {
    expect(classifyBrowserAction('browser_eval_script', { js: 'fetch(1)' })).toBe('risky')
    expect(classifyBrowserAction('browser_upload', { target: 'input', filePath: 'x' })).toBe('risky')
    expect(classifyBrowserAction('browser_dialog', { action: 'accept' })).toBe('risky')
    expect(classifyBrowserAction('browser_press_key', { key: 'Enter' })).toBe('risky')
  })

  it('任务范围动作：navigate/hover/截图/其他按键/tabs(new|select|close)/dialog(dismiss)', () => {
    for (const [t, a] of [
      ['browser_navigate', { url: 'https://x.test' }],
      ['browser_hover', { target: '#a' }],
      ['browser_screenshot', {}],
      ['browser_press_key', { key: 'Tab' }],
      ['browser_dialog', { action: 'dismiss' }],
      ['browser_tabs', { action: 'new' }],
      ['browser_tabs', { action: 'close' }]
    ] as Array<[string, Record<string, unknown>]>) {
      expect(classifyBrowserAction(t, a), `${t} ${JSON.stringify(a)}`).toBe('task')
    }
  })

  it('点击按宿主读到的目标事实分类（修正 A）：普通字段/链接/无控件特征 → task', () => {
    expect(classifyBrowserAction('browser_click', FIELD)).toBe('task')
    expect(classifyBrowserAction('browser_click', { targetInfo: { link: true, desc: 'a' } })).toBe('task')
    expect(classifyBrowserAction('browser_click', { targetInfo: { desc: 'div' } })).toBe('task')
  })

  it('已知提交/文件选择/未知作用控件 → risky（不吃站点许可；修正 A 独审红转绿）', () => {
    expect(classifyBrowserAction('browser_click', SUBMIT)).toBe('risky')
    expect(classifyBrowserAction('browser_click', { targetInfo: { file: true } })).toBe('risky')
    expect(classifyBrowserAction('browser_click', { targetInfo: { control: true } })).toBe('risky')
    expect(classifyBrowserAction('browser_click', { targetInfo: { editable: true } })).toBe('risky')
    expect(classifyBrowserAction('browser_click', { target: '#x' }), '未读到元素事实 = 未知').toBe('risky')
  })

  it('输入：普通输入框 → task；非输入框/未读到 → risky（修正 A）', () => {
    expect(classifyBrowserAction('browser_type', FIELD)).toBe('task')
    expect(classifyBrowserAction('browser_type', { target: '#x' })).toBe('risky')
    expect(classifyBrowserAction('browser_type', { targetInfo: { editable: true } })).toBe('risky')
  })

  it('字段带明确风险证据（onclick/按钮型控件）不得被 field 短路（剩余两项修正：反例②③）', () => {
    // 输入工具会先真点击聚焦 → 聚焦点击同样触发 onclick：field+control 必须 risky
    expect(classifyBrowserAction('browser_type', { target: '#b', targetInfo: { field: true, control: true } })).toBe('risky')
    // 按钮型 input 不是普通字段（browser_click 与 browser_type 两条路都拦）
    const btn = { target: '#input-submit', targetInfo: { field: false, control: true, desc: 'input[button]' } }
    expect(classifyBrowserAction('browser_click', btn)).toBe('risky')
    expect(classifyBrowserAction('browser_type', btn)).toBe('risky')
    // 祖先提交控件（span 命中的是按钮内部装饰）
    const viaAncestor = { target: '#go-label', targetInfo: { submit: true, desc: 'button[submit]（祖先/关联控件）' } }
    expect(classifyBrowserAction('browser_click', viaAncestor)).toBe('risky')
  })

  it('统一规则：整条路径风险 OR 不被 field/link 身份短路（限定修正批）', () => {
    // onclick 链接：link 身份不抹风险
    expect(classifyBrowserAction('browser_click', { target: '#a', targetInfo: { link: true, control: true } })).toBe('risky')
    // 字段外层 onclick：field 身份不抹风险（点击与输入两条路）
    expect(classifyBrowserAction('browser_click', { targetInfo: { field: true, control: true } })).toBe('risky')
    expect(classifyBrowserAction('browser_type', { targetInfo: { field: true, control: true } })).toBe('risky')
    // 深层 submit：submit 事实成立（无论包装层数），卡面走提交文案
    expect(classifyBrowserAction('browser_click', { targetInfo: { submit: true, control: true, desc: 'button[submit]（关联控件）' } })).toBe('risky')
    // 无风险事实的普通链接/普通字段仍连续执行（不一律禁）
    expect(classifyBrowserAction('browser_click', { targetInfo: { link: true } })).toBe('task')
    expect(classifyBrowserAction('browser_click', { targetInfo: { field: true } })).toBe('task')
    expect(classifyBrowserAction('browser_type', { targetInfo: { field: true } })).toBe('task')
  })

  it('拖拽 → risky（宿主读不出副作用；修正 A）', () => {
    expect(classifyBrowserAction('browser_drag', { from: '#a', to: '#b' })).toBe('risky')
  })

  it('未知工具名保守按高危（不认识的放行就是旁路）', () => {
    expect(classifyBrowserAction('browser_future_thing', {})).toBe('risky')
  })
})

describe('TaskAuthorizer：按任务授权而非逐动作询问', () => {
  it('task 动作首次问一次，批准后同站点普通操作连续执行不重复问', async () => {
    const confirm = stubConfirm(true)
    const auth = new TaskAuthorizer(confirm)
    expect((await auth.authorize(ACT('browser_navigate'))).allowed).toBe(true)
    expect((await auth.authorize(ACT('browser_click', FIELD))).allowed).toBe(true)
    expect((await auth.authorize(ACT('browser_type', FIELD))).allowed).toBe(true)
    expect(confirm.calls, '同站点普通操作只问一次').toHaveLength(1)
  })

  it('换站点重新问（一次授权不是全站通行证）', async () => {
    const confirm = stubConfirm(true)
    const auth = new TaskAuthorizer(confirm)
    await auth.authorize(ACT('browser_navigate'))
    await auth.authorize({ ...ACT('browser_click', FIELD), site: 'https://other.test' })
    expect(confirm.calls).toHaveLength(2)
  })

  it('站点授权**不吃**提交/拖拽/未知作用（修正 A）：已授权后这些仍逐次问', async () => {
    const confirm = stubConfirm(true)
    const auth = new TaskAuthorizer(confirm)
    await auth.authorize(ACT('browser_navigate')) // 站点授权 1 次
    await auth.authorize(ACT('browser_click', FIELD)) // 普通字段：吃授权，不问
    await auth.authorize(ACT('browser_click', SUBMIT)) // 提交：再问
    await auth.authorize(ACT('browser_click', SUBMIT)) // 提交：每次都问
    await auth.authorize(ACT('browser_drag', { from: '#a', to: '#b' })) // 拖拽：再问
    expect(confirm.calls, '1 站点 + 2 提交 + 1 拖拽').toHaveLength(4)
  })

  it('risky 动作每次问、不复用任务授权', async () => {
    const confirm = stubConfirm(true)
    const auth = new TaskAuthorizer(confirm)
    await auth.authorize(ACT('browser_click', FIELD)) // task 一次
    await auth.authorize(ACT('browser_eval_script', { js: '1' })) // risky 一次
    await auth.authorize(ACT('browser_eval_script', { js: '2' })) // risky 再一次
    expect(confirm.calls).toHaveLength(3)
  })

  it('用户拒绝 → 不执行且原因可见', async () => {
    const auth = new TaskAuthorizer(stubConfirm(false))
    const r = await auth.authorize(ACT('browser_click', FIELD))
    expect(r.allowed).toBe(false)
    expect(r.reason, '拒绝原因必须可解释').toContain('拒绝')
  })

  it('无确认服务 → 一律拒绝，不降级放行', async () => {
    const auth = new TaskAuthorizer(null)
    expect((await auth.authorize(ACT('browser_click', FIELD))).allowed).toBe(false)
    expect((await auth.authorize(ACT('browser_eval_script', { js: '1' }))).allowed).toBe(false)
    // 只读动作不经过确认服务，照常放行
    expect((await auth.authorize(ACT('browser_read_page'))).allowed).toBe(true)
  })

  it('提交确认卡的 detail 带表单目标（授权范围可展示；修正 A）', async () => {
    const confirm = stubConfirm(false)
    const auth = new TaskAuthorizer(confirm)
    await auth.authorize(ACT('browser_click', SUBMIT))
    expect(String(confirm.calls[0]!.detail)).toContain('提交表单')
    expect(String(confirm.calls[0]!.detail)).toContain('http://x.test/submit')
    expect(String(confirm.calls[0]!.tool)).toBe('browser_click')
  })
})
