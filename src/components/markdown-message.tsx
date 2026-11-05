import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 聊天消息里的 Markdown 渲染。
 *
 * 安全边界：
 * - 不启用 rehype-raw，原始 HTML 只作为文本显示（不会执行）；
 * - 链接统一新窗口打开并带 rel；
 * - 不加载 markdown 图片，避免 Agent 输出触发任意远程请求（图片走 artifact/附件）。
 *
 * 这里刻意不加 rehype-sanitize：它会把未解析的 raw HTML 节点整段丢掉，
 * 导致原本应显示为文本的 HTML 内容消失。react-markdown 默认的转义已经能阻止执行。
 */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => (
    <span className="md-image-placeholder">[图片{alt ? `：${alt}` : ''}]</span>
  ),
}

export function MarkdownMessage({ content }: { content: string }) {
  if (!content) return null

  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
