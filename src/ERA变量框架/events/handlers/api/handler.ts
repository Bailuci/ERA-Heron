/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：API 写入与 forceSync 在事件队列中等待完成；新增脚本设置“API写入不修改消息”；修复第二批改动在审查中发现的问题；新增额外模型分步更新、等待式提交、试算与变量结构说明等；更新过时的注释与路径示例；
 *       2026-11-26 Era.applyText 经 commit 提交文本中的指令；新聊天设置了指令外层标签时，追加到正文的指令块包在外层标签里
 *       2026-11-27 atomic 预检与实际写入使用相同的压缩参数，含 $expr 的写入预检与落盘的骰点一致；Era.commit 可以写工具调用 { call }；幂等键 key
 *       2026-11-28 写入事件追加指令块时保留正文里的宏；问题说明不重复路径
 *       2026-11-28 追加到正文不会执行时改为旁路写入
 *       2026-11-28 旁路写入的位置改用 apiPositionOf
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 外部事件 API 实现模块
 * @description
 * 该模块实现 `era:*` 请求事件的处理器。外部脚本与 ERA 交互有两种方式：
 * - 用酒馆的 `eventEmit` 发送 `era:*` 事件（本文件）；
 * - 调用全局接口 `Era`（`api/global.ts`），例如 `Era.commit`、`Era.getVarsAt`。`Era.commit` 也经由本文件的 `commit` 执行。
 *
 * `index.ts` 监听这些事件，推入事件队列（`events/queue.ts`），队列再调用本文件中对应的处理器。
 *
 * 写入有两条路径：
 * - 默认设置下，把对应的指令块（`<VariableInsert>` 等）追加到最后一条 AI 消息的正文末尾，
 *   再调度 `era:apiWrite` 触发同步，像 AI 写的指令一样计算；
 * - 开启 `API写入不修改消息`，或使用 `era:commit` / `Era.commit` 时，写入保存在 `ERAMetaData.ApiOps`
 *   （旁路写入，见 `core/api_ops.ts`），挂在目标楼层上，正文不变。
 *
 * `*ByPath` 事件的路径只能用点分隔的对象键：处理器用 `_.set({}, path, value)` 把路径转成指令块，
 * 带 `[n]` 的路径会变成数组值，导致整个数组被替换或删除。操作数组元素请用 `era:patch`。
 */

import { getStatAtMK, getStatsBetweenMKs } from '../../../core/snapshot';
import { getActiveSchema } from '../../../api/schema_registry';
import { hasActiveExtensions } from '../../../api/tool_registry';
import { appendApiOp, createApiOp, createTextApiOps } from '../../../core/api_ops';
import { createFloorSimulator } from '../../../core/simulate';
import { findApiWriteTarget, readMessageKey } from '../../../core/key/mk';
import { markPendingApiWrite } from '../../../core/pending_api';
import { resyncStateOnHistoryChange } from '../../../core/sync';
import { getCurrentParseOptions } from '../../../core/version';
import { API_OPS_PATH, ApiOp, SEL_PATH, WriteDonePayload } from '../../../utils/constants';
import { J, unescapeEraData } from '../../../utils/data';
import { getEraData, removeMetaFields, settings, updateEraMetaData } from '../../../utils/era_data';
import { Logger } from '../../../utils/log';
import {
  ApiPosition,
  apiPositionOf,
  extractExecutedBlocks,
  findLastAiMessage,
  getRawMessageContent,
  isUserMessage,
  updateMessageContent,
} from '../../../utils/message';
import { debouncedEmitApiWrite, emitQueryResultEvent, emitWriteDoneEvent } from '../../emitters/events';
import { EventJob } from '../../merger';
import { ActionsTaken, DispatcherPayload } from '../../types';
import { handleSyncEvent } from '../sync';
import { describeIssue } from '../../../core/crud/diagnostics';
import { ApiTicket, assertTicket, registerTicket } from './tickets';

const logger = new Logger();
let lastWriteDonePayload: WriteDonePayload | null = null;
eventOn('era:writeDone', (payload: WriteDonePayload) => {
  lastWriteDonePayload = payload;
});

