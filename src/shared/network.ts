/**
 * 网络与代理（plan7 批 F2）—— 纯逻辑：不 import electron、不碰 IO，可被单测直接覆盖。
 *
 * 三档与 Electron 的 `session.setProxy` 一一对应：**跟随系统 / 直连 / 手动配置**。
 *
 * ⚠️ 三条只有真跑才会撞上的事实（写在这里，免得后人凭直觉改错）：
 *   1. **`setProxy` 管不到 Node 原生 `fetch`**。模型请求原来走的是 Node 原生 fetch（undici），
 *      与 Chromium 的网络栈**不是一条** —— 配了代理却照直连，界面还显示"已生效"（静默假象）。
 *      实证见 `scripts/probe-main-proxy.cjs` 与 `scripts/probe-main-net.cjs`。
 *   2. **`<-loopback>` 是"取消绕过 loopback"，不是"绕过 loopback"**。Chromium **默认**就不代理
 *      localhost/127.0.0.1，本地模型（Ollama 之类）天然直连；写上 `<-loopback>` 反而会把本地
 *      请求硬塞进代理 —— 那是反效果。故本文件的 bypass 规则**留空**。
 *   3. **凭据不当作普通字段存**。代理地址里可能带 `user:pass`，那是凭据 —— 一律从规则串里
 *      **剥出来**单独走 safeStorage 加密，规则串里只留 `scheme://host:port`。
 */

import { z } from 'zod'

export type ProxyMode = 'system' | 'direct' | 'custom'

export interface NetworkSettings {
  proxyMode: ProxyMode
  /**
   * 手动配置档的代理规则（Chromium `proxyRules` 语法，如 `http=127.0.0.1:7897;https=127.0.0.1:7897`
   * 或 `socks5://127.0.0.1:1080`）。⚠️ **不含凭据**：保存时剥走、应用时拼回。
   */
  proxyRules: string
}

/** 代理认证凭据。**只存在于内存与 safeStorage 密文里**，不进明文配置 */
export interface NetworkCredentials {
  user: string
  pass: string
}

/** 界面要的完整状态：落盘意图 + **真生效情况** + 凭据"有没有"（不回传明文） */
export interface NetworkView extends NetworkSettings {
  /** 是否已存凭据。⚠️ 只报**有没有**，不回传明文 —— 与 API Key 同一个口径 */
  hasCredentials: boolean
  /**
   * 最近一次 `session.resolveProxy()` 的结果（PAC 串，如 `PROXY 127.0.0.1:7897; DIRECT`）。
   * ⚠️ 它是**缓存值**：系统代理会变（用户改了系统设置、切换了网络），这里是最近一次探测到的。
   * null = 还没探测成功过。
   */
  effective: string | null
  /** 上面那条是按**哪个目标**算出来的 —— 不写清楚，`PROXY ...` 会被读成"全局都走它" */
  effectiveFor: string | null
  effectiveError: string | null
  /** 落盘意图是否已真的写进 session（false = 界面显示"已保存"而请求照旧走老路） */
  applied: boolean
  /** 应用或保存失败的原因。**不许静默**：代理配错最难排查的一类就是"以为配了其实没配" */
  error: string | null
}

/** 落盘默认值：跟随系统 —— 与 Electron 自身默认一致，也是三档里最少让人意外的那档 */
export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxyMode: 'system',
  proxyRules: ''
}

/**
 * 探测"当前生效代理"用的目标地址。
 * ⚠️ `resolveProxy()` **不发请求**，只按规则/系统配置算出"这个地址会走什么"，所以这里填谁都不会
 * 真的连出去。填一个真实的公共端点，是因为不同目标的解析结果可以不同（PAC 按 URL 分流）——
 * 而用户最关心的正是"访问模型厂商走不走代理"。
 */
export const PROXY_PROBE_URL = 'https://api.openai.com'

/** 规则串长度上限。Chromium 没有硬上限，但一个"代理地址"不该长到这份上 —— 超了多半是粘错了东西 */
export const PROXY_RULES_MAX = 512

export const proxyModeSchema = z.enum(['system', 'direct', 'custom'])

