/**
 * 整数字符串解析工具函数。
 */

/**
 * 将字符串解析为整数。
 *
 * 规则：
 * - 允许可选的正负号（`+` / `-`），且最多一个，只能出现在开头；
 * - 其余部分必须是纯数字（0-9）；
 * - 不允许空白、小数点、千分位分隔符等任何其他字符；
 * - 解析成功返回对应整数，失败返回 `null`（不抛异常）。
 *
 * @param input 待解析的字符串（`undefined` / `null` 视为解析失败）
 * @returns 解析出的整数；非法输入返回 `null`
 *
 * @example
 * parseInteger("42");    // 42
 * parseInteger("-7");    // -7
 * parseInteger("+007");  // 7
 * parseInteger("3.14");  // null
 * parseInteger(" 42");   // null
 * parseInteger("");      // null
 */
export function parseInteger(input: string | null | undefined): number | null {
  if (typeof input !== "string" || input.length === 0) {
    return null;
  }

  // 剥离可选的正负号
  let digits = input;
  let sign = 1;
  if (input[0] === "+" || input[0] === "-") {
    if (input[0] === "-") {
      sign = -1;
    }
    digits = input.slice(1);
  }

  // 剩余部分必须是非空的纯数字
  if (digits.length === 0 || !/^\d+$/.test(digits)) {
    return null;
  }

  const value = Number(digits);
  // 防御性检查：极长的数字串可能超出 Number 精确表示范围
  if (!Number.isSafeInteger(value)) {
    return null;
  }

  return sign * value;
}
