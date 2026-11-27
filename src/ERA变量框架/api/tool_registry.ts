/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。日期：2026-11-27。
 * 目的：工具调用 <EraFCall> 与自定义公式函数的注册表（路线图 1.8-2）
 *       2026-11-27 公式函数不能叫 call（求值器保留给存成变量的公式）
 *       2026-11-27 因未注册而失败过的名字可以取出，记进元数据（跨页面会话，注册后完全重算）
 */
/**
 * @file ERA 变量框架 - 工具与自定义公式函数的注册表
 * @description
 * 与钩子一样只存在于内存中，由角色卡脚本在加载时注册，并绑定在注册时的角色卡上（群聊按群组）。
 * - 工具：`<EraFCall name="…">参数</EraFCall>` 按名字调用，读取“执行到这里时”的变量，返回普通的变量操作；
 * - 自定义公式函数：在 `$expr` 里像内置函数一样调用，只接收数字、返回数字。
 * 两者都是同步纯函数，重算时重新执行，不新增持久化数据。
 */
'use strict';

import {
  BUILTIN_EXPR_FUNCTION_NAMES,
  ExprError,
  ExprFnResolver,
  ExprFunction,
  resolveBuiltinExprFn,
  RESERVED_EXPR_NAMES,
} from '../core/crud/expr';
import { runGuarded } from '../core/reentry';
import { Logger } from '../utils/log';
import { hasActiveHooks } from './hook_registry';
import { getCurrentOwner } from './schema_registry';

const logger = new Logger();

/** 工具名与公式函数名：字母、数字、下划线和中文，不以数字开头。 */
export const EXTENSION_NAME_PATTERN = /^[A-Za-z_一-鿿][\w一-鿿]*$/;

/** 一个表达式里调用自定义公式函数的次数上限。 */
export const EXPR_FN_MAX_CALLS = 200;

export interface ToolCallContext {
  /** 本楼的 MK，重算时不变。 */
  mk: string;
  /** 执行到这次调用时的变量（反转义、去掉 `$meta` 等保留字段的副本）。 */
  stat: any;
  /** 本楼开始前的变量（副本）。 */
  old_stat: any;
  /** 按 MK、工具名和调用位置取种子的确定性随机数 [0, 1)。 */
  random(): number;
  /** 确定性数学函数，用法同 `Math`。 */
  math: any;
}

export interface ToolDefinition {
  /** 给 AI 看的说明，`{{ERA-tools}}` 会列出。 */
  description?: string;
  /** 参数的 zod schema（有 `safeParse` 即可）；也可以只写一段说明文字，不做校验。 */
  parameters?: any;
  /** 改了 handler 的逻辑时提高版本号，ERA 会完全重算一次。 */
  version?: string | number;
  /** 同步纯函数。返回操作数组，或 `{ operations?, result? }`（`result` 会出现在 `{{ERA-toolResults}}` 里）。 */
  handler: (args: any, ctx: ToolCallContext) => any;
}

export interface RegisteredTool extends ToolDefinition {
  name: string;
  owner: string;
  notified: boolean;
}

export interface ExprFnOptions {
  /** 参数个数：一个数表示固定个数，`[最少, 最多]` 表示范围；默认 0～16 个。 */
  params?: number | [number, number];
  description?: string;
  version?: string | number;
}

export interface RegisteredExprFn {
  name: string;
  fn: (...args: number[]) => number;
  minArgs: number;
  maxArgs: number;
  description?: string;
  version?: string | number;
  owner: string;
}

let tools: RegisteredTool[] = [];
let exprFns: RegisteredExprFn[] = [];

/** 丢弃不属于当前角色卡的注册。 */
function purge() {
  const owner = getCurrentOwner();
  if (tools.some(tool => tool.owner !== owner) || exprFns.some(fn => fn.owner !== owner)) {
    logger.warn('purge', '当前角色卡与注册时不同，已自动注销遗留的工具与公式函数。');
    tools = tools.filter(tool => tool.owner === owner);
    exprFns = exprFns.filter(fn => fn.owner === owner);
  }
}

// ---- 注册时还不认识的名字：记下来，注册后完全重算一次 ----

