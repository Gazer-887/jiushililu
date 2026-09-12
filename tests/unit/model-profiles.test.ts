import { describe, expect, it } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import {
  PROFILE_NAME_MAX,
  activeProfile,
  canDeleteProfile,
  createProfile,
  legacyKeyOwnerId,
  normalizeProfiles,
  profileOf,
  removeProfile,
  settingsOf,
  type ModelProfile
} from '@shared/models'

/**
 * 模型档案（plan7 F5，提前做）—— 纯逻辑部分。
 *
 * 要盯住的三件事：
 *   ① **老数据不许丢**（迁移：单模型设置 + 那把 Key → 恰好一个档案，Key 有主）
 *   ② **不许出现"没有模型可用"**（删到最后一个要拦住；`activeId` 过期要有兜底）
 *   ③ **读盘容错**（坏条目丢掉并计数，绝不整表崩 —— 那会让人以为 Key 也跟着没了）
 */

const NOW = 1_700_000_000_000

const settings = (over: Partial<ModelSettings> = {}): ModelSettings => ({
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

const profile = (id: string, name = id): ModelProfile =>
  createProfile({ id, settings: settings({ model: name }), name, now: NOW })

describe('建档案', () => {
  it('名字为空时退回模型名（列表里不留空白行）', () => {
    const p = createProfile({ id: 'a', settings: settings({ model: 'deepseek-flash' }), now: NOW })
    expect(p.name).toBe('deepseek-flash')
  })

  it('名字超长会截断（显示名是标签，不是描述）', () => {
    const p = createProfile({ id: 'a', settings: settings(), name: 'x'.repeat(200), now: NOW })
    expect(p.name.length).toBe(PROFILE_NAME_MAX)
  })

  it('默认来源是自定义，迁移来的标 deepseek', () => {
    expect(createProfile({ id: 'a', settings: settings(), now: NOW }).source).toBe('custom')
    expect(profileOf(settings(), NOW).source).toBe('deepseek')
  })
})

describe('迁移：老的"单模型 + 一把 Key" → 一个档案，且 Key 有主', () => {
  it('老设置包成档案后，参数一个不丢', () => {
    const old = settings({ model: 'deepseek-v4-flash', contextWindow: 384_000, supportsImages: true })
    const p = profileOf(old, NOW, { name: 'DeepSeek-V4 Flash' })
    expect(settingsOf(p)).toEqual(old)
  })

  it('`settingsOf` 只摊平内核认识的字段（id/name/source/时间戳不外泄）', () => {
    const p = profile('a')
    expect(Object.keys(settingsOf(p)).sort()).toEqual(Object.keys(settings()).sort())
  })

  it('**老 Key 归第一个档案**（旧数据就是"当前在用的那一个模型"）', () => {
    const migrated = [profileOf(settings(), NOW), profile('b')]
    expect(legacyKeyOwnerId(migrated)).toBe(migrated[0].id)
  })

  it('一个档案都没有时不认领 Key（返回 null，调用方据此不写 Key）', () => {
    expect(legacyKeyOwnerId([])).toBeNull()
  })
})

describe('当前档案：三条兜底，绝不允许"没有模型可用"', () => {
  it('命中 activeId → 用它', () => {
    const list = [profile('a'), profile('b')]
    expect(activeProfile(list, 'b')?.id).toBe('b')
  })

  it('**activeId 过期（档案被删）→ 落到第一个**，而不是变成 null', () => {
    const list = [profile('a'), profile('b')]
    expect(activeProfile(list, '已经删掉的id')?.id).toBe('a')
  })

  it('activeId 为 null → 第一个', () => {
    expect(activeProfile([profile('a')], null)?.id).toBe('a')
  })

  it('**列表为空 → null**（调用方要当成"还没配模型"来提示，而不是崩）', () => {
    expect(activeProfile([], 'a')).toBeNull()
  })
})

describe('删除：至少要留一个', () => {
  it('只剩一个时不许删，且理由是人话', () => {
    const one = [profile('a')]
    const r = canDeleteProfile(one, 'a')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('至少')
  })

  it('两个以上可以删', () => {
    expect(canDeleteProfile([profile('a'), profile('b')], 'a').ok).toBe(true)
  })

  it('删一个不存在的 → 拒绝并说明"可能已经被删过了"', () => {
    const r = canDeleteProfile([profile('a'), profile('b')], 'ghost')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不存在')
  })

  it('`removeProfile` 只去掉那一个（别的原样保留）', () => {
    const list = [profile('a'), profile('b'), profile('c')]
    expect(removeProfile(list, 'b').map((p) => p.id)).toEqual(['a', 'c'])
  })
})

describe('读盘容错：坏条目丢掉并计数，绝不整表崩', () => {
  it('整份不是数组 → 全丢并计数', () => {
    expect(normalizeProfiles({ nope: 1 })).toEqual({ profiles: [], dropped: 1 })
  })

  it('缺 id / 缺 baseURL / 缺模型名 / 协议非法 / id 重复 → 丢掉，好的留下', () => {
    const res = normalizeProfiles([
      { id: 'ok', providerType: 'openai-compatible', baseURL: 'https://x', model: 'm', createdAt: 1 },
      { id: 'ok', providerType: 'openai-compatible', baseURL: 'https://x', model: '重复id', createdAt: 1 },
      { id: '', providerType: 'openai-compatible', baseURL: 'https://x', model: 'm', createdAt: 1 },
      { id: 'noUrl', providerType: 'openai-compatible', baseURL: '', model: 'm', createdAt: 1 },
      { id: 'noModel', providerType: 'openai-compatible', baseURL: 'https://x', model: '', createdAt: 1 },
      { id: 'badProvider', providerType: 'whatever', baseURL: 'https://x', model: 'm', createdAt: 1 },
      null,
      42
    ])
    expect(res.profiles.map((p) => p.id)).toEqual(['ok'])
    expect(res.dropped).toBe(7)
  })

  it('采样参数坏掉 → 退化成 null（"不发送该参数"是合法状态，不该丢整条）', () => {
    const res = normalizeProfiles([
      {
        id: 'a',
        providerType: 'anthropic',
        baseURL: 'https://x',
        model: 'm',
        temperature: 'NaN',
        topP: Number.POSITIVE_INFINITY
      }
    ])
    expect(res.profiles[0].temperature).toBeNull()
    expect(res.profiles[0].topP).toBeNull()
  })

  it('数值字段坏掉 → 用默认值补齐（宁可参数保守，也别丢用户配好的模型）', () => {
    const res = normalizeProfiles([
      { id: 'a', providerType: 'openai-compatible', baseURL: 'https://x', model: 'm', maxTokens: 'huge', timeoutMs: null }
    ])
    expect(res.profiles[0].maxTokens).toBe(4096)
    expect(res.profiles[0].timeoutMs).toBe(60_000)
  })

  it('名字缺失 → 退回模型名；来源不认识 → 当成自定义', () => {
    const res = normalizeProfiles([
      { id: 'a', providerType: 'openai-compatible', baseURL: 'https://x', model: 'my-model', source: '外星' }
    ])
    expect(res.profiles[0].name).toBe('my-model')
    expect(res.profiles[0].source).toBe('custom')
  })

  it('`stream` 缺省视为 true（历史数据没这个字段）', () => {
    const res = normalizeProfiles([{ id: 'a', providerType: 'openai-compatible', baseURL: 'https://x', model: 'm' }])
    expect(res.profiles[0].stream).toBe(true)
  })

  it('空数组 → 什么都不丢（别把"还没配模型"报成"数据坏了"）', () => {
    expect(normalizeProfiles([])).toEqual({ profiles: [], dropped: 0 })
  })
})
