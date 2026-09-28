import { describe, expect, it } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import {
  PROFILE_NAME_MAX,
  activeEntry,
  activeProfile,
  canDeleteEntry,
  canDeleteProfile,
  createProfile,
  entryLabel,
  findModelEntry,
  legacyKeyOwnerId,
  makeEntry,
  normalizeProfiles,
  profileOf,
  removeProfile,
  settingsOf,
  type ModelProfile
} from '@shared/models'

/**
 * 模型档案（plan7 F5 / F5.1：端点 + 模型目录）—— 纯逻辑部分。
 * 四条不变量：老数据两种历史形状都要读进来且参数不丢；任何情况不许出现"没有模型可用"；
 * 有效设置 = 端点默认 ⊕ 模型覆盖（只存改过的字段）；坏条目只丢并计数，整表崩 = 让人以为 Key 也没了。
 */

const NOW = 1_700_000_000_000

/** 一份完整的"老形状"设置（迁移起点） */
const legacySettings = (over: Partial<ModelSettings> = {}): ModelSettings => ({
  providerType: 'openai-compatible',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60_000,
  stream: true,
  contextWindow: 128_000,
  reasoningEffort: 'default',
  maxToolRounds: 12,
  inputModalities: ['text'],
  ...over
})

const profile = (id: string, models: string[] = [id]): ModelProfile =>
  createProfile({
    id,
    name: id,
    providerType: 'openai-compatible',
    baseURL: 'https://x',
    models: models.map((m, i) => makeEntry({ id: `${id}-m${i + 1}`, model: m })),
    now: NOW
  })

describe('端点：一条连接挂一串模型', () => {
  it('第一个模型自动成为当前（创建后不会是"没选中任何模型"）', () => {
    const p = profile('a', ['m-one', 'm-two'])
    expect(p.activeModelId).toBe('a-m1')
    expect(activeEntry(p)?.model).toBe('m-one')
  })

  it('名字为空时退回第一条模型名（列表里不留空白行）', () => {
    const p = createProfile({
      id: 'x',
      providerType: 'openai-compatible',
      baseURL: 'https://x',
      models: [makeEntry({ id: 'e1', model: 'agnes-3.0-flash' })],
      now: NOW
    })
    expect(p.name).toBe('agnes-3.0-flash')
  })

  it('端点名超长会截断（显示名是标签，不是描述）', () => {
    const p = createProfile({
      id: 'x',
      name: 'x'.repeat(200),
      providerType: 'openai-compatible',
      baseURL: 'https://x',
      models: [makeEntry({ id: 'e1', model: 'm' })],
      now: NOW
    })
    expect(p.name.length).toBe(PROFILE_NAME_MAX)
  })

  it('条目显示名：没写就用模型 ID', () => {
    expect(entryLabel({ id: 'e', model: 'agnes-image-2.5-flash' })).toBe('agnes-image-2.5-flash')
    expect(entryLabel({ id: 'e', model: 'm', name: '画图模型' })).toBe('画图模型')
  })
})

describe('有效设置 = 端点默认 ⊕ 该模型的高级设置', () => {
  const p: ModelProfile = {
    ...profile('a', ['m-one']),
    timeoutMs: 30_000,
    stream: false,
    activeModelId: 'a-m1'
  }

  it('没写覆盖项 → 全取端点默认', () => {
    const s = settingsOf(p, p.models[0])
    expect(s.providerType).toBe('openai-compatible')
    expect(s.baseURL).toBe('https://x')
    expect(s.model).toBe('m-one')
    expect(s.timeoutMs).toBe(30_000)
    expect(s.stream).toBe(false)
    expect(s.maxTokens).toBe(4096)
    expect(s.temperature).toBeNull()
  })

  it('**只覆盖写了的字段**，其余仍跟随端点默认（这正是不做全量复制的原因）', () => {
    const entry = { ...p.models[0], settings: { maxTokens: 8192, inputModalities: ['text', 'image'] } }
    const s = settingsOf(p, entry)
    expect(s.maxTokens).toBe(8192)
    expect(s.inputModalities).toContain('image')
    expect(s.contextWindow).toBe(131072)
    expect(s.timeoutMs).toBe(30_000)
  })

  it('`model` 永远取条目自己的（不是端点名）', () => {
    const entry = makeEntry({ id: 'e', model: 'agnes-video-2.5-flash' })
    expect(settingsOf(p, entry).model).toBe('agnes-video-2.5-flash')
  })

  it('`settingsOf` 只摊平内核认识的字段（id/name/source/时间戳不外泄）', () => {
    const s = settingsOf(p, p.models[0])
    expect(Object.keys(s).sort()).toEqual(Object.keys(legacySettings()).sort())
  })
})

