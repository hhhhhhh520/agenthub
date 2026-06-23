/**
 * Contract v1 §1.2 a (动作 5,降级版):
 * 上游 task.result 的 outputSchema 校验。
 *
 * 与动作 6 对称:不做硬失败,只产出可观察的警告信号。
 *
 * 设计取舍:
 * - outputSchema 当前仅由下游 LLM 通过 prompt 中的 `<dependency>` 标签消费
 *   下游 LLM 读上游的自由文字就够,不需要程序化 JSON 解析
 * - 强制 schema 硬失败会高频误伤(LLM 不一定按格式输出 JSON 块)
 * - 因此本模块只做"提取 + 解析 + 字段名比对",失败只产生结构化警告
 *
 * 如果未来流程演进到"非 LLM 步骤需要读结构化上游产出",
 * 可以把本模块的返回值升级为硬失败信号。
 */

export interface SchemaValidationResult {
  /** 校验是否通过(向前兼容:即使 valid=false 也不影响任务状态) */
  valid: boolean
  /** 校验状态 */
  status: 'no-schema' | 'no-json' | 'parse-error' | 'missing-fields' | 'ok'
  /** 已声明但 result JSON 里缺失的字段(仅 status='missing-fields' 时非空) */
  missingFields: string[]
  /** 用于发送给用户的可读消息(无问题时为 ''.) */
  message: string
}

/**
 * 从 outputSchema 持久化字符串中抽取声明的字段名。
 * outputSchema 格式: JSON.stringify(["field_a:type - 说明", "field_b:type - 说明"])
 */
function extractFieldNames(outputSchema: string): string[] {
  try {
    const arr = JSON.parse(outputSchema)
    if (!Array.isArray(arr)) return []
    return arr
      .map((entry: unknown) => {
        if (typeof entry !== 'string') return ''
        // "field_name:type - 说明" → "field_name"
        const colonIdx = entry.indexOf(':')
        return colonIdx > 0 ? entry.slice(0, colonIdx).trim() : entry.trim()
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 从自由文本 result 中提取最后一个 JSON 块。
 * 优先匹配 ```json {...} ``` 围栏,fallback 到裸 JSON 对象。
 * 返回 null 表示没找到任何 JSON 块。
 */
function extractLastJsonBlock(result: string): string | null {
  if (typeof result !== 'string' || result.length === 0) return null

  // 先找 fenced code block: ```json {...} ``` 或 ```{...}```
  // 同时也匹配 ```json [...] ``` 这样能在数组场景下被后续 JSON.parse 判定 parse-error
  const fencedRegex = /```(?:json|JSON)?\s*([\{\[][\s\S]*?[\}\]])\s*```/g
  let lastFenced: string | null = null
  let match: RegExpExecArray | null
  while ((match = fencedRegex.exec(result)) !== null) {
    lastFenced = match[1]
  }
  if (lastFenced) return lastFenced

  // fallback: 从末尾找最后一个独立的 { ... } JSON 对象
  // 简单策略:从字符串末尾向前找最后一个 '{',然后向前匹配到对应的 '}'
  // 注意:不做完整 JSON 解析,只做粗略括号匹配,真正解析交给调用方 JSON.parse
  const lastOpenBrace = result.lastIndexOf('{')
  if (lastOpenBrace === -1) return null
  // 向后找最后一个 '}'
  const lastCloseBrace = result.lastIndexOf('}')
  if (lastCloseBrace <= lastOpenBrace) return null

  return result.slice(lastOpenBrace, lastCloseBrace + 1)
}

/**
 * 校验 task.result 是否符合 outputSchema 声明的字段。
 *
 * 流程:
 *   1. outputSchema 为空 → no-schema(跳过)
 *   2. 提取不到 JSON 块 → no-json
 *   3. JSON.parse 失败 → parse-error
 *   4. 字段名有缺失 → missing-fields
 *   5. 全部字段名都有 → ok
 *
 * @param result - task 的自由文本输出
 * @param outputSchema - Task.outputSchema 字段(JSON.stringify 的字符串数组)
 */
export function validateAgainstSchema(
  result: string,
  outputSchema: string | null | undefined,
): SchemaValidationResult {
  if (!outputSchema) {
    return { valid: true, status: 'no-schema', missingFields: [], message: '' }
  }

  const declaredFields = extractFieldNames(outputSchema)
  if (declaredFields.length === 0) {
    return { valid: true, status: 'no-schema', missingFields: [], message: '' }
  }

  const jsonBlock = extractLastJsonBlock(result)
  if (!jsonBlock) {
    return {
      valid: false,
      status: 'no-json',
      missingFields: declaredFields,
      message: `[schema 警告] 未在产出末尾找到 JSON 块,声明的字段无法校验: ${declaredFields.join(', ')}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBlock)
  } catch {
    return {
      valid: false,
      status: 'parse-error',
      missingFields: declaredFields,
      message: `[schema 警告] 产出末尾的 JSON 块解析失败,声明的字段无法校验: ${declaredFields.join(', ')}`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      valid: false,
      status: 'parse-error',
      missingFields: declaredFields,
      message: `[schema 警告] 产出末尾的 JSON 块不是对象,无法校验字段名`,
    }
  }

  const presentKeys = new Set(Object.keys(parsed as Record<string, unknown>))
  const missing = declaredFields.filter(f => !presentKeys.has(f))
  if (missing.length > 0) {
    return {
      valid: false,
      status: 'missing-fields',
      missingFields: missing,
      message: `[schema 警告] 产出 JSON 缺少声明字段: ${missing.join(', ')}`,
    }
  }

  return { valid: true, status: 'ok', missingFields: [], message: '' }
}
