// 子 Agent 管理的共享契约与静态目录（plan17）。
// ⚠️ TOOL_CATALOG 只表达"可声明什么"，不表达"运行时装配了什么"——
// 声明了但未注册的工具由 allowedToolsFor 过滤（安全已收口），目录无需与装配结果对齐。

export type AgentSource = 'builtin' | 'user' | 'project'

export interface ToolCatalogItem {
  name: string
  /** 给用户看的一句话说明（§十文案规范：影响 + 代价） */
  description: string
  group: ToolGroup
}

export type ToolGroup = '读类' | '写类' | '命令' | '浏览器' | '协作'

export const TOOL_GROUP_ORDER: ToolGroup[] = ['读类', '写类', '命令', '浏览器', '协作']

export const TOOL_CATALOG: ToolCatalogItem[] = [
  { name: 'read_file', description: '按行号区间读取工作区内文件', group: '读类' },
  { name: 'list_dir', description: '列出工作区目录内容', group: '读类' },
  { name: 'search_files', description: '在工作区内按关键词搜索文件', group: '读类' },
  { name: 'fetch_url', description: '抓取网页正文（协议白名单内）', group: '读类' },
  { name: 'write_file', description: '写入工作区文件；写入前进检查点快照，可回滚', group: '写类' },
  { name: 'run_command', description: '执行系统命令；可写档下每次执行前需确认', group: '命令' },
  { name: 'check_command', description: '查询后台命令的输出与状态', group: '命令' },
  { name: 'kill_command', description: '终止后台命令及其子进程', group: '命令' },
  { name: 'browser_navigate', description: '在内置浏览器打开网址', group: '浏览器' },
  { name: 'browser_read_page', description: '读取当前网页正文', group: '浏览器' },
  { name: 'browser_click', description: '点击网页元素（会改变远端状态）', group: '浏览器' },
  { name: 'browser_type', description: '向网页输入框填写文字', group: '浏览器' },
  { name: 'update_todos', description: '维护本轮任务的待办清单', group: '协作' },
  { name: 'set_goal', description: '登记跨轮次的长期目标', group: '协作' },
  { name: 'ask_user', description: '向用户提问并给出选项', group: '协作' },
  { name: 'spawn_agents', description: '派出多个子代理并行执行互不依赖的子任务', group: '协作' }
]

/** 管理页列表条目：每文件一条的全量视图（被高层同名定义覆盖的条目 overridden=true，不在生效集合里） */
export interface AgentListEntry {
  name: string
  description: string
  tools?: string[]
  model?: string
  /** plan27：该 Agent 产出方案后是否**停下等用户点头**（只有 `'plan'` 一个取值） */
  approval?: 'plan'
  /** plan27：批准后由哪个 Agent 接手执行（缺省按 code-executor → 内核默认兜底） */
  executor?: string
  source: AgentSource
  /** 来源文件绝对路径——read/delete 都按它定位，禁止按 name 反推（文件可手改，name 与文件名可脱钩） */
  file: string
  overridden: boolean
}

export interface AgentsView {
  entries: AgentListEntry[]
  /** 加载失败被跳过的文件与原因（fail-soft 但绝不静默） */
  warnings: string[]
}

/** 表单保存入参：file 缺省 = 新建（以 name 派生文件名落盘）；带 file = 编辑既有定义 */
export interface AgentSaveInput {
  name: string
  description: string
  tools: string[]
  model?: string
  /**
   * plan27：`'plan'` = 本 Agent 给出方案后**停下等用户点头**，批准后才交 `executor` 执行。
   * 缺省 = 现有行为（跑完即返回），不受影响。
   *
   * ⚠️ 与**权限档位无关**：它只解决「停一下等我点头」，不解决「能不能写」——
   * 全局档仍是硬上限，read-only 档下就算批准了 executor 也写不了。
   */
  approval?: 'plan'
  /** plan27：批准后接手执行的 Agent 名。留空 = 按 `code-executor` → 内核默认兜底；写错名字也走兜底（不报错） */
  executor?: string
  systemPrompt: string
  file?: string
}

/** 保存结果：ok=true 可带 notice（如"将覆盖内置同名定义"）；ok=false 的 reason 是可直接显示的人话 */
export type AgentSaveResult =
  | { ok: true; file: string; notice?: string }
  | { ok: false; reason: string }

/** name/description/正文的三条硬规则（plan17 D3）：loader 解析与管理表单共用的唯一口径，两处不许各写一份 */
export function validateAgentFields(input: {
  name: string
  description: string
  systemPrompt: string
}): { ok: true } | { ok: false; reason: string } {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.name)) {
    return { ok: false, reason: 'name 需小写字母/数字/- 组成，1~64 字符，以字母或数字开头' }
  }
  if (input.description.length === 0) return { ok: false, reason: 'description 缺失' }
  if (input.systemPrompt.trim().length === 0) return { ok: false, reason: '职责描述正文不能为空' }
  return { ok: true }
}
