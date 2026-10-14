// 内置原生浏览器的动作分类与**任务授权**（plan79 切片 2；修正批 A 收紧动作边界）——纯策略层，
// 不 import electron，可被单测与 adapter 共用；禁止复制两套授权账。
//
// 口径（plan79 §3.3 + 限定修正批统一规则）：导航/读取/填写普通输入框/点击无风险普通元素在
// **已授权任务范围内连续完成**；**整条事件路径上已知危险事实的 OR**（提交控件/文件选择、
// 明确 onclick、按钮型控件、任意 button、role=button、可编辑、拖拽、任意脚本、上传、
// 弹窗 accept、Enter 提交）→ **外部作用动作每次问**——站点浏览许可**不能**吃下这些，
// 且不被层数、最近字段/链接身份或布尔短路抹掉。授权来源只能是宿主确认桥返回的可信用户决定
// ——网页内容、模型自报、历史批准卡文本都不是授权来源。

/** 只读动作：读页面/快照/console/网络/等待/tabs(list) */
const READONLY_ACTIONS = new Set([
  'browser_read_page',
  'browser_snapshot',
  'browser_console',
  'browser_network',
  'browser_wait'
])
/** 外部作用定义明确的动作：每次问（不因任务授权缓存放行） */
const RISKY_ACTIONS = new Set(['browser_eval_script', 'browser_upload'])

export type BrowserActionClass = 'readonly' | 'task' | 'risky'

/**
 * 宿主读取的点击/输入**目标事实**（describeTarget 宿主固定读脚本产出；缺 = 未读到元素）。
 * 判定只看宿主读到的页面事实，不看模型话术或按钮文案。
 */
export interface BrowserTargetInfo {
  /** 提交控件：button(无 type 或 submit) / input[submit|image] */
  submit?: boolean
  /** 文件选择控件：input[file] */
  file?: boolean
  /** 普通表单字段：input/textarea/select（不含 submit/file） */
  field?: boolean
  /** 可编辑区（contenteditable） */
  editable?: boolean
  /** 链接：a[href]（含 role=link） */
  link?: boolean
  /** 形似触发动作的控件（button[type=button|reset]、onclick、role=button）：副作用读不出来 → 保守问 */
  control?: boolean
  /** 元素摘要（tag[type]），只用于确认卡展示 */
  desc?: string
  /** 所属表单的 action / method（提交卡展示用） */
  formAction?: string
  formMethod?: string
}

function targetInfo(args: Record<string, unknown>): BrowserTargetInfo | null {
  const v = args['targetInfo']
  return v && typeof v === 'object' ? (v as BrowserTargetInfo) : null
}

/** 归一按键名（Enter 的别写都算提交键） */
const isEnterKey = (key: unknown): boolean =>
  typeof key === 'string' && ['enter', 'return'].includes(key.trim().toLowerCase())

export function classifyBrowserAction(tool: string, args: Record<string, unknown>): BrowserActionClass {
  if (READONLY_ACTIONS.has(tool)) return 'readonly'
  if (tool === 'browser_tabs') return args['action'] === 'list' ? 'readonly' : 'task'
  if (RISKY_ACTIONS.has(tool)) return 'risky'
  if (tool === 'browser_dialog') return args['action'] === 'accept' ? 'risky' : 'task'
  if (tool === 'browser_press_key') return isEnterKey(args['key']) ? 'risky' : 'task'
  if (tool === 'browser_screenshot') return 'task' // 截图随下轮出示模型，纳入任务范围
  if (tool === 'browser_navigate' || tool === 'browser_hover') return 'task'
  // 拖拽的作用宿主读不出来（可排序、可上传、可提交）：恒问（独审修正 A：不吃站点许可）
  if (tool === 'browser_drag') return 'risky'
  if (tool === 'browser_click') {
    const info = targetInfo(args)
    if (!info) return 'risky' // 没读到元素事实（含路径读取失败）= 未知作用 → 保守问
    if (info.submit === true || info.file === true) return 'risky' // 已知提交/文件选择：恒问
    // control = 整条事件路径危险事实的 OR（onclick 链接、外层 onclick 的字段、按钮型控件、
    // 任意 button/role=button/可编辑）——不被 field/link 身份短路（限定修正批统一规则）
    if (info.control === true || info.editable === true) return 'risky'
    return 'task' // 无风险事实的普通字段 / 普通链接 / 普通元素：随任务范围连续操作
  }
  if (tool === 'browser_type') {
    const info = targetInfo(args)
    if (!info || info.field !== true) return 'risky' // 目标不是普通输入框（含未读到）= 未知 → 问
    // 明确风险证据（onclick/可编辑）不得被 field 短路（独审反例③：输入工具会先真点击聚焦，
    // 聚焦点击同样会触发 onclick）
    if (info.control === true || info.editable === true) return 'risky'
    return 'task'
  }
  return 'risky' // 未知工具保守按高危：不认识的放行就是旁路
}

