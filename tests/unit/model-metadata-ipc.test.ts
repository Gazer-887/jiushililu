import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveMetadata } from '@shared/model-metadata'
import {
  applyUserMetadataPatch,
  modelMetadataPatchInputSchema,
  type ModelMetadata
} from '@shared/model-metadata'

const existing: ModelMetadata = {
  contextWindow: {
    official: { value: 131072, observedAt: 1000 },
    catalog: { value: 999999, observedAt: 2000 },
    user: { value: 262144, observedAt: 3000 }
  }
}

describe('S3-10C2A applyUserMetadataPatch · 用户覆盖语义', () => {
  it('set 只写 user 来源并覆盖 official/catalog；其他来源保留；observedAt 由 now 盖章', () => {
    const next = applyUserMetadataPatch(
      existing,
      { set: { contextWindow: { user: { value: 999999 } } } },
      1234567
    )
    const cw = next?.contextWindow
    expect(cw?.user).toEqual({ value: 999999, observedAt: 1234567 })
    expect(cw?.official?.value).toBe(131072)
    expect(cw?.catalog?.value).toBe(999999)
    // 三者共存且解析优先级为 user
    expect(resolveMetadata(cw)?.source).toBe('user')
    expect(resolveMetadata(cw)?.value).toBe(999999)
  })

  it('clear 只清 user 来源，回落 official/catalog', () => {
    const next = applyUserMetadataPatch(existing, { clear: ['contextWindow'] }, 1234567)
    expect(next?.contextWindow?.user).toBeUndefined()
    expect(next?.contextWindow?.official?.value).toBe(131072)
    expect(next?.contextWindow?.catalog?.value).toBe(999999)
  })

  it('clear 唯一来源后字段消失；全部字段消失时 metadata 为 undefined', () => {
    const onlyUser: ModelMetadata = {
      contextWindow: { user: { value: 1, observedAt: 1 } },
      pricing: {
        user: {
          value: [{ category: 'public-api', amount: 0.5, currency: 'USD', unit: '1M' }],
          observedAt: 1
        }
      }
    }
    const afterOne = applyUserMetadataPatch(onlyUser, { clear: ['contextWindow'] }, 5)
    expect(afterOne?.contextWindow).toBeUndefined()
    expect(afterOne?.pricing).toBeDefined()
    const afterAll = applyUserMetadataPatch(afterOne as ModelMetadata, { clear: ['pricing'] }, 5)
    expect(afterAll).toBeUndefined()
  })

  it('clear 不存在的字段不产生空键', () => {
    const next = applyUserMetadataPatch(existing, { clear: ['pricing'] }, 5)
    expect('pricing' in next!).toBe(false)
  })

  it('set 新字段（原 metadata 无该字段）照常写入并盖章', () => {
    const next = applyUserMetadataPatch(
      existing,
      { set: { pricing: { user: { value: [{ category: 'public-api', amount: 0.5, currency: 'USD', unit: '1M-input-tokens' }] } } } },
      42
    )
    expect(next?.pricing?.user?.value[0].amount).toBe(0.5)
    expect(next?.pricing?.user?.observedAt).toBe(42)
  })
})

describe('S3-10C2A patch 输入合同（modelMetadataPatchInputSchema）', () => {
  const lookup = { profileId: 'p1', entryId: 'm1' }

  it('set 夹带 official/catalog 来源被拒（只允许 user）', () => {
    const official = modelMetadataPatchInputSchema.safeParse({
      ...lookup,
      patch: { set: { contextWindow: { official: { value: 1, observedAt: 1 } } } }
    })
    expect(official.success).toBe(false)
    const catalog = modelMetadataPatchInputSchema.safeParse({
      ...lookup,
      patch: { set: { contextWindow: { catalog: { value: 1, observedAt: 1 } } } } }
    )
    expect(catalog.success).toBe(false)
  })

  it('set 里自带 observedAt 被拒（主进程一次 Date.now() 盖章，不信任 renderer）', () => {
    const r = modelMetadataPatchInputSchema.safeParse({
      ...lookup,
      patch: { set: { contextWindow: { user: { value: 1, observedAt: 999 } } } } }
    )
    expect(r.success).toBe(false)
  })

  it('同一字段 set+clear 同时出现被拒', () => {
    const r = modelMetadataPatchInputSchema.safeParse({
      ...lookup,
      patch: { set: { contextWindow: { user: { value: 1 } } }, clear: ['contextWindow'] } }
    )
    expect(r.success).toBe(false)
  })

  it('空 patch 被拒', () => {
    expect(modelMetadataPatchInputSchema.safeParse({ ...lookup, patch: {} }).success).toBe(false)
    expect(modelMetadataPatchInputSchema.safeParse({ ...lookup, patch: { set: {}, clear: [] } }).success).toBe(false)
  })

  it('重复 clear 字段被拒', () => {
    const r = modelMetadataPatchInputSchema.safeParse({
      ...lookup,
      patch: { clear: ['contextWindow', 'contextWindow'] } }
    )
    expect(r.success).toBe(false)
  })

  it('未知字段与非法枚举值被拒', () => {
    expect(modelMetadataPatchInputSchema.safeParse({ ...lookup, patch: { clear: ['rogueField'] } }).success).toBe(false)
    const badValue = modelMetadataPatchInputSchema.safeParse({
      ...lookup,
      patch: { set: { contextWindow: { user: { value: 'not-a-number' } } } } }
    )
    expect(badValue.success).toBe(false)
  })

  it('合法最小 patch：仅 clear 一个字段；仅 set 一个字段（含 limitations）', () => {
    expect(modelMetadataPatchInputSchema.safeParse({ ...lookup, patch: { clear: ['pricing'] } }).success).toBe(true)
    const withLimitations = modelMetadataPatchInputSchema.safeParse({
      ...lookup,
      patch: { set: { pricing: { user: { value: [{ category: 'public-api', amount: 1, currency: 'USD', unit: '1M' }], limitations: ['限流未知'] } } } } }
    )
    expect(withLimitations.success).toBe(true)
  })
})

