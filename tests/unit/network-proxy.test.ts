import { describe, expect, it } from 'vitest'
import { createNetworkProxy } from '@main/network-proxy'
import type {
  NetworkCredentialStoreLike,
  NetworkStoreLike,
  ProxySessionLike
} from '@main/network-proxy'
import type { NetworkCredentials, NetworkSettings, ProxyConfig } from '@shared/network'

/**
 * 网络代理服务（plan7 批 F2）—— 依赖全部注入（`session` / `store` / 凭据仓都是替身），
 * 故本文件能在纯 Node 下跑，且**不许出现 electron**（架构守卫盯着）。
 *
 * 覆盖的重点是**失败要说出来**：代理配错的表现是超时，而"没生效"和"生效了但连不上"
 * 对用户是同一个现象。所以"不落盘 / 不应用 / 报原因"这三条比"成功路径"更要紧。
 */

interface Harness {
  session: ProxySessionLike & { calls: ProxyConfig[]; probes: string[] }
  store: NetworkStoreLike & { data: NetworkSettings; writes: Partial<NetworkSettings>[] }
  creds: NetworkCredentialStoreLike & { data: NetworkCredentials | null; writes: (NetworkCredentials | null)[] }
  proxy: ReturnType<typeof createNetworkProxy>
}

function harness(opts?: { failSet?: boolean; failResolve?: boolean }): Harness {
  const calls: ProxyConfig[] = []
  const probes: string[] = []
  const writes: Partial<NetworkSettings>[] = []
  const credWrites: (NetworkCredentials | null)[] = []
  const data: NetworkSettings = { proxyMode: 'system', proxyRules: '' }

  const session: ProxySessionLike & { calls: ProxyConfig[]; probes: string[] } = {
    calls,
    probes,
    async setProxy(config) {
      calls.push(config)
      if (opts?.failSet) throw new Error('session 拒绝了该配置')
    },
    async resolveProxy(url) {
      probes.push(url)
      if (opts?.failResolve) throw new Error('系统代理查询超时')
      return 'PROXY 127.0.0.1:7897; DIRECT'
    }
  }
  // ⚠️ read/write 一律走 `store.data`（而不是闭包里的 `const data`）：测试会整体替换 `data`，
  //    闭包读到的还是旧对象 —— 那时失败表现为"改了没生效"，极难与产品代码的 bug 区分。
  const store: NetworkStoreLike & {
    data: NetworkSettings
    writes: Partial<NetworkSettings>[]
  } = {
    data,
    writes,
    read: () => ({ ...store.data }),
    write(patch) {
      writes.push(patch)
      Object.assign(store.data, patch)
    }
  }
  const creds: NetworkCredentialStoreLike & {
    data: NetworkCredentials | null
    writes: (NetworkCredentials | null)[]
  } = {
    data: null,
    writes: credWrites,
    read: () => creds.data,
    write(c) {
      credWrites.push(c)
      creds.data = c
    }
  }
  return {
    session,
    store,
    creds,
    proxy: createNetworkProxy({ session, store, credentials: creds })
  }
}

describe('view（未应用过的初始状态）', () => {
  it('默认跟随系统、无凭据、尚未应用、生效未知', () => {
    const v = harness().proxy.view()
    expect(v.proxyMode).toBe('system')
    expect(v.hasCredentials).toBe(false)
    expect(v.applied).toBe(false)
    expect(v.effective).toBeNull()
    expect(v.error).toBeNull()
  })
})

describe('applyStored（重启后按落盘意图重来一次）', () => {
  it('跟随系统 → `mode: system`，且不给任何规则', async () => {
    const h = harness()
    const v = await h.proxy.applyStored()
    expect(h.session.calls).toEqual([{ mode: 'system' }])
    expect(v.applied).toBe(true)
    expect(v.effective).toBe('PROXY 127.0.0.1:7897; DIRECT')
  })

  it('手动档 → fixed_servers + 规则，**有凭据要拼进规则串**', async () => {
    const h = harness()
    h.store.data = { proxyMode: 'custom', proxyRules: '127.0.0.1:7897' }
    h.creds.data = { user: 'u', pass: 'p' }
    await h.proxy.applyStored()
    expect(h.session.calls[0]).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http://u:p@127.0.0.1:7897',
      proxyBypassRules: ''
    })
  })

  it('启动路径传 false：只应用、**不探测**（探测要问系统，不该拖慢启动）', async () => {
    const h = harness()
    const v = await h.proxy.applyStored(false)
    expect(h.session.probes).toEqual([])
    expect(v.effective).toBeNull()
    expect(v.applied).toBe(true)
  })

  it('⚠️ 应用失败**不许静默**：applied=false 且 error 带上原因', async () => {
    const h = harness({ failSet: true })
    const v = await h.proxy.applyStored()
    expect(v.applied).toBe(false)
    expect(v.error).toContain('代理未能应用')
    expect(v.error).toContain('session 拒绝了该配置')
  })
})