// API 写入任务的接口定义
interface ApiWriteJob {
  blockTag: 'VariableInsert' | 'VariableEdit' | 'VariableDelete' | 'VariablePatch';
  blockContent: object;
}

// ==================================================================
// API 事件参考
// (事件名称的常量定义见于 `constants.ts` 中的 `ERA_API_EVENTS` 对象)
// ==================================================================

/**
 * @section API Event: 'era:insertByObject'
 * @description 通过一个对象，非破坏性地插入新变量。只会写入不存在的路径。
 * @param {object} detail - 要插入的变量对象。
 * @example
 * eventEmit('era:insertByObject', {
 *   player: { name: "勇者", hp: 100, inventory: [] }
 * });
 */

/**
 * @section API Event: 'era:updateByObject'
 * @description 通过一个对象，修改已存在的变量。如果路径不存在，则忽略。
 * @param {object} detail - 要更新的变量对象。
 * @example
 * eventEmit('era:updateByObject', {
 *   player: { hp: 120, status: 'blessed' }
 * });
 */

/**
 * @section API Event: 'era:insertByPath'
 * @description 通过指定路径和值，非破坏性地插入一个新变量。
 * @param {object} detail - 包含路径和值的对象。
 * @param {string} detail.path - 变量的路径，只能用点分隔的对象键（不要用 `[n]`，数组元素请用 `era:patch`）。
 * @param {*} detail.value - 要插入的值。
 * @example
 * eventEmit('era:insertByPath', {
 *   path: 'player.inventory.生命药水',
 *   value: { count: 3 }
 * });
 * // 向数组追加元素
 * eventEmit('era:patch', [{ op: 'insert', path: '/player/list/-', value: '生命药水' }]);
 */

/**
 * @section API Event: 'era:updateByPath'
 * @description 通过指定路径和值，修改一个已存在的变量。
 * @param {object} detail - 包含路径和值的对象。
 * @param {string} detail.path - 变量的路径。
 * @param {*} detail.value - 要设置的新值。可以是直接的值，也可以是运算表达式。
 * @example
 * eventEmit('era:updateByPath', {
 *   path: 'player.hp',
 *   value: '+=10'
 * });
 */

/**
 * @section API Event: 'era:deleteByObject'
 * @description 通过一个对象，删除已存在的变量。
 * @param {object} detail - 描述要删除路径的结构。值的结构决定了删除行为。
 * @example
 * // 准备删除 player.gold。指令中 gold 的值必须是空对象 {}
 * eventEmit('era:deleteByObject', { player: { gold: {} } });
 *
 * // 准备删除整个 player 对象。
 * eventEmit('era:deleteByObject', { player: {} });
 *
 * // **重要**: 如果 player 对象包含 gold 和 mana 两个属性，
 * // 以下指令只会删除 gold 和 mana，而 player 对象本身会被保留（变为空对象）。
 * // 这与 `eventEmit('era:deleteByObject', { player: {} })` 的效果是不同的。
 * eventEmit('era:deleteByObject', { player: { gold: {}, mana: {} } });
 */

/**
 * @section API Event: 'era:deleteByPath'
 * @description 通过指定路径，删除一个已存在的变量。
 * @param {object} detail - 包含路径的对象。
 * @param {string} detail.path - 要删除的变量的路径，只能用点分隔的对象键。
 * @example
 * eventEmit('era:deleteByPath', { path: 'player.inventory.生命药水' });
 * // 删除数组的第一个元素：用 era:patch，`deleteByPath('list[0]')` 会删除整个数组
 * eventEmit('era:patch', [{ op: 'remove', path: '/player/list/0' }]);
 */

// ==================================================================
// 内部核心函数
// ==================================================================

/**
 * 执行一次 API 写入操作。
 * 它将指定的变量修改块追加到最后一条 AI 消息的末尾，然后调度一个 'era:apiWrite' 事件。
 * @param {ApiWriteJob} job - 要执行的写入任务。
 */
