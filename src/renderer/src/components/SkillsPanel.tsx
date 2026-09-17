import { useEffect, useState } from 'react'
import type { SkillInfo } from '@shared/ipc'

// 技能分区（plan22 S8 → plan34 S2a/S2b）：开关 + 内置项「›」下拉双语简介 + **写路径**（新建 / 导入 / 删除）。
// D-103：技能只有两层（内置 < 用户），无项目级；隔离靠**开关**，不靠分层。
// 写路径只落**用户层**（内置随包不可写）；删除走回收站；内置不可删 —— 正确动作是开关关闭。
// 残留清理（用户拍板 §三-1）：开关名单里已不存在的技能 = 死条目，进面板时静默清掉。

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  builtin: '内置',
  user: '自定义'
}

interface Draft {
  name: string
  description: string
  descriptionZh: string
  descriptionEn: string
  version: string
  body: string
}

const EMPTY_DRAFT: Draft = { name: '', description: '', descriptionZh: '', descriptionEn: '', version: '', body: '' }

/** 导入解析：与 main/skills/loader 的 frontmatter 解析同一套规则（简化版 —— 只取值，不校验；校验在保存侧） */
function parseImported(raw: string, fileName: string): Draft {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const fm: Record<string, string> = {}
  let body = raw
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim())
      if (kv) fm[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
    }
    body = m[2]
  }
  const name = fileName.replace(/\.md$/i, '')
  return {
    name: /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : '',
    description: fm['description'] ?? '',
    descriptionZh: fm['description_zh'] ?? '',
    descriptionEn: fm['description_en'] ?? '',
    version: fm['version'] ?? '',
    body: body.trim()
  }
}

export default function SkillsPanel(): JSX.Element {
  const [items, setItems] = useState<SkillInfo[] | null>(null)
  const [disabled, setDisabled] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [ghost, setGhost] = useState<number>(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = (): void => {
    void window.api.listSkills().then((list) => {
      setItems(list)
      void window.api.getSkillsDisabled().then((names) => {
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
    // 写后广播（设置窗保存 → 本窗及主窗的技能列表都刷新）
    return window.api.onSkillsChanged(refresh)
  }, [])

  const toggle = (name: string): void => {
    const next = disabled.includes(name) ? disabled.filter((n) => n !== name) : [...disabled, name]
    setDisabled(next)
    void window.api.setSkillsDisabled(next)
  }

  const del = async (name: string): Promise<void> => {
    const r = await window.api.skillDelete(name)
    if (!r.ok) setNotice({ ok: false, text: r.reason })
    // 成功的反馈交给 onSkillsChanged → 列表刷新
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    const r = await window.api.skillSave({
      name: draft.name,
      description: draft.description,
      ...(draft.descriptionZh ? { descriptionZh: draft.descriptionZh } : {}),
      ...(draft.descriptionEn ? { descriptionEn: draft.descriptionEn } : {}),
      ...(draft.version ? { version: draft.version } : {}),
      body: draft.body
    })
    if (r.ok) {
      setDraft(null)
      setNotice({ ok: true, text: '已保存到自定义技能' })
    } else {
      setNotice({ ok: false, text: r.reason })
    }
  }

  const importFile = (file: File): void => {
    const reader = new FileReader()
    reader.onload = (): void => {
      setDraft(parseImported(String(reader.result ?? ''), file.name))
    }
    reader.readAsText(file)
  }

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
          {/* 删除**只给自定义项**：内置随包不可删（删了升级会回来），正确动作是开关关闭 */}
          {s.source === 'user' ? (
            <button className="skills-item-del" title="删除（进回收站，可恢复）" onClick={() => void del(s.name)}>
              删除
            </button>
          ) : null}
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
        开关是<strong>真关</strong>：关闭后模型确实看不到这个技能；下一轮对话即生效。
      </p>
      {ghost > 0 ? <p className="skills-ghost">已清理 {ghost} 条失效的开关记录（对应技能已不存在）。</p> : null}
      {notice ? <p className={notice.ok ? 'skills-notice-ok' : 'skills-notice-bad'}>{notice.text}</p> : null}

      {draft === null ? (
        <div className="skills-actions">
          <button className="skills-btn" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            新建技能
          </button>
          <label className="skills-btn" title="读取本地 .md 文件，解析后填入下方表单，确认再保存">
            导入 .md…
            <input
              type="file"
              accept=".md,text/markdown"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) importFile(f)
                e.currentTarget.value = ''
              }}
            />
          </label>
        </div>
      ) : (
        <div className="skills-form">
          <label className="skills-field">
            <span>名称（小写字母/数字/-，即文件名）</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="skills-field">
            <span>description（模型按它决定何时用这个技能）</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <label className="skills-field">
            <span>简介（中文，给人看 —— 设置页「›」展开显示；可留空）</span>
            <input value={draft.descriptionZh} onChange={(e) => setDraft({ ...draft, descriptionZh: e.target.value })} />
          </label>
          <label className="skills-field">
            <span>简介（英文，可留空）</span>
            <input value={draft.descriptionEn} onChange={(e) => setDraft({ ...draft, descriptionEn: e.target.value })} />
          </label>
          <label className="skills-field">
            <span>版本号（可选）</span>
            <input value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
          </label>
          <label className="skills-field">
            <span>技能正文（frontmatter 之后的指令内容）</span>
            <textarea rows={10} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </label>
          <div className="skills-actions">
            <button className="skills-btn" onClick={() => void save()}>
              保存
            </button>
            <button className="skills-btn" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

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
            <p className="skills-empty">暂无自定义技能 —— 点上方「新建技能」或「导入 .md…」。</p>
          ) : (
            <ul className="skills-list">{custom.map(row)}</ul>
          )}
        </>
      )}
    </div>
  )
}
