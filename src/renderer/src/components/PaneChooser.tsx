import { BUILTIN_LABELS, BUILTIN_TYPES, type BuiltinType } from '@shared/workbench'

// 「＋」开窗菜单的内容（plan9 W3/W4）：六个内置面板。
//
// 与改造前的区别：以前是**常驻的六页签条**（点一个换一个），
// 现在是"**点 ＋ 才出现**"的开窗菜单 —— 对应 DSH 的 pane 选择器。
// 空栏、空工作台、栏内 ＋ 三处共用同一份名单，所以只有这里一处需要维护。

export default function PaneChooser({ onPick }: { onPick: (t: BuiltinType) => void }): JSX.Element {
  return (
    <div className="wb-chooser">
      {BUILTIN_TYPES.map((t) => (
        <button key={t} className="wb-pick" onClick={() => onPick(t)}>
          {BUILTIN_LABELS[t]}
        </button>
      ))}
    </div>
  )
}