describe('迁移①：老的"单模型设置" → 端点 + 一条目录（参数一个不丢）', () => {
  it('连接级留在端点、模型级进目录，且合起来与原来完全一致', () => {
    const old = legacySettings({
      model: 'deepseek-v4-flash',
      maxTokens: 16384,
      contextWindow: 384_000,
      reasoningEffort: 'high',
      maxToolRounds: 30,
      inputModalities: ['text', 'image'],
      temperature: 0.7,
      timeoutMs: 90_000,
      stream: false
    })
    const p = profileOf(old, NOW, { name: 'DeepSeek-V4 Flash' })
    expect(p.providerType).toBe(old.providerType)
    expect(p.baseURL).toBe(old.baseURL)
    expect(p.timeoutMs).toBe(90_000)
    expect(p.stream).toBe(false)
    expect(p.models).toHaveLength(1)
    expect(settingsOf(p, p.models[0])).toEqual(old) // 一个字段都不少
    expect(p.activeModelId).toBe(p.models[0].id)
  })

  it('**老 Key 归第一个端点**（旧数据就是"当前在用的那一个"）', () => {
    const migrated = [profileOf(legacySettings(), NOW), profile('b')]
    expect(legacyKeyOwnerId(migrated)).toBe(migrated[0].id)
  })

  it('一个端点都没有时不认领 Key（返回 null）', () => {
    expect(legacyKeyOwnerId([])).toBeNull()
  })
})

describe('迁移②：0.13.16 的"扁平档案" → 新形状（可单测、幂等）', () => {
  const flat = [
    {
      id: 'p1',
      name: 'DeepSeek-V4 Flash',
      source: 'deepseek',
      providerType: 'openai-compatible',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      temperature: 0.3,
      topP: null,
      topK: null,
      maxTokens: 8192,
      timeoutMs: 45_000,
      stream: true,
      contextWindow: 384_000,
      reasoningEffort: 'high',
      maxToolRounds: 25,
      // ⚠️ 这是**0.13.16 的老形状输入数据**，故意保留旧字段名：本用例测的就是"老档案里的
      // `supportsImages` 能不能被迁移成模态集合"。批量改名时这里被一起改成了新字段，
      // 于是迁移路径看不到旧字段、断言当场红 —— 同名字段在"输入夹具"与"输出断言"里语义相反，不能一把替换。
      supportsImages: true,
      createdAt: 1,
      updatedAt: 2
    }
  ]

  it('扁平的一条 → 端点 + 一条目录，参数全在', () => {
    const res = normalizeProfiles(flat)
    expect(res.dropped).toBe(0)
    const p = res.profiles[0]
    expect(p.id).toBe('p1')
    expect(p.name).toBe('DeepSeek-V4 Flash')
    expect(p.source).toBe('deepseek')
    expect(p.models).toHaveLength(1)
    expect(p.models[0].model).toBe('deepseek-v4-flash')
    const s = settingsOf(p, p.models[0])
    expect(s.maxTokens).toBe(8192)
    expect(s.contextWindow).toBe(384_000)
    expect(s.reasoningEffort).toBe('high')
    expect(s.maxToolRounds).toBe(25)
    expect(s.inputModalities).toContain('image')
    expect(s.temperature).toBe(0.3)
    expect(s.timeoutMs).toBe(45_000)
  })

  it('**幂等**：升级结果再读一遍完全一样（不会反复搬）', () => {
    const once = normalizeProfiles(flat).profiles
    const twice = normalizeProfiles(once).profiles
    expect(twice).toEqual(once)
  })

  it('缺 model 也缺 models 的条目 → 丢掉并计数', () => {
    const res = normalizeProfiles([{ id: 'x', providerType: 'openai-compatible', baseURL: 'https://x' }])
    expect(res.profiles).toEqual([])
    expect(res.dropped).toBe(1)
  })
})

