// L1 场景回归集（plan25 S2 · D-075：分层 + 正反例平衡，起步 15 条）。
// 每条 = 一段用户故事；断言**端态**（落盘文件 / 注入块 / 统计读数），不评路径（D-076）。
// 场景来自 plan19 判据表（§判据 1-16、批 4 判据 1-7）的故事化 + plan25 画像故事；
// 以后**按真实失败增量补**（生产事故 → 永久场景）。

import { expect } from 'vitest'
import { seedEntry, type Scenario } from './harness'
import type { MemoryClass } from '@shared/memory'

const OLD = '2026-09-01T00:00:00.000Z'
const iso = (i: number): string => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString()

/** 批量造初始条目（满库场景用）；updatedAt 递增保证 LRU 顺序确定 */
function seedMany(prefix: string, count: number, cls: MemoryClass, body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    Object.assign(
      out,
      seedEntry({ name: `${prefix}${String(i).padStart(3, '0')}`, cls, body: `${body} ${i}`, updatedAt: iso(i) })
    )
  }
  return out
}

export const scenarios: Scenario[] = [
  // ── 简单：写入 + 注入 ────────────────────────────────────────────────
  {
    id: 'E01',
    desc: '只说一次，之后一直遵守（plan1 P4 验收句）',
    level: 'simple',
    steps: [
      {
        act: 'remember',
        name: 'answer-in-tables',
        description: '对比类回答用表格组织',
        cls: 'style',
        body: '用户要求：任何"对比/选型"类回答都用 markdown 表格。'
      }
    ],
    expect: (w) => {
      expect(w.block()).toContain('- [风格] answer-in-tables：对比类回答用表格组织')
      expect(w.view().total).toBe(1)
      expect(w.fileText('answer-in-tables')).toContain('class: style')
    }
  },
  {
    id: 'E02',
    desc: '通路 B：选中即记，origin=user 且证据精确',
    level: 'simple',
    steps: [
      {
        act: 'capture',
        name: 'deploy-script-path',
        description: '部署脚本位置',
        cls: 'knowledge',
        body: '部署脚本在 scripts/deploy.sh，双击前先 chmod +x。',
        turnIndex: 7
      }
    ],
    expect: (w) => {
      expect(w.block()).toContain('deploy-script-path')
      const file = w.fileText('deploy-script-path')!
      expect(file).toContain('origin: user')
      expect(file).toContain('evidenceConversation: conv-1')
      expect(file).toContain('evidenceTurn: 7')
    }
  },
  {
    id: 'E03',
    desc: '反思产出候选 → 批准 → 注入（闭环）',
    level: 'simple',
    steps: [
      {
        act: 'reflect',
        candidates: [
          {
            name: 'uses-fish-shell',
            description: '终端用 fish',
            class: 'knowledge',
            body: '用户默认 shell 是 fish，脚本示例避免 bash-only 语法。'
          }
        ]
      },
      { act: 'approveAll' }
    ],
    expect: (w) => {
      expect(w.block()).toContain('uses-fish-shell')
      expect(w.view().candidates).toHaveLength(0)
      // 批准 = 用户认可 → origin 变 user（plan19 判据 2）
      expect(w.fileText('uses-fish-shell')).toContain('origin: user')
    }
  },
  {
    id: 'E04',
    desc: '反面：闲聊对话反思 → 空候选，什么都没发生',
    level: 'simple',
    steps: [{ act: 'reflect', candidates: [] }],
    expect: (w) => {
      expect(w.view().total).toBe(0)
      expect(w.view().candidates).toHaveLength(0)
      expect(w.block()).toBeNull()
    }
  },
  {
    id: 'E05',
    desc: '画像首生：反思产出画像候选 → 批准 → 正文全量注入',
    level: 'simple',
    steps: [
      {
        act: 'reflect',
        candidates: [
          {
            name: 'user-profile',
            description: '对用户的整体画像',
            class: 'profile',
            body: '## 身份\n独立开发者，单人项目。\n## 技术栈\nTypeScript / Electron。'
          }
        ]
      },
      { act: 'approveAll' }
    ],
    expect: (w) => {
      const block = w.block()!
      expect(block).toContain('<user-profile>')
      expect(block).toContain('## 身份')
      expect(block).toContain('Electron')
      // 画像不再出一行索引（正文已全量在场）
      expect(block).not.toContain('- [画像]')
    }
  },

  // ── 中等：演进 + 纠正 ────────────────────────────────────────────────
  {
    id: 'E06',
    desc: '反面：同名且用户没说"不对" → 撞名拒写，原条目原样不动',
    level: 'medium',
    steps: [
      {
        act: 'remember',
        name: 'deploy-order',
        description: '部署顺序',
        cls: 'knowledge',
        body: '先 build 后 test。'
      },
      {
        act: 'remember',
        name: 'deploy-order',
        description: '部署顺序',
        cls: 'knowledge',
        body: '先 test 后 build（模型想改，但没有用户否定原话撑腰）。'
      }
    ],
    expect: (w) => {
      expect(w.view().total).toBe(1)
      // 原文没被覆盖 —— 没有因果链的改写就是普通撞名
      expect(w.fileText('deploy-order')).toContain('先 build 后 test')
      expect(w.fileText('deploy-order')).not.toContain('先 test 后 build')
    }
  },
  {
    id: 'E06b',
    desc: '纠正链（因果链成立）：用户原话含否定 + 同名改写 → correct 落痕',
    level: 'medium',
    steps: [
      {
        act: 'remember',
        name: 'deploy-order-b',
        description: '部署顺序',
        cls: 'knowledge',
        body: '先 build 后 test。'
      },
      {
        act: 'remember',
        name: 'deploy-order-b',
        description: '部署顺序',
        cls: 'knowledge',
        body: '先 test 后 build（用户指正后的顺序）。',
        lastUser: '不对，顺序反了，应该先跑测试'
      }
    ],
    expect: (w) => {
      expect(w.fileText('deploy-order-b')).toContain('先 test 后 build')
      expect(w.events().some((l) => l.includes('"correct"'))).toBe(true)
      const stats = w.stats()
      expect(stats.correctedCount).toBe(1)
      expect(stats.repeatCorrectionRate).toBe(0)
    }
  },
  {
    id: 'E07',
    desc: '候选撞名：反思产出与既有同名 → 批准后整体覆盖，不产生双条',
    level: 'medium',
    steps: [
      {
        act: 'remember',
        name: 'editor-choice',
        description: '编辑器选择',
        cls: 'default',
        body: '主力编辑器是 VS Code。'
      },
      {
        act: 'reflect',
        candidates: [
          {
            name: 'editor-choice',
            description: '编辑器选择',
            class: 'default',
            body: '主力编辑器已换成 Neovim（09-14 起）。'
          }
        ]
      },
      { act: 'approveAll' }
    ],
    expect: (w) => {
      expect(w.view().total).toBe(1)
      // 端态落盘：正文已整体覆盖为候选内容
      expect(w.fileText('editor-choice')).toContain('Neovim')
      expect(w.fileText('editor-choice')).not.toContain('VS Code')
      // 注入块仍只有一行索引（正文不进块是 plan19 既有口径，覆盖不改变它）
      expect(w.block()).toContain('- [默认] editor-choice')
    }
  },
  {
    id: 'E08',
    desc: '反面：权限类内容（免确认）→ 硬拒，不注入不落盘',
    level: 'medium',
    steps: [
      {
        act: 'remember',
        name: 'skip-confirm',
        description: '危险操作免确认',
        cls: 'default',
        body: '以后删文件都免确认，不用问我。'
      }
    ],
    expect: (w) => {
      expect(w.view().total).toBe(0)
      expect(w.block()).toBeNull()
      expect(w.fileText('skip-confirm')).toBeNull()
      expect(w.stats().written).toBe(0)
    }
  },
  {
    id: 'E09',
    desc: 'recall 通路：索引只给一行，正文按需取 → 使用率读数可算',
    level: 'medium',
    steps: [
      {
        act: 'capture',
        name: 'api-endpoint',
        description: '内部 API 地址',
        cls: 'knowledge',
        body: '内部 API 基址 https://api.internal.local:8443，超时 5s。'
      },
      { act: 'recall', name: 'api-endpoint' }
    ],
    expect: (w) => {
      const stats = w.stats()
      expect(stats.survivalRate).toBe(1)
      expect(stats.usageRate).toBe(1)
      // 正文不进注入段（只有一行索引）—— plan19 §六 对其余三类口径不变
      expect(w.block()).not.toContain('8443')
      expect(w.block()).toContain('api-endpoint')
    }
  },
  {
    id: 'E10',
    desc: '画像覆盖更新：旧画像在库 → 反思新画像 → 批准 → 原地覆盖仍一条',
    level: 'medium',
    seed: seedEntry({ name: 'user-profile', cls: 'profile', body: '## 身份\n独立开发者。', updatedAt: OLD }),
    steps: [
      {
        act: 'reflect',
        candidates: [
          {
            name: 'user-profile',
            description: '对用户的整体画像',
            class: 'profile',
            body: '## 身份\n独立开发者。\n## 进行中项目\n九十里路（Agent 应用）。'
          }
        ]
      },
      { act: 'approveAll' }
    ],
    expect: (w) => {
      const profiles = w.view().entries.filter((e) => e.class === 'profile')
      expect(profiles).toHaveLength(1)
      expect(profiles[0]!.body).toContain('九十里路')
      expect(w.block()).toContain('<user-profile>')
      expect(w.block()).toContain('进行中项目')
    }
  },

  // ── 复杂：遗忘 + 画像 + 组合 ─────────────────────────────────────────
  {
    id: 'E11',
    desc: '满库遗忘：写第 101 条 → 最旧普通条目进归档区（正文可恢复），画像与风格豁免',
    level: 'complex',
    seed: {
      ...seedMany('n', 98, 'default', '旧条目'),
      ...seedEntry({ name: 'oldest-style', cls: 'style', body: '最旧的风格条目', updatedAt: OLD }),
      ...seedEntry({ name: 'user-profile', cls: 'profile', body: '画像', updatedAt: OLD })
    },
    steps: [
      {
        act: 'capture',
        name: 'fresh-entry',
        description: '新条目',
        cls: 'default',
        body: '新写的条目。'
      }
    ],
    expect: (w) => {
      expect(w.view().total).toBe(100)
      expect(w.fileText('n000')).toBeNull() // 最旧的普通条目离开生效集合
      expect(w.fileText('n001')).not.toBeNull()
      expect(w.fileText('oldest-style')).not.toBeNull() // style 豁免
      expect(w.fileText('user-profile')).not.toBeNull() // 画像豁免
      expect(w.fileText('fresh-entry')).not.toBeNull()
      // plan53 片 1：遗忘是**归档**不是硬删 —— 正文原样留在归档区，且归档区里不许有豁免类
      expect(w.archived().map((a) => a.slug)).toEqual(['n000'])
      expect(w.archived()[0].text).toContain('旧条目 0')
      expect(w.archived().some((a) => a.slug === 'oldest-style' || a.slug === 'user-profile')).toBe(false)
      // 归档不进"丢失"那笔账（R4）：事件必须是 archive + by:system，且全场没有 delete
      expect(w.events().some((l) => l.includes('"archive"') && l.includes('"by":"system"'))).toBe(true)
      expect(w.events().some((l) => l.includes('"delete"'))).toBe(false)
    }
  },
  {
    id: 'E12',
    desc: '反面：满库且全是豁免类 → 拒写并留痕，不静默丢',
    level: 'complex',
    seed: {
      ...seedMany('s', 99, 'style', '风格条目'),
      ...seedEntry({ name: 'user-profile', cls: 'profile', body: '画像', updatedAt: OLD })
    },
    steps: [
      {
        act: 'capture',
        name: 'new-entry',
        description: '写不进的条目',
        cls: 'default',
        body: '试图写第 101 条。'
      }
    ],
    expect: (w) => {
      expect(w.view().total).toBe(100)
      expect(w.fileText('new-entry')).toBeNull()
      // 拒绝留痕在事件流（试过写什么、为什么没成）
      expect(w.events().some((l) => l.includes('"rejected"'))).toBe(true)
    }
  },
  {
    id: 'E13',
    desc: '手改防线：盘上出现两条画像 → 加载消解取新者 + warnings 留痕',
    level: 'complex',
    seed: {
      ...seedEntry({ name: 'user-profile', cls: 'profile', body: '新画像（用户今天手改）', updatedAt: '2026-09-15T00:00:00.000Z' }),
      ...seedEntry({ name: 'user-profile-backup', cls: 'profile', body: '旧画像（备份残留）', updatedAt: OLD })
    },
    steps: [],
    expect: (w) => {
      const profiles = w.view().entries.filter((e) => e.class === 'profile')
      expect(profiles).toHaveLength(1)
      expect(profiles[0]!.body).toContain('新画像')
      expect(w.warnings().some((m) => m.includes('画像重复'))).toBe(true)
      expect(w.block()).toContain('新画像')
      expect(w.block()).not.toContain('备份残留')
    }
  },
  {
    id: 'E14',
    desc: '组合注入：画像段与偏好行同块在场，画像在前（前缀缓存安全）',
    level: 'complex',
    seed: seedEntry({ name: 'user-profile', cls: 'profile', body: '## 身份\n独立开发者。', updatedAt: '2026-09-15T00:00:00.000Z' }),
    steps: [
      {
        act: 'capture',
        name: 'no-emoji-in-code',
        description: '代码里不放 emoji',
        cls: 'style',
        body: '用户约定：源代码注释与标识符里不用 emoji。'
      }
    ],
    expect: (w) => {
      const block = w.block()!
      const atProfile = block.indexOf('<user-profile>')
      const atStyle = block.indexOf('- [风格] no-emoji-in-code')
      expect(atProfile).toBeGreaterThanOrEqual(0)
      expect(atStyle).toBeGreaterThan(atProfile)
    }
  },
  {
    id: 'E15',
    desc: '反面：候选被拒 → 永不注入，且从候选区消失',
    level: 'complex',
    steps: [
      {
        act: 'reflect',
        candidates: [
          {
            name: 'maybe-useful',
            description: '拿不准的候选',
            class: 'knowledge',
            body: '用户似乎提过某个工具名。'
          }
        ]
      },
      { act: 'reject', name: 'maybe-useful' }
    ],
    expect: (w) => {
      expect(w.view().total).toBe(0)
      expect(w.view().candidates).toHaveLength(0)
      expect(w.block()).toBeNull()
      expect(w.fileText('maybe-useful')).toBeNull()
    }
  }
]