async function performApiWrite(job: ApiWriteJob) {
  if (settings.value.API写入不修改消息) {
    await performApiOp(job);
    return;
  }

  // 1. 生成指令块。新聊天设置了指令外层标签时，标签外的指令不执行，因此包在外层标签里
  const contentString = J(job.blockContent);
  const outerTag = getCurrentParseOptions()?.outerTag;
  const inner = `<${job.blockTag}>\n${contentString}\n</${job.blockTag}>`;
  const block = outerTag ? `\n<${outerTag}>\n${inner}\n</${outerTag}>` : `\n${inner}`;

  // 2. 查找目标消息并追加内容
  const lastAiMessage = findLastAiMessage();
  if (!lastAiMessage) {
    logger.warn('performApiWrite', '找不到任何 AI 消息，无法执行 API 写入。');
    return;
  }

  // 末楼正在生成（流式输出、重新生成）时，追加到它正文里的指令块会被后面的输出覆盖掉：改为旁路写入，
  // 由它按“正在输出的消息除外”的规则选目标
  const generating = typeof builtin !== 'undefined' && !!builtin.duringGenerating?.();
  if (generating && Number(lastAiMessage.message_id) === Number(getChatMessages(-1)?.[0]?.message_id)) {
    logger.warn('performApiWrite', '最后一条 AI 消息正在生成，追加到正文的指令块会被覆盖，改为旁路写入');
    await performApiOp(job);
    return;
  }

  // 必须取未展开宏的原文：getMessageContent 会把 {{user}}、{{char}} 换成当前的名字，写回去就固定下来了
  const originalContent = getRawMessageContent(lastAiMessage);
  const newContent = originalContent + block;

  // 正文里有没闭合的思考标签（回复被截断）时，追加在末尾的指令块会被一起遮蔽、不执行：改为旁路写入
  if (extractExecutedBlocks(newContent).length <= extractExecutedBlocks(originalContent).length) {
    logger.warn('performApiWrite', '追加到正文的指令块不会被执行（正文里可能有没闭合的思考标签），改为旁路写入');
    await performApiOp(job);
    return;
  }

  logger.debug('performApiWrite', `实时写入 API 任务 (${job.blockTag}) 到消息 ID ${lastAiMessage.message_id}...`);

  // 3. 实时更新消息内容
  await updateMessageContent(lastAiMessage, newContent);
  markPendingApiWrite(readMessageKey(lastAiMessage));

  // 4. 调用防抖函数来调度写入事件的发送
  debouncedEmitApiWrite();
}

const OP_TYPES = {
  VariableInsert: 'insert',
  VariableEdit: 'edit',
  VariableDelete: 'delete',
  VariablePatch: 'patch',
} as const;

/**
 * 执行一次旁路写入：不修改消息正文，把写入保存到 `ERAMetaData.ApiOps`，再调度 `era:apiWrite` 触发同步。
 * 目标消息不放在事件里（相邻的 SYNC 事件会被合并），同步时由 `rev > applied` 推出。
 */
async function performApiOp(job: ApiWriteJob) {
  const chatId = SillyTavern.getCurrentChatId?.();
  try {
    const target = await findApiWriteTarget();
    if (!target) throw new Error('没有可以写入的消息');
    if (SillyTavern.getCurrentChatId?.() !== chatId) throw new Error('聊天已切换');

    const op = createApiOp(
      OP_TYPES[job.blockTag],
      job.blockContent,
      apiPositionOf(target.msg),
      settings.value.繁体转简体,
    );
    const compact = getActiveSchema() === null && !hasActiveExtensions();
    await updateEraMetaData(meta => {
      _.set(meta, [API_OPS_PATH, target.mk], appendApiOp(_.get(meta, [API_OPS_PATH, target.mk]), op, compact));
      return meta;
    });
    debouncedEmitApiWrite();
  } catch (error: any) {
    logger.warn('performApiOp', `API 写入失败: ${error?.message ?? error}`, job);
  }
}

/** `era:commit` / `Era.commit` 中的一项写入。 */
export type CommitOperation =
  | { insert: object }
  | { edit: object }
  | { delete: object }
  | { patch: object[] }
  | { call: { name: string; args?: any } };

