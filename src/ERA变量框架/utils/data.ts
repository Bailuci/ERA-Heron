/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25
 * 目的：新增脚本设置“数组内保留对象”；新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复第三批改动在审查中发现的问题；修复复审中发现的问题等
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 通用数据处理模块
 */

'use strict';

import { settings } from './era_data';
import { Logger } from './log';

const logger = new Logger();

const ESCAPE_MAP: { [key: string]: string } = {
  '.': '__DOT__',
  '"': '__DQUOTE__',
  "'": '__SQUOTE__',
};

/** 只在键中转义的字符：方括号会被 lodash 当作路径的一部分，使键被拆成多级。值中保持原样。 */
const KEY_ESCAPE_MAP: { [key: string]: string } = { ...ESCAPE_MAP, '[': '__LBRACKET__', ']': '__RBRACKET__' };

const UNESCAPE_MAP: { [key: string]: string } = _.invert(KEY_ESCAPE_MAP);

const escapeRegex = new RegExp(Object.keys(ESCAPE_MAP).map(_.escapeRegExp).join('|'), 'g');
const keyEscapeRegex = new RegExp(Object.keys(KEY_ESCAPE_MAP).map(_.escapeRegExp).join('|'), 'g');
const unescapeRegex = new RegExp(Object.values(KEY_ESCAPE_MAP).map(_.escapeRegExp).join('|'), 'g');

/** `名称[0]` 这样的键一直表示数组下标，不能当作普通键转义，否则旧消息中的修改会失效。 */
const INDEX_KEY_REGEX = /^[^[\]]+(?:\[\d+\])+$/;

/** 转义一个键。 */
export function escapeEraKey(key: string): string {
  return INDEX_KEY_REGEX.test(key)
    ? key.replace(escapeRegex, match => ESCAPE_MAP[match])
    : key.replace(keyEscapeRegex, match => KEY_ESCAPE_MAP[match]);
}

/**
 * 某个键对应的路径。早期版本不转义方括号，`好感[小明]` 会被拆成 `好感` 下的 `小明`，`[0]` 是数组下标；
 * 当前变量里是拆开存放的，就继续使用拆开的路径。
 */
export function resolveKeyPath(stat: any, basePath: string, key: string): string {
  const join = (name: string) => (!basePath ? name : name.startsWith('[') ? basePath + name : `${basePath}.${name}`);
  const path = join(key);
  if (!key.includes('__LBRACKET__') || _.has(stat, path)) return path;
  const legacy = join(key.replace(/__LBRACKET__/g, '[').replace(/__RBRACKET__/g, ']'));
  return _.has(stat, legacy) ? legacy : path;
}

/**
 * 递归地转义对象或数组中所有字符串值和键的特殊字符。
 * @param data - 要处理的数据。
 * @returns - 转义后的数据。
 */
export function escapeEraData<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map(item => escapeEraData(item)) as any;
  }
  if (_.isPlainObject(data)) {
    const newObj: { [key: string]: any } = {};
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const escapedKey = escapeEraKey(key);
        newObj[escapedKey] = escapeEraData((data as any)[key]);
      }
    }
    return newObj as any;
  }
  if (typeof data === 'string') {
    return data.replace(escapeRegex, match => ESCAPE_MAP[match]) as any;
  }
  return data;
}

/**
 * 递归地反转义对象或数组中所有字符串值和键的特殊字符。
 * @param data - 要处理的数据。
 * @returns - 反转义后的数据。
 */
export function unescapeEraData<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map(item => unescapeEraData(item)) as any;
  }
  if (_.isPlainObject(data)) {
    const newObj: { [key: string]: any } = {};
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const unescapedKey = key.replace(unescapeRegex, match => UNESCAPE_MAP[match]);
        newObj[unescapedKey] = unescapeEraData((data as any)[key]);
      }
    }
    return newObj as any;
  }
  if (typeof data === 'string') {
    return data.replace(unescapeRegex, match => UNESCAPE_MAP[match]) as any;
  }
  return data;
}

/**
 * 判断一个值是否为“纯粹的对象”（Plain Object）。
 * 数组、null、函数、Date 对象等都会返回 false。
 * @param {*} v - 待检查的值。
 * @returns {boolean} 如果是纯粹的对象则返回 true，否则返回 false。
 */
export const isPO = (v: any): v is Record<string, any> => _.isPlainObject(v);

