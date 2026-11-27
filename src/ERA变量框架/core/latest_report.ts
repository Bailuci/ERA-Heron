/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：最新 AI 楼的报告：{{ERA-issues}} 把未生效的指令告诉主模型；同步后校验最新状态并广播 era:schemaInvalid
 *       2026-11-27 记录工具调用结果，供 {{ERA-toolResults}}；工具调用的问题同样告诉主模型
 *       2026-11-27 {{ERA-issues}} 只报告主模型写在正文里的指令：排除 <era_extra> 中额外模型的输出与 ApiOps 中的旁路写入（含 Era.applyText）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 最新 AI 楼的报告
 * @description
 * 同步结束后，记下参与计算的 AI 消息上没有生效的指令，供 `{{ERA-issues}}` 宏把最新一条 AI 消息的问题放进下一轮的提示词，
 * 让主模型知道自己上一轮写错了什么（额外模型有自动重试，主模型原本没有任何纠错途径）。
 *
 * 这些报告只在内存里，**不是源数据**：它们完全由“正文 + `ApiOps`”重放得到，丢失后下一次同步会重建。
 * 按“聊天 ID + MK”保存最近计算过的若干楼（删除末尾的消息后，露出来的上一楼不会重新计算，仍能找到它的报告）；
 * 一楼之前的任何楼层变化都会让它重新计算并覆盖旧报告，所以按 MK 查到的报告总与重放结果一致。
 * 当前最新 AI 楼没有报告时，一律当作没有问题。
 * 1.8-2 的 `{{ERA-toolResults}}` 复用这里的记录与“最新 AI 楼”的判断，只需在 `FloorReport` 上增加字段。
 *
 * 同一时机还会校验最新状态是否符合已注册的变量结构（1.7-3 的诊断）：不符合时广播 `era:schemaInvalid`，
 * 同一聊天、同一组问题只广播一次。**放行行为不变**：这里只报告，不拦截任何修改。
 */
'use strict';

import { ERA_EVENT_EMITTER, SchemaInvalidPayload } from '../utils/constants';
import { Logger } from '../utils/log';
import { isUserMessage } from '../utils/message';
import type { CommandIssue } from './crud/diagnostics';
import type { ToolCallResult } from './tools';
import { readMessageKey } from './key/mk';
import type { EraSchemaLike, SchemaRejection } from './schema';
import { diagnoseStat, issueSignature } from './schema_diag';

const logger = new Logger();

/** 一处没有生效的指令。 */
export interface FloorIssue {
  /** `command`：指令本身没有生效（路径不存在、受保护、无法解析等）；`schema`：被变量结构拦截。 */
  kind: 'command' | 'schema';
  /** 指令类型；变量结构拦截时是被拦截的日志操作（`insert` / `update` / `delete`）。 */
  type: string;
  path: string;
  reason: string;
  /** 变量结构拦截时，指令试图写入的值。 */
  value?: any;
  /** 来自哪种指令：正文、旁路写入或钩子；无法解析的块、afterApply 钩子引起的拦截没有。 */
  origin?: 'text' | 'api' | 'hook' | 'tool';
  /**
   * 指令的来源标记：`extra` 是 `<era_extra>` 中额外模型的输出，`apiOps` 是旁路写入（含 `Era.applyText`）。
   * 主模型写在正文里的指令没有。`origin` 决定规则（例如下划线只读），这个字段只决定报告给谁。
   */
  source?: 'extra' | 'apiOps';
}

/** 某一楼计算后的报告。 */
export interface FloorReport {
  chatId: string | undefined;
  mk: string;
  message_id: number;
  issues: FloorIssue[];
  /** 本楼的工具调用结果，按执行顺序。 */
  toolResults: ToolCallResult[];
}

/** 最多保存的报告数（按计算顺序，保留最后计算的楼层）。 */
const MAX_REPORTS = 64;
const reports = new Map<string, FloorReport>();
const reportKey = (chatId: string | undefined, mk: string) => `${chatId ?? ''}\n${mk}`;