describe('S3-10C2A 静态门（接线与原子性）', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')

  it('shared/ipc.ts 注册两通道；ApiBridge 两方法为必需（S3-10C2B 转正）', () => {
    const s = read('src/shared/ipc.ts')
    expect(s).toContain("modelsGetMetadata: 'models:get-metadata'")
    expect(s).toContain("modelsPatchMetadata: 'models:patch-metadata'")
    // S3-10C2B：可选转必需；详细形状断言在下方 C2B describe
    expect(s).toContain("getModelMetadata(profileId: string, entryId: string)")
    expect(s).toContain("patchModelMetadata(input: import('./model-metadata').ModelMetadataPatchInput)")
    // 类型引自 model-metadata.ts，不得重定义一套 metadata 字段
    expect(s).not.toContain('interface ModelMetadata {')
  })

  it('main handler：读取走 store getEntryMetadata；补丁走 friendlyParse→applyUserMetadataPatch→patchEntryMetadata→广播→modelsView', () => {
    const s = read('src/main/ipc.ts')
    expect(s).toContain('IPC.modelsGetMetadata')
    expect(s).toContain('IPC.modelsPatchMetadata')
    expect(s).toContain('getEntryMetadata(input.profileId, input.entryId)')
    expect(s).toContain('applyUserMetadataPatch(')
    // S3-10C2A-R1（C2A-M2）：落盘形态升级为规范值 check.data（旧 next 断言随之收紧）
    expect(s).toContain('patchEntryMetadata(input.profileId, input.entryId, check.data)')
    expect(s).toContain('const check = modelMetadataSchema.safeParse(next)')
    expect(s).toContain("deps.onSettingsChanged?.('models')")
    expect(s).toContain('modelMetadataLookupSchema')
    expect(s).toContain('modelMetadataPatchInputSchema')
  })

  it('metadata 补丁 handler 区域不以 saveEndpoint 替代原子补丁', () => {
    const s = read('src/main/ipc.ts')
    const start = s.indexOf('IPC.modelsPatchMetadata')
    expect(start).toBeGreaterThan(-1)
    const region = s.slice(start, s.indexOf('ipcMain.handle(', start))
    expect(region).toContain('patchEntryMetadata')
    expect(region).not.toContain('saveEndpoint')
  })

  it('store：patchEntryMetadata 单次 store.set(profiles)；getEntryMetadata 缺失抛人话错误', () => {
    const s = read('src/main/store/models.ts')
    expect(s).toContain('export function getEntryMetadata')
    expect(s).toContain('export function patchEntryMetadata')
    const start = s.indexOf('export function patchEntryMetadata')
    const region = s.slice(start)
    // 精确匹配实际调用（JSDoc 里的提及不算）；nextProfiles=唯一实参形态
    expect((region.match(/store\.set\('profiles', nextProfiles\)/g) ?? []).length).toBe(1)
    expect(region).toContain("hits !== 2")
    expect(region).not.toContain('saveEndpoint')
  })
})

