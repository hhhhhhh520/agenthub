// contract v1 §1.2 a (动作 5,降级版): outputSchema 软校验测试
import { describe, it, expect } from 'vitest'
import { validateAgainstSchema } from '@/lib/services/schema-validator'

describe('validateAgainstSchema', () => {
  // ── 跳过场景 ──────────────────────────────────────
  describe('跳过校验', () => {
    it('outputSchema 为 null 时跳过', () => {
      const r = validateAgainstSchema('任意输出', null)
      expect(r.valid).toBe(true)
      expect(r.status).toBe('no-schema')
    })

    it('outputSchema 为 undefined 时跳过', () => {
      const r = validateAgainstSchema('任意输出', undefined)
      expect(r.valid).toBe(true)
      expect(r.status).toBe('no-schema')
    })

    it('outputSchema 为空字符串时跳过', () => {
      const r = validateAgainstSchema('任意输出', '')
      expect(r.valid).toBe(true)
      expect(r.status).toBe('no-schema')
    })

    it('outputSchema 是空数组 JSON 时跳过', () => {
      const r = validateAgainstSchema('任意输出', JSON.stringify([]))
      expect(r.valid).toBe(true)
      expect(r.status).toBe('no-schema')
    })

    it('outputSchema 非法 JSON 时跳过(不抛错)', () => {
      const r = validateAgainstSchema('任意输出', 'not-valid-json')
      expect(r.valid).toBe(true)
      expect(r.status).toBe('no-schema')
    })
  })

  // ── 通过场景 ──────────────────────────────────────
  describe('校验通过', () => {
    it('result 末尾有完整 fenced JSON 块,字段名齐全', () => {
      const schema = JSON.stringify([
        'component_path:string - 组件路径',
        'exports:string[] - 导出符号',
      ])
      const result = `我做完了登录组件。

\`\`\`json
{
  "component_path": "src/components/Login.tsx",
  "exports": ["LoginForm", "useLogin"]
}
\`\`\``
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(true)
      expect(r.status).toBe('ok')
      expect(r.missingFields).toEqual([])
    })

    it('JSON 块多了字段也算通过(只校验声明的字段,不限制额外字段)', () => {
      const schema = JSON.stringify(['name:string - 名字'])
      const result = '\`\`\`json\n{"name":"x","extra":"y"}\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(true)
    })

    it('裸 JSON 对象(无 fenced 围栏)也能被识别', () => {
      const schema = JSON.stringify(['key:string - 含义'])
      const result = '一些描述文字。\n\n{"key": "value"}'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(true)
      expect(r.status).toBe('ok')
    })

    it('result 里有多个 JSON 块时,识别最后一个', () => {
      const schema = JSON.stringify(['final:string - 最终值'])
      const result = `
首次尝试:
\`\`\`json
{"draft": "v1"}
\`\`\`

修正后:
\`\`\`json
{"final": "v2"}
\`\`\``
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(true)
      expect(r.status).toBe('ok')
    })
  })

  // ── 失败场景(只产生警告) ─────────────────────────────
  describe('校验失败但只产生警告', () => {
    it('result 完全没 JSON 块 → no-json + 警告消息', () => {
      const schema = JSON.stringify(['x:string - x'])
      const result = '一段自由文字,没有任何 JSON。'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(false)
      expect(r.status).toBe('no-json')
      expect(r.message).toContain('未在产出末尾找到 JSON 块')
      expect(r.missingFields).toEqual(['x'])
    })

    it('JSON 块语法错误 → parse-error', () => {
      const schema = JSON.stringify(['x:string'])
      const result = '\`\`\`json\n{"x": broken}\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(false)
      expect(r.status).toBe('parse-error')
      expect(r.message).toContain('解析失败')
    })

    it('JSON 块解析出数组 → parse-error(校验只看对象)', () => {
      const schema = JSON.stringify(['x:string'])
      const result = '\`\`\`json\n[1,2,3]\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(false)
      expect(r.status).toBe('parse-error')
    })

    it('JSON 缺一个声明字段 → missing-fields', () => {
      const schema = JSON.stringify([
        'a:string - a',
        'b:string - b',
        'c:string - c',
      ])
      const result = '\`\`\`json\n{"a": "1", "b": "2"}\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(false)
      expect(r.status).toBe('missing-fields')
      expect(r.missingFields).toEqual(['c'])
      expect(r.message).toContain('c')
    })

    it('JSON 全部字段都缺 → missing-fields 包含所有声明', () => {
      const schema = JSON.stringify(['a:string', 'b:string'])
      const result = '\`\`\`json\n{"other": "x"}\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(false)
      expect(r.status).toBe('missing-fields')
      expect(r.missingFields).toEqual(['a', 'b'])
    })
  })

  // ── 字段名解析边缘 ────────────────────────────────
  describe('outputSchema 字段名解析', () => {
    it('解析 "name:type - 说明" 格式只取 name 部分', () => {
      const schema = JSON.stringify(['my_field:string[] - 这是说明'])
      const result = '\`\`\`json\n{"my_field": []}\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(true)
    })

    it('字段名前后空格被裁掉', () => {
      const schema = JSON.stringify(['  spaced  :string'])
      const result = '\`\`\`json\n{"spaced": "v"}\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(true)
    })

    it('字段名不带冒号时按整个字符串当字段名', () => {
      const schema = JSON.stringify(['plain_name'])
      const result = '\`\`\`json\n{"plain_name": "v"}\n\`\`\`'
      const r = validateAgainstSchema(result, schema)
      expect(r.valid).toBe(true)
    })
  })

  // ── 与动作 6 对称:不抛错,返回结构化结果 ────────────
  describe('永不抛错(与动作 6 对称的软语义)', () => {
    it('result 空字符串不抛错', () => {
      const schema = JSON.stringify(['x:string'])
      expect(() => validateAgainstSchema('', schema)).not.toThrow()
    })

    it('result 是 undefined 安全降级(只触发 no-json,不抛错)', () => {
      const schema = JSON.stringify(['x:string'])
      // @ts-expect-error - 故意传 undefined 测试容错
      const r = validateAgainstSchema(undefined, schema)
      expect(r.valid).toBe(false)
      expect(r.status).toBe('no-json')
    })

    it('result 是奇怪结构的对象不抛错', () => {
      const schema = JSON.stringify(['x:string'])
      // 这种应该在调用层就不让发生,但防御性测试
      // @ts-expect-error - 故意传非字符串
      expect(() => validateAgainstSchema({} as any, schema)).not.toThrow()
    })
  })
})
