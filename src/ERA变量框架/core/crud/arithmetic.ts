/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：VariableEdit 支持 +=、-=、*=、/= 增量运算；增量运算：不舍入大整数，不把编号类字符串当数字；新增脚本设置“API写入不修改消息”；表达式 $expr 共用 toOperand
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 增量运算解析模块
 * @description
 * 解析 `<VariableEdit>` 叶子值中的增量运算表达式（`+=`、`-=`、`*=`、`/=`），
 * 使 `{"player": {"hp": "+=10"}}` 或 `era:updateByPath` 的 `value: '+=10'` 能基于当前值做运算。
 *
 * 本模块是纯函数，不依赖任何全局状态。
 */
'use strict';

/** 匹配形如 `+=10`、`-= 2.5`、`*=-1` 的表达式。 */
const ARITHMETIC_REGEX = /^\s*([+\-*/])=\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*$/;

/** 可以参与运算的字符串：普通十进制数，整数部分不带多余的前导 0。 */
const DECIMAL_STRING_REGEX = /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)$/;

/** 指令中的字符串值在进入 crud 之前已被 `escapeEraData` 转义，小数点会变成该占位符。 */
const ESCAPED_DOT = /__DOT__/g;

/** 判断一个值是否为增量运算表达式。 */
export function isArithmeticExpression(value: any): boolean {
  return typeof value === 'string' && ARITHMETIC_REGEX.test(value.replace(ESCAPED_DOT, '.'));
}

export type ArithmeticResult =
  /** 不是运算表达式，或当前值不是数字：按普通值处理。 */
  | { kind: 'none' }
  /** 运算成功。 */
  | { kind: 'ok'; value: number }
  /** 是运算表达式且当前值是数字，但无法得到有限结果（如除以 0）。 */
  | { kind: 'invalid'; reason: string };

/**
 * 将当前值转换为可参与运算的数字。
 * 只接受有限数字，以及内容为纯数字的字符串（AI 有时会把数字写成字符串）。
 */
export function toOperand(current: any): number | null {
  if (typeof current === 'number') {
    return Number.isFinite(current) ? current : null;
  }
  if (typeof current === 'string') {
    const text = current.replace(ESCAPED_DOT, '.').trim();
    // 只接受普通十进制写法。`Number()` 还会把 '0x10'、'1e3'、'007' 这类字符串当成数字，
    // 而它们更可能是编号之类的文本，不应被运算覆盖。
    if (!DECIMAL_STRING_REGEX.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 尝试把 `newValue` 当作增量运算表达式，基于 `current` 计算新值。
 *
 * - `newValue` 不是形如 `+=10` 的字符串时，返回 `{ kind: 'none' }`。
 * - `current` 不是数字（或纯数字字符串）时，同样返回 `{ kind: 'none' }`：
 *   这样文本字段仍然可以被写入以 `+=` 开头的普通字符串，保持旧行为。
 *
 * @param newValue 指令中给出的新值。
 * @param current 该路径当前的值。
 */
export function resolveArithmetic(newValue: any, current: any): ArithmeticResult {
  if (typeof newValue !== 'string') return { kind: 'none' };

  const match = newValue.replace(ESCAPED_DOT, '.').match(ARITHMETIC_REGEX);
  if (!match) return { kind: 'none' };

  const base = toOperand(current);
  if (base === null) return { kind: 'none' };

  const operator = match[1];
  const operand = Number(match[2]);

  let result: number;
  switch (operator) {
    case '+':
      result = base + operand;
      break;
    case '-':
      result = base - operand;
      break;
    case '*':
      result = base * operand;
      break;
    default:
      if (operand === 0) return { kind: 'invalid', reason: '除数不能为 0' };
      result = base / operand;
      break;
  }

  if (!Number.isFinite(result)) {
    return { kind: 'invalid', reason: `运算结果不是有限数字: ${result}` };
  }

  // 整数结果原样返回，避免大整数（时间戳、大额数值）被舍入。
  if (Number.isInteger(result)) {
    return { kind: 'ok', value: result };
  }
  // 小数结果保留 15 位有效数字，消除 0.1 + 0.2 这类浮点误差带来的长尾小数。
  return { kind: 'ok', value: Number(result.toPrecision(15)) };
}
