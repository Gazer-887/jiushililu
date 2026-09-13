/**
 * 网络代理（plan7 批 F2）—— 主进程侧状态机：把落盘的**意图**翻成真实的 `session.setProxy()`。
 *
 * 与 `system-integration.ts` 同一套规矩：本文件**不 import electron**（依赖全部注入）——
 * 架构守卫禁止单测 import 图里出现 electron，注入才让它进得了单测链路。
 *
 * ⚠️ 「设了」≠「生效了」必须分开报，理由比 F1 更硬：
 *   代理配错的表现是**请求超时**，而超时既可能是"代理没生效"，也可能是"代理生效了但它连不上"。
 *   所以这里额外报 **当前生效的代理**（`resolveProxy` 的结果）—— 那是"到底走没走代理"唯一的硬证据。
 */

import {
  DEFAULT_NETWORK_SETTINGS,
  PROXY_PROBE_URL,
  normalizeNetwork,
  normalizeProxyRules,
  proxyConfigFor,
  proxyRulesError,
  splitCredentials,
  type NetworkCredentials,
  type NetworkPatch,
  type NetworkSettings,
  type NetworkView,
  type ProxyConfig
} from '@shared/network'

/** `session.defaultSession` 需要的最小面（注入进来，本文件就不必认识 electron） */
export interface ProxySessionLike {
  /** ⚠️ **异步**：返回 Promise，必须 await —— 不等就往下走会得到"配置没生效"的假象 */
  setProxy(config: ProxyConfig): Promise<void>
  /** 只做规则解析/系统查询，**不发请求**；返回 PAC 串，如 `PROXY 127.0.0.1:7897; DIRECT` */
  resolveProxy(url: string): Promise<string>
}

export interface NetworkStoreLike {
  read(): NetworkSettings
  write(patch: Partial<NetworkSettings>): void
}

/** 凭据仓：与 API Key 同一口径 —— 存密文，读明文（只在内存里用） */
export interface NetworkCredentialStoreLike {
  read(): NetworkCredentials | null
  write(credentials: NetworkCredentials | null): void
}

export interface NetworkProxyDeps {
  session: ProxySessionLike
  store: NetworkStoreLike
  credentials: NetworkCredentialStoreLike
  /** 探测"当前生效代理"用的目标；缺省用 `PROXY_PROBE_URL` */
  probeUrl?: string
  log?: (message: string, extra?: Record<string, unknown>) => void
}

export interface NetworkProxy {
  view(): NetworkView
  set(patch: NetworkPatch): Promise<NetworkView>
  /**
   * app ready 后应用一次落盘意图（进程级配置，重启必须重来）。
   * @param withProbe 是否顺带探测"当前生效代理"。启动路径传 `false` —— 探测要问系统，慢；
   *                  不传的话第一发模型请求要等它，而用户等的是**代理生效**不是**看到它生效**。
   */
  applyStored(withProbe?: boolean): Promise<NetworkView>
  /** 重新探测"当前生效代理"（系统代理会变，界面切回来时应当重取） */
  refresh(): Promise<NetworkView>
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createNetworkProxy(deps: NetworkProxyDeps): NetworkProxy {
  const probeUrl = deps.probeUrl ?? PROXY_PROBE_URL
  const log = (message: string, extra?: Record<string, unknown>): void => deps.log?.(message, extra)

  let effective: string | null = null
  let effectiveError: string | null = null
  let applied = false
  let error: string | null = null

  function view(): NetworkView {
    const stored = normalizeNetwork(deps.store.read())
    return {
      ...stored,
      hasCredentials: deps.credentials.read() !== null,
      effective,
      effectiveFor: effective === null ? null : probeUrl,
      effectiveError,
      applied,
      error
    }
  }

  /** 探测当前生效代理。失败也**不许抛**：这只是"看一眼"，配错了不该让设置页打不开 */
  async function refresh(): Promise<NetworkView> {
    try {
      effective = await deps.session.resolveProxy(probeUrl)
      effectiveError = null
      log('代理探测完成', { effective, for: probeUrl })
    } catch (err) {
      effective = null
      effectiveError = reasonOf(err)
      log('代理探测失败', { reason: effectiveError })
    }
    return view()
  }

  async function apply(settings: NetworkSettings): Promise<void> {
    const creds = deps.credentials.read()
    const config = proxyConfigFor(settings, creds)
    try {
      await deps.session.setProxy(config)
      applied = true
      error = null
      log('代理已应用', { mode: config.mode, hasCredentials: creds !== null })
    } catch (err) {
      // ⚠️ 应用失败**必须说出来**：否则界面显示"已保存"而请求照旧走老路 —— 这正是本批要消灭的假象
      applied = false
      error = `代理未能应用：${reasonOf(err)}`
      log('代理应用失败', { reason: reasonOf(err), config })
    }
  }

  async function set(patch: NetworkPatch): Promise<NetworkView> {
    const stored = normalizeNetwork(deps.store.read())
    const next: NetworkSettings = {
      proxyMode: patch.proxyMode ?? stored.proxyMode,
      proxyRules:
        patch.proxyRules === undefined ? stored.proxyRules : normalizeProxyRules(patch.proxyRules)
    }

    // ── 凭据：显式传了就用传的；没传但地址里带了 user:pass，就**剥出来**存（不让凭据进明文配置）──
    let creds: NetworkCredentials | null = deps.credentials.read()
    if (patch.proxyUser !== undefined || patch.proxyPass !== undefined) {
      const user = patch.proxyUser ?? ''
      const pass = patch.proxyPass ?? ''
      creds = user.length === 0 && pass.length === 0 ? null : { user, pass }
    }
    const split = splitCredentials(next.proxyRules)
    next.proxyRules = split.rules
    if (split.credentials) creds = split.credentials

    // ── 体检：不通过就**不落盘也不应用**。脏值存进去只会在下次启动继续报错 ──
    const badness =
      next.proxyMode === 'custom' && next.proxyRules.length === 0
        ? '手动配置需要填写代理地址（示例：127.0.0.1:7897）'
        : proxyRulesError(next.proxyRules)
    if (badness !== null) {
      applied = false
      error = badness
      log('代理设置未通过体检', { reason: badness })
      // 界面要看到"用户刚填的那个值"，否则输入会莫名跳回上一个值，像是没保存上
      return { ...view(), ...next }
    }

    try {
      deps.store.write(next)
      deps.credentials.write(creds)
    } catch (err) {
      applied = false
      error = `设置保存失败：${reasonOf(err)}`
      log('代理设置保存失败', { reason: reasonOf(err) })
      return view()
    }

    await apply(next)
    return await refresh()
  }

  async function applyStored(withProbe = true): Promise<NetworkView> {
    const stored = normalizeNetwork(deps.store.read())
    await apply(stored)
    // ⚠️ 探测**单独一步**：`resolveProxy` 要问系统（Windows 读注册表、配了 PAC 还要跑脚本），
    //    可能比 `setProxy` 慢一个量级。启动路径只 await 应用、探测放后台 —— 否则"启动变慢"会
    //    被算到 setProxy 头上，而用户真正在等的是**代理生效**，不是"看到它生效"。
    if (!withProbe) return view()
    return await refresh()
  }

  return { view, set, applyStored, refresh }
}

export { DEFAULT_NETWORK_SETTINGS }
