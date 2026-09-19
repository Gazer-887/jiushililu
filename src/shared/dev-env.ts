/**
 * 开发环境配置（plan43）—— 共享类型与纯函数。
 *
 * 立场（§〇之二）：只做编辑器能力的**配置面**——探测、如实呈现、记住选择；
 * 不下载、不安装、不指路（「未检测到，请刷新」逐字，文案纪律见决策 3b）。
 * 两条实测硬约束：① 版本一律 `--version` 实测，**禁止从路径解析**（目录名 3.13.12 实为 3.13.14）；
 * ② `WindowsApps\python.exe` 商店占位符必须排除（执行它弹商店，不报错）。
 */

export type RuntimeSource = 'conda' | 'venv' | 'system' | 'nvm' | 'volta' | 'pyenv' | 'uv' | 'other'

export interface RuntimeEntry {
  /** 'node' | 'python' | 'uv'（工具类也算一种"语言"，plan44 的 uv 联动靠它） */
  language: string
  /** 可执行文件绝对路径 —— 唯一标识 */
  path: string
  /** 实测版本（`--version` 解析而来）；'' = 未探到（超时/挂死跳过，不猜） */
  version: string
  /** conda env 名等；解析不出就没有（不猜） */
  alias?: string
  source: RuntimeSource
  onPath: boolean
}

export interface LanguageGroup {
  id: string
  label: string
  /** 可证明来源的（conda/venv/system/nvm/…），已排序 */
  main: RuntimeEntry[]
  /** 证明不了来源的：默认折叠，**折叠不等于隐藏** */
  others: RuntimeEntry[]
}

export interface DevEnvSnapshot {
  detectedAt: string
  groups: LanguageGroup[]
  /** 用户选择：语言 id → 可执行文件路径 */
  selected: Record<string, string>
}

export interface LanguageSpec {
  id: string
  label: string
  /** PATH 搜索用的 bin 名（不带扩展名；Windows 分派 .exe） */
  probeBins: string[]
}

/** UI 先只显 Node + Python（开放点 2），探测层按此表扩展 */
export const LANGUAGE_SPECS: LanguageSpec[] = [
  { id: 'node', label: 'Node.js', probeBins: ['node'] },
  { id: 'python', label: 'Python', probeBins: ['python', 'python3'] },
  // uv 是工具不是语言，但 plan44 推荐卡片要它的存在性 —— 同一条通道带回来
  { id: 'uv', label: 'uv', probeBins: ['uv'] }
]

/** 商店占位符判定：路径含 WindowsApps 且（符号链接或名字含 AppInstaller）→ 排除 */
export function isStorePlaceholder(path: string, isSymlink: boolean): boolean {
  const norm = path.replace(/\\/g, '/')
  if (!/\/WindowsApps\//i.test(norm)) return false
  return isSymlink || /AppInstaller/i.test(norm) || /Redirector/i.test(norm)
}

/** 来源分类（决策 2b）：能证明的就分类，证明不了的不硬猜 */
export function classifySource(facts: {
  hasCondaMeta: boolean
  hasPyvenvCfg: boolean
  onPath: boolean
  fromNvm?: boolean
  fromVolta?: boolean
  fromPyenv?: boolean
  fromUvDir?: boolean
}): RuntimeSource {
  if (facts.hasCondaMeta) return 'conda'
  if (facts.hasPyvenvCfg) return 'venv'
  if (facts.fromNvm) return 'nvm'
  if (facts.fromVolta) return 'volta'
  if (facts.fromPyenv) return 'pyenv'
  if (facts.fromUvDir) return 'uv'
  if (facts.onPath) return 'system'
  return 'other'
}

const SOURCE_ORDER: Record<RuntimeSource, number> = {
  conda: 0,
  venv: 1,
  system: 2,
  nvm: 2,
  volta: 2,
  pyenv: 2,
  uv: 2,
  other: 3
}

/** conda 别名反推（风险 4）：`<root>/envs/<name>/python.exe` → name；root 直下 → base；解析不出 → undefined */
export function condaAliasFromPath(path: string): string | undefined {
  const norm = path.replace(/\\/g, '/')
  const envs = norm.match(/\/envs\/([^/]+)\/(?:Scripts\/)?python(?:\.exe)?$/i)
  if (envs?.[1]) return envs[1]
  const root = norm.match(/\/(?:python(?:\.exe)?|node(?:\.exe)?)$/i)
  if (root && !/\/envs\//i.test(norm)) {
    const parent = norm.replace(/\/[^/]+$/, '')
    if (/miniconda|anaconda|mamba/i.test(parent)) return 'base'
  }
  return undefined
}

/** 版本实测输出解析（这是**允许**的解析——从命令输出，不是从路径）：Python 3.12.13 / v24.18.0 / uv 0.9.x */
export function versionFromOutput(stdout: string): string {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/)
  return m ? m[1] : ''
}

