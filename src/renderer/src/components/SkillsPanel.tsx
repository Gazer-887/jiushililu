import { useEffect, useState } from 'react'
import type { SkillInfo } from '@shared/ipc'

// 技能分区（plan22 S8 → plan34 S2a）：**开关 + 内置项「›」下拉双语简介**。
// D-103：技能只有两层（内置 < 用户），无项目级；隔离靠**开关**（项目内选择启用集），不靠分层。
// 写路径（创建 / 导入 / 删除）归 S2b —— 本片先交付「看得懂（下拉简介）+ 关得住（真禁用）」。
// 残留清理（用户拍板 §三-1）：开关名单里已不存在的技能 = 死条目，进面板时静默清掉 ——
// 否则迟早出现"列表里有个东西点不动"的怪 bug。

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  builtin: '内置',
  user: '自定义'
}

export default function SkillsPanel(): JSX.Element {
  const [items, setItems] = useState<SkillInfo[] | null>(null)
  const [disabled, setDisabled] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  /** 被静默清掉的死条目数（可见性：静默不等于不说，提一句让用户知道发生了什么） */
  const [ghost, setGhost] = useState<number>(0)

  const refresh = (): void => {
    void window.api.listSkills().then((list) => {
      setItems(list)
      void window.api.getSkillsDisabled().then((names) => {
        // 残留清理：开关名单 ∩ 现存技能。名单里的死名字静默写回（本片数据层已保证幽灵名字无害）
        const alive = new Set(list.map((s) => s.name))
        const live = names.filter((n) => alive.has(n))
        setDisabled(live)
        if (live.length !== names.length) {
          setGhost(names.length - live.length)
          void window.api.setSkillsDisabled(live)
        } else {
          setGhost(0)
        }
      })
    })
  }

  useEffect(() => {
    refresh()
  }, [])

  const toggle = (name: string): void => {
    const next = disabled.includes(name) ? disabled.filter((n) => n !== name) : [...disabled, name]
    setDisabled(next)
    // 立即生效（S1）：下一轮装配即按新名单 —— 无需重启，也无需确认（关错了再点开就行）
    void window.api.setSkillsDisabled(next)
  }

  /** 展开简介按语言取：i18n（G3）未就绪 → zh 优先，en 兜底，最后回落到原 description */
  const briefOf = (s: SkillInfo): string => s.descriptionZh ?? s.descriptionEn ?? s.description

  const builtin = (items ?? []).filter((s) => s.source === 'builtin')
  const custom = (items ?? []).filter((s) => s.source === 'user')

  const row = (s: SkillInfo): JSX.Element => {
    const off = disabled.includes(s.name)
    const isBuiltin = s.source === 'builtin'
    const expanded = open === s.name
    return (
      <li key={s.name} className={`skills-item ${off ? 'skills-item-off' : ''}`}>
        <div className="skills-item-head">
          {/* 「›」下拉**只给内置项**（用户 10:29 拍板）：我们塞的就必须自己讲清楚；自定义项用户自己负责 */}
          {isBuiltin ? (
            <button
              className="skills-item-fold"
              title={expanded ? '收起简介' : '这是干嘛的？'}
              aria-label={expanded ? '收起简介' : '展开简介'}
              onClick={() => setOpen(expanded ? null : s.name)}
            >
              {expanded ? '⌄' : '›'}
            </button>
          ) : null}
          <span className="skills-item-name">{s.name}</span>
          <span className="skills-item-source">{SOURCE_LABEL[s.source] ?? s.source}</span>
          {s.overridden ? <span className="skills-item-overridden">已被同名更高层技能覆盖，未生效</span> : null}
          <label className="skills-item-switch" title={off ? '已关闭：模型看不到这个技能' : '开启中：正常注入'}>
            <input type="checkbox" checked={!off} onChange={() => toggle(s.name)} />
            <span>{off ? '已关' : '开启'}</span>
          </label>
        </div>
        {isBuiltin && expanded ? <p className="skills-item-brief">{briefOf(s)}</p> : null}
      </li>
    )
  }

  return (
    <div className="skills-panel">
      <p className="skills-intro">
        技能是<strong>人写的流程知识包</strong>：模型按需加载后注入当前对话，按既定步骤做事。
        与「子 Agent」（独立上下文的<strong>角色</strong>）、「Playbook」（项目使用中<strong>自动沉淀</strong>的经验册）互补。
        开关是<strong>真关</strong>：关闭后模型确实看不到这个技能（不是只藏界面）；下一轮对话即生效。
        自定义技能：把 <code>.md</code> 文件放进应用数据目录的 <code>skills/</code> 子目录即可生效（写入表单后续版本）。
      </p>
      {ghost > 0 ? <p className="skills-ghost">已清理 {ghost} 条失效的开关记录（对应技能已不存在）。</p> : null}
      {items === null ? (
        <p className="skills-loading">加载中…</p>
      ) : (
        <>
          <h4 className="skills-group-title">内置技能（随软件分发）</h4>
          {builtin.length === 0 ? (
            <p className="skills-empty">暂无内置技能。</p>
          ) : (
            <ul className="skills-list">{builtin.map(row)}</ul>
          )}
          <h4 className="skills-group-title">自定义技能</h4>
          {custom.length === 0 ? (
            <p className="skills-empty">暂无自定义技能。</p>
          ) : (
            <ul className="skills-list">{custom.map(row)}</ul>
          )}
        </>
      )}
    </div>
  )
}