export interface CommitDetail {
  operations: CommitOperation | CommitOperation[];
  /** 写到哪一楼；默认是最后一条 AI 消息。 */
  mk?: string;
  message_id?: number;
  /** 有任何一项不能生效时，全部不写入。 */
  atomic?: boolean;
  /** 幂等键：目标楼已有同 key 的写入时跳过这次提交，结果带 `skipped: true`。 */
  key?: string;
}

/**
 * `Era.applyText` 经由 `era:commit` 的队列提交：`text` 中的指令在执行时按目标聊天的解析方式解析，
 * 保存为 `origin: 'text'` 的旁路写入。
 */
export interface TextCommitDetail extends Omit<CommitDetail, 'operations'> {
  text: string;
}

const isTextCommit = (detail: any): detail is TextCommitDetail =>
  !!detail && typeof detail.text === 'string' && detail.operations === undefined;

/** 把 `Era.applyText` 的文本解析成旁路写入；没有可以执行的指令时抛出异常，`atomic` 时有无法解析的块也抛出。 */
function textToApiOps(detail: TextCommitDetail, at: ApiPosition): ApiOp[] {
  const { ops, issues } = createTextApiOps(detail.text, at, settings.value.繁体转简体, getCurrentParseOptions());
  if (detail.atomic && issues.length > 0) throw new Error(`提交被放弃: ${describeIssue(issues[0])}`);
  if (ops.length === 0) {
    throw new Error(issues.length > 0 ? `文本中的指令无法解析: ${issues[0].reason}` : '文本中没有可以执行的指令');
  }
  return ops;
}

/** 把 `era:commit` 的写入转换成旁路写入。 */
export function toApiOps(operations: CommitDetail['operations'], at: ApiPosition): ApiOp[] {
  const list = _.compact(_.castArray(operations));
  if (list.length === 0) throw new Error('没有要写入的内容');
  return list.map(operation => {
    const entries = Object.entries(operation ?? {});
    const [type, data] = entries[0] ?? [];
    if (entries.length !== 1 || !['insert', 'edit', 'delete', 'patch', 'call'].includes(type)) {
      throw new Error('每项写入必须是 { insert } / { edit } / { delete } / { patch } / { call } 之一');
    }
    if (type === 'call') {
      const call = data as any;
      if (!_.isPlainObject(call) || typeof call.name !== 'string' || call.name === '') {
        throw new Error('{ call } 必须是 { name: 工具名, args?: 参数 }');
      }
      return createApiOp('call', { name: call.name, args: call.args ?? {} }, at, false);
    }
    return createApiOp(type as ApiOp['type'], data, at, settings.value.繁体转简体);
  });
}

