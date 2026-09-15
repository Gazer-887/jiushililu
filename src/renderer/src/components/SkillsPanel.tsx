import { useEffect, useState } from 'react'
import type { SkillInfo } from '@shared/ipc'

// 技能分区（plan22 S8）：**只读列表** —— 本期技能是人写的流程知识文件
// （内置随包 resources/skills + 用户层 userData/skills），无 UI 编辑路径（写入功能后续版本）。
// 页首三行说明划清三兄弟的边界：技能 = 流程知识（注入当前对话）≠ 子 Agent（角色，独立上下文）≠ Playbook（项目使用中自沉淀）。

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  builtin: '内置',
  user: '自定义',
  project: '项目'
}

export default function SkillsPanel(): JSX.Element {
  const [items, setItems] = useState<SkillInfo[] | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.listSkills().then((list) => {
      if (alive) setItems(list)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="skills-panel">
      <p className="skills-intro">
        技能是<strong>人写的流程知识包</strong>：模型按需加载后注入当前对话，按既定步骤做事。
        与「子 Agent」（独立上下文的<strong>角色</strong>）、「Playbook」（项目使用中<strong>自动沉淀</strong>的经验册）互补。
        自定义技能：把 <code>.md</code> 文件放进应用数据目录的 <code>skills/</code> 子目录即可生效。
      </p>
      {items === null ? (
        <p className="skills-loading">加载中…</p>
      ) : items.length === 0 ? (
        <p className="skills-empty">尚无任何技能。</p>
      ) : (
        <ul className="skills-list">
          {items.map((s) => (
            <li key={`${s.source}/${s.name}`} className="skills-item">
              <div className="skills-item-head">
                <span className="skills-item-name">{s.name}</span>
                <span className="skills-item-source">{SOURCE_LABEL[s.source] ?? s.source}</span>
                {s.overridden ? <span className="skills-item-overridden">已被同名更高层技能覆盖，未生效</span> : null}
              </div>
              <p className="skills-item-desc">{s.description}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
