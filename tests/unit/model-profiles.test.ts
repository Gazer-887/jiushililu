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
  legacyKeyOwnerId,
  makeEntry,
  normalizeProfiles,
  profileOf,
  removeProfile,
  settingsOf,
  type ModelProfile
} from '@shared/models'

/**
 * 模型档案（plan7 F5 / F5.1：**端点 + 模型目录**）—— 纯逻辑部分。
 *
 * 要盯住的四件事：
 *   ① **老数据不许丢**（两种历史形状都要能读进来，参数一个不少）
 *   ② **不许出现"没有模型可用"**（端点空 / 目录空 / activeModelId 过期，全都要兜住）
 *   ③ **有效设置 = 端点默认 ⊕ 模型覆盖**（只存改过的字段，改了端点默认所有模型跟着变）
 *   ④ **读盘容错**（坏条目按条丢掉并计数，绝不整表崩 —— 那会让人以为 Key 也跟着没了）
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
  supportsImages: false,
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
    const entry = { ...p.models[0], settings: { maxTokens: 8192, supportsImages: true } }
    const s = settingsOf(p, entry)
    expect(s.maxTokens).toBe(8192) // 覆盖了
    expect(s.supportsImages).toBe(true)
    expect(s.contextWindow).toBe(131072) // 没写 → 端点默认
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
      supportsImages: true,
      temperature: 0.7,
      timeoutMs: 90_000,
      stream: false
    })
    const p = profileOf(old, NOW, { name: 'DeepSeek-V4 Flash' })
    // 连接级
    expect(p.providerType).toBe(old.providerType)
    expect(p.baseURL).toBe(old.baseURL)
    expect(p.timeoutMs).toBe(90_000)
    expect(p.stream).toBe(false)
    // 模型级
    expect(p.models).toHaveLength(1)
    expect(settingsOf(p, p.models[0])).toEqual(old) // ★ 一个字段都不少
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
    expect(s.supportsImages).toBe(true)
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
        models: [{ id: 'e', model: 'm', settings: { temperature: 'NaN', maxTokens: 'huge', reasoningEffort: '外星' } }]
      }
    ])
    const s = res.profiles[0].models[0].settings
    expect(s?.temperature).toBeNull()
    expect(s?.maxTokens).toBe(4096)
    expect(s?.reasoningEffort).toBe('default')
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
