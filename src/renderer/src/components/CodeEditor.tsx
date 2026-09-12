import { useEffect, useRef, useState } from 'react'

// Monaco 封装（plan13 批 B）—— **按需加载**：只有真正要显示编辑器时，才把 monaco 拉进来。
//
// ## 为什么"按需"是硬要求，不是顺手优化
//
// 实测基线（2026-09-13）：渲染层主 chunk 是 **784 kB**。
// monaco 若被打进主 chunk，会直接多出**几 MB** —— 而那是**每次启动**都要付的代价，
// 可绝大多数会话根本不看代码。所以它必须是"打开文件时才拉"的独立 chunk。
//
// ## Worker 为什么必须这么配（这一节是实测推出来的，不是抄的）
//
// ① 生产态 CSP（`config/electron.vite.config.ts` 的 `CSP_PROD`）里**没有 `worker-src`** →
//    回落到 `default-src 'self'` → **只允许同源 Worker**。
//    这就否掉了"走 CDN loader"那条路（`@monaco-editor/react` 默认从 CDN 拉，
//    既跨源、又离线直接死），也否掉了任何用 `blob:` 造 Worker 的写法。
// ② Vite 的 `?worker` 后缀会把 worker 打成**独立 chunk**，并用 `new Worker(new URL(...))`
//    在**同源**位置加载 —— 正好落在那条策略允许的范围内。
// ③ 语言 worker（json / css / html / ts）**按需给**：只有对应语言的文件才需要它们。
//
// ⚠️ **这一条要真机验证过才算数**：`file://` 协议下 `'self'` 的语义与 http 不同，
// 理论可行不等于实际可行 —— 所以 B1 的验收里有一条"Worker 真的起来了"的实测断言。

type Monaco = typeof import('monaco-editor')

/** 单例：整个应用只加载一次 monaco（Vite 也会把它切成独立 chunk，只拉一次） */
let monacoPromise: Promise<Monaco> | null = null

function loadMonaco(): Promise<Monaco> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      // ⚠️ 顺序有意义：**先注册 Worker 工厂，再 import 主模块**。
      //    反过来的话，monaco 会用自己的默认逻辑去找 worker（在打包环境下必然找不到），
      //    症状是"编辑器能显示、但语法高亮/校验一直转圈"—— 不报错，只是永远出不来。
      const [editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
        // ⚠️ **路径不能带 `esm/vs/` 前缀**（2026-09-13 实测踩到）：
        //    monaco 0.56 的 `package.json` 里写着 `"./*": "./esm/vs/*.js"` ——
        //    子路径**自动**映射进 `esm/vs/`，所以写 `monaco-editor/esm/vs/…` 会被解析成
        //    `esm/vs/esm/vs/…`（不存在）→ 构建期直接报 Rollup resolve 失败。
        //    正确写法就是下面这样（`monaco-editor/<相对 esm/vs 的路径>`）。
        import('monaco-editor/editor/editor.worker.js?worker'),
        import('monaco-editor/language/json/json.worker.js?worker'),
        import('monaco-editor/language/css/css.worker.js?worker'),
        import('monaco-editor/language/html/html.worker.js?worker'),
        import('monaco-editor/language/typescript/ts.worker.js?worker')
      ])

      // monaco 约定的全局挂点（类型库里没有这个字段，故此处显式声明）
      ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
        getWorker(_workerId: string, label: string): Worker {
          switch (label) {
            case 'json':
              return new jsonWorker.default()
            case 'css':
            case 'scss':
            case 'less':
              return new cssWorker.default()
            case 'html':
            case 'handlebars':
            case 'razor':
              return new htmlWorker.default()
            case 'typescript':
            case 'javascript':
              return new tsWorker.default()
            default:
              return new editorWorker.default()
          }
        }
      }

      return import('monaco-editor')
    })()
  }
  return monacoPromise
}

/**
 * 按文件扩展名推断语言 id。
 *
 * 不猜、也不求全：认不出来就 `plaintext`（照样有行号、选区、查找，只是不高亮）——
 * 把不认识的后缀硬映射成某个语言，会让编辑器给出**错误的**语法校验，比不高亮更坏。
 */
export function languageOf(rel: string): string {
  const name = rel.split(/[\\/]/).pop() ?? rel
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    toml: 'ini',
    ini: 'ini',
    env: 'ini'
  }
  return map[ext] ?? 'plaintext'
}

interface Props {
  /** 当前文本（受控） */
  value: string
  /** 用哪个语言高亮（不知道就 `plaintext`） */
  language?: string
  readOnly?: boolean
  onChange?: (next: string) => void
}

/**
 * 编辑器本体。**按需加载 monaco**：加载期间显示"编辑器加载中…"，
 * 加载失败**必须说出来**（不能留一个空白框 —— 用户会以为文件是空的）。
 */