/** 按顺序提交一组写入：不修改正文，可以指定楼层，可以要求全部成功。也用于 `Era.applyText`（`detail.text`）。 */
export async function commit(detail: CommitDetail | TextCommitDetail, ticket?: ApiTicket): Promise<void> {
  const chatId = SillyTavern.getCurrentChatId?.();
  try {
    assertTicket(ticket, chatId);
    const key = detail.key;
    if (key !== undefined && (typeof key !== 'string' || key === '')) throw new Error('key 必须是非空字符串');
    const prepare = (msg: any) =>
      (isTextCommit(detail)
        ? textToApiOps(detail, apiPositionOf(msg))
        : toApiOps((detail as CommitDetail)?.operations, apiPositionOf(msg))
      ).map(op => (key === undefined ? op : { ...op, key }));
    const hasKey = (meta: any, mk: string) =>
      key !== undefined && _.some(_.get(meta, [API_OPS_PATH, mk, 'ops']), (op: ApiOp) => op.key === key);
    prepare({ mes: '' }); // 格式有误时，不做任何改动就报告

    let target = await findApiWriteTarget(_.pick(detail, ['mk', 'message_id']));
    if (!target) throw new Error('没有可以写入的消息');
    assertTicket(ticket, chatId);

    // 预检与实际写入必须用同一个压缩参数：压缩会改变含 $expr 的写入的执行序号，也就改变骰点
    const compactOps = () => getActiveSchema() === null && !hasActiveExtensions();
    if (detail.atomic && !hasKey(getEraData().meta, target.mk)) {
      // 先算完之前的写入、刚到的消息和未完成的回滚，否则会基于过期的状态判断
      await resyncStateOnHistoryChange();
      assertTicket(ticket, chatId);
      target = await findApiWriteTarget({ mk: target.mk });
      const simulator = target && (await createFloorSimulator(target.msg));
      if (!target || !simulator) throw new Error('该楼之前的日志已折叠，无法预先检查；请不要使用 atomic');
      const { problems } = await simulator.run({ ops: prepare(target.msg), compact: compactOps() });
      if (problems.length > 0) throw new Error(`提交被放弃: ${describeIssue(problems[0])}`);
    }

    const { msg, mk } = target;
    const ops = prepare(msg);
    const compact = compactOps();
    let rev = 0;
    assertTicket(ticket, chatId);
    let skipped = false;
    await updateEraMetaData(meta => {
      assertTicket(ticket, chatId);
      if (hasKey(meta, mk)) {
        skipped = true;
        rev = _.get(meta, [API_OPS_PATH, mk, 'rev'], 0);
        return meta;
      }
      for (const op of ops) {
        const record = appendApiOp(_.get(meta, [API_OPS_PATH, mk]), op, compact);
        _.set(meta, [API_OPS_PATH, mk], record);
        rev = record.rev;
      }
      return meta;
    });
    if (ticket) {
      ticket.skipped = skipped;
      registerTicket(ticket, mk, rev);
    }
    debouncedEmitApiWrite();
  } catch (error: any) {
    logger.warn('commit', `提交失败: ${error?.message ?? error}`, detail);
    ticket?.reject(error);
  }
}

/** **【处理器】** 处理 `era:patch` 事件。 */
export async function patch(operations: object | object[]) {
  await performApiWrite({ blockTag: 'VariablePatch', blockContent: _.castArray(operations) });
}

// ==================================================================
// 事件处理器实现 (由 event_queue.ts 调用)
// ==================================================================

/**
 * **【处理器】** 处理 `era:insertByObject` 事件。
 * @param {object} data - 从事件的 `detail` 中获取的变量对象。
 */
export async function insertByObject(data: object) {
  await performApiWrite({ blockTag: 'VariableInsert', blockContent: data });
}

/**
 * **【处理器】** 处理 `era:updateByObject` 事件。
 * @param {object} data - 从事件的 `detail` 中获取的变量对象。
 */
export async function updateByObject(data: object) {
  await performApiWrite({ blockTag: 'VariableEdit', blockContent: data });
}

/**
 * **【处理器】** 处理 `era:insertByPath` 事件。
 * @param {string} path - 从事件 `detail` 的 `path` 属性获取。
 * @param {*} value - 从事件 `detail` 的 `value` 属性获取。
 */
export async function insertByPath(path: string, value: any) {
  const block = _.set({}, path, value);
  await performApiWrite({ blockTag: 'VariableInsert', blockContent: block });
}

/**
 * **【处理器】** 处理 `era:updateByPath` 事件。
 * @param {string} path - 从事件 `detail` 的 `path` 属性获取。
 * @param {*} value - 从事件 `detail` 的 `value` 属性获取。
 */
export async function updateByPath(path: string, value: any) {
  const block = _.set({}, path, value);
  await performApiWrite({ blockTag: 'VariableEdit', blockContent: block });
}

/**
 * **【处理器】** 处理 `era:deleteByObject` 事件。
 * @param {object} data - 从事件的 `detail` 中获取的变量结构。
 */
export async function deleteByObject(data: object) {
  await performApiWrite({ blockTag: 'VariableDelete', blockContent: data });
}

/**
 * **【处理器】** 处理 `era:deleteByPath` 事件。
 * @param {string} path - 从事件 `detail` 的 `path` 属性获取。
 */
export async function deleteByPath(path: string) {
  // 对于删除操作，我们用一个空对象作为值来表示删除该路径的意图
  const block = _.set({}, path, {});
  await performApiWrite({ blockTag: 'VariableDelete', blockContent: block });
}

/**
 * **【处理器】** 处理 `era:getCurrentVars` 事件。
 * 获取当前最新的变量状态，并通过 `era:queryResult` 事件发回结果。
 * @param {any} detail - 原始请求的 detail 对象。
 */