/** 动作摘要（确认卡 detail 用人话；不含网页正文与表单秘密） */
export function describeBrowserAction(tool: string, args: Record<string, unknown>): string {
  const cut = (v: unknown, n: number): string => String(v ?? '').slice(0, n)
  switch (tool) {
    case 'browser_navigate':
      return `在内置浏览器打开 ${cut(args['url'], 120)}`
    case 'browser_click': {
      const info = targetInfo(args)
      const el = `「${cut(args['target'], 60)}」`
      if (!info) return `点击 ${el}——宿主未能读取元素事实，按未知风险确认`
      if (info?.submit) {
        const form = info.formAction
          ? `（表单目标：${cut(info.formAction, 100)}${info.formMethod ? `，${info.formMethod.toUpperCase()}` : ''}）`
          : '（提交所属表单）'
        return `提交表单：点击 ${el}${form}`
      }
      if (info?.file) return `点击文件选择控件 ${el}（可能打开本机文件选择）`
      if (info?.control || info?.editable) return `点击 ${el}——事件路径上存在已知危险事实（onclick/按钮型控件等），可能触发页面动作`
      return `点击页面元素${el}`
    }
    case 'browser_type': {
      const info = targetInfo(args)
      const plainField = info?.field === true && info.control !== true && info.editable !== true
      return plainField
        ? `向「${cut(args['target'], 40)}」输入文字`
        : `向「${cut(args['target'], 40)}」输入文字——目标不是普通输入框或带未知作用特征，宿主无法确认副作用`
    }
    case 'browser_drag':
      return `从「${cut(args['from'] ?? args['0'], 40)}」拖拽到「${cut(args['to'] ?? args['1'], 40)}」——宿主无法确认拖拽的作用`
    case 'browser_eval_script':
      return '在页面执行任意脚本（与在页面控制台粘贴执行等效）'
    case 'browser_upload':
      return `上传本机文件「${cut(args['filePath'], 80)}」到页面`
    case 'browser_dialog':
      return args['action'] === 'accept' ? '确认页面弹出的对话框' : '关闭页面弹出的对话框'
    case 'browser_press_key':
      return `按下按键「${cut(args['key'], 20)}」（可能提交表单）`
    default:
      return `浏览器操作 ${tool}`
  }
}

export interface BrowserActionContext {
  tool: string
  args: Record<string, unknown>
  /** 实际发起代理名（确认卡署名） */
  agent: string
  /** 目标站点 origin（授权按站点核；换站点重新问） */
  site: string
  conversationId?: string
}

/** 宿主确认桥（与 run_command 的 CommandConfirm 同形状） */
export type ConfirmFn = (req: {
  tool: string
  detail: string
  agent: string
  where: string
  conversationId: string
}) => Promise<boolean>

export interface AuthorizeResult {
  allowed: boolean
  reason?: string
}

/**
 * 任务授权器：一个受控任务一份（按任务/代理/站点缓存 task 级授权）。
 * 站点授权只覆盖「浏览与普通操作」这一类（导航/读取/普通填写/普通点击/截图）；
 * 提交、上传、脚本、拖拽、未知作用控件**每次都问**（独审修正 A：不吃站点许可）。
 * 授权元数据只存本轮内存，不落盘、不含网页内容或表单秘密。
 */
export class TaskAuthorizer {
  /** 已授权站点（本轮） */
  private readonly grantedSites = new Set<string>()

  constructor(private readonly confirm: ConfirmFn | null) {}

  async authorize(action: BrowserActionContext): Promise<AuthorizeResult> {
    const cls = classifyBrowserAction(action.tool, action.args)
    if (cls === 'readonly') return { allowed: true }
    if (!this.confirm) {
      return { allowed: false, reason: '宿主确认服务不可用：已拒绝该浏览器动作（不降级执行）' }
    }
    const site = action.site || '(未知站点)'
    if (cls === 'risky') {
      const ok = await this.confirm({
        tool: action.tool,
        detail: describeBrowserAction(action.tool, action.args),
        agent: action.agent,
        where: site,
        conversationId: action.conversationId ?? ''
      })
      return ok ? { allowed: true } : { allowed: false, reason: '用户拒绝执行该浏览器动作' }
    }
    // task 级：首次在宿主确认卡上取得站点授权，之后同站点**普通操作**连续执行；
    // 卡面写清覆盖范围与例外（提交/未知作用仍逐次确认），授权范围可展示。
    if (this.grantedSites.has(site)) return { allowed: true }
    const ok = await this.confirm({
      tool: 'browser_task',
      detail: `允许在 ${site} 上进行浏览与普通页面操作（导航、读取、填写普通输入框、点击普通元素、截图）；提交表单、上传与未知作用动作仍会逐次确认`,
      agent: action.agent,
      where: site,
      conversationId: action.conversationId ?? ''
    })
    if (!ok) return { allowed: false, reason: '用户拒绝授权该站点的浏览器操作' }
    this.grantedSites.add(site)
    return { allowed: true }
  }
}

/** 门位拒绝（只读/越权/未授权）：抛给工具层转「错误文本回」给模型，不停整轮。 */
export class BrowserGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserGateError'
  }
}
