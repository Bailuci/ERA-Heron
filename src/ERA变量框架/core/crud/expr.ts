/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：新增表达式 $expr：<VariableEdit> 中 {"$expr": "..."} 叶子按公式与骰点求值
 *       2026-11-27 新增 call(公式路径, 参数…)：调用存成字符串变量的公式，公式里用 a、b、c… 引用参数
 *       2026-11-27 call 参数过多时的报错写明“最多 15 个参数（不含公式路径）”
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 表达式求值
 * @description
 * `<VariableEdit>` 中形如 `{"hp": {"$expr": "clamp(hp + roll(1, 6), 0, 上限.hp)"}}` 的叶子，
 * 在目标当前值是有限数字时按表达式求值（判定在 `update.ts`）。
 *
 * - 手写词法分析 + 递归下降，不使用 `eval` / `new Function`。纯同步，结果只取决于输入。
 * - 三角、指数、对数一律用 `utils/det_math`，各浏览器引擎逐位一致；不使用 `**` 与原生的近似函数。
 * - 每个运算符、每次函数调用的结果都立即检查，NaN 或 ±Infinity 当场失败。
 * - 函数通过“函数解析器”查表，1.8 的 `Era.registerExprFn` 在这里接入。
 *
 * 语法：数字（可带指数）、`+ - * / ^`、括号、一元正负号；`^` 右结合且优先级高于一元负号（`-2^2 = -4`）。
 * 路径 `a.b`，每段可以用反引号括起；`@路径` 读本楼开始前的值。只有单独出现的大写 `PI`、`E` 是常量。
 *
 * `call(公式.伤害, x, y)`：读取路径上存的公式文本，按同样的语法解析求值。公式里单独一个小写字母是参数
 * （a 是第 1 个、b 是第 2 个……），其余与外层相同；随机数与外层共用一个序列。见 `evaluateFormulaCall`。
 */
'use strict';

import { escapeEraKey, resolveKeyPath, unescapeEraData } from '../../utils/data';
import * as det from '../../utils/det_math';
import { createSeededRandom, randomAt } from '../../utils/seeded_random';
import { toOperand } from './arithmetic';

/** 表达式的长度上限（字符）。 */
export const EXPR_MAX_LENGTH = 1000;
/** 记号数上限。 */
export const EXPR_MAX_TOKENS = 300;
/** 括号与函数调用的嵌套深度上限。 */
export const EXPR_MAX_DEPTH = 32;
/** 单个函数的参数个数上限。 */
export const EXPR_MAX_ARGS = 16;
/** 单个表达式随机抽取次数的上限。 */
export const EXPR_MAX_DRAWS = 64;

/** 求值失败，`message` 是给 AI 看的、可以照着改的说明。 */
export class ExprError extends Error {}

/** 调用函数时可用的环境。 */
export interface ExprCallEnv {
  /** 本表达式的确定性随机数 [0, 1)，按调用序号取值。 */
  random(): number;
}

/** 表达式函数。参数和返回值都是有限数字；出错时抛出 `ExprError`。 */
export interface ExprFunction {
  minArgs: number;
  maxArgs: number;
  call(args: number[], env: ExprCallEnv): number;
}

/** 按名字查找函数，找不到时返回 `undefined`。 */
export type ExprFnResolver = (name: string) => ExprFunction | undefined;

export interface ExprEnv {
  /** 当前执行位置的变量（转义过的）。 */
  stat: any;
  /** 本楼开始前的变量（转义过的），供 `@路径` 读取。 */
  oldStat: any;
  /** 随机数种子。 */
  seed: string;
  /** 函数解析器，默认只有内置函数。 */
  resolveFn?: ExprFnResolver;
}

export type ExprResult = { ok: true; value: number } | { ok: false; reason: string };

/** `{"$expr": "<字符串>"}`：只有一个键的对象。 */
export function isExprLeaf(value: any): value is { $expr: string } {
  return _.isPlainObject(value) && typeof value.$expr === 'string' && Object.keys(value).length === 1;
}

// ---------------------------------------------------------------------------
// 数字的格式与规整
// ---------------------------------------------------------------------------