let unknown: { chat: string | undefined; names: Set<string> } = { chat: undefined, names: new Set() };

/** 记下一次因“未知工具 / 未知函数”失败的调用。 */
export function noteUnknownExtension(kind: 'tool' | 'expr', name: string): void {
  const chat = SillyTavern.getCurrentChatId?.();
  if (unknown.chat !== chat) unknown = { chat, names: new Set() };
  unknown.names.add(`${kind}:${name}`);
}

/**
 * 当前聊天里因未注册而失败过、现在仍未注册的名字（`tool:名字` / `expr:名字`）。
 * 同步时记进元数据的 `Extensions`，值为 `MISSING_EXTENSION_VERSION`：之后它注册时版本不相等，完全重算一次（跨页面会话也有效）。
 */
export function getUnknownExtensions(): string[] {
  if (unknown.chat !== SillyTavern.getCurrentChatId?.()) return [];
  return [...unknown.names].filter(key => {
    const [kind, ...rest] = key.split(':');
    const name = rest.join(':');
    return kind === 'tool' ? !hasTool(name) : !hasExprFn(name);
  });
}

/** 元数据 `Extensions` 里表示“算的时候没有注册”的版本。 */
export const MISSING_EXTENSION_VERSION = 'missing';

/** 该名字是否在当前聊天里因未注册而失败过；查询后清除记录。 */
export function takeUnknownExtension(kind: 'tool' | 'expr', name: string): boolean {
  if (unknown.chat !== SillyTavern.getCurrentChatId?.()) return false;
  return unknown.names.delete(`${kind}:${name}`);
}

// ---- 工具 ----

/** 注册工具，同名的替换。参数无效时返回说明原因的字符串。 */
export function addTool(name: unknown, definition: unknown): RegisteredTool | string {
  if (typeof name !== 'string' || !EXTENSION_NAME_PATTERN.test(name)) {
    return `工具名只能由字母、数字、下划线和中文组成，且不以数字开头（收到：${String(name)}）`;
  }
  const def = definition as ToolDefinition;
  if (!def || typeof def.handler !== 'function') return `工具 ${name} 缺少 handler 函数`;
  const tool: RegisteredTool = {
    name,
    description: typeof def.description === 'string' ? def.description : undefined,
    parameters: def.parameters,
    version: def.version,
    handler: def.handler,
    owner: getCurrentOwner(),
    notified: false,
  };
  tools = tools.filter(other => other.name !== name);
  tools.push(tool);
  logger.log('addTool', `已注册工具 ${name}。`);
  return tool;
}

export function dropTool(tool: RegisteredTool): void {
  tools = tools.filter(other => other !== tool);
}

export function getTool(name: string): RegisteredTool | undefined {
  purge();
  return tools.find(tool => tool.name === name);
}

export function hasTool(name: string): boolean {
  return getTool(name) !== undefined;
}

export function getActiveTools(): RegisteredTool[] {
  purge();
  return _.sortBy(tools, tool => tool.name);
}

// ---- 自定义公式函数 ----

/** 注册公式函数，同名的替换。参数无效时返回说明原因的字符串。 */
export function addExprFn(name: unknown, fn: unknown, options: ExprFnOptions = {}): RegisteredExprFn | string {
  if (typeof name !== 'string' || !EXTENSION_NAME_PATTERN.test(name)) {
    return `函数名只能由字母、数字、下划线和中文组成，且不以数字开头（收到：${String(name)}）`;
  }
  if (name === 'call') return 'call 用于调用存成变量的公式（call(公式路径, 参数…)），不能注册为公式函数';
  if (BUILTIN_EXPR_FUNCTION_NAMES.includes(name) || RESERVED_EXPR_NAMES.includes(name)) {
    return `${name} 是内置函数或常量，不能重新定义`;
  }
  if (typeof fn !== 'function') return `公式函数 ${name} 必须是函数`;
  const params = options?.params;
  let [minArgs, maxArgs] = [0, 16];
  if (typeof params === 'number') [minArgs, maxArgs] = [params, params];
  else if (Array.isArray(params)) [minArgs, maxArgs] = [Number(params[0]), Number(params[1])];
  if (!Number.isInteger(minArgs) || !Number.isInteger(maxArgs) || minArgs < 0 || maxArgs > 16 || minArgs > maxArgs) {
    return `公式函数 ${name} 的 params 必须是 0～16 的整数，或 [最少, 最多]`;
  }
  const entry: RegisteredExprFn = {
    name,
    fn: fn as RegisteredExprFn['fn'],
    minArgs,
    maxArgs,
    description: typeof options?.description === 'string' ? options.description : undefined,
    version: options?.version,
    owner: getCurrentOwner(),
  };
  exprFns = exprFns.filter(other => other.name !== name);
  exprFns.push(entry);
  logger.log('addExprFn', `已注册公式函数 ${name}。`);
  return entry;
}