/** 把一楼的计算结果整理成报告。 */
export function buildFloorReport(
  chatId: string | undefined,
  mk: string,
  message_id: number,
  commandIssues: CommandIssue[],
  schemaRejections: SchemaRejection[],
  toolResults: ToolCallResult[] = [],
): FloorReport {
  return {
    chatId,
    mk,
    message_id,
    toolResults,
    issues: [
      ...commandIssues.map(({ type, path, reason, origin, source }): FloorIssue => ({
        kind: 'command',
        type,
        path,
        reason,
        origin,
        ...(source === undefined ? {} : { source }),
      })),
      ...schemaRejections.map(({ op, path, message, value, origin, source }): FloorIssue => ({
        kind: 'schema',
        type: op,
        path,
        reason: message,
        ...(value === undefined ? {} : { value }),
        origin,
        ...(source === undefined ? {} : { source }),
      })),
    ],
  };
}

/** 同步写入成功后记录本次计算过的楼层的报告（按楼层顺序）。 */
export function recordFloorReports(list: FloorReport[]): void {
  for (const report of list) {
    const key = reportKey(report.chatId, report.mk);
    reports.delete(key);
    reports.set(key, report);
  }
  while (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value!);
}

/** 清空全部报告（测试用）。 */
export function clearFloorReports(): void {
  reports.clear();
}

/** 当前最新的一条 AI 消息（跳过末尾的用户消息）；没有时返回 `null`。 */
export function findLatestAiMessage(): { mk: string | null; message_id: number } | null {
  let msg = getChatMessages(-1, { include_swipes: true })?.[0];
  while (msg && isUserMessage(msg)) {
    const id = Number(msg.message_id) - 1;
    if (!Number.isInteger(id) || id < 0) return null;
    msg = getChatMessages(id, { include_swipes: true })?.[0];
  }
  if (!msg) return null;
  return { mk: readMessageKey(msg) || null, message_id: Number(msg.message_id) };
}

/** 当前最新 AI 楼的报告；这一楼还没有计算过（例如滑到新的回复、还没有同步）时返回 `null`。 */
export function getLatestReport(): FloorReport | null {
  const current = findLatestAiMessage();
  if (!current?.mk) return null;
  return reports.get(reportKey(SillyTavern.getCurrentChatId?.(), current.mk)) ?? null;
}

/**
 * 报告中属于主模型自己的问题：它写在正文里的指令与无法解析的指令块。
 * 以下都不是主模型这一轮写的，不告诉它：旁路写入（含 `Era.applyText`，虽然按正文规则执行）、钩子，
 * 以及 `<era_extra>` 中额外模型的输出（额外模型有自己的重试，主模型在提示词里也看不到它们）。
 */
export function issuesForModel(report: FloorReport | null): FloorIssue[] {
  if (!report) return [];
  return report.issues.filter(
    issue =>
      issue.source === undefined &&
      (issue.origin === 'text' ||
        (issue.kind === 'command' && (issue.type === 'parse' || issue.type === 'call') && !issue.origin)),
  );
}

const TAGS: Record<string, string> = {
  insert: 'VariableInsert',
  edit: 'VariableEdit',
  delete: 'VariableDelete',
  patch: 'VariablePatch',
  call: 'EraFCall',
};

/** 提示词里最多列出的问题数。 */
const MAX_LISTED = 10;