/**
 * 递归地“净化”一个对象，将其中数组内的数组或对象元素转换为字符串。
 *
 * 这是 ERA 的历史行为：数组里的对象会被存成 JSON 字符串。
 * 当脚本设置 `数组内保留对象` 开启时，本函数不做任何转换，数组可以直接存放对象。
 *
 * @param {*} v - 待净化的值。
 * @param {boolean} [keepObjects] - 是否保留数组内的对象/数组。默认读取脚本设置 `数组内保留对象`。
 * @returns {*} 净化后的值。
 */
export function sanitizeArrays(v: any, keepObjects: boolean = settings.value.数组内保留对象): any {
  if (keepObjects) {
    return v;
  }
  if (Array.isArray(v)) {
    // 如果是数组，则遍历其元素。如果元素是数组或对象，则字符串化它。
    return v.map(e => (Array.isArray(e) || _.isPlainObject(e) ? JSON.stringify(e) : e));
  } else if (_.isPlainObject(v)) {
    // 如果是对象，则递归地对其每个属性值进行净化。
    const o: { [key: string]: any } = {};
    for (const k in v) o[k] = sanitizeArrays(v[k], keepObjects);
    return o;
  } else {
    // 其他类型的值直接返回。
    return v;
  }
}

/**
 * 安全地将一个对象序列化为格式化的 JSON 字符串。
 * 如果序列化失败，不会抛出异常，而是返回一个包含错误信息的字符串。
 * @param {*} o - 待序列化的对象。
 * @returns {string} 成功则返回 JSON 字符串，失败则返回错误提示。
 */
export const J = (o: any): string => {
  try {
    return JSON.stringify(o, null, 2); // 使用 2 个空格进行缩进，提高可读性。
  } catch (e: any) {
    return `<<stringify失败: ${e?.message || e}>>`;
  }
};

/**
 * 使用“新数组覆盖旧数组”的策略来深度合并两个对象。
 * 这是 `_.merge` 的一个变体，专门用于处理模板合并等场景，
 * 在这些场景中，我们希望补丁对象中的数组能够完全替换基础对象中的数组，而不是合并它们。
 * @param {*} base - 基础对象。
 * @param {*} patch - 补丁对象。
 * @returns {*} 合并后的新对象。
 */
export function mergeReplaceArray(base: any, patch: any): any {
  // 使用 _.cloneDeep 确保不修改原始对象。
  return _.mergeWith(_.cloneDeep(base), _.cloneDeep(patch), (a: any, b: any) => {
    // 自定义合并逻辑：如果任一值为数组，则直接返回补丁值（b），从而实现覆盖。
    if (Array.isArray(a) || Array.isArray(b)) return b;
    // 对于非数组类型，返回 undefined 以使用 _.merge 的默认合并行为。
    return undefined;
  });
}

/**
 * 健壮地解析 `EditLog` 的原始数据。
 * `EditLog` 可能以多种格式存在（对象、数组、JSON字符串），此函数旨在统一处理它们。
 * @param {*} raw - 从变量中读取的原始 `EditLog` 数据。
 * @returns {any[]} 解析后的 `EditLog` 数组。如果解析失败或输入无效，则返回一个空数组。
 */
export function parseEditLog(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw]; // 单个对象也视为有效日志
  if (typeof raw === 'string') {
    const s = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''); // 移除代码围栏
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 智能地从字符串中移除各种风格的注释，同时保留字符串字面量中的内容。
 *
 * **工作原理**:
 * 该函数通过一个小型状态机来逐字解析输入字符串。它维护一个 `inString` 状态，
 * 用于判断当前字符是否位于一个双引号包裹的字符串内部。
 *
 * 1. 当检测到进入或退出一个字符串时（通过非转义的双引号 `"`），`inString` 状态会翻转。
 * 2. 如果 `inString` 为 `true`，则所有字符都会被无条件地保留。这确保了字符串值（如 URL）中的 `//` 或 `/*` 不会被当作注释处理。
 * 3. 如果 `inString` 为 `false`，函数会检查是否存在注释标记（`//`, `/*`, `<!--`）。
 * 4. 如果找到注释标记，函数会向前扫描直到注释结束，并跳过这部分内容。
 * 5. 如果没有找到注释，则将当前字符追加到结果中。
 *
 * @param str - 待处理的字符串。
 * @returns 移除了注释的字符串。
 */
