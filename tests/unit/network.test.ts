import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NETWORK_SETTINGS,
  describeProxy,
  normalizeNetwork,
  normalizeProxyRules,
  proxyConfigFor,
  proxyRulesError,
  splitCredentials,
  withCredentials,
  type NetworkSettings
} from '@shared/network'

describe('normalizeNetwork（老配置 / 坏值一律回落，不抛错）', () => {
  it('null 与空对象都回落到「跟随系统」', () => {
    expect(normalizeNetwork(null)).toEqual(DEFAULT_NETWORK_SETTINGS)
    expect(normalizeNetwork({})).toEqual(DEFAULT_NETWORK_SETTINGS)
  })

  it('认不出的档位回落默认，但**认识的另一半要保住**', () => {
    // 手改 json 把 mode 写成 typo：整个设置不该被丢掉，只回落那一项
    const v = normalizeNetwork({ proxyMode: 'auto' as never, proxyRules: '127.0.0.1:7897' })
    expect(v.proxyMode).toBe('system')
    expect(v.proxyRules).toBe('127.0.0.1:7897')
  })

  it('规则串两侧空白要trim（从别处粘来的常带换行）', () => {
    expect(normalizeNetwork({ proxyMode: 'custom', proxyRules: '  127.0.0.1:7897\n' }).proxyRules).toBe(
      '127.0.0.1:7897'
    )
  })
})

describe('proxyRulesError（体检：坏值要说人话，不许抛）', () => {
  it('空串不算错（该不该填由档位判断，不是这里的职责）', () => {
    expect(proxyRulesError('')).toBeNull()
    expect(proxyRulesError('   ')).toBeNull()
  })

  it('正常写法放行', () => {
    expect(proxyRulesError('127.0.0.1:7897')).toBeNull()
    expect(proxyRulesError('http=127.0.0.1:7897;https=127.0.0.1:7897')).toBeNull()
    expect(proxyRulesError('socks5://127.0.0.1:1080')).toBeNull()
  })

  it('带凭据的地址不算错（凭据会被剥走，不是非法字符）', () => {
    expect(proxyRulesError('http://user:pass@127.0.0.1:7897')).toBeNull()
  })

  it('超长与含怪字符都要报原因', () => {
    expect(proxyRulesError('a'.repeat(600))).toContain('过长')
    expect(proxyRulesError('127.0.0.1:7897 && rm -rf /')).toContain('不认识的字符')
  })
})

describe('凭据剥离与拼回（凭据不进明文配置）', () => {
  it('单段：剥出来后规则串里只剩 host:port', () => {
    const r = splitCredentials('http://alice:secret@127.0.0.1:7897')
    expect(r.credentials).toEqual({ user: 'alice', pass: 'secret' })
    expect(r.rules).toBe('http://127.0.0.1:7897')
  })

  it('Chromium 的 `http=` 写法也要认（前缀不是纯 scheme）', () => {
    const r = splitCredentials('http=http://alice:secret@127.0.0.1:7897;https=127.0.0.1:7897')
    expect(r.credentials).toEqual({ user: 'alice', pass: 'secret' })
    expect(r.rules).toBe('http=http://127.0.0.1:7897;https=127.0.0.1:7897')
  })

  it('没有凭据就原样返回、credentials 为 null（**不许**把 host:port 误认成凭据）', () => {
    const r = splitCredentials('127.0.0.1:7897')
    expect(r.credentials).toBeNull()
    expect(r.rules).toBe('127.0.0.1:7897')
    expect(splitCredentials('socks5://127.0.0.1:1080').credentials).toBeNull()
  })

  it('⚠️ **不带 scheme** 的凭据也要剥出来 —— 漏掉就是凭据明文落盘（红线）', () => {
    const r = splitCredentials('alice:secret@127.0.0.1:7897')
    expect(r.credentials).toEqual({ user: 'alice', pass: 'secret' })
    expect(r.rules).toBe('127.0.0.1:7897')
  })

  it('⚠️ `key=` 前缀 + 不带 scheme 的凭据同样要剥', () => {
    const r = splitCredentials('http=alice:secret@127.0.0.1:7897;https=127.0.0.1:7897')
    expect(r.credentials).toEqual({ user: 'alice', pass: 'secret' })
    expect(r.rules).toBe('http=127.0.0.1:7897;https=127.0.0.1:7897')
  })

  it('往返：剥出来再拼回去，规则串能回到含凭据的原样', () => {
    const raw = 'http://alice:secret@127.0.0.1:7897'
    const { rules, credentials } = splitCredentials(raw)
    expect(withCredentials(rules, credentials)).toBe(raw)
  })

  it('⚠️ 密码含 `$&` / `$1` 时**不得被当成替换模式**（用函数式 replace 的原因）', () => {
    const creds = { user: 'a$b', pass: 'p$&1' }
    const out = withCredentials('http://127.0.0.1:7897', creds)
    expect(out).toBe('http://a%24b:p%24%261@127.0.0.1:7897')
    // 拼回去再剥出来必须还是原样 —— 密码悄悄变样是极难排查的一类 bug
    expect(splitCredentials(out).credentials).toEqual(creds)
  })

  it('只认第一组凭据：多段各带不同凭据时不猜，其余原样保留', () => {
    const r = splitCredentials('http://a:1@h1:1;http://b:2@h2:2')
    expect(r.credentials).toEqual({ user: 'a', pass: '1' })
    expect(r.rules).toBe('http://h1:1;http://h2:2')
  })
})