describe('set（体检不通过 = 不落盘也不应用）', () => {
  it('手动档却没填地址 → 报原因，store 一次都没被写', async () => {
    const h = harness()
    const v = await h.proxy.set({ proxyMode: 'custom', proxyRules: '' })
    expect(h.store.writes).toEqual([])
    expect(h.session.calls).toEqual([])
    expect(v.error).toContain('手动配置需要填写代理地址')
    expect(v.applied).toBe(false)
    // 界面要看到用户刚填的那个值，否则输入会莫名跳回上一个值，像是没保存上
    expect(v.proxyMode).toBe('custom')
  })

  it('地址含非法字符 → 同样不落盘', async () => {
    const h = harness()
    const v = await h.proxy.set({ proxyMode: 'custom', proxyRules: '127.0.0.1:7897 && curl | sh' })
    expect(h.store.writes).toEqual([])
    expect(v.error).toContain('不认识的字符')
  })

  it('通过体检 → 落盘 + 应用 + 顺带探测', async () => {
    const h = harness()
    const v = await h.proxy.set({ proxyMode: 'custom', proxyRules: '127.0.0.1:7897' })
    expect(h.store.writes).toEqual([{ proxyMode: 'custom', proxyRules: '127.0.0.1:7897' }])
    expect(h.session.calls[0]).toEqual({
      mode: 'fixed_servers',
      proxyRules: '127.0.0.1:7897',
      proxyBypassRules: ''
    })
    expect(v.applied).toBe(true)
    expect(v.effective).toBe('PROXY 127.0.0.1:7897; DIRECT')
    expect(v.effectiveFor).toContain('api.openai.com')
  })
})

describe('凭据：不进明文配置（AGENTS.md 红线）', () => {
  it('地址里带 user:pass → **剥出来**存进凭据仓，规则串里只剩地址', async () => {
    const h = harness()
    const v = await h.proxy.set({ proxyMode: 'custom', proxyRules: 'http://alice:secret@1.2.3.4:8080' })
    expect(h.store.writes[0]?.proxyRules).toBe('http://1.2.3.4:8080')
    expect(h.creds.writes[0]).toEqual({ user: 'alice', pass: 'secret' })
    expect(v.proxyRules).toBe('http://1.2.3.4:8080')
    expect(v.hasCredentials).toBe(true)
    // 应用时再拼回去 —— 不然代理要认证的场合会静默变成"配了账号密码还是 407"
    expect(h.session.calls[0]?.proxyRules).toBe('http://alice:secret@1.2.3.4:8080')
  })

  it('显式传 null = 清除凭据（改地址不该把密码顺手清掉，故不传就是不动）', async () => {
    const h = harness()
    await h.proxy.set({ proxyMode: 'custom', proxyRules: '1.2.3.4:8080', proxyUser: 'u', proxyPass: 'p' })
    expect(h.creds.data).toEqual({ user: 'u', pass: 'p' })
    const v = await h.proxy.set({ proxyUser: null, proxyPass: null })
    expect(h.creds.data).toBeNull()
    expect(v.hasCredentials).toBe(false)
  })

  it('只改地址、不动凭据', async () => {
    const h = harness()
    await h.proxy.set({ proxyMode: 'custom', proxyRules: '1.2.3.4:8080', proxyUser: 'u', proxyPass: 'p' })
    await h.proxy.set({ proxyRules: '5.6.7.8:8080' })
    expect(h.creds.data).toEqual({ user: 'u', pass: 'p' })
    expect(h.store.data.proxyRules).toBe('5.6.7.8:8080')
  })
})

describe('refresh（探测"当前生效的代理"）', () => {
  it('探测失败只记原因、**不抛**（这只是"看一眼"，不该让设置页打不开）', async () => {
    const h = harness({ failResolve: true })
    const v = await h.proxy.refresh()
    expect(v.effective).toBeNull()
    expect(v.effectiveError).toContain('系统代理查询超时')
  })
})