describe('当前：三条兜底，绝不允许"没有模型可用"', () => {
  it('命中 activeId → 用它；过期 → 落第一个；没有 → null', () => {
    const list = [profile('a'), profile('b')]
    expect(activeProfile(list, 'b')?.id).toBe('b')
    expect(activeProfile(list, '已经删掉的')?.id).toBe('a')
    expect(activeProfile(list, null)?.id).toBe('a')
    expect(activeProfile([], 'a')).toBeNull()
  })

  it('**activeModelId 过期 → 落目录第一条**（端点仍可用，不会变成"没有模型"）', () => {
    const p: ModelProfile = { ...profile('a', ['m-one', 'm-two']), activeModelId: '已经删掉的条目' }
    expect(activeEntry(p)?.model).toBe('m-one')
  })

  it('目录为空 → `activeEntry` 返回 null（调用方要当成"这个端点没配模型"提示）', () => {
    const p: ModelProfile = { ...profile('a'), models: [] }
    expect(activeEntry(p)).toBeNull()
  })
})

describe('删除护栏', () => {
  it('端点：只剩一个时不许删，理由是人话', () => {
    const r = canDeleteProfile([profile('a')], 'a')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('至少')
  })

  it('端点：两个以上可以删；删不存在的会被拒', () => {
    expect(canDeleteProfile([profile('a'), profile('b')], 'a').ok).toBe(true)
    expect(canDeleteProfile([profile('a'), profile('b')], 'ghost').ok).toBe(false)
  })

  it('**模型条目：端点里只剩一条时不许删**（删空了 = 一条空连接）', () => {
    const r = canDeleteEntry(profile('a', ['only-one']), 'a-m1')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('至少要留一个模型')
  })

  it('模型条目：两条以上可以删', () => {
    expect(canDeleteEntry(profile('a', ['m1', 'm2']), 'a-m2').ok).toBe(true)
  })

  it('`removeProfile` 只去掉那一个端点', () => {
    const list = [profile('a'), profile('b'), profile('c')]
    expect(removeProfile(list, 'b').map((p) => p.id)).toEqual(['a', 'c'])
  })
})

