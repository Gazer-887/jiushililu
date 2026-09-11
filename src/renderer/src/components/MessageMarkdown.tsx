import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown 渲染（P2）：react-markdown 渲染为 React 元素，**不使用 innerHTML**，
// 因此模型输出里的 HTML/脚本不会被执行（天然免疫 XSS）。
// gfm 插件补上表格、删除线、任务列表等 GitHub 风格语法。

export default function MessageMarkdown({ content }: { content: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 代码块加语言标注与独立样式（行内 code 由 CSS 区分）
          code({ className, children, ...props }) {
            const isBlock = Boolean(className)
            return isBlock ? (
              <pre className="md-pre">
                <code className={className} {...props}>
                  {children}
                </code>
              </pre>
            ) : (
              <code className="md-code-inline" {...props}>
                {children}
              </code>
            )
          },
          a({ href, children }) {
            // 外链交给系统浏览器打开由主进程处理；此处仅标注，避免应用内跳转丢上下文
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