export function stripComments(str: string): string {
  if (!str) return '';

  let result = '';
  let inString = false; // 状态：是否在字符串内部

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    // 检查是否进入或退出字符串。忽略转义的双引号 `\"`。
    if (char === '"' && (i === 0 || str[i - 1] !== '\\')) {
      inString = !inString;
    }

    // 如果在字符串内部，直接追加字符，不进行任何注释检查。
    if (inString) {
      result += char;
      continue;
    }

    // --- 只有在字符串外部时，才进行注释检查 ---
    const nextChar = str[i + 1];

    // 检查行注释 `//`
    if (char === '/' && nextChar === '/') {
      const endOfLine = str.indexOf('\n', i + 2);
      if (endOfLine === -1) {
        // 如果没有换行符，说明注释直到字符串末尾，直接结束循环。
        break;
      }
      // 保留换行符，并将索引 `i` 快进到行尾。
      result += '\n';
      i = endOfLine;
      continue;
    }

    // 检查块注释 `/* ... */`
    if (char === '/' && nextChar === '*') {
      const endOfComment = str.indexOf('*/', i + 2);
      if (endOfComment === -1) {
        // 未闭合的注释，忽略剩余所有内容。
        break;
      }
      // 将索引 `i` 快进到注释结尾。
      i = endOfComment + 1;
      continue;
    }

    // 检查 HTML 注释 `<!-- ... -->`
    if (char === '<' && str.substring(i, i + 4) === '<!--') {
      const endOfComment = str.indexOf('-->', i + 4);
      if (endOfComment === -1) {
        // 未闭合的注释。
        break;
      }
      i = endOfComment + 2;
      continue;
    }

    // 如果不是注释，则保留该字符。
    result += char;
  }
  return result;
}

/**
 * 解析一个包含多个串联 JSON 对象的字符串（类似于 JSONL 格式）。
 * 这种格式有时会由 AI 生成。此函数能够逐个提取并解析它们。
 *
 * @param {string} str - 待解析的字符串。
 * @param failures 如果提供，会记录解析失败的片段（包括末尾没有闭合的片段），`at` 是它之前已解析出的对象数。
 * @returns {any[]} 解析出的对象数组。
 */
export function parseJsonl(str: string, failures?: { at: number; text: string }[]): any[] {
  const objects: any[] = [];
  if (!str || typeof str !== 'string') {
    return objects;
  }

  // 在解析 JSON 之前，必须先安全地移除所有注释。
  // 不能使用简单的正则表达式（如 `/\/\/.*/g`），因为它无法区分代码中的注释和字符串值（如 URL "https://..."）中的 `//`，
  // 会错误地破坏 JSON 字符串的结构。`stripComments` 函数通过状态管理解决了这个问题。
  const strWithoutComments = stripComments(str);
  const trimmedStr = strWithoutComments.trim();

  let braceCount = 0; // 花括号平衡计数器
  let startIndex = -1; // 当前 JSON 对象的起始索引
  let inString = false; // 标记是否处于双引号字符串内部

  for (let i = 0; i < trimmedStr.length; i++) {
    const char = trimmedStr[i];

    // 切换 inString 状态，忽略转义的双引号
    if (char === '"' && (i === 0 || trimmedStr[i - 1] !== '\\')) {
      inString = !inString;
    }

    // 如果在字符串内部，则跳过所有花括号的逻辑判断
    if (inString) continue;

    if (char === '{') {
      if (braceCount === 0) {
        // 发现一个新 JSON 对象的开始
        startIndex = i;
      }
      braceCount++;
    } else if (char === '}') {
      if (braceCount > 0) {
        braceCount--;
        if (braceCount === 0 && startIndex !== -1) {
          // 花括号平衡，一个完整的 JSON 对象被找到
          const jsonString = trimmedStr.substring(startIndex, i + 1);
          try {
            const obj = JSON.parse(jsonString);
            objects.push(obj);
          } catch (e: any) {
            // 如果解析失败，记录错误并继续，不中断整个过程
            failures?.push({ at: objects.length, text: jsonString });
            logger.error(`JSONL 解析失败: ${e?.message || e}. 失败的片段: ${jsonString}`, e);
          }
          // 重置状态，准备寻找下一个对象
          startIndex = -1;
        }
      }
    }
  }
  if (braceCount > 0 || inString) {
    failures?.push({ at: objects.length, text: startIndex === -1 ? '' : trimmedStr.substring(startIndex) });
  }
  return objects;
}
