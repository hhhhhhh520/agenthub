import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownMessage } from '../src/components/markdown-message'

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownMessage, { content }))

describe('MarkdownMessage', () => {
  it('renders bold, lists and inline code', () => {
    const html = render('**完成**\n\n- 第一项\n- 第二项\n\n`const x = 1`')

    expect(html).toContain('<strong>完成</strong>')
    expect(html).toContain('<li>第一项</li>')
    expect(html).toContain('<li>第二项</li>')
    expect(html).toContain('<code>const x = 1</code>')
  })

  it('renders GFM tables inside an overflow wrapper', () => {
    const html = render('| 名称 | 值 |\n| --- | --- |\n| a | 1 |')

    expect(html).toContain('class="md-table-wrap"')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>名称</th>')
    expect(html).toContain('<td>a</td>')
  })

  it('does not execute raw HTML', () => {
    const html = render('<script>alert(1)</script>')

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('opens links in a new tab with rel', () => {
    const html = render('[示例](https://example.com)')

    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('href="https://example.com"')
  })

  it('does not load markdown images', () => {
    const html = render('![截图](https://example.com/track.png)')

    expect(html).not.toContain('<img')
    expect(html).toContain('[图片：截图]')
  })

  it('returns nothing for empty content', () => {
    expect(render('')).toBe('')
  })
})