// ── S3-10C2A-R1 补丁边界与规范落盘（主脑复核 C2A-M1/M2/M3） ─────────────────
describe('S3-10C2A-R1 补丁边界与规范落盘', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  const lookup = { profileId: 'p1', entryId: 'm1' }
  const allFields = [
    'contextWindow', 'maxOutputTokens', 'reasoningLevels', 'nativeInputModalities',
    'nativeExtendedInputs', 'attachmentParsing', 'pricing', 'subscriptionPlan',
    'catalogPolicy'
  ] as const

  it('C2A-M1：超长 clear 数组（>字段总数）被 schema 拒绝', () => {
    const overlong = [...allFields, 'contextWindow']
    expect(overlong).toHaveLength(10)
    const r = modelMetadataPatchInputSchema.safeParse({ ...lookup, patch: { clear: overlong } })
    expect(r.success).toBe(false)
    // C2A-M1 静态绑定：schema 源码含显式限长（先限长再到重复/语义检查）
    expect(read('src/shared/model-metadata.ts')).toContain('.max(MODEL_METADATA_FIELDS.length)')
  })

  it('C2A-M1：九个唯一字段 clear 合法（上限=字段总数）', () => {
    const r = modelMetadataPatchInputSchema.safeParse({ ...lookup, patch: { clear: [...allFields] } })
    expect(r.success).toBe(true)
  })

  it('C2A-M2：静态门确认 handler 落盘 check.data（规范值）而非原始 next', () => {
    const s = read('src/main/ipc.ts')
    expect(s).toContain('patchEntryMetadata(input.profileId, input.entryId, check.data)')
    // 不得再把未规范化的 next 传给落盘
    expect(s).not.toContain('patchEntryMetadata(input.profileId, input.entryId, next)')
  })

  it('C2A-M3：静态门确认 store 函数内部走 listProfiles() 且仍只有一次 store.set(profiles)', () => {
    const s = read('src/main/store/models.ts')
    const start = s.indexOf('export function patchEntryMetadata')
    const region = s.slice(start)
    expect(region).toContain('listProfiles()')
    // 精确匹配实际调用（JSDoc 提及不算）；nextProfiles 为唯一实参形态
    expect((region.match(/store\.set\('profiles', nextProfiles\)/g) ?? []).length).toBe(1)
  })
})


// ── S3-10C2B preload 桥与 SettingsView 广播重读 ─────────────────────────────
describe('S3-10C2B ApiBridge 两方法转必需', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  it('ApiBridge 两方法已非可选（C2B 实现）', () => {
    const s = read('src/shared/ipc.ts')
    expect(s).toContain("getModelMetadata(profileId: string, entryId: string): Promise<import('./model-metadata').ModelMetadata | null>")
    expect(s).toContain("patchModelMetadata(input: import('./model-metadata').ModelMetadataPatchInput): Promise<import('./models').ModelsView>")
    expect(s).not.toContain('getModelMetadata?(profileId')
    expect(s).not.toContain('patchModelMetadata?(input')
  })
})

describe('S3-10C2B preload 白名单桥', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  it('preload 两方法走正确 channel 并返回 invoke', () => {
    const s = read('src/preload/index.ts')
    expect(s).toContain('getModelMetadata: (profileId: string, entryId: string) =>')
    expect(s).toContain('ipcRenderer.invoke(IPC.modelsGetMetadata, { profileId, entryId })')
    expect(s).toContain('patchModelMetadata: (input: ModelMetadataPatchInput) =>')
    expect(s).toContain('ipcRenderer.invoke(IPC.modelsPatchMetadata, input)')
  })
  it('preload 不暴露 ipcRenderer 本体（contextBridge 白名单不变破）', () => {
    const s = read('src/preload/index.ts')
    const expose = s.indexOf('contextBridge.exposeInMainWorld')
    const exposed = s.slice(expose)
    expect(exposed).not.toContain('ipcRenderer,')
    expect(exposed).not.toContain('ipcRenderer:')
  })
})

describe('S3-10C2B SettingsView 广播重读', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  it('订阅 onSettingsChanged 且仅 kind=models 触发 refreshModels；返回退订函数', () => {
    const s = read('src/renderer/src/views/SettingsView.tsx')
    expect(s).toContain("kind === 'models'")
    expect(s).toContain('refreshModels()')
    expect(s).toMatch(/return\s+offModels/)
    expect(s).toContain('useEffect(')
  })
  it('refreshModels 使用 listModels 真值（本地不复制 metadata）', () => {
    const s = read('src/renderer/src/views/SettingsView.tsx')
    expect(s).toContain('window.api.listModels()')
    expect(s).not.toContain('metadataByEntry')
  })
  it('InputTools 现有 onSettingsChanged 重读链仍在（防重复真源）', () => {
    const s = read('src/renderer/src/components/InputTools.tsx')
    expect(s).toContain('window.api.onSettingsChanged(')
    expect(s).toContain('reload()')
  })
})