/** 非整数按 15 位有效数字规整，吸收 `2.9999999999999996` 这类误差。整数原样返回，避免大整数被舍入。 */
const normalize15 = (x: number): number => (Number.isInteger(x) ? x : Number(x.toPrecision(15)));

/** 最终结果：整数原样，小数 15 位有效数字，`-0` 归一为 0。 */
function finalize(x: number): number {
  const value = normalize15(x);
  return value === 0 ? 0 : value;
}

/** 用于说明的数字文本。 */
const show = (x: number): string => String(finalize(x));

// ---------------------------------------------------------------------------
// 内置函数
// ---------------------------------------------------------------------------

const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10];

const fn = (minArgs: number, maxArgs: number, call: (args: number[], env: ExprCallEnv) => number): ExprFunction => ({
  minArgs,
  maxArgs,
  call,
});

const unary = (call: (x: number) => number): ExprFunction => fn(1, 1, ([x]) => call(x));

/** 检查参数的定义域。 */
function domain(ok: boolean, message: string): void {
  if (!ok) throw new ExprError(message);
}

/** .5 远离零的舍入。 */
function roundHalfAway(x: number, digits: number): number {
  const scale = POW10[digits];
  const magnitude = normalize15(Math.abs(normalize15(x)) * scale);
  const whole = Math.trunc(magnitude);
  const rounded = magnitude - whole >= 0.5 ? whole + 1 : whole;
  const result = rounded / scale;
  return x < 0 ? -result : result;
}

function ln(x: number, name = 'ln'): number {
  domain(x > 0, `${name} 的参数必须大于 0，实际为 ${show(x)}`);
  return det.log(x);
}

function checkedPow(base: number, exponent: number): number {
  if (base === 0 && exponent < 0) throw new ExprError(`0 不能取负数次方：0^${show(exponent)}`);
  if (base < 0 && !Number.isInteger(exponent)) {
    throw new ExprError(`负数不能取非整数次方：(${show(base)})^${show(exponent)}`);
  }
  return det.pow(base, exponent);
}