export const networkSetSchema = z.object({
  proxyMode: proxyModeSchema.optional(),
  proxyRules: z.string().max(PROXY_RULES_MAX).optional(),
  /** 传 `null` = 清除凭据；不传 = 不动它（改地址不该把密码顺手清掉） */
  proxyUser: z.string().max(256).nullable().optional(),
  proxyPass: z.string().max(256).nullable().optional()
})

/** 一次设置的改动（比 `NetworkSettings` 多出凭据两项；`undefined` = 不动，`null` = 清除） */
export interface NetworkPatch extends Partial<NetworkSettings> {
  proxyUser?: string | null
  proxyPass?: string | null
}

export function isProxyMode(v: unknown): v is ProxyMode {
  return v === 'system' || v === 'direct' || v === 'custom'
}

/** 老配置 / 手改坏的 json → 回落到默认档（与省 token 档位、系统集成同一口径：回落、不写回盘） */
export function normalizeNetwork(raw: Partial<NetworkSettings> | null | undefined): NetworkSettings {
  if (!raw) return { ...DEFAULT_NETWORK_SETTINGS }
  return {
    proxyMode: isProxyMode(raw.proxyMode) ? raw.proxyMode : DEFAULT_NETWORK_SETTINGS.proxyMode,
    proxyRules: typeof raw.proxyRules === 'string' ? raw.proxyRules.trim() : ''
  }
}

/**
 * 规则串的清洗与体检：去首尾空白、去换行（从别处粘来的常带 `\r\n`，会让 Chromium 解析出鬼规则）。
 * 返回**错误原因**而不是抛错 —— 设置项保存失败要能说人话。
 */
export function proxyRulesError(raw: string): string | null {
  const s = raw.replace(/\s+/g, ' ').trim()
  if (s.length === 0) return null // 空 = 没填，由调用方结合档位判断"该不该填"
  if (s.length > PROXY_RULES_MAX) {
    return `代理规则过长（${s.length} 字符，上限 ${PROXY_RULES_MAX}）：看起来不止一个地址，请检查是否粘多了。`
  }
  if (!/^[a-z0-9_=;.:/@[\]-]+$/i.test(s)) {
    return '代理规则里有不认识的字符。格式示例：127.0.0.1:7897 或 http=127.0.0.1:7897;https=127.0.0.1:7897 或 socks5://127.0.0.1:1080'
  }
  return null
}

export function normalizeProxyRules(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

// 段内凭据的两种写法（Chromium 都认）：
//   ① 带 scheme：`[前缀]scheme://user:pass@host...`，前缀允许 `http=` 这类写法
//   ② **不带 scheme**：`host:port` 形式的 `user:pass@host:port` —— ①的正则吃不下它，
//      而漏掉就意味着**凭据被当成普通字符留在规则串里明文落盘**（红线），故必须单独认。
//     ⚠️ 判据是"存在 `@` 且冒号在 `@` 之前"：`127.0.0.1:7897` 这种没有 `@` 的不会被误伤。
const CRED_WITH_SCHEME = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+):([^/@\s]*)@(.+)$/i
const CRED_BARE = /^([^/@\s]+):([^/@\s]*)@(.+)$/

/** 拆出 Chromium 的 `key=` 前缀（`http=`/`https=`），好让后面的拼接只在"值"上动手 */
function splitKeyValue(seg: string): { prefix: string; value: string } {
  const m = /^([a-z][a-z0-9+.-]*=)(.*)$/i.exec(seg)
  return m ? { prefix: m[1]!, value: m[2]! } : { prefix: '', value: seg }
}

function decodePart(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    // 不是合法百分号编码就当原文 —— 密码里带一个裸 % 很常见，为此报错不值当
    return s
  }
}

/**
 * 把凭据从规则串里**剥出来**（保存时调）。
 * ⚠️ 多段规则各带不同凭据的情况**不支持**：只认第一组，其余原样保留 —— 与其猜，不如不猜。
 */
export function splitCredentials(rules: string): {
  rules: string
  credentials: NetworkCredentials | null
} {
  let credentials: NetworkCredentials | null = null
  const out = rules
    .split(';')
    .map((segRaw) => {
      const seg = segRaw.trim()
      const { prefix, value } = splitKeyValue(seg)
      const withScheme = CRED_WITH_SCHEME.exec(value)
      const m = withScheme ?? CRED_BARE.exec(value)
      if (!m) return segRaw
      const [user, pass, host] = withScheme
        ? [m[2]!, m[3]!, m[4]!]
        : [m[1]!, m[2]!, m[3]!]
      if (!credentials) credentials = { user: decodePart(user), pass: decodePart(pass) }
      // 剥掉凭据后若原本没有 scheme，就**保持没有** —— 拼回时再按需补，别在这里擅自改写法
      const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)
      return `${prefix}${scheme ? scheme[0] : ''}${host}`
    })
    .join(';')
  return { rules: out, credentials }
}