function preview(value: any, max = 60): string {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text ?? String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeIssue(issue: FloorIssue): string {
  const path = issue.path || '（根）';
  if (issue.kind === 'schema') {
    const value = issue.value === undefined ? '' : `（写入的值 ${preview(issue.value)}）`;
    const reason = issue.reason.split('\n')[0];
    return `${path}：修改不符合变量结构，已被拦截${value}。${reason}`;
  }
  if (issue.type === 'parse') return `指令块无法解析（开头：${path}）：${issue.reason}`;
  return `<${TAGS[issue.type] ?? issue.type}> ${path}：${issue.reason}`;
}

/**
 * 把问题整理成给主模型看的文字；没有问题时返回空字符串。
 * 例：
 * ```
 * 上一条回复中有 2 处变量指令没有生效，相关变量保持原值。需要时请在本次回复中按原因改正后重新写，已经生效的修改不要重复：
 * 1. <VariableEdit> 主角.体力：路径不存在
 * 2. 主角.金钱：修改不符合变量结构，已被拦截（写入的值 "很多"）。Invalid input: expected number, received string
 * ```
 */
export function formatIssuesForModel(issues: FloorIssue[]): string {
  if (issues.length === 0) return '';
  const lines = issues.slice(0, MAX_LISTED).map((issue, index) => `${index + 1}. ${describeIssue(issue)}`);
  if (issues.length > MAX_LISTED) lines.push(`……另有 ${issues.length - MAX_LISTED} 处`);
  return [
    `上一条回复中有 ${issues.length} 处变量指令没有生效，相关变量保持原值。需要时请在本次回复中按原因改正后重新写，已经生效的修改不要重复：`,
    ...lines,
  ].join('\n');
}

/**
 * 把工具调用结果整理成给主模型看的文字；没有调用时返回空字符串。
 * 例：
 * ```
 * 上一条回复中的工具调用结果：
 * 1. 攻击 {"目标":"哥布林"}：成功，结果 {"伤害":7,"击杀":false}
 * 2. 使用道具 {"名称":"药水"}：失败，背包里没有这个道具
 * ```
 */
export function formatToolResultsForModel(results: ToolCallResult[]): string {
  if (results.length === 0) return '';
  const lines = results.slice(0, MAX_LISTED).map((call, index) => {
    const head = `${index + 1}. ${call.name} ${preview(call.args, 120)}`;
    if (!call.ok) return `${head}：失败，${call.error ?? '未知错误'}`;
    return call.result === undefined ? `${head}：成功` : `${head}：成功，结果 ${preview(call.result, 300)}`;
  });
  if (results.length > MAX_LISTED) lines.push(`……另有 ${results.length - MAX_LISTED} 次调用`);
  return ['上一条回复中的工具调用结果：', ...lines].join('\n');
}

/** `{{ERA-toolResults}}` 的内容：最新 AI 楼的工具调用结果。 */
export function describeLatestToolResults(): string {
  try {
    return formatToolResultsForModel(getLatestReport()?.toolResults ?? []);
  } catch (error) {
    logger.warn('describeLatestToolResults', '读取最新楼层的工具调用结果失败', error);
    return '';
  }
}

/** `{{ERA-issues}}` 的内容。 */
export function describeLatestIssues(): string {
  try {
    return formatIssuesForModel(issuesForModel(getLatestReport()));
  } catch (error) {
    logger.warn('describeLatestIssues', '读取最新楼层的指令问题失败', error);
    return '';
  }
}

// ============================ 变量结构诊断的广播 ============================

/** 上一次广播的聊天和问题签名；状态恢复合法后清空，下次再不合法时会重新广播。 */
let lastSchemaInvalid: { chat: string | undefined; signature: string } | null = null;

/**
 * 同步写入后校验最新状态。不合法（且变量非空）时广播 `era:schemaInvalid`，按聊天和问题签名去重。
 * @returns 广播的载荷；没有广播时返回 `null`。
 */
export function checkLatestSchema(
  schema: EraSchemaLike | null | undefined,
  stat: any,
  chatId: string | undefined,
  latestMessage: { mk: string | null; message_id: number },
): SchemaInvalidPayload | null {
  try {
    return checkSchemaState(schema, stat, chatId, latestMessage);
  } catch (error) {
    // 诊断只是报告，出错不能影响同步结果
    logger.warn('checkLatestSchema', '校验最新状态失败', error);
    return null;
  }
}

function checkSchemaState(
  schema: EraSchemaLike | null | undefined,
  stat: any,
  chatId: string | undefined,
  latestMessage: { mk: string | null; message_id: number },
): SchemaInvalidPayload | null {
  if (!schema) {
    lastSchemaInvalid = null;
    return null;
  }
  // 变量为空时通常还没被开场白初始化，不算问题
  if (_.isEmpty(_.omit(stat ?? {}, ['$meta', '$template']))) return null;
  const diagnosis = diagnoseStat(schema, stat);
  if (diagnosis.valid) {
    if (lastSchemaInvalid?.chat === chatId) lastSchemaInvalid = null;
    return null;
  }
  const signature = diagnosis.error !== undefined ? `error:${diagnosis.error}` : issueSignature(diagnosis.issues);
  if (lastSchemaInvalid && lastSchemaInvalid.chat === chatId && lastSchemaInvalid.signature === signature) {
    return null;
  }
  lastSchemaInvalid = { chat: chatId, signature };
  const payload: SchemaInvalidPayload = {
    mk: latestMessage.mk,
    message_id: latestMessage.message_id,
    issues: diagnosis.issues.map(({ kind, path, message }) => ({ kind, path, message })),
    ...(diagnosis.error === undefined ? {} : { error: diagnosis.error }),
  };
  eventEmit(ERA_EVENT_EMITTER.SCHEMA_INVALID, payload);
  return payload;
}