describe('读盘容错：坏条目丢掉并计数，绝不整表崩', () => {
  it('整份不是数组 → 全丢并计数', () => {
    expect(normalizeProfiles({ nope: 1 })).toEqual({ profiles: [], dropped: 1 })
  })

  it('新形状里：缺 id / 缺 baseURL / 协议非法 / id 重复 丢掉；条目的坏数据按条丢', () => {
    const res = normalizeProfiles([
      {
        id: 'ok',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [
          { id: 'e1', model: 'm1' },
          { id: 'e2', model: '' }, // 空模型 ID → 丢
          { id: 'e1', model: 'm2' } // 重复条目 id → 丢
        ]
      },
      { id: 'ok', providerType: 'openai-compatible', baseURL: 'https://x', models: [{ id: 'e', model: 'm' }] },
      { id: '', providerType: 'openai-compatible', baseURL: 'https://x', models: [{ id: 'e', model: 'm' }] },
      { id: 'noUrl', providerType: 'openai-compatible', baseURL: '', models: [{ id: 'e', model: 'm' }] },
      { id: 'badProvider', providerType: 'whatever', baseURL: 'https://x', models: [{ id: 'e', model: 'm' }] },
      { id: 'noModels', providerType: 'openai-compatible', baseURL: 'https://x', models: [] },
      null
    ])
    expect(res.profiles.map((p) => p.id)).toEqual(['ok'])
    expect(res.profiles[0].models).toHaveLength(1)
    // 丢的是：空模型 ID + 重复条目 id + 重复端点 + 空 id + 空 url + 非法协议 + 空目录 + null = 8 条
    expect(res.dropped).toBe(8)
  })

  it('条目的高级设置坏掉 → 退化成"不覆盖"（跟随端点默认），不丢整条', () => {
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [{ id: 'e', model: 'm', settings: { temperature: 'NaN', maxTokens: 'huge' } }]
      }
    ])
    const s = res.profiles[0].models[0].settings
    expect(s?.temperature).toBeNull()
    expect(s?.maxTokens).toBe(4096)
  })

  it('★ 档名不再被洗（plan58 R6 + 用户 09-27 裁定「读盘不洗，原值保留」）', () => {
    // 这一条是**改判**：原断言是"`reasoningEffort` 不在 {low,medium,high} 里 ⇒ 洗成 default"，
    // 上面那条因此在 09-27 之前顺带塞了 `reasoningEffort:'外星'`。
    // 改判理由三条，缺一条都不足以推翻原判据：
    //   ① 官方档名**逐厂商不同**（OpenAI 有 xhigh/minimal，DeepSeek 与 Kimi/GLM 没有 medium），
    //      拿应用级词表洗档 = 替厂商下结论；
    //   ② 我们三家端点**一格都没实测过**（plan58 §丁），照别家文档洗就是拿文档值冒充实测值；
    //   ③ 洗 = 静默改掉用户填的值且无处可查。合法性改由保存时的 schema 按该模型
    //      自己声明的 `reasoning.levels` 判（见 schemas.test.ts 的白名单组）。
    // 后果链：未知档名现在会一路走到 provider ⇒ 那侧**必须**显式降级
    // （`thinkingBudgetFor` 的 undefined 兜底就是为此立的，见 providers.test.ts）。
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [{ id: 'e', model: 'm', settings: { reasoningEffort: 'xhigh' } }]
      }
    ])
    expect(res.profiles[0].models[0].settings?.reasoningEffort).toBe('xhigh')
  })

  it('档名仍做**形状**容错：空串 / 纯空白 / 非字符串一律当"没填"，不占位', () => {
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [
          { id: 'e1', model: 'm', settings: { reasoningEffort: '   ' } },
          { id: 'e2', model: 'm', settings: { reasoningEffort: 42 } },
          { id: 'e3', model: 'm', settings: { reasoningEffort: '' } }
        ]
      }
    ])
    for (const e of res.profiles[0].models) {
      // 形状坏掉 ⇒ 字段整个不出现（"跟随端点默认"），而不是存一个空串当档名
      expect(Object.keys(e.settings ?? {}), e.id).not.toContain('reasoningEffort')
    }
  })

  it('★ `reasoning` 声明必须能穿过读盘（normalizeEntry 是白名单重建，不加容错就整段丢）', () => {
    // 这条专打"字段在类型里、用户填得进去、读一次就没了"（no-dead-wiring 同族）。
    // 反向哨兵：`kind` 是四个已知值之外的 ⇒ 整个丢掉（宁可不许有，不许存半截配置）。
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [
          { id: 'e1', model: 'm', settings: { reasoning: { kind: 'effort', levels: ['low', 'high', 'low'] } } },
          { id: 'e2', model: 'm', settings: { reasoning: { kind: '外星' } } },
          { id: 'e3', model: 'm', settings: { reasoning: { kind: 'toggle', enabled: true } } }
        ]
      }
    ])
    const [e1, e2, e3] = res.profiles[0].models
    expect(e1.settings?.reasoning).toEqual({ kind: 'effort', levels: ['low', 'high'] }) // 顺带去重
    expect(e2.settings?.reasoning).toBeUndefined()
    expect(e3.settings?.reasoning).toEqual({ kind: 'toggle', enabled: true })
  })

  it('★ falsy 值必须活下来：`enabled:false` 与 `budget:0`（`if (r.enabled)` 那种写法会静默丢）', () => {
    // 09-28 独立审查指出：schema 明确允许 `enabled:false`（z.boolean().optional()）与
    // `budget:0`（z.number().int().min(0)），而容错里若写成 `if (r.enabled)` / `if (r.budget)`
    // 就会把它们**静默丢掉**。对 toggle 来说"丢 false"方向完全相反：界面按缺省渲染成**开**。
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [
          { id: 'e1', model: 'm', settings: { reasoning: { kind: 'toggle', enabled: false } } },
          { id: 'e2', model: 'm', settings: { reasoning: { kind: 'budget_tokens', budget: 0 } } }
        ]
      }
    ])
    expect(res.profiles[0].models[0].settings?.reasoning).toEqual({ kind: 'toggle', enabled: false })
    expect(res.profiles[0].models[1].settings?.reasoning).toEqual({ kind: 'budget_tokens', budget: 0 })
  })

  it('扁平老形状升级分支同样**不洗档**（那份拷贝只有文本守卫罩着，行为层此前无覆盖）', () => {
    // `normalizeProfiles` 的"0.13.16 扁平档案"分支是同一段逻辑的**第二份拷贝**。
    // 既有用例只喂词表内的 `'high'` —— 洗与不洗对它没差别，于是那半边只有 no-dead-wiring
    // 的文本扫描守着（而文本扫描有它自己的覆盖边界，见该守卫的说明）。
    const res = normalizeProfiles([
      {
        id: 'old',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        model: 'deepseek-flash',
        reasoningEffort: 'xhigh'
      }
    ])
    const entry = res.profiles[0].models[0]
    expect(entry.settings?.reasoningEffort).toBe('xhigh')
  })

  it('Q12 存量档案不动：没填 `reasoning` 的模型，有效设置逐字段不变（reasoning 键整个不存在）', () => {
    // 防"加了字段就顺手给老档案补默认"：盘上三家端点的档案都没有 reasoning，
    // 若这里凭空补一个 `kind:'none'`，出境行为虽不变，落盘却会多出一段用户没填过的东西。
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [{ id: 'e', model: 'm', settings: { reasoningEffort: 'high' } }]
      }
    ])
    const s = settingsOf(res.profiles[0], res.profiles[0].models[0])
    expect(s.reasoningEffort).toBe('high')
    expect('reasoning' in s).toBe(false)
  })

  it('★ 填了 `reasoning` 的模型，有效设置里**必须原样透传**（这条是补洞补出来的）', () => {
    // 09-27 变异自检当场露的洞：上面那条只钉住"没填的不许凭空补"，却没钉"填了的不许丢" ——
    // 把 `settingsOf` 里的透传删掉，34 条**照样全绿**。这正是 no-dead-wiring 那个形状：
    // 字段在类型里、用户填得进去、合成时没人读，于是**声明等于没写**，而没有一道闸会红。
    // 读盘容错（`normalizeReasoning`）与合成透传是**两跳**，两条都得有判据。
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [
          { id: 'e1', model: 'm', settings: { reasoningEffort: 'xhigh', reasoning: { kind: 'effort', levels: ['low', 'high', 'xhigh'] } } },
          { id: 'e2', model: 'm', settings: { reasoning: { kind: 'toggle', enabled: true } } },
          { id: 'e3', model: 'm', settings: { reasoning: { kind: 'budget_tokens', budget: 4096 } } }
        ]
      }
    ])
    const [e1, e2, e3] = res.profiles[0].models.map((e) => settingsOf(res.profiles[0], e))
    expect(e1.reasoning).toEqual({ kind: 'effort', levels: ['low', 'high', 'xhigh'] })
    expect(e1.reasoningEffort).toBe('xhigh')
    expect(e2.reasoning).toEqual({ kind: 'toggle', enabled: true })
    expect(e3.reasoning).toEqual({ kind: 'budget_tokens', budget: 4096 })
  })

  it('`activeModelId` 指向不存在的条目 → 修正成第一条', () => {
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'openai-compatible',
        baseURL: 'https://x',
        models: [{ id: 'e1', model: 'm1' }],
        activeModelId: '不存在'
      }
    ])
    expect(res.profiles[0].activeModelId).toBe('e1')
  })

  it('空数组 → 什么都不丢（别把"还没配模型"报成"数据坏了"）', () => {
    expect(normalizeProfiles([])).toEqual({ profiles: [], dropped: 0 })
  })
})

describe('findModelEntry（plan39 D-101：快速切换的精确匹配）', () => {
  it('命中当前端点优先（同名条目分布在两端时）', () => {
    const a = profile('a', ['shared', 'only-a'])
    const b = profile('b', ['shared'])
    expect(findModelEntry([b, a], 'a', 'shared')).toEqual({ profileId: 'a', entryId: 'a-m1' })
  })
  it('当前端点没有 → 跨端点命中（切端点，**绝不改名**）', () => {
    const a = profile('a', ['mine'])
    const b = profile('b', ['theirs-1', 'theirs-2'])
    expect(findModelEntry([a, b], 'a', 'theirs-2')).toEqual({ profileId: 'b', entryId: 'b-m2' })
  })
  it('哪端都没有 → null（调用方只能报错指路，没有第三条路）', () => {
    const a = profile('a', ['mine'])
    expect(findModelEntry([a], 'a', 'MINE')).toBeNull()
    expect(findModelEntry([], null, 'x')).toBeNull()
  })
})