export default function CodeEditor({
  value,
  language = 'plaintext',
  readOnly = false,
  onChange
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  /** 编辑器实例（保存下来才能在卸载时 dispose —— 不 dispose 会漏 Worker 与监听器） */
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  /** monaco 模块本身（改语言要用它的 `setModelLanguage`） */
  const monacoRef = useRef<Monaco | null>(null)
  /** 最新的 value：它每敲一个字都变，但**不能**进 effect 依赖（否则每次按键都重建编辑器） */
  const valueRef = useRef(value)
  /** 最新的 onChange：理由同上 —— 父组件的内联函数每次渲染都是新的 */
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  /**
   * **程序化灌内容期间为 true** —— 这是边界②的命门。
   *
   * monaco 的 `setValue` **也会**触发 `onDidChangeModelContent`。
   * 不区分的话，"外部把内容换掉（换文件 / 重新载入 / 回滚后刷新）"会被当成
   * "用户敲了字"，回灌给父组件 → 父组件据此更新草稿 → 磁盘文本反过来盖掉用户输入。
   * （事件是同步派发的，所以 try/finally 就够，不需要等到某个 tick 之后。）
   */
  const syncingRef = useRef(false)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setState('loading')

    void (async () => {
      try {
        const monaco = await loadMonaco()
        if (!alive || !hostRef.current) return
        monacoRef.current = monaco

        // ⚠️ 这里的 `language` / `readOnly` 是**首次渲染**的值（依赖为空，见 effect 末尾）。
        //    "初值用第一次的，后续变化就地施加"是有意设计 —— 它们各自的 effect 在下面。
        const editor = monaco.editor.create(hostRef.current, {
          value: valueRef.current,
          language,
          readOnly,
          automaticLayout: true, // 面板宽度可拖拽，不自动布局就会在拖拽后错位
          minimap: { enabled: false }, // 右抽屉本来就窄，缩略图只会挤掉正文
          scrollBeyondLastLine: false,
          fontSize: 12,
          renderWhitespace: 'selection',
          wordWrap: 'on' // 窄面板里不换行等于逼人左右拖
        })
        editorRef.current = editor

        // 内容变化 → 回调（**只在这里**接一次；value 的后续同步走下面那个 effect）
        // ⚠️ 走 `onChangeRef`，**不能**直接用闭包里的 `onChange`：这个 effect 依赖为空，
        //    直接闭包捕获的会是**首次渲染那一个**函数 —— 父组件后来传的新回调（带着新的
        //    rel / 新的磁盘基线）永远进不来，"脏标记"就会拿旧基准去比。
        editor.onDidChangeModelContent(() => {
          if (syncingRef.current) return // 我们灌进去的，不是用户敲的（见 syncingRef 说明）
          onChangeRef.current?.(editor.getValue())
        })

        setState('ready')
      } catch (err) {
        if (!alive) return
        setState('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      alive = false
      editorRef.current?.dispose()
      editorRef.current = null
      monacoRef.current = null
    }
    // ⚠️ 依赖**故意为空**。monaco 实例是重资产（Worker + 监听器 + model），
    //    重建一次的代价是**丢撤销栈、丢光标、丢滚动位置**，还会闪一下。
    //    所以 `value` / `language` / `readOnly` 的后续变化**都不重建**，
    //    分别由下面三个 effect 就地施加：
    //      · value    → setValue（带回声屏蔽）
    //      · language → setModelLanguage
    //      · readOnly → updateOptions
    //    （这里不写 eslint-disable —— 本项目没装 react-hooks 插件，写了反而会因为"规则不存在"报错。）
  }, [])

  // 语言变了（切到另一个文件）→ **就地**换语言，不重建编辑器
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || state !== 'ready') return
    const model = editor.getModel()
    // 传同一个 id 时 monaco 内部会直接返回，所以这里不必自己判"变没变"
    if (model) monaco.editor.setModelLanguage(model, language)
  }, [language, state])

  // 只读态变了（预览 ↔ 编辑）→ **就地**改选项，不重建编辑器（重建会丢撤销栈）
  useEffect(() => {
    if (!editorRef.current || state !== 'ready') return
    editorRef.current.updateOptions({ readOnly })
  }, [readOnly, state])

  // 外部把 value 换掉时（切文件 / 重新载入 / 回滚后刷新），同步进编辑器
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || state !== 'ready') return
    valueRef.current = value
    if (editor.getValue() === value) return // 自己敲出来的回灌，不动
    // `setValue` 会**清空撤销栈并把光标归位** —— 所以只在"外部真的换了内容"时才走。
    // 灌的时候必须屏蔽 onDidChangeModelContent：那是我们在写，不是用户在敲。
    syncingRef.current = true
    try {
      editor.setValue(value)
    } finally {
      syncingRef.current = false
    }
  }, [value, state])

  if (state === 'error') {
    return <div className="ex-msg ex-err">编辑器加载失败：{error}（下面仍可用预览查看内容）</div>
  }

  return (
    <div className="ce-wrap">
      <div ref={hostRef} className="ce-host" />
      {state === 'loading' && <div className="ce-loading">编辑器加载中…</div>}
    </div>
  )
}