describe('proxyConfigFor（意图 → setProxy 配置）', () => {
  const custom: NetworkSettings = { proxyMode: 'custom', proxyRules: '127.0.0.1:7897' }

  it('直连档不带任何规则', () => {
    expect(proxyConfigFor({ ...custom, proxyMode: 'direct' }, null)).toEqual({ mode: 'direct' })
  })

  it('跟随系统档同样是"什么都不带"，交给系统', () => {
    expect(proxyConfigFor({ ...custom, proxyMode: 'system' }, { user: 'u', pass: 'p' })).toEqual({
      mode: 'system'
    })
  })

  it('手动档才带规则；无凭据时规则串原样不动', () => {
    expect(proxyConfigFor(custom, null)).toEqual({
      mode: 'fixed_servers',
      proxyRules: '127.0.0.1:7897',
      proxyBypassRules: ''
    })
  })

  it('⚠️ 有凭据且地址**没有 scheme** 时要补 `http://` —— 不补凭据会被静默丢弃（表现为代理回 407）', () => {
    expect(proxyConfigFor(custom, { user: 'u', pass: 'p' }).proxyRules).toBe(
      'http://u:p@127.0.0.1:7897'
    )
    expect(
      proxyConfigFor({ proxyMode: 'custom', proxyRules: 'http=127.0.0.1:7897' }, {
        user: 'u',
        pass: 'p'
      }).proxyRules
    ).toBe('http=http://u:p@127.0.0.1:7897')
  })

  it('⚠️ bypass 留空：`<-loopback>` 是"取消绕过 loopback"，写上去会把本地模型也推进代理', () => {
    const cfg = proxyConfigFor(custom, null)
    expect(cfg.proxyBypassRules).toBe('')
    expect(cfg.proxyRules).not.toContain('<-loopback>')
  })
})

describe('describeProxy（PAC 串翻人话）', () => {
  it('未知 / 空 = 未知', () => {
    expect(describeProxy(null)).toBe('未知')
    expect(describeProxy('')).toBe('未知')
  })

  it('纯直连', () => {
    expect(describeProxy('DIRECT')).toBe('直连')
  })

  it('代理 + 兜底直连（PAC 串里最常见的形态）', () => {
    expect(describeProxy('PROXY 127.0.0.1:7897; DIRECT')).toBe('HTTP 代理 127.0.0.1:7897 → 直连')
  })

  it('SOCKS 也认', () => {
    expect(describeProxy('SOCKS5 127.0.0.1:1080')).toBe('SOCKS5 127.0.0.1:1080')
  })
})

describe('normalizeProxyRules', () => {
  it('中间的换行与多余空白压成单空格（Chromium 见到裸换行会解析出鬼规则）', () => {
    expect(normalizeProxyRules(' http=1.1.1.1:1;\r\nhttps=2.2.2.2:2 ')).toBe(
      'http=1.1.1.1:1; https=2.2.2.2:2'
    )
  })
})