export function handleGetCurrentVars(detail: any) {
  logger.debug('handleGetCurrentVars', `请求获取当前变量。`);
  let result: any;
  try {
    const { stat, meta } = getEraData();
    const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);
    const lastMk = selectedMks[selectedMks.length - 1] || '';
    const lastMessageId = selectedMks.length - 1;
    const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: false });
    const lastMessage = messages[lastMessageId];

    result = {
      mk: lastMk,
      message_id: lastMessageId,
      is_user: lastMessage ? isUserMessage(lastMessage) : false,
      stat: unescapeEraData(stat),
      statWithoutMeta: unescapeEraData(removeMetaFields(stat)),
    };
  } catch (error) {
    const errorMessage = `获取当前变量时发生错误: ${error instanceof Error ? error.message : String(error)}`;
    logger.error('handleGetCurrentVars', errorMessage);
    result = { error: errorMessage };
  }
  emitQueryResultEvent('getCurrentVars', detail, result);
}

/**
 * **【处理器】** 处理 `era:getSnapshotAtMk` 事件。
 * 计算指定 MK 的历史快照，并通过 `era:queryResult` 事件发回结果。
 * @param {any} detail - 从事件中获取的 `detail` 对象，应包含 `mk`。
 */
export function handleGetSnapshotAtMk(detail: any) {
  logger.debug('handleGetSnapshotAtMk', `请求获取历史快照...`);
  let result: any;
  try {
    const mk = detail?.mk;
    if (!mk) {
      throw new Error('请求缺少 "mk" 参数。');
    }

    logger.debug('handleGetSnapshotAtMk', `MK: ${mk}`);
    const stat = getStatAtMK(mk);

    if (stat) {
      const { meta } = getEraData();
      const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);
      const message_id = selectedMks.indexOf(mk);
      const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: false });
      const message = messages[message_id];

      result = {
        mk,
        message_id,
        is_user: message ? isUserMessage(message) : false,
        stat: unescapeEraData(stat),
        statWithoutMeta: unescapeEraData(removeMetaFields(stat)),
      };
    } else {
      const errorMessage = `找不到 MK "${mk}" 对应的快照。`;
      logger.warn('handleGetSnapshotAtMk', errorMessage);
      result = { error: errorMessage, stat: null };
    }
  } catch (error) {
    const errorMessage = `获取快照时发生错误: ${error instanceof Error ? error.message : String(error)}`;
    logger.error('handleGetSnapshotAtMk', errorMessage);
    result = { error: errorMessage };
  }
  emitQueryResultEvent('getSnapshotAtMk', detail, result);
}

/**
 * **【处理器】** 处理 `era:getSnapshotsBetweenMks` 事件。
 * 计算两个 MK 之间的所有历史快照，并通过 `era:queryResult` 事件发回结果数组。
 * @param {any} detail - 从事件中获取的 `detail` 对象，应包含 `startMk` 和 `endMk`。
 */
export function handleGetSnapshotsBetweenMks(detail: any) {
  const { startMk, endMk } = detail || {};
  logger.debug('handleGetSnapshotsBetweenMks', `请求获取批量快照，从: ${startMk || '开始'}, 到: ${endMk || '结束'}`);
  let finalResult: any;

  try {
    const results = getStatsBetweenMKs(startMk, endMk);

    if (results) {
      const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: false });
      finalResult = results.map(item => {
        const message = messages[item.message_id];
        return {
          ...item,
          is_user: message ? isUserMessage(message) : false,
          stat: unescapeEraData(item.stat),
          statWithoutMeta: unescapeEraData(removeMetaFields(item.stat)),
        };
      });
    } else {
      logger.warn('handleGetSnapshotsBetweenMks', '在指定范围内没有找到快照，或范围无效。');
      finalResult = [];
    }
  } catch (error) {
    const errorMessage = `获取批量快照时发生错误: ${error instanceof Error ? error.message : String(error)}`;
    logger.error('handleGetSnapshotsBetweenMks', errorMessage);
    finalResult = { error: errorMessage };
  }
  emitQueryResultEvent('getSnapshotsBetweenMks', detail, finalResult);
}

