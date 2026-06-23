import { describe, it, expect } from 'vitest'
import { isValidDownloadUrl } from '@/lib/url-safety'

describe('isValidDownloadUrl — XSS scheme guard for FileCard', () => {
  // ─── XSS 攻击向量必须全部拒 ───
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',  // 大小写绕过
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',  // 前导空格
    '\tjavascript:alert(1)', // 前导 Tab
    '\njavascript:alert(1)', // 前导换行
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'vbscript:msgbox("xss")',
    'file:///etc/passwd',
    'file:///C:/Windows/System32',
  ])('rejects %s', (url) => {
    expect(isValidDownloadUrl(url)).toBe(false)
  })

  // ─── 协议相对 URL 绕过(`//evil.com` 浏览器视为绝对) ───
  it('rejects protocol-relative //evil.com', () => {
    expect(isValidDownloadUrl('//evil.com/file')).toBe(false)
  })

  it('rejects protocol-relative with leading whitespace', () => {
    expect(isValidDownloadUrl(' //evil.com/file')).toBe(false)
  })

  // ─── 反斜杠绕过 ───
  it('rejects URL containing backslash', () => {
    expect(isValidDownloadUrl('\\\\evil.com\\file')).toBe(false)
    expect(isValidDownloadUrl('/api/\\evil')).toBe(false)
  })

  // ─── 合法 URL 必须通过 ───
  it.each([
    '/api/attachments/abc',
    '/api/sessions/uuid/files/test.txt',
    'https://example.com/file.pdf',
    'http://localhost:3000/f',
    'https://example.com/path?q=javascript:foo',  // query 含关键字不应误伤
  ])('accepts %s', (url) => {
    expect(isValidDownloadUrl(url)).toBe(true)
  })

  // ─── 边界 ───
  it('rejects empty / null / undefined', () => {
    expect(isValidDownloadUrl('')).toBe(false)
    expect(isValidDownloadUrl(undefined)).toBe(false)
    expect(isValidDownloadUrl(null as unknown as string)).toBe(false)
  })

  it('rejects malformed URL', () => {
    expect(isValidDownloadUrl('not a url')).toBe(false)
    expect(isValidDownloadUrl('http://')).toBe(false)
  })

  it('rejects relative path not starting with /', () => {
    // ../etc/passwd 等不该作为 downloadUrl
    expect(isValidDownloadUrl('../etc/passwd')).toBe(false)
    expect(isValidDownloadUrl('foo/bar')).toBe(false)
  })
})