/** 语义版本比较（降序用）：段数不等长按 0 补齐；非数字段退字典序 */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  return b.localeCompare(a)
}

/** Windows 路径大小写不敏感去重键 */
export function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 分组 + 筛选 + 排序（决策 2b）：去重 → 排除商店占位 → main/others 分家 → 组内排序 */
export function organizeRuntimes(
  entries: RuntimeEntry[],
  specs: LanguageSpec[] = LANGUAGE_SPECS
): LanguageGroup[] {
  const seen = new Set<string>()
  const byLang = new Map<string, RuntimeEntry[]>()
  for (const e of entries) {
    // 双保险：lstat 级判定在探测层做（那里有符号链接信息）；这里按路径再挡一道
    if (e.language === 'python' && /\/WindowsApps\//i.test(e.path.replace(/\\/g, '/'))) continue
    const k = `${e.language}|${pathKey(e.path)}`
    if (seen.has(k)) continue
    seen.add(k)
    const list = byLang.get(e.language) ?? []
    list.push(e)
    byLang.set(e.language, list)
  }
  return specs.map((spec) => {
    const list = byLang.get(spec.id) ?? []
    const main = list
      .filter((e) => e.source !== 'other')
      .sort(
        (a, b) =>
          SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
          compareVersionsDesc(a.version, b.version)
      )
    const others = list
      .filter((e) => e.source === 'other')
      .sort((a, b) => compareVersionsDesc(a.version, b.version))
    return { id: spec.id, label: spec.label, main, others }
  })
}

/** 下拉项第一行文案：`Python 3.12.13 ('ai_env')`；无版本无别名时退回文件名 */
export function runtimeDisplayName(e: RuntimeEntry, langLabel: string): string {
  const base = e.version.length > 0 ? `${langLabel} ${e.version}` : langLabel
  return e.alias ? `${base} ('${e.alias}')` : base
}

/** 选中项有效性（卸了软件要能明确报"你选的这个不见了"）：在探测结果里找不到 = 失效 */
export function isSelectionValid(selected: Record<string, string>, snapshot: DevEnvSnapshot): string[] {
  const all = new Set<string>()
  for (const g of snapshot.groups)
    for (const e of [...g.main, ...g.others]) all.add(pathKey(e.path))
  return Object.entries(selected)
    .filter(([, p]) => !all.has(pathKey(p)))
    .map(([lang]) => lang)
}

// ── S3：当前**生效**的运行环境（状态栏显示用）────────────────────────────

/** 某个语言在"命令执行时"实际会命中的东西 */
export interface ActiveRuntime {
  language: string
  label: string
  /** 用户选中的原件路径；'' = 未选择 */
  selected: string
  /** 文件名/别名简称，给状态栏一行显示用（如 `python 3.12.13`）；未选择时为 '' */
  display: string
}

/**
 * 状态栏要显的「当前生效」快照。
 *
 * ⚠️ 为什么叫"生效"而不叫"选择"：设置页里那个是**意向**（用户点了什么），
 * 这里要的是**事实**（命令真的会跑什么）。两者可能不一致 ——
 * 选中的文件被删了、shim 没建起来、或者用户手改了外部 PATH。
 * 状态栏显示意向而不显示事实，就等于让用户继续靠猜（0.13.71 的教训）。
 */
export interface ActiveRuntimeSnapshot {
  /** 实际生效的语言（只列已选择成功的） */
  active: ActiveRuntime[]
  /** 选了但**没能生效**的：原件不存在 / shim 建不起来 —— 必须显式告知，不许静默 */
  failed: { language: string; label: string; selected: string; reason: string }[]
  /** 已注入的 PATH 是否真的在环境里（事实核对） */
  injected: boolean
}

