/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。日期：2026-11-27。
 * 目的：执行工具调用 <EraFCall>（路线图 1.8-2）
 *       2026-11-28 工具返回单个操作对象时报错
 */
/**
 * @file ERA 变量框架 - 工具调用
 * @description
 * `<EraFCall>` 在本楼指令的执行顺序中按位置执行：工具读到的是“执行到这里时”的变量，返回普通的变量操作，
 * 这些操作随后与正文指令一样经过 schema、`$meta` 保护和日志。重算就是重跑，不保存任何额外数据。
 */
'use strict';

import { getTool, noteUnknownExtension } from '../api/tool_registry';
import { escapeEraData, unescapeEraData } from '../utils/data';
import { detMath } from '../utils/det_math';
import { EraCommand } from '../utils/message';
import { createSeededRandom } from '../utils/seeded_random';
import { runGuarded } from './reentry';
import { stripReserved } from './schema';

/** 单楼最多执行的工具调用数。 */
export const TOOL_MAX_CALLS_PER_FLOOR = 50;
/** 一次调用最多产出的操作数。 */
export const TOOL_MAX_OPERATIONS = 200;

/** 一次工具调用的结果，供 `era:toolResult` 与 `{{ERA-toolResults}}` 使用。 */
export interface ToolCallResult {
  name: string;
  args: any;
  ok: boolean;
  /** 工具返回的 `result`（给 AI 看的结果）。 */
  result?: any;
  /** 失败原因。 */
  error?: string;
  /** 产出的操作数。 */
  operations: number;
}

const toJson = (value: any): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const describeError = (error: any): string => {
  try {
    return String(error?.message || error) || '未知错误';
  } catch {
    return '未知错误';
  }
};

/** 把工具返回的操作转换成指令。格式与 `Era.commit` 相同：`{ insert } / { edit } / { delete } / { patch }`。 */
function toCommands(operations: any[], exprBase: string, source?: EraCommand['source']): EraCommand[] {
  if (operations.length > TOOL_MAX_OPERATIONS) {
    throw new Error(`一次调用最多产出 ${TOOL_MAX_OPERATIONS} 个操作`);
  }
  return operations.map((operation, i) => {
    const entries = Object.entries(operation ?? {});
    const [type, data] = entries[0] ?? [];
    if (entries.length !== 1 || !['insert', 'edit', 'delete', 'patch'].includes(type)) {
      throw new Error('每个操作必须是 { insert } / { edit } / { delete } / { patch } 之一');
    }
    const blocks = _.castArray(toJson(data));
    return {
      type: type as EraCommand['type'],
      data: type === 'patch' ? blocks : escapeEraData(blocks),
      origin: 'tool',
      exprId: `${exprBase}|${i}`,
      ...(source ? { source } : {}),
    } as EraCommand;
  });
}

/**
 * 执行一次工具调用。不会抛出异常：失败时 `result.ok` 为 `false`，`commands` 为空。
 * @param stat 执行到这里时的变量（转义过的，不会被修改）。
 * @param oldStat 本楼开始前的变量。
 * @param seed 本次调用的随机数种子，重算时不变。
 */
export function runToolCall(
  call: { name: string; args: any },
  stat: any,
  oldStat: any,
  mk: string,
  seed: string,
  /** 调用的来源标记（`extra`、`apiOps`），产出的操作继承它，只用于报告。 */
  source?: EraCommand['source'],
): { commands: EraCommand[]; result: ToolCallResult } {
  const result: ToolCallResult = { name: call.name, args: call.args, ok: false, operations: 0 };
  const tool = getTool(call.name);
  if (!tool) {
    noteUnknownExtension('tool', call.name);
    result.error = `未知工具 ${call.name}`;
    return { commands: [], result };
  }
  try {
    let args = toJson(call.args);
    const parameters = tool.parameters;
    if (parameters && typeof parameters.safeParse === 'function') {
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error?.issues?.[0];
        const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
        throw new Error(`参数不合法：${where}${issue?.message ?? String(parsed.error)}`);
      }
      args = parsed.data;
    }
    const view = (value: any) => toJson(stripReserved(unescapeEraData(value)));
    const output = runGuarded(`工具 ${tool.name} `, () =>
      tool.handler(args, {
        mk,
        stat: view(stat),
        old_stat: view(oldStat),
        random: createSeededRandom(seed),
        math: detMath,
      }),
    );
    if (output && typeof output.then === 'function') {
      output.then(
        () => {},
        () => {},
      );
      throw new Error('工具必须是同步函数，不能返回 Promise');
    }
    // 直接返回单个操作（如 `return { edit: {…} }`）既不是数组也没有 operations：以前被当成“没有操作”而显示成功
    if (
      _.isPlainObject(output) &&
      !('operations' in output) &&
      ['insert', 'edit', 'delete', 'patch', 'call'].some(key => key in output)
    ) {
      throw new Error('工具返回了单个操作对象，请返回操作数组，或 { operations: [...], result }');
    }
    const operations = Array.isArray(output) ? output : _.castArray(output?.operations ?? []);
    const commands = toCommands(_.compact(operations), seed, source);
    // 先序列化结果：无法序列化时整次调用失败，而不是操作被丢弃却显示成功
    const value = !Array.isArray(output) && output?.result !== undefined ? toJson(output.result) : undefined;
    result.ok = true;
    result.operations = commands.length;
    if (value !== undefined) result.result = value;
    return { commands, result };
  } catch (error: any) {
    result.error = describeError(error);
    return { commands: [], result };
  }
}