/**
 * **【处理器】** 处理 `era:getSnapshotAtMId` 事件。
 * 计算指定 message_id 的历史快照，并通过 `era:queryResult` 事件发回结果。
 * @param {any} detail - 从事件中获取的 `detail` 对象，应包含 `message_id`。
 */
export function handleGetSnapshotAtMId(detail: any) {
  logger.debug('handleGetSnapshotAtMId', `请求获取历史快照...`);
  let result: any;
  try {
    const message_id = detail?.message_id;
    if (typeof message_id !== 'number') {
      throw new Error('请求缺少 "message_id" 参数或类型不正确。');
    }

    logger.debug('handleGetSnapshotAtMId', `Message ID: ${message_id}`);

    const { meta } = getEraData();
    const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);

    if (message_id < 0 || message_id >= selectedMks.length) {
      throw new Error(`Message ID ${message_id} 超出范围 [0, ${selectedMks.length - 1}]。`);
    }

    const mk = selectedMks[message_id];
    if (!mk) {
      const errorMessage = `Message ID ${message_id} 处没有找到有效的 MK。`;
      logger.warn('handleGetSnapshotAtMId', errorMessage);
      result = { error: errorMessage, stat: null };
    } else {
      const stat = getStatAtMK(mk);
      if (stat) {
        const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: false });
        const message = messages[message_id];
        result = {
          mk,
          message_id,
          is_user: message ? isUserMessage(message) : false,
          stat: unescapeEraData(stat),
          statWithoutMeta: unescapeEraData(removeMetaFields(stat)),
        };
      } else {
        const errorMessage = `获取快照失败，MK: ${mk} (来自 Message ID: ${message_id})。可能该快照已被清理。`;
        logger.error('handleGetSnapshotAtMId', errorMessage);
        result = { error: errorMessage, stat: null };
      }
    }
  } catch (error) {
    const errorMessage = `获取快照时发生错误: ${error instanceof Error ? error.message : String(error)}`;
    logger.error('handleGetSnapshotAtMId', errorMessage);
    result = { error: errorMessage };
  }
  emitQueryResultEvent('getSnapshotAtMId', detail, result);
}

/**
 * **【处理器】** 处理 `era:getSnapshotsBetweenMIds` 事件。
 * 计算两个 message_id 之间的所有历史快照，并通过 `era:queryResult` 事件发回结果数组。
 * @param {any} detail - 从事件中获取的 `detail` 对象，应包含 `startId` 和 `endId`。
 */
export function handleGetSnapshotsBetweenMIds(detail: any) {
  const { startId, endId } = detail || {};
  logger.debug(
    'handleGetSnapshotsBetweenMIds',
    `请求获取批量快照，从 ID: ${startId ?? '开始'}, 到 ID: ${endId ?? '结束'}`,
  );
  let finalResult: any;

  try {
    const { meta } = getEraData();
    const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);

    const startIndex = startId ?? 0;
    const endIndex = endId ?? selectedMks.length - 1;

    if (startIndex > endIndex || startIndex < 0 || endIndex >= selectedMks.length) {
      throw new Error(`ID 范围 [${startIndex}, ${endIndex}] 无效或超出范围 [0, ${selectedMks.length - 1}]。`);
    }

    const startMk = selectedMks[startIndex];
    const endMk = selectedMks[endIndex];

    if (!startMk || !endMk) {
      throw new Error('指定的 ID 范围内没有找到有效的起始或结束 MK。');
    }

    const results = getStatsBetweenMKs(startMk, endMk);

    if (results) {
      const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: false });
      finalResult = results.map(item => {
        const message = messages[item.message_id];
        return {
          ...item,
          is_user: message ? isUserMessage(message) : false,
          stat: unescapeEraData(item.stat),
          statWithoutMeta: unescapeEraData(removeMetaFields(item.stat)),
        };
      });
    } else {
      logger.warn('handleGetSnapshotsBetweenMIds', '在指定 ID 范围内没有找到快照。');
      finalResult = [];
    }
  } catch (error) {
    const errorMessage = `获取批量快照时发生错误: ${error instanceof Error ? error.message : String(error)}`;
    logger.error('handleGetSnapshotsBetweenMIds', errorMessage);
    finalResult = { error: errorMessage };
  }
  emitQueryResultEvent('getSnapshotsBetweenMIds', detail, finalResult);
}

