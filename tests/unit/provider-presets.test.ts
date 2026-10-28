import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  getProviderPreset,
  listForbiddenPresets,
  listProviderPresets,
  OPEN_CODE_CONSOLE_NOTE,
  resolvePresetAuth,
  validatePresetBase
} from '@shared/provider-presets'

describe('S3-10B 冻结预设目录结构（12普通+6订阅+2自定义+1本地；禁用5不提供通路）', () => {
  const presets = listProviderPresets()

  it('件数与分类计数与冻结名单一致（12/6/2/1）', () => {
    expect(presets).toHaveLength(21)
    expect(presets.filter((p) => p.category === 'regular-api')).toHaveLength(12)
    expect(presets.filter((p) => p.category === 'subscription')).toHaveLength(6)
    expect(presets.filter((p) => p.category === 'custom')).toHaveLength(2)
    expect(presets.filter((p) => p.category === 'local-gateway')).toHaveLength(1)
  })

  it('id 唯一；禁用五项不入可选目录且 listForbiddenPresets=5', () => {
    const ids = presets.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    const forbidden = listForbiddenPresets()
    expect(forbidden).toHaveLength(5)
    for (const f of forbidden) expect(ids).not.toContain(f.id)
    expect(getProviderPreset('ark-coding-plan')).toBeUndefined()
    expect(getProviderPreset('zhipu-glm-coding-plan')).toBeUndefined()
  })

  it('OpenCode Console 不设第13家预设，只保留按量说明', () => {
    expect(ids().some((id) => id.includes('console'))).toBe(false)
    expect(OPEN_CODE_CONSOLE_NOTE).toContain('按量')
    function ids(): string[] {
      return listProviderPresets().map((p) => p.id)
    }
  })

  it('每预设公开元数据齐备：faces 非空、helpUrl 为官方 https、无 Key/个人字段', () => {
    for (const p of presets) {
      expect(p.faces.length).toBeGreaterThan(0)
      for (const f of p.faces) {
        expect(['openai-compatible', 'anthropic']).toContain(f.protocol)
        if (f.baseUrlTemplate) expect(f.baseUrlTemplate.startsWith('http')).toBe(true)
      }
      expect(p.authDefaultSource).toBeTruthy()
      for (const key of Object.keys(p)) {
        expect(key.toLowerCase()).not.toContain('key')
        expect(key.toLowerCase()).not.toContain('apikey')
      }
    }
  })

  it('导入零副作用：模块源码不含 fetch/http请求/electron 引用（纯数据+纯函数）', () => {
    const src = readFileSync('src/shared/provider-presets.ts', 'utf-8')
    expect(src.includes('fetch(')).toBe(false)
    expect(src.includes('XMLHttpRequest')).toBe(false)
    expect(src.includes('http.request')).toBe(false)
    expect(src.includes("require('electron')")).toBe(false)
    expect(src.includes('from \'electron\'')).toBe(false)
  })
})

describe('S3-10B 认证缺省与解析（合同 authentication 逐字）', () => {
  it('MiniMax 系（按量+M Plan）authDefault=bearer/bearer（official-captured-page）', () => {
    const regular = getProviderPreset('minimax')!
    const plan = getProviderPreset('minimax-m-plan')!
    expect(regular.authDefault).toEqual({ 'openai-compatible': 'bearer', anthropic: 'bearer' })
    expect(plan.authDefault).toEqual({ 'openai-compatible': 'bearer', anthropic: 'bearer' })
    expect(regular.authDefaultSource).toContain('official-captured-page')
  })

  it('Anthropic 预设 anthropic:bearer（F-04 合同来源）；其余新预设 unknown', () => {
    expect(getProviderPreset('anthropic')!.authDefault).toEqual({ anthropic: 'bearer' })
    for (const id of ['openai', 'google-gemini', 'deepseek', 'bailian', 'ark']) {
      const p = getProviderPreset(id)!
      for (const v of Object.values(p.authDefault)) expect(v).toBe('unknown')
    }
  })

  it('unknown + auto 拒绝生成可发送配置；显式 bearer 通过', () => {
    const openai = getProviderPreset('openai')!
    expect(resolvePresetAuth(openai, 'openai-compatible', 'auto').ok).toBe(false)
    const bearer = resolvePresetAuth(openai, 'openai-compatible', 'bearer')
    expect(bearer).toEqual({ ok: true, auth: 'bearer' })
  })

  it('authDefault 非 unknown 时 auto 解析为该缺省（MiniMax M Plan → bearer）', () => {
    const plan = getProviderPreset('minimax-m-plan')!
    expect(resolvePresetAuth(plan, 'openai-compatible', 'auto')).toEqual({ ok: true, auth: 'bearer' })
    expect(resolvePresetAuth(plan, 'anthropic', 'auto')).toEqual({ ok: true, auth: 'bearer' })
  })

  it('openai-compatible + x-api-key 明确拒绝；anthropic + x-api-key 允许', () => {
    const openai = getProviderPreset('openai')!
    expect(resolvePresetAuth(openai, 'openai-compatible', 'x-api-key').ok).toBe(false)
    const anthropic = getProviderPreset('anthropic')!
    expect(resolvePresetAuth(anthropic, 'anthropic', 'x-api-key')).toEqual({ ok: true, auth: 'x-api-key' })
  })

  it('双协议面预设按 face 取各自 authDefault（MiniMax M Plan 两面均 bearer）', () => {
    const plan = getProviderPreset('minimax-m-plan')!
    for (const face of plan.faces) {
      expect(resolvePresetAuth(plan, face.protocol, 'auto').auth).toBe('bearer')
    }
  })
})