const BUILTINS: Readonly<Record<string, ExprFunction>> = Object.freeze({
  // 基础
  abs: unary(Math.abs),
  sign: unary(Math.sign),
  floor: unary(x => Math.floor(normalize15(x))),
  ceil: unary(x => Math.ceil(normalize15(x))),
  trunc: unary(x => Math.trunc(normalize15(x))),
  round: fn(1, 2, ([x, digits = 0]) => {
    domain(
      Number.isInteger(digits) && digits >= 0 && digits <= 10,
      `round 的第二个参数（保留几位小数）必须是 0～10 的整数，实际为 ${show(digits)}`,
    );
    return roundHalfAway(x, digits);
  }),
  min: fn(1, EXPR_MAX_ARGS, args => Math.min(...args)),
  max: fn(1, EXPR_MAX_ARGS, args => Math.max(...args)),
  clamp: fn(3, 3, ([x, lo, hi]) => {
    domain(
      lo <= hi,
      `clamp(值, 最小值, 最大值) 的最小值不能大于最大值，实际为 clamp(${show(x)}, ${show(lo)}, ${show(hi)})`,
    );
    return Math.min(Math.max(x, lo), hi);
  }),
  pow: fn(2, 2, ([x, y]) => checkedPow(x, y)),
  sqrt: unary(x => {
    domain(x >= 0, `sqrt 的参数不能为负数，实际为 ${show(x)}`);
    return Math.sqrt(x);
  }),
  mod: fn(2, 2, ([x, y]) => {
    const a = normalize15(x);
    const b = normalize15(y);
    domain(b !== 0, 'mod(x, y) 的除数 y 不能为 0');
    // 地板取余：结果的符号与除数相同。JS 的 % 是精确的 fmod。
    let r = a % b;
    if (r !== 0 && r < 0 !== b < 0) r += b;
    return r;
  }),

  // 初等函数（弧度）
  exp: unary(det.exp),
  ln: unary(x => ln(x)),
  log: fn(1, 2, args => {
    const x = args[0];
    if (args.length === 1) return ln(x, 'log');
    const base = args[1];
    domain(base > 0 && base !== 1, `log(x, 底数) 的底数必须大于 0 且不等于 1，实际为 ${show(base)}`);
    domain(x > 0, `log 的参数必须大于 0，实际为 ${show(x)}`);
    if (base === 10) return det.log10(x);
    if (base === 2) return det.log2(x);
    return det.log(x) / det.log(base);
  }),
  log10: unary(x => {
    domain(x > 0, `log10 的参数必须大于 0，实际为 ${show(x)}`);
    return det.log10(x);
  }),
  log2: unary(x => {
    domain(x > 0, `log2 的参数必须大于 0，实际为 ${show(x)}`);
    return det.log2(x);
  }),
  sin: unary(det.sin),
  cos: unary(det.cos),
  tan: unary(det.tan),
  asin: unary(x => {
    domain(x >= -1 && x <= 1, `asin 的参数必须在 -1 到 1 之间，实际为 ${show(x)}`);
    return det.asin(x);
  }),
  acos: unary(x => {
    domain(x >= -1 && x <= 1, `acos 的参数必须在 -1 到 1 之间，实际为 ${show(x)}`);
    return det.acos(x);
  }),
  atan: unary(det.atan),
  atan2: fn(2, 2, ([y, x]) => det.atan2(y, x)),
  sinh: unary(det.sinh),
  cosh: unary(det.cosh),
  tanh: unary(det.tanh),

  // 第二梯队
  asinh: unary(det.asinh),
  acosh: unary(x => {
    domain(x >= 1, `acosh 的参数必须大于等于 1，实际为 ${show(x)}`);
    return det.acosh(x);
  }),
  atanh: unary(x => {
    domain(x > -1 && x < 1, `atanh 的参数必须在 -1 到 1 之间（不含两端），实际为 ${show(x)}`);
    return det.atanh(x);
  }),
  hypot: fn(1, EXPR_MAX_ARGS, args => args.reduce((sum, x) => det.hypot(sum, x), 0)),
  deg: unary(x => (x * 180) / Math.PI),
  rad: unary(x => (x * Math.PI) / 180),

  // 随机
  random: fn(0, 0, (_args, env) => env.random()),
  roll: fn(2, 2, ([lo, hi], env) => {
    domain(
      Number.isSafeInteger(lo) && Number.isSafeInteger(hi),
      `roll(最小值, 最大值) 的参数必须是整数，实际为 roll(${show(lo)}, ${show(hi)})`,
    );
    domain(lo <= hi, `roll(最小值, 最大值) 的最小值不能大于最大值，实际为 roll(${lo}, ${hi})`);
    domain(hi - lo < 4294967296, 'roll 的范围太大：最大值与最小值之差不能超过 4294967295');
    return lo + Math.floor(env.random() * (hi - lo + 1));
  }),
  random_at: fn(2, 2, ([seed, draw]) => randomAt(seed, draw)),
});

/** 内置函数的解析器。 */
export const resolveBuiltinExprFn: ExprFnResolver = name =>
  Object.prototype.hasOwnProperty.call(BUILTINS, name) ? BUILTINS[name] : undefined;

/** 全部内置函数名，供文档与提示词使用。 */
export const BUILTIN_EXPR_FUNCTION_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTINS));

// ---------------------------------------------------------------------------
// 词法分析
// ---------------------------------------------------------------------------

/** 全角与常见的数学符号。只在反引号之外归一化，键名里的全角括号不受影响。 */
const FULL_WIDTH: Record<string, string> = {
  '（': '(',
  '）': ')',
  '＋': '+',
  '－': '-',
  '−': '-',
  '＊': '*',
  '×': '*',
  '／': '/',
  '÷': '/',
  '＾': '^',
  '，': ',',
  '．': '.',
  '＠': '@',
  '％': '%',
  '｀': '`',
  '　': ' ',
};

function normalizeSymbols(source: string): string {
  let result = '';
  let quoted = false;
  for (const ch of source) {
    if (quoted) {
      if (ch === '`' || ch === '｀') {
        quoted = false;
        result += '`';
      } else {
        result += ch;
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    // 全角数字 ０-９
    const mapped = code >= 0xff10 && code <= 0xff19 ? String.fromCharCode(code - 0xff10 + 48) : (FULL_WIDTH[ch] ?? ch);
    if (mapped === '`') quoted = true;
    result += mapped;
  }
  return result;
}

const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}\p{M}_$]/u;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