/**
 * **【处理器】** 处理 `era:requestWriteDone` 事件。
 * 请求 ERA 框架重新广播最新的 `writeDone` 事件。
 */
export function handleRequestWriteDone() {
  logger.debug('handleRequestWriteDone', '接收到 writeDone 重播请求。');
  if (lastWriteDonePayload) {
    logger.debug('handleRequestWriteDone', '正在重播上一次的 writeDone 事件。');
    emitWriteDoneEvent(lastWriteDonePayload);
  } else {
    logger.warn('handleRequestWriteDone', '没有可供重播的 writeDone 事件。');
  }
}

/**
 * @section API Event: 'era:forceSync'
 * @description 强制触发一次变量同步，用于手动修复状态或在外部逻辑变更后更新变量。
 * @param {object} [detail] - （可选）包含同步模式和相关参数的对象。
 * @param {'full' | 'latest' | 'auto' | 'rollbackTo'} [detail.mode='auto'] - 同步模式:
 *   - `'full'`: 强制从头开始完全重算整个聊天记录。
 *   - `'latest'`: 只重算最后一条消息，并将状态停留在最新。
 *   - `'auto'` (默认): 触发一次标准的差异同步，自动修复不一致。
 *   - `'rollbackTo'`: 将变量状态回滚到指定 `message_id` 处理完毕后的状态，并停留在那里。需要提供 `message_id` 参数。
 * @param {number} [detail.message_id] - 当 `mode` 为 `'rollbackTo'` 时，必须提供此参数。
 * @example
 * // 触发标准同步
 * eventEmit('era:forceSync');
 *
 * // 强制完全重算
 * eventEmit('era:forceSync', { mode: 'full' });
 *
 * // 将状态回滚到第 5 条消息之后
 * eventEmit('era:forceSync', { mode: 'rollbackTo', message_id: 5 });
 */
export async function handleForceSync(
  job: EventJob,
  actionsTaken: ActionsTaken,
  payload: DispatcherPayload,
): Promise<void> {
  const detail = job.detail;
  const mode = detail?.mode || 'auto';
  logger.log('handleForceSync', `接收到强制同步请求，模式: ${mode}`);

  let targetMessageId: number | undefined = undefined;
  let stopAtTarget = false;
  let isFullSync = false;

  switch (mode) {
    case 'full':
      isFullSync = true;
      break;
    case 'latest': {
      const latestMessage = getChatMessages(-1, { include_swipes: true })?.[0];
      if (latestMessage) {
        targetMessageId = latestMessage.message_id;
        // 在这里，stopAtTarget 为 false，因为我们要重算到结尾（虽然起点是最后一条，但逻辑上是完整的）
        // 但为了实现“只重算最后一条”的精确效果，我们依然可以利用 stopAtTarget
        stopAtTarget = false;
      } else {
        logger.warn('handleForceSync', '聊天记录为空，无法执行 "latest" 模式。');
        return;
      }
      break;
    }
    case 'rollbackTo': {
      const msgId = detail?.message_id;
      if (typeof msgId !== 'number') {
        logger.error('handleForceSync', '"rollbackTo" 模式需要一个有效的 "message_id" 参数。');
        return;
      }
      targetMessageId = msgId;
      stopAtTarget = true; // 核心：处理完目标消息后就停止
      break;
    }
    case 'auto':
    default:
      // 使用 handleSyncEvent 的默认行为，不设置 targetMessageId 和 stopAtTarget
      break;
  }

  // 创建一个新的 job 对象，将 isFullSync 标志传递给 handleSyncEvent
  const syncJob: EventJob = {
    ...job,
    type: isFullSync ? 'manual_full_sync' : job.type,
  };

  await handleSyncEvent(syncJob, actionsTaken, payload, targetMessageId, stopAtTarget);
}