describe('S3-10B 地址校验（占位/空值/账号专属）', () => {
  it('百炼 Token Plan：空 base 拒绝并明示账号专属（不拿按量地址冒充）', () => {
    const p = getProviderPreset('bailian-token-plan')!
    const empty = validatePresetBase(p, 'openai-compatible', '')
    expect(empty.ok).toBe(false)
    expect(empty.reason).toContain('账号专属')
    expect(validatePresetBase(p, 'openai-compatible', 'https://dashscope.aliyuncs.com/compatible-mode/v1').ok).toBe(true)
  })

  it('未填占位符拒绝（{WorkspaceId} 类）', () => {
    const bailian = getProviderPreset('bailian')!
    const bad = validatePresetBase(bailian, 'openai-compatible', 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('占位')
  })

  it('自定义入口空 base 拒绝；非 http(s) 拒绝；合法值通过', () => {
    const custom = getProviderPreset('custom-openai-compatible')!
    expect(validatePresetBase(custom, 'openai-compatible', '').ok).toBe(false)
    expect(validatePresetBase(custom, 'openai-compatible', 'ftp://example.com/v1').ok).toBe(false)
    expect(validatePresetBase(custom, 'openai-compatible', 'https://my-gateway.example.com/v1').ok).toBe(true)
  })

  it('百炼按量默认 base（旧域）直接可用；Magpie 本机模板可用', () => {
    const bailian = getProviderPreset('bailian')!
    expect(validatePresetBase(bailian, 'openai-compatible', 'https://dashscope.aliyuncs.com/compatible-mode/v1').ok).toBe(true)
    const magpie = getProviderPreset('local-magpie')!
    expect(validatePresetBase(magpie, 'openai-compatible', 'http://127.0.0.1:3425/v1').ok).toBe(true)
  })
})

describe('S3-10B requestIdentity 窄策略映射（S3-00C closure-proposal；运行态注入归 30T/F）', () => {
  it('OpenCode Go = opencode-v1；订阅组 self-ua；普通/自定义 default', () => {
    expect(getProviderPreset('opencode-go')!.requestIdentity).toBe('opencode-v1')
    for (const id of ['minimax-m-plan', 'xiaomi-mimo-token-plan', 'kimi-code', 'bailian-token-plan', 'step-plan']) {
      expect(getProviderPreset(id)!.requestIdentity).toBe('self-ua')
    }
    for (const id of ['openai', 'anthropic', 'custom-openai-compatible', 'local-magpie']) {
      expect(getProviderPreset(id)!.requestIdentity).toBe('default')
    }
  })
})

describe('S3-10B 特殊路径元数据（OpenCode Go models 与聊天 base 分列）', () => {
  it('OpenCode Go faces 记录 models 特殊路径，同 origin（/inference/go/v1/models）', () => {
    const go = getProviderPreset('opencode-go')!
    const openaiFace = go.faces.find((f) => f.protocol === 'openai-compatible')!
    expect(openaiFace.paths?.models).toBe('https://opencode.ai/inference/go/v1/models')
  })
})

// ── S3-10A 模板选择→保存→读回（纯函数行为） ─────────────────────────────────
import {
  applyPresetFace,
  presetSaveBlockers,
  mergePresetIntoEntry,
  handleProtocolSwitch
} from '@shared/provider-presets'

const get = (id: string) => {
  const p = listProviderPresets().find((x) => x.id === id)
  if (!p) throw new Error(`missing preset ${id}`)
  return p
}
import { listProviderPresets } from '@shared/provider-presets'

describe('S3-10A 模板选择生成连接草稿', () => {
  it('applyPresetFace 生成正确协议/URL/认证缺省/requestIdentity', () => {
    const d = applyPresetFace(get('minimax-m-plan'), 'openai-compatible')
    expect(d).toBeDefined()
    expect(d!.providerType).toBe('openai-compatible')
    expect(d!.baseURL).toBe('https://api.minimax.cn/v1')
    expect(d!.requestIdentity).toBe('self-ua')
    expect(d!.authDefault).toBe('bearer')
    expect(d!.presetId).toBe('minimax-m-plan')
  })

  it('双协议模板可切换协议面；无对应协议面时拒绝', () => {
    const d1 = applyPresetFace(get('deepseek'), 'openai-compatible')
    const d2 = applyPresetFace(get('deepseek'), 'anthropic')
    expect(d1?.baseURL).toBe('https://api.deepseek.com')
    expect(d2?.baseURL).toBe('https://api.deepseek.com/anthropic')
    expect(applyPresetFace(get('openai'), 'anthropic')).toBeUndefined()
  })

  it('切换预设不清空 Key/模型/settings/metadata（applyPresetFace 只产连接字段）', () => {
    const d = applyPresetFace(get('kimi-code'), 'openai-compatible')
    expect(d).toBeDefined()
    const keys = Object.keys(d as object)
    expect(keys.some((k) => k.toLowerCase().includes('key'))).toBe(false)
    expect(keys.some((k) => k.toLowerCase().includes('modelid'))).toBe(false)
  })

  it('模块导入零网络副作用（纯数据+纯函数）', () => {
    const src = readFileSync('src/shared/provider-presets.ts', 'utf-8')
    expect(src.includes('fetch(')).toBe(false)
    expect(src.includes('XMLHttpRequest')).toBe(false)
  })
})

describe('S3-10A 保存前阻断（presetSaveBlockers）', () => {
  const base = { protocol: 'openai-compatible' as const, modelId: 'test-model', isNewEndpoint: true }

  it('base 为空阻断', () => {
    const r = presetSaveBlockers({ ...base, preset: get('openai'), baseURL: '', apiKey: 'sk', authChoice: 'bearer' })
    expect(r.ok).toBe(false)
    expect(r.blockers.length).toBeGreaterThan(0)
  })

  it('百炼 Token Plan 空账号专属 base 阻断', () => {
    const r = presetSaveBlockers({ ...base, preset: get('bailian-token-plan'), baseURL: '', apiKey: 'sk', authChoice: 'bearer' })
    expect(r.ok).toBe(false)
    expect(r.blockers.some((b) => b.includes('账号专属'))).toBe(true)
  })

  it('{占位符} 未填阻断', () => {
    const bailian = get('bailian')
    const r = presetSaveBlockers({
      ...base, preset: bailian,
      baseURL: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk', authChoice: 'bearer'
    })
    expect(r.ok).toBe(false)
    expect(r.blockers.some((b) => b.includes('占位'))).toBe(true)
  })

  it('非 http(s) URL 阻断', () => {
    const r = presetSaveBlockers({ ...base, preset: get('openai'), baseURL: 'ftp://x', apiKey: 'sk', authChoice: 'bearer' })
    expect(r.ok).toBe(false)
  })

  it('协议面不存在阻断', () => {
    const r = presetSaveBlockers({ ...base, preset: get('openai'), protocol: 'anthropic', baseURL: 'https://a', apiKey: 'sk', authChoice: 'bearer' })
    expect(r.ok).toBe(false)
    expect(r.blockers.some((b) => b.includes('协议面'))).toBe(true)
  })

  it('unknown + auto 阻断；MiniMax 已知缺省 auto 解析为 bearer', () => {
    const openai = presetSaveBlockers({ ...base, preset: get('openai'), baseURL: 'https://api.openai.com/v1', apiKey: 'sk', authChoice: 'auto' })
    expect(openai.ok).toBe(false)
    expect(openai.blockers.some((b) => b.includes('bearer 或 x-api-key'))).toBe(true)
    const minimax = presetSaveBlockers({ ...base, preset: get('minimax'), baseURL: 'https://api.minimax.cn/v1', apiKey: 'sk', authChoice: 'auto' })
    expect(minimax.ok).toBe(true)
  })

  it('openai-compatible + x-api-key 阻断', () => {
    const r = presetSaveBlockers({ ...base, preset: get('openai'), baseURL: 'https://api.openai.com/v1', apiKey: 'sk', authChoice: 'x-api-key' })
    expect(r.ok).toBe(false)
  })

  it('新增端点无模型 ID / 无 API Key 阻断', () => {
    const noModel = presetSaveBlockers({ ...base, preset: get('openai'), baseURL: 'https://api.openai.com/v1', apiKey: 'sk', modelId: '', authChoice: 'bearer' })
    expect(noModel.ok).toBe(false)
    expect(noModel.blockers.some((b) => b.includes('模型'))).toBe(true)
    const noKey = presetSaveBlockers({ ...base, preset: get('openai'), baseURL: 'https://api.openai.com/v1', apiKey: '', authChoice: 'bearer' })
    expect(noKey.ok).toBe(false)
    expect(noKey.blockers.some((b) => b.toLowerCase().includes('key'))).toBe(true)
  })

  it('已有端点编辑时空 Key 表示保留既有密文 Key（不阻断）', () => {
    const r = presetSaveBlockers({ ...base, preset: get('openai'), baseURL: 'https://api.openai.com/v1', apiKey: '', isNewEndpoint: false, authChoice: 'bearer' })
    expect(r.blockers.some((b) => b.toLowerCase().includes('key'))).toBe(false)
  })
})

describe('S3-10A-R2A1 mergePresetIntoEntry 保留全部字段与安全落位', () => {
  it('钉住 id/model/name/settings/metadata 全部保留', () => {
    const existing = {
      id: 'm1',
      model: 'old-model',
      name: '旧名',
      metadata: { contextWindow: { user: { value: 262144, observedAt: 1 } } },
      settings: { temperature: 0.5, maxTokens: 4096 }
    }
    const merged = mergePresetIntoEntry(get('minimax-m-plan'), existing, 'bearer')
    expect(merged.id).toBe('m1')
    expect(merged.model).toBe('old-model')
    expect(merged.name).toBe('旧名')
    expect(merged.metadata).toEqual({ contextWindow: { user: { value: 262144, observedAt: 1 } } })
    expect(merged.settings.temperature).toBe(0.5)
    expect(merged.settings.maxTokens).toBe(4096)
  })

  it('钉住身份/认证位于 settings 而非条目顶层', () => {
    const merged = mergePresetIntoEntry(get('minimax-m-plan'), { model: 'm1' }, 'bearer')
    expect(merged.settings?.requestIdentity).toBe('self-ua')
    expect(merged.settings?.authentication).toBe('bearer')
    expect('requestIdentity' in merged).toBe(false)
    expect('authentication' in merged).toBe(false)
  })

  it('既有 metadata 原样保留且仍挂条目顶层', () => {
    const meta = { contextWindow: { user: { value: 1, observedAt: 1 } } }
    const merged = mergePresetIntoEntry(get('openai'), { model: 'm', metadata: meta }, 'bearer')
    expect(merged.metadata).toEqual(meta)
  })

  it('无 metadata 时不出现该键', () => {
    const merged = mergePresetIntoEntry(get('openai'), { model: 'm' }, 'bearer')
    expect('metadata' in merged).toBe(false)
  })
})

describe('S3-10A-R2A1 handleProtocolSwitch 纯函数行为', () => {
  it('覆盖双协议模板切换（DeepSeek / OpenCode Go）', () => {
    const deepseek = get('deepseek')
    const rOpenAI = handleProtocolSwitch(deepseek, 'openai-compatible', 'https://old.example.com')
    expect(rOpenAI).toEqual({
      changed: true,
      protocol: 'openai-compatible',
      baseURL: 'https://api.deepseek.com',
      authDefault: 'unknown',
      requestIdentity: 'default'
    })

    const rAnthropic = handleProtocolSwitch(deepseek, 'anthropic', 'https://api.deepseek.com')
    expect(rAnthropic).toEqual({
      changed: true,
      protocol: 'anthropic',
      baseURL: 'https://api.deepseek.com/anthropic',
      authDefault: 'unknown',
      requestIdentity: 'default'
    })

    const opencode = get('opencode-go')
    const rOpencodeAnthropic = handleProtocolSwitch(opencode, 'anthropic', 'https://opencode.ai/inference/go/openai/v1')
    expect(rOpencodeAnthropic).toEqual({
      changed: true,
      protocol: 'anthropic',
      baseURL: 'https://opencode.ai/inference/go/anthropic',
      authDefault: 'unknown',
      requestIdentity: 'opencode-v1'
    })
  })

  it('覆盖未知/未支持协议面时 changed=false 并保留当前 base', () => {
    const openai = get('openai')
    const r = handleProtocolSwitch(openai, 'anthropic', 'https://api.openai.com/v1')
    expect(r).toEqual({
      changed: false,
      protocol: 'anthropic',
      baseURL: 'https://api.openai.com/v1',
      authDefault: 'unknown',
      requestIdentity: 'default'
    })
  })

  it('覆盖无模板手填（preset=undefined）时 changed=false 并保留当前 base', () => {
    const rOpenAI = handleProtocolSwitch(undefined, 'openai-compatible', 'https://custom-gateway.local/v1')
    expect(rOpenAI).toEqual({
      changed: false,
      protocol: 'openai-compatible',
      baseURL: 'https://custom-gateway.local/v1',
      authDefault: 'unknown',
      requestIdentity: 'default'
    })

    const rAnthropic = handleProtocolSwitch(undefined, 'anthropic', 'https://custom-gateway.local/anthropic')
    expect(rAnthropic).toEqual({
      changed: false,
      protocol: 'anthropic',
      baseURL: 'https://custom-gateway.local/anthropic',
      authDefault: 'unknown',
      requestIdentity: 'default'
    })
  })

  it('provider-presets.ts 源码不再含 ModelSaveInputLike 或 buildModelSaveInput', () => {
    const src = readFileSync('src/shared/provider-presets.ts', 'utf-8')
    expect(src).not.toContain('ModelSaveInputLike')
    expect(src).not.toContain('buildModelSaveInput')
  })
})

describe('S3-10A-R1 SettingsView 保存链源码契约', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  it('保存异常分支不包含草稿清空/列表替换动作', () => {
    const s = read('src/renderer/src/views/SettingsView.tsx')
    const catchIdx = s.indexOf("setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })")
    const catchBlock = s.slice(catchIdx, catchIdx + 200)
    expect(catchBlock).not.toContain('setDraftName')
    expect(catchBlock).not.toContain('setDraftModels([])')
    expect(catchBlock).not.toContain("setApiKey('')")
    expect(catchBlock).not.toContain('refreshModels()')
  })
  it('draftAuth 状态存在且认证选择控件在表单中', () => {
    const s = read('src/renderer/src/views/SettingsView.tsx')
    expect(s).toContain('draftAuth')
    expect(s).toContain('setDraftAuth')
    expect(s).toContain('authentication-choice')
  })
  it('保存合并覆盖全部 draftModels（非仅 [0]）并走 mergePresetIntoEntry', () => {
    const s = read('src/renderer/src/views/SettingsView.tsx')
    expect(s).toContain('draftModels.map(')
    expect(s).toContain('mergePresetIntoEntry(')
    expect(s).toContain('resolvePresetAuth(')
  })
  it('ProviderPresetPicker 展示 preset.notes 与 face.notes', () => {
    const s = read('src/renderer/src/components/ProviderPresetPicker.tsx')
    expect(s).toContain('p.notes')
    expect(s).toContain('f.notes')
    expect(s).toContain('preset-note')
  })
  it('startEdit/cancelEdit/startCreate 清 presetSelection 与 draftAuth', () => {
    const s = read('src/renderer/src/views/SettingsView.tsx')
    expect((s.match(/setPresetSelection\(null\)/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((s.match(/setDraftAuth\(''/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('S3-10A-R2A2 编辑态认证保真', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  const view = () => read('src/renderer/src/views/SettingsView.tsx')

  it('authTouched 状态存在；startCreate/startEdit/cancelEdit 均重置为未触碰', () => {
    const s = view()
    expect(s).toContain('const [authTouched, setAuthTouched] = useState(false)')
    expect((s.match(/setAuthTouched\(false\)/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('未触碰认证时逐条保留，不读 draft.authentication 兜底', () => {
    const s = view()
    expect(s).not.toContain('draft.authentication')
    const start = s.indexOf('const save = async')
    const saveBlock = s.slice(start, s.indexOf('const handlePresetSelect', start))
    const mergeAt = saveBlock.indexOf('if (preset && concreteAuth)')
    const explicitAt = saveBlock.indexOf('if (!preset && authTouched && draftAuth)')
    const passthroughAt = saveBlock.indexOf('return m')
    expect(mergeAt).toBeGreaterThan(-1)
    expect(explicitAt).toBeGreaterThan(mergeAt)
    expect(passthroughAt).toBeGreaterThan(explicitAt)
  })

  it('用户明确选择认证后统一更新：只写认证字段，其余 settings/metadata 保留', () => {
    const s = view()
    expect(s).toContain('setAuthTouched(true)')
    expect(s).toContain('authentication: draftAuth')
  })

  it('选中模板时初始化实际认证缺省值，unknown 才留空', () => {
    const s = view()
    expect(s).toContain("setDraftAuth(sel.authDefault === 'unknown' ? '' : sel.authDefault)")
    expect(s).toContain("setAuthTouched(sel.authDefault !== 'unknown')")
    expect(s).not.toContain("sel.authDefault === 'unknown' ? '' : 'bearer'")
  })
})

describe('S3-10A-R2A2 协议切换接线', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  const view = () => read('src/renderer/src/views/SettingsView.tsx')

  it('协议下拉走唯一处理函数，内部调用 handleProtocolSwitch', () => {
    const s = view()
    expect(s).toContain('handleProtocolSwitch(')
    expect(s).toContain('const handleProtocolChange = (next: ProviderType): void =>')
    expect(s).toContain('onChange={(e) => handleProtocolChange(e.target.value as ProviderType)}')
    expect(s).not.toContain("onChange={(e) => update('providerType', e.target.value as ProviderType)}")
  })

  it('模板含目标协议面：同步协议/地址/身份/认证缺省', () => {
    const s = view()
    const start = s.indexOf('const handleProtocolChange')
    const block = s.slice(start, start + 1600)
    expect(block).toContain('result.changed')
    expect(block).toContain('result.baseURL')
    expect(block).toContain('result.requestIdentity')
    expect(block).toContain('result.authDefault')
    expect(block).toContain("setAuthTouched(result.authDefault !== 'unknown')")
  })

  it('模板不含目标协议面：清模板、保留 baseURL 转手填、清空认证', () => {
    const s = view()
    const start = s.indexOf('const handleProtocolChange')
    const block = s.slice(start, start + 1600)
    expect(block).toContain('setPresetSelection(null)')
    expect(block).toContain("setDraftAuth('')")
    expect(block).toContain('setAuthTouched(false)')
    expect(block).toContain('result.baseURL')
  })

  it('保存校验、认证解析与条目合并统一使用当前协议', () => {
    const s = view()
    expect(s).toContain('const protocol = draft.providerType')
    expect(s).toContain('resolvePresetAuth(preset, protocol, authChoice)')
    expect(s).toContain('mergePresetIntoEntry(preset, m, concreteAuth)')
  })
})

describe('S3-10A-R2A2 模板帮助链接', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')

  it('ProviderPresetPicker 对非空 helpUrl 输出安全外链', () => {
    const s = read('src/renderer/src/components/ProviderPresetPicker.tsx')
    expect(s).toContain('helpUrl')
    expect(s).toContain('preset-help-link')
    expect(s).toContain('href={url}')
    expect(s).toContain('target="_blank"')
    expect(s).toContain('rel="noreferrer noopener"')
  })

  it('选择模板后的编辑表单显示模板名与帮助链接', () => {
    const s = read('src/renderer/src/views/SettingsView.tsx')
    expect(s).toContain('presetSelection.presetName')
    expect(s).toContain('presetSelection.helpUrl')
    expect(s).toContain('preset-help-link')
  })

  it('CSS 使用既有语义 token，无新增裸色值', () => {
    const css = read('src/renderer/src/styles.css')
    const line = css.split('\n').find((l) => l.trimStart().startsWith('.preset-help-link'))
    expect(line).toBeDefined()
    expect(line!).toContain('var(--accent)')
    expect(line!).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })
})

describe('S3-10A-R2A2 保存异常分支', () => {
  it('catch 只显示错误，不清空草稿/Key/模板/认证/已有端点', () => {
    const s = readFileSync('src/renderer/src/views/SettingsView.tsx', 'utf-8')
    const catchAt = s.indexOf("setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })")
    expect(catchAt).toBeGreaterThan(-1)
    const block = s.slice(catchAt, s.indexOf('} finally', catchAt))
    for (const forbidden of [
      'setDraftName(',
      'setDraftModels(',
      "setApiKey('')",
      'setPresetSelection(',
      'setDraftAuth(',
      'setAuthTouched(',
      'refreshModels()',
      'setEditingModel('
    ]) {
      expect(block).not.toContain(forbidden)
    }
  })
})
