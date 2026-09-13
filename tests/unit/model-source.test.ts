import { describe, expect, it } from 'vitest'
import { sourceLabel, sourceOfBaseURL } from '@shared/models'

/**
 * 来源标签（plan7 F5.1）：**从 baseURL 推**，不存字段 —— 品牌只是地址的函数，存下来必然过期
 * （旧数据曾把用户自加的 agnes 端点也标成"深度求索"）。
 * 认不出来一律算自定义：宁可不标，也不标错。
 */

describe('来源：从地址推', () => {
  it('地址里有 deepseek（大小写无关）→ 深度求索', () => {
    expect(sourceOfBaseURL('https://api.deepseek.com')).toBe('deepseek')
    expect(sourceOfBaseURL('https://API.DeepSeek.com/v1')).toBe('deepseek')
  })

  it('别的地址一律算自定义 —— **宁可不标品牌，也不标错品牌**', () => {
    expect(sourceOfBaseURL('https://apihub.agnes-ai.cn/v1')).toBe('custom')
    expect(sourceOfBaseURL('http://localhost:11434/v1')).toBe('custom')
    expect(sourceOfBaseURL('')).toBe('custom')
  })

  it('标签文案只在这一处定义（界面各处不再各写一遍三元表达式）', () => {
    expect(sourceLabel('deepseek')).toBe('深度求索')
    expect(sourceLabel('custom')).toBe('自定义')
  })
})
