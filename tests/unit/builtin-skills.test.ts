// plan34 S3：内置技能守门 —— 随包分发的技能必须全部能解析 + 带中文简介（「›」下拉展示用）。
// 这是准入标准的自动化：以后往 resources/skills/ 加任何文件，这条测试都会先替用户把一道关。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSkillDefinition } from '@main/skills/loader'

const BUILTIN_DIR = join(process.cwd(), 'resources/skills')

function builtinFiles(): string[] {
  return readdirSync(BUILTIN_DIR).filter((f) => f.toLowerCase().endsWith('.md'))
}

describe('内置技能守门（plan34 S3 准入标准）', () => {
  it('每个内置技能都能被 loader 解析（零格式 / 零签名 / 零本项目事实的底线：语法先合法）', () => {
    const files = builtinFiles()
    expect(files.length).toBeGreaterThanOrEqual(9) // S3 交付 9 个；只增不减
    for (const f of files) {
      const raw = readFileSync(join(BUILTIN_DIR, f), 'utf8')
      expect(() => parseSkillDefinition(raw, 'builtin', f, `builtin/${f}`), `${f} 解析失败`).not.toThrow()
    }
  })

  it('★ 每个内置技能都带 description_zh（「›」下拉给人的简介；用户 10:29/10:33 拍板）', () => {
    for (const f of builtinFiles()) {
      const raw = readFileSync(join(BUILTIN_DIR, f), 'utf8')
      expect(raw, `${f} 缺 description_zh —— 英文名技能没有中文简介，用户不知道它是干嘛的`).toContain('description_zh:')
    }
  })

  it('每个内置技能带 description_en（双语字段成对；i18n G3 就绪后即插即用）', () => {
    for (const f of builtinFiles()) {
      const raw = readFileSync(join(BUILTIN_DIR, f), 'utf8')
      expect(raw, `${f} 缺 description_en`).toContain('description_en:')
    }
  })

  it('准入红线：不得携带本机签名约定（write-commit-message 事故的回归测试）', () => {
    for (const f of builtinFiles()) {
      const raw = readFileSync(join(BUILTIN_DIR, f), 'utf8')
      expect(raw, `${f} 含 Co-Authored-By —— 内置技能不得预置任何签名/署名约定（D-093）`).not.toContain('Co-Authored-By')
      expect(raw, `${f} 含 noreply@local —— 内置技能不得携带本机邮箱`).not.toContain('noreply@local')
    }
  })
})