interface PathToken {
  t: 'path';
  at: boolean;
  segs: string[];
  /** 单独一段、没有反引号、没有 `@`：可能是函数名或常量。 */
  bare: boolean;
  text: string;
}
type Token = { t: 'num'; v: number; text: string } | PathToken | { t: 'op'; v: string };

function tokenize(source: string): Token[] {
  const chars = Array.from(source);
  const tokens: Token[] = [];
  let i = 0;
  const isIdentStart = (ch: string | undefined) => ch !== undefined && IDENT_START.test(ch);
  const isIdentPart = (ch: string | undefined) => ch !== undefined && IDENT_PART.test(ch);
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > EXPR_MAX_TOKENS) {
      throw new ExprError(`表达式太长：最多 ${EXPR_MAX_TOKENS} 个记号，请拆成几条指令`);
    }
  };

  while (i < chars.length) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(chars[i + 1] ?? ''))) {
      const match = chars
        .slice(i, i + 64)
        .join('')
        .match(NUMBER)!;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new ExprError(`数字 ${match[0]} 超出范围`);
      i += match[0].length;
      if (isIdentStart(chars[i]) || chars[i] === '`' || chars[i] === '@') {
        throw new ExprError(`不支持省略乘号：“${match[0]}${chars[i]}” 请写成 ${match[0]}*${chars[i]}`);
      }
      push({ t: 'num', v: value, text: match[0] });
      continue;
    }
    if (ch === '@' || ch === '`' || isIdentStart(ch)) {
      const at = ch === '@';
      const start = i;
      if (at) {
        i++;
        if (!(chars[i] === '`' || isIdentStart(chars[i])))
          throw new ExprError('@ 后面要紧跟变量路径，例如 @角色.生命值');
      }
      const segs: string[] = [];
      let quoted = false;
      for (;;) {
        if (chars[i] === '`') {
          const end = chars.indexOf('`', i + 1);
          if (end === -1) throw new ExprError('反引号没有闭合：含特殊字符的键名要写成 `键名`');
          const seg = chars.slice(i + 1, end).join('');
          if (seg === '') throw new ExprError('反引号里的键名不能为空');
          segs.push(seg);
          quoted = true;
          i = end + 1;
        } else {
          const from = i;
          while (isIdentPart(chars[i])) i++;
          segs.push(chars.slice(from, i).join(''));
        }
        if (chars[i] === '.' && (chars[i + 1] === '`' || isIdentStart(chars[i + 1]))) {
          i++;
          continue;
        }
        break;
      }
      push({
        t: 'path',
        at,
        segs,
        bare: !at && !quoted && segs.length === 1,
        text: chars.slice(start, i).join(''),
      });
      continue;
    }
    if (ch === '%') throw new ExprError('不支持 %：取余请用 mod(x, y)；百分比请写成乘法，例如 50% 写成 *0.5');
    if (ch === '"' || ch === "'")
      throw new ExprError('表达式里不能有引号；含特殊字符的键名请用反引号括起来，例如 `生命值(当前)`');
    if ('+-*/^(),'.includes(ch)) {
      push({ t: 'op', v: ch });
      i++;
      continue;
    }
    if (ch === '=' || ch === '<' || ch === '>' || ch === '!' || ch === '?' || ch === ':' || ch === '&' || ch === '|') {
      throw new ExprError(`不支持比较、条件和逻辑运算（“${ch}”）；需要取舍时可以用 min、max、clamp`);
    }
    throw new ExprError(`无法识别的字符 “${ch}”`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 语法分析
// ---------------------------------------------------------------------------

type Node =
  | { k: 'num'; v: number }
  | { k: 'const'; v: number }
  | { k: 'path'; token: PathToken }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

function parse(tokens: Token[]): Node {
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (token: Token | undefined, v: string) => token?.t === 'op' && token.v === v;
  const describe = (token: Token | undefined) =>
    token === undefined ? '表达式结尾' : token.t === 'op' ? `“${token.v}”` : `“${token.text}”`;
  const enter = () => {
    if (++depth > EXPR_MAX_DEPTH) throw new ExprError(`嵌套太深：括号和函数最多嵌套 ${EXPR_MAX_DEPTH} 层`);
  };

  function expression(): Node {
    let node = term();
    while (isOp(peek(), '+') || isOp(peek(), '-')) {
      const op = (tokens[pos++] as { v: string }).v;
      node = { k: 'bin', op, a: node, b: term() };
    }
    return node;
  }

  function term(): Node {
    let node = unaryExpr();
    while (isOp(peek(), '*') || isOp(peek(), '/')) {
      const op = (tokens[pos++] as { v: string }).v;
      node = { k: 'bin', op, a: node, b: unaryExpr() };
    }
    return node;
  }

  function unaryExpr(): Node {
    if (isOp(peek(), '-')) {
      pos++;
      return { k: 'neg', a: unaryExpr() };
    }
    if (isOp(peek(), '+')) {
      pos++;
      return unaryExpr();
    }
    return power();
  }

  function power(): Node {
    const base = primary();
    if (isOp(peek(), '^')) {
      pos++;
      // 右结合，指数可以带符号：2^-1、2^3^2 = 2^9
      return { k: 'bin', op: '^', a: base, b: unaryExpr() };
    }
    return base;
  }

  function primary(): Node {
    const token = peek();
    if (token === undefined) throw new ExprError('表达式不完整：结尾缺少数字或变量');
    if (token.t === 'num') {
      pos++;
      return { k: 'num', v: token.v };
    }
    if (isOp(token, '(')) {
      pos++;
      enter();
      const node = expression();
      if (!isOp(peek(), ')')) throw new ExprError(`括号没有闭合：在 ${describe(peek())} 处缺少 “)”`);
      pos++;
      depth--;
      return node;
    }
    if (token.t === 'path') {
      pos++;
      if (isOp(peek(), '(')) {
        if (!token.bare) {
          throw new ExprError(`“${token.text}” 后面不能直接跟括号：函数名不能带路径；要相乘请写 *`);
        }
        return call(token.segs[0]);
      }
      if (token.bare && token.segs[0] === 'PI') return { k: 'const', v: Math.PI };
      if (token.bare && token.segs[0] === 'E') return { k: 'const', v: Math.E };
      return { k: 'path', token };
    }
    throw new ExprError(`语法错误：${describe(token)} 不能出现在这里`);
  }

  function call(name: string): Node {
    pos++; // (
    enter();
    const args: Node[] = [];
    if (!isOp(peek(), ')')) {
      for (;;) {
        args.push(expression());
        if (args.length > EXPR_MAX_ARGS) {
          // call 的第一个参数是公式路径，上限要按公式自己的参数说
          throw new ExprError(
            name === 'call'
              ? `call 的参数太多：call 最多 ${EXPR_MAX_ARGS - 1} 个参数（不含公式路径）`
              : `函数 ${name} 的参数太多：最多 ${EXPR_MAX_ARGS} 个`,
          );
        }
        if (isOp(peek(), ',')) {
          pos++;
          continue;
        }
        break;
      }
    }
    if (!isOp(peek(), ')')) throw new ExprError(`函数 ${name}( 的括号没有闭合：在 ${describe(peek())} 处缺少 “)”`);
    pos++;
    depth--;
    return { k: 'call', name, args };
  }

  const node = expression();
  if (pos < tokens.length) {
    const rest = tokens[pos];
    if (rest.t !== 'op' || rest.v === '(') {
      throw new ExprError(`缺少运算符：${describe(rest)} 前面需要 + - * / ^ 之一`);
    }
    throw new ExprError(`语法错误：${describe(rest)} 不能出现在这里`);
  }
  return node;
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 预览一个值，用于说明。 */
function preview(value: any): string {
  let text: string;
  try {
    text = JSON.stringify(unescapeEraData(value)) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 按路径记号取值（转义过的原值）。`key` 是解析后的完整路径，`@` 路径带 `@` 前缀。 */
function lookupPath(token: PathToken, env: ExprEnv): { found: boolean; value: any; key: string } {
  const root = token.at ? env.oldStat : env.stat;
  let path = '';
  for (const seg of token.segs) {
    if (FORBIDDEN_KEYS.has(seg)) throw new ExprError(`不能读取 ${seg}`);
    path = resolveKeyPath(root, path, escapeEraKey(seg));
  }
  let node = root;
  let found = true;
  for (const key of _.toPath(path)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ExprError(`不能读取 ${key}`);
    if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, key)) {
      node = node[key];
    } else {
      found = false;
      break;
    }
  }
  return { found, value: node, key: `${token.at ? '@' : ''}${path}` };
}

function readPath(token: PathToken, env: ExprEnv): number {
  const { found, value: node } = lookupPath(token, env);
  if (!found) {
    const name = token.text;
    if (token.bare && (name === 'pi' || name === 'e')) {
      throw new ExprError(`变量 ${name} 不存在。圆周率请写大写 PI，自然常数请写大写 E`);
    }
    if (token.at) throw new ExprError(`本楼开始时变量 ${name.slice(1)} 不存在（${name} 读的是本楼开始前的值）`);
    throw new ExprError(
      `变量 ${name} 不存在。路径用 . 分隔；键名含 - 、空格、括号等字符时用反引号括起该段，例如 角色.\`生命值(当前)\``,
    );
  }
  const value = toOperand(node);
  if (value === null) throw new ExprError(`变量 ${token.text} 不是数字（当前值：${preview(node)}）`);
  return value;
}

const OP_NAMES: Record<string, string> = { '+': '加法', '-': '减法', '*': '乘法', '/': '除法', '^': '乘方' };

// ---------------------------------------------------------------------------
// 存成变量的公式：call(公式路径, 参数…)
// ---------------------------------------------------------------------------

/** `call` 的嵌套层数上限（外层表达式直接调用的公式算第 1 层）。 */
export const EXPR_CALL_MAX_DEPTH = 4;
/** 单个表达式（含它调用的全部公式）执行 `call` 的次数上限。 */
export const EXPR_CALL_MAX_CALLS = 64;
/** 公式的参数个数上限：`call` 的第一个参数是公式路径，其余是参数。 */
export const EXPR_CALL_MAX_PARAMS = EXPR_MAX_ARGS - 1;

/** 求值器保留、不能用 `Era.registerExprFn` 注册的名字。 */
export const RESERVED_EXPR_NAMES: readonly string[] = Object.freeze(['call', 'PI', 'E']);

/** 公式里的参数名：单独一个小写英文字母，a 是第 1 个参数，b 是第 2 个…… */
const PARAM_NAME = /^[a-z]$/;
const paramIndex = (token: PathToken): number =>
  token.bare && PARAM_NAME.test(token.segs[0]) ? token.segs[0].charCodeAt(0) - 97 : -1;

/** 正在执行的公式（调用链上的一层）。 */
interface CallFrame {
  /** 写在 call 里的路径，用于说明。 */
  name: string;
  /** 解析后的完整路径，用于发现递归。 */
  key: string;
  params: number[];
  depth: number;
  parent: CallFrame | null;
}

interface ParsedFormula {
  tree: Node;
  /** 公式用到的参数个数（用到的最大字母序号 + 1）。 */
  arity: number;
}

/** 一次 `evaluateExpr` 的求值上下文。 */
interface EvalScope {
  env: ExprEnv;
  callEnv: ExprCallEnv;
  resolve: ExprFnResolver;
  /** 当前所在的公式；外层表达式为 `null`，此时单个字母照旧是变量路径。 */
  frame: CallFrame | null;
  shared: { calls: number; cache: Map<string, ParsedFormula> };
}

const letters = (count: number): string =>
  Array.from({ length: count }, (_x, i) => String.fromCharCode(97 + i)).join('、');

/** 公式用到的参数个数。`call` 的第一个参数是公式路径，不算参数。 */
function arityOf(node: Node): number {
  switch (node.k) {
    case 'path':
      return paramIndex(node.token) + 1;
    case 'neg':
      return arityOf(node.a);
    case 'bin':
      return Math.max(arityOf(node.a), arityOf(node.b));
    case 'call':
      return node.args.reduce(
        (max, arg, i) => (node.name === 'call' && i === 0 ? max : Math.max(max, arityOf(arg))),
        0,
      );
    default:
      return 0;
  }
}

/** 解析公式文本（转义过的），同一次求值内按文本缓存。限制与 `$expr` 相同。 */
function parseFormula(source: string, scope: EvalScope): ParsedFormula {
  const cached = scope.shared.cache.get(source);
  if (cached) return cached;
  const text = normalizeSymbols(unescapeEraData(source));
  if (text.length > EXPR_MAX_LENGTH) throw new ExprError(`公式太长：最多 ${EXPR_MAX_LENGTH} 个字符`);
  if (text.trim() === '') throw new ExprError('公式是空的');
  const tree = parse(tokenize(text));
  const parsed = { tree, arity: arityOf(tree) };
  scope.shared.cache.set(source, parsed);
  return parsed;
}

function evaluateFormulaCall(node: Extract<Node, { k: 'call' }>, scope: EvalScope): number {
  const target = node.args[0];
  if (target?.k !== 'path') {
    throw new ExprError(
      'call 的第一个参数必须是存放公式的变量路径，其余是参数，例如 call(公式.伤害, 主角.攻击, 敌人.防御)',
    );
  }
  const token = target.token;
  const depth = (scope.frame?.depth ?? 0) + 1;
  if (depth > EXPR_CALL_MAX_DEPTH) {
    throw new ExprError(`call 最多嵌套 ${EXPR_CALL_MAX_DEPTH} 层，${token.text} 是第 ${depth} 层`);
  }
  if (++scope.shared.calls > EXPR_CALL_MAX_CALLS) {
    throw new ExprError(`单个表达式最多执行 ${EXPR_CALL_MAX_CALLS} 次 call，请拆成几条指令`);
  }

  const { found, value, key } = lookupPath(token, scope.env);
  if (!found) {
    throw new ExprError(
      token.at
        ? `本楼开始时公式 ${token.text.slice(1)} 不存在（call 的第一个参数是存放公式文本的变量路径）`
        : `公式 ${token.text} 不存在（call 的第一个参数是存放公式文本的变量路径）`,
    );
  }
  if (typeof value !== 'string') {
    throw new ExprError(
      `${token.text} 不是文本（当前值：${preview(value)}）。call 的第一个参数要指向存放公式文本的变量，例如 call(公式.伤害, 3, 4)`,
    );
  }
  const frames: CallFrame[] = [];
  for (let frame = scope.frame; frame; frame = frame.parent) frames.unshift(frame);
  const self = frames.findIndex(frame => frame.key === key);
  if (self !== -1) {
    const chain = [...frames.slice(self).map(frame => frame.name), token.text].join(' → ');
    throw new ExprError(`公式不能直接或间接调用自己：${chain}`);
  }

  let parsed: ParsedFormula;
  try {
    parsed = parseFormula(value, scope);
  } catch (error) {
    if (error instanceof ExprError) throw new ExprError(`公式 ${token.text} 写错了：${error.message}`);
    throw error;
  }
  const given = node.args.length - 1;
  if (given < parsed.arity) {
    throw new ExprError(
      `公式 ${token.text} 用到了第 ${parsed.arity} 个参数（${letters(parsed.arity)}），但只给了 ${given} 个`,
    );
  }
  if (given > parsed.arity) {
    throw new ExprError(
      parsed.arity === 0
        ? `公式 ${token.text} 不使用参数，但给了 ${given} 个`
        : `公式 ${token.text} 只用到 ${parsed.arity} 个参数（${letters(parsed.arity)}），但给了 ${given} 个`,
    );
  }
  // 参数在调用处求值：参数里的单个字母是调用处所在公式的参数
  const params = node.args.slice(1).map(arg => evaluate(arg, scope));
  const frame: CallFrame = { name: token.text, key, params, depth, parent: scope.frame };
  try {
    return evaluate(parsed.tree, { ...scope, frame });
  } catch (error) {
    if (error instanceof ExprError) throw new ExprError(`公式 ${token.text} 出错：${error.message}`);
    throw error;
  }
}

function evaluate(node: Node, scope: EvalScope): number {
  switch (node.k) {
    case 'num':
    case 'const':
      return node.v;
    case 'path': {
      const params = scope.frame?.params;
      const index = params ? paramIndex(node.token) : -1;
      if (params && index >= 0) {
        // 调用前已按公式检查过参数个数，这里只是兜底
        if (index >= params.length) {
          throw new ExprError(`用到了第 ${index + 1} 个参数 ${node.token.text}，但只给了 ${params.length} 个`);
        }
        return params[index];
      }
      return readPath(node.token, scope.env);
    }
    case 'neg':
      return -evaluate(node.a, scope);
    case 'bin': {
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      let result: number;
      switch (node.op) {
        case '+':
          result = a + b;
          break;
        case '-':
          result = a - b;
          break;
        case '*':
          result = a * b;
          break;
        case '/':
          if (b === 0) throw new ExprError(`除数不能为 0：${show(a)} / 0`);
          result = a / b;
          break;
        default:
          result = checkedPow(a, b);
          break;
      }
      if (!Number.isFinite(result)) {
        throw new ExprError(`${OP_NAMES[node.op]}的结果超出数值范围：${show(a)} ${node.op} ${show(b)}`);
      }
      return result;
    }
    case 'call': {
      // call 由求值器处理，不经过函数解析器（不能注册同名函数）
      if (node.name === 'call') return evaluateFormulaCall(node, scope);
      const target = scope.resolve(node.name);
      if (target === undefined) {
        throw new ExprError(
          node.name === 'random_int' || node.name === 'randint' || node.name === 'dice'
            ? `未知函数 ${node.name}。掷骰请用 roll(最小值, 最大值)，例如 roll(1, 6)`
            : `未知函数 ${node.name}`,
        );
      }
      const count = node.args.length;
      if (node.name === 'random' && count > 0) {
        throw new ExprError(
          'random() 不接受参数，返回 0 到 1 之间的小数；要掷骰请用 roll(最小值, 最大值)，例如 roll(1, 6)',
        );
      }
      if (count < target.minArgs || count > target.maxArgs) {
        const expected =
          target.minArgs === target.maxArgs ? `${target.minArgs}` : `${target.minArgs}～${target.maxArgs}`;
        throw new ExprError(`函数 ${node.name} 需要 ${expected} 个参数，实际给了 ${count} 个`);
      }
      const args = node.args.map(arg => evaluate(arg, scope));
      const result = target.call(args, scope.callEnv);
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        const call = `${node.name}(${args.map(show).join(', ')})`;
        throw new ExprError(
          result === Infinity || result === -Infinity ? `${call} 的结果超出数值范围` : `${call} 的结果不是有限数字`,
        );
      }
      return result;
    }
  }
}

/**
 * 求一个表达式的值。`source` 可以是转义过的（`__DOT__` 等会先还原）。
 * 不会抛出异常：失败时返回 `{ ok: false, reason }`。
 */
export function evaluateExpr(source: string, env: ExprEnv): ExprResult {
  try {
    if (typeof source !== 'string') throw new ExprError('$expr 的值必须是字符串');
    const text = normalizeSymbols(unescapeEraData(source));
    if (text.length > EXPR_MAX_LENGTH) {
      throw new ExprError(`表达式太长：最多 ${EXPR_MAX_LENGTH} 个字符，请拆成几条指令`);
    }
    if (text.trim() === '') throw new ExprError('表达式是空的');
    const tree = parse(tokenize(text));

    let rng: (() => number) | null = null;
    let draws = 0;
    const callEnv: ExprCallEnv = {
      random() {
        if (++draws > EXPR_MAX_DRAWS) {
          throw new ExprError(`单个表达式最多抽取 ${EXPR_MAX_DRAWS} 次随机数，请拆成几条指令`);
        }
        rng ??= createSeededRandom(env.seed);
        return rng();
      },
    };
    const value = evaluate(tree, {
      env,
      callEnv,
      resolve: env.resolveFn ?? resolveBuiltinExprFn,
      frame: null,
      shared: { calls: 0, cache: new Map() },
    });
    if (!Number.isFinite(value)) throw new ExprError('结果不是有限数字');
    return { ok: true, value: finalize(value) };
  } catch (error: any) {
    if (error instanceof ExprError) return { ok: false, reason: error.message };
    // 自定义函数等抛出的其他错误；栈溢出等也在这里兜住
    return { ok: false, reason: `计算出错：${String(error?.message ?? error)}` };
  }
}
