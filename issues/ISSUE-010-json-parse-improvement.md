# LLM 返回的 JSON 解析失败
> 创建时间: 2026-05-19 | 状态: 🟢已解决

## 问题描述
LLM 返回的内容中 JSON 前后可能有额外文本，导致 `JSON.parse()` 失败。原来的正则 `/[\[{][\s\S]*[\]}]/` 会贪婪匹配到最后一个 `]` 或 `}`，可能包含非 JSON 内容。

## 出现原因
LLM 不总是返回纯 JSON，可能在 JSON 前后添加说明文字，或在 JSON 中嵌套多层对象/数组。

## 解决方案
使用平衡括号匹配算法提取 JSON：
```typescript
const start = Math.min(
  text.indexOf('{') === -1 ? Infinity : text.indexOf('{'),
  text.indexOf('[') === -1 ? Infinity : text.indexOf('[')
)

if (start !== -1) {
  const opener = text[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === opener) depth++
    if (text[i] === closer) depth--
    if (depth === 0) {
      return JSON.parse(text.substring(start, i + 1))
    }
  }
}
```

## 相关文件
- `src/lib/orchestrator/index.ts` - `parseJSON()` 函数