/**
 * 把凭据**拼回去**（应用时调）。
 *
 * ⚠️ 两处不能想当然：
 *   1. 用**函数式** `replace` 而不是 `'...$1...'`：密码里可能含 `$&`、`$1` 这类替换模式，
 *      字符串写法会把它当占位符展开，得到一个悄悄变样的密码。
 *   2. 段里**没有 scheme**（如 `127.0.0.1:7897`、`http=127.0.0.1:7897`）时，必须补一个 `http://` ——
 *      Chromium 的凭据只能写在 URL 里，没有 scheme 就没有地方挂 `user:pass@`，凭据会被**静默丢弃**
 *      （表现为"配了账号密码，代理照样回 407"）。补 `http://` 与无 scheme 的原语义等价。
 */
export function withCredentials(rules: string, credentials: NetworkCredentials | null): string {
  if (!credentials || credentials.user.length === 0) return rules
  const token = `${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.pass)}@`
  return rules
    .split(';')
    .map((seg) => {
      const { prefix, value } = splitKeyValue(seg)
      if (value.length === 0) return seg
      const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)
      if (scheme) return `${prefix}${scheme[0]}${token}${value.slice(scheme[0].length)}`
      return `${prefix}http://${token}${value}`
    })
    .join(';')
}

/** `session.setProxy()` 的配置形状（主进程照它调，本文件不认识 electron） */
export interface ProxyConfig {
  mode: 'system' | 'direct' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

/**
 * 落盘意图 + 凭据 → setProxy 配置。
 * ⚠️ bypass **刻意留空**：Chromium 默认就绕过 loopback（本地模型直连），而 `<-loopback>` 是
 *    "**取消**那个默认" —— 写上去会把 localhost 也推进代理，与我们要的相反。
 */
export function proxyConfigFor(
  settings: NetworkSettings,
  credentials: NetworkCredentials | null
): ProxyConfig {
  if (settings.proxyMode === 'direct') return { mode: 'direct' }
  if (settings.proxyMode === 'custom') {
    return {
      mode: 'fixed_servers',
      proxyRules: withCredentials(settings.proxyRules, credentials),
      proxyBypassRules: ''
    }
  }
  return { mode: 'system' }
}

/** 把 PAC 串翻成人话：`PROXY 127.0.0.1:7897; DIRECT` → 「代理 127.0.0.1:7897（失败则直连）」 */
export function describeProxy(pac: string | null): string {
  if (!pac) return '未知'
  const parts = pac
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) return '未知'
  const zh = parts.map((p) => {
    if (p === 'DIRECT') return '直连'
    const m = /^(PROXY|SOCKS|SOCKS5|HTTPS|HTTP)\s+(\S+)$/i.exec(p)
    if (!m) return p
    const kind = m[1]!.toUpperCase()
    return `${kind === 'PROXY' ? 'HTTP 代理' : kind} ${m[2]}`
  })
  return zh.join(' → ')
}

/** 一档选择的界面文案（与系统集成同一口径：影响什么 + 代价） */
export interface ProxyModeInfo {
  key: ProxyMode
  label: string
  note: string
}

export const PROXY_MODES: readonly ProxyModeInfo[] = [
  {
    key: 'system',
    label: '跟随系统',
    note: '使用操作系统里配置的代理（Windows 的「代理服务器」、macOS 的网络设置）。系统改了这里就跟着变。'
  },
  {
    key: 'direct',
    label: '直连',
    note: '不使用任何代理。系统里配了代理也一律忽略 —— 排查网络问题时用得上。'
  },
  {
    key: 'custom',
    label: '手动配置',
    note: '只在本应用内生效，不影响系统设置。示例：127.0.0.1:7897；HTTP 与 HTTPS 分开写：http=127.0.0.1:7897;https=127.0.0.1:7897；SOCKS：socks5://127.0.0.1:1080。'
  }
]
