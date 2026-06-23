/**
 * 校验 FileCard / 其他用户面下载链接的 href 是否安全。
 * 防 #43:agent 输出的 `<!-- artifact:file downloadUrl=javascript:... -->` 被原样渲染为 <a href> 时会同源执行 JS。
 *
 * 通过规则(白名单):
 *  - http: / https: 协议绝对 URL
 *  - 以 `/` 开头的同源相对路径,且非协议相对 `//evil.com`
 *
 * 拒绝向量:
 *  - javascript: / data: / vbscript: / file: 等危险协议(含大小写、前导空白绕过)
 *  - `//host/path` 协议相对(浏览器视为绝对)
 *  - 含反斜杠 `\`(历史上 Edge/Chrome 对 `\\host` 有特殊处理)
 *  - 相对路径(不以 `/` 开头)
 *  - 空 / null / undefined / 畸形 URL
 */
export function isValidDownloadUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false

  // 拒绝任何反斜杠(浏览器 URL 解析历史上的特殊处理)
  if (url.includes('\\')) return false

  // 拒绝前导空白(防 ` javascript:`、`\tjavascript:` 等)
  if (url !== url.trimStart()) return false

  // 同源相对路径:以单个 `/` 开头,但拒绝协议相对 `//host/path`
  if (url.startsWith('/') && !url.startsWith('//')) return true

  // 绝对 URL:用 new URL 解析,严格校验 .protocol
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