export function dropExprFn(entry: RegisteredExprFn): void {
  exprFns = exprFns.filter(other => other !== entry);
}

export function hasExprFn(name: string): boolean {
  purge();
  return exprFns.some(fn => fn.name === name);
}

export function getActiveExprFns(): RegisteredExprFn[] {
  purge();
  return _.sortBy(exprFns, fn => fn.name);
}

/** 调用次数按表达式计（每个表达式有自己的 callEnv）。 */
const callCounts = new WeakMap<object, number>();

function wrapExprFn(entry: RegisteredExprFn): ExprFunction {
  return {
    minArgs: entry.minArgs,
    maxArgs: entry.maxArgs,
    call(args, env) {
      const count = (callCounts.get(env) ?? 0) + 1;
      callCounts.set(env, count);
      if (count > EXPR_FN_MAX_CALLS) {
        throw new ExprError(`单个表达式最多调用自定义函数 ${EXPR_FN_MAX_CALLS} 次，请拆成几条指令`);
      }
      const result = runGuarded(`公式函数 ${entry.name} `, () => entry.fn(...args));
      if (result && typeof (result as any).then === 'function') {
        throw new ExprError(`公式函数 ${entry.name} 必须是同步函数，不能返回 Promise`);
      }
      return result;
    },
  };
}

/**
 * 表达式用的函数解析器：已注册的公式函数优先（以后新增同名内置函数也不改变旧卡的结果），其次是内置函数。
 * 都找不到时记下这个名字，注册后完全重算。
 */
export function createExprFnResolver(): ExprFnResolver {
  const registered = new Map(getActiveExprFns().map(entry => [entry.name, wrapExprFn(entry)]));
  return name => {
    const found = registered.get(name) ?? resolveBuiltinExprFn(name);
    if (found === undefined) noteUnknownExtension('expr', name);
    return found;
  };
}

// ---- 汇总 ----

/** 当前生效的工具与公式函数的标识，带版本号；变化（新增或提高版本）时需要完全重算。 */
export function getExtensionKeys(): string[] {
  return [
    ...getActiveTools().map(tool => `tool:${tool.name}@${tool.version ?? 0}`),
    ...getActiveExprFns().map(fn => `expr:${fn.name}@${fn.version ?? 0}`),
  ];
}

/** 当前工具与公式函数的版本：`{ 'tool:名字': '版本' }`。记在聊天的元数据里，跨页面会话比较（见 `core/sync.ts`）。 */
export function getExtensionVersions(): Record<string, string> {
  return Object.fromEntries([
    ...getActiveTools().map(tool => [`tool:${tool.name}`, String(tool.version ?? 0)]),
    ...getActiveExprFns().map(fn => [`expr:${fn.name}`, String(fn.version ?? 0)]),
  ]);
}

/**
 * 是否有任何会读取“执行中途的状态”或依赖指令细节的扩展：钩子、工具、公式函数。
 * 有时旁路写入不能压缩，重算的起点也要前移（见 `core/sync.ts` 的 `widenRecalcForHooks`）。
 */
export function hasActiveExtensions(): boolean {
  if (hasActiveHooks()) return true;
  purge();
  return tools.length > 0 || exprFns.length > 0;
}

/** 测试用：清空全部注册。 */
export function clearExtensions(): void {
  tools = [];
  exprFns = [];
  unknown = { chat: undefined, names: new Set() };
}
