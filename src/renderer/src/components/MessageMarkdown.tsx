import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown 渲染（P2）：react-markdown 渲染为 React 元素，**不使用 innerHTML**，
// 因此模型输出里的 HTML/脚本不会被执行（天然免疫 XSS）。
// gfm 插件补上表格、删除线、任务列表等 GitHub 风格语法。
//
// memo（plan30 S2）：props 只有 content 字符串。流式期间每个 chunk 都会让消息列表整体
// 重渲染——历史消息的 content 没变，memo 让 react-markdown 的重解析（本列表里最贵的活）
// 只发生在真正变化的那条上。plan29 S4 量测：渲染层占切换/流式卡顿 97%。
//
// 解析缓存（plan30 第二批）：**会话切换 = 全部消息重新解析**——切换后每条 content 都变了，
// memo 帮不上；而 react-markdown 解析恰是 731ms 的主体。缓存 content → 已解析元素树：
// 内容字符串不变 ⇒ 元素可复用，且**同一引用会让 React 直接跳过该子树的 diff**（比 memo 更彻底）。
// LRU 80 条封顶。流式期间最后一条消息每个 chunk 都是新串，会持续挤出旧条目——无害（只是缓存抖动）。

const CACHE_MAX = 80
const parseCache = new Map<string, JSX.Element>()

function MessageMarkdownImpl({ content }: { content: string }): JSX.Element {
  const hit = parseCache.get(content)
  if (hit) {
    // 触碰即续期（Map 迭代序 = 插入序，删了重插 = LRU）
    parseCache.delete(content)
    parseCache.set(content, hit)
    return hit
  }
  const el = (
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
  if (parseCache.size >= CACHE_MAX) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  parseCache.set(content, el)
  return el
}

const MessageMarkdown = memo(MessageMarkdownImpl)
export default MessageMarkdown
