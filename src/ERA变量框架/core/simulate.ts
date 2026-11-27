/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；新增折叠日志存档：旧楼日志存到单独文件，可回滚与查询，缺失时自动从头重放；修复第三批改动在审查中发现的问题；修复复审中发现的问题；试算可指定随机数种子的 MK；额外模型的试算取不到前一楼状态、退回最新状态时告诉调用方
 *       2026-11-26 试算文本时按当前聊天的解析版本解析
 *       2026-11-27 额外模型的试算按真实写入的形式拼接（appendExtraBlock），开启指令外层标签时校验不再失效；整楼试算可指定是否压缩旁路写入，atomic 预检与实际写入一致；新增 computeFloorIssues（/era-issues 没有报告时重算）；问题带上来源标记 source；新增 simulateUserText（按玩家消息试算，正文前规划用）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 试算
 * @description 在不写入任何数据的前提下，计算一段指令会产生的结果和问题。用于原子提交和额外模型的校验。
 */
'use strict';

import { API_OPS_PATH, ApiOp, LOGS_PATH, SEL_PATH } from '../utils/constants';
import { getEraData, settings } from '../utils/era_data';
import { appendExtraBlock, getMessageContent, stripExtraBlock } from '../utils/message';
import { appendApiOp } from './api_ops';
import { getFoldedIndex } from './compaction';
import type { CommandIssue } from './crud/diagnostics';
import { ApplyVarChangeForMessage } from './crud/patcher';
import { readMessageKey } from './key/mk';
import { expandArchive, loadArchive } from './log_archive';
import type { SchemaRejection } from './schema';
import { getStatAtMK } from './snapshot';
import { parserMetaOf } from './version';
import { rollbackStatToMK } from './timetravel';

/** 试算使用的 MK，不对应任何消息。 */
const SIMULATE_MK = 'era_simulate';

export interface SimulateProblem {
  path: string;
  reason: string;
  /** 来自哪种指令，参见 `EraCommand.origin`。 */
  origin?: string;
  /** 指令的来源标记，参见 `EraCommand.source`；主模型写在正文里的指令没有。 */
  source?: 'extra' | 'apiOps';
}

export interface SimulateResult {
  /** 结果状态（转义过的）。 */
  stat: any;
  problems: SimulateProblem[];
}

async function compute(msg: any, stat: any, meta: any, mk: string): Promise<SimulateResult> {
  const result = await ApplyVarChangeForMessage(msg, stat, meta, { 繁体转简体: settings.value.繁体转简体 }, mk);
  return {
    stat: result.finalStat,
    problems: [
      ...result.commandIssues.map(({ path, reason, origin, source }) => ({
        path,
        reason,
        origin,
        ...(source && { source }),
      })),
      ...result.schemaRejections.map(({ path, message, origin, source }) => ({
        path,
        reason: message,
        origin,
        ...(source && { source }),
      })),
    ],
  };
}

/**
 * 在 `stat`（转义过的）上试算一段正文中的指令，视为一条新的 AI 消息。按当前聊天的解析方式解析。
 * @param seedMk 表达式 `random()` / `roll()` 与钩子随机数所用的 MK；默认是不对应任何消息的 `era_simulate`，
 *   这时骰点只供参考，与真正写入时的不同。指定时，骰点与“这段文本出现在该楼正文里”相同；
 *   旁路写入（`Era.applyText` / `Era.commit`）按写入序号取种子，骰点不同，要预览它们请用 `atomic` 提交。
 */
export const simulateText = (text: string, stat: any, seedMk: string = SIMULATE_MK): Promise<SimulateResult> =>
  compute({ message_id: -1, role: 'assistant', mes: text }, stat, parserMetaOf(getEraData().meta), seedMk);

/** 按玩家消息的规则试算一段文本（不执行钩子与工具），用于正文前规划（1.8 起）。 */
export const simulateUserText = (text: string, stat: any): Promise<SimulateResult> =>
  compute({ message_id: -1, role: 'user', mes: text }, stat, parserMetaOf(getEraData().meta), SIMULATE_MK);

/** 去掉 `baseline` 中原本就有的问题。区分来源：改动可能使钩子原有的问题消失，不能与改动自己的问题抵消。 */
function newProblems(candidate: SimulateProblem[], baseline: SimulateProblem[]): SimulateProblem[] {
  const rest = [...baseline];
  return candidate.filter(problem => {
    const index = rest.findIndex(item => _.isEqual(item, problem));
    if (index === -1) return true;
    rest.splice(index, 1);
    return false;
  });
}

const loadMessages = (): any[] => getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];

/** 按 MK 查找当前显示该内容的消息。 */
export function findMessageByMk(mk: string): any | null {
  return loadMessages().find(msg => readMessageKey(msg) === mk) ?? null;
}

/** 按 MK 查找消息及其 swipe，包括没有显示的。 */
export function findSwipeByMk(mk: string): { msg: any; swipe_id: number; active: boolean } | null {
  for (const msg of loadMessages()) {
    if (readMessageKey(msg) === mk) return { msg, swipe_id: Number(msg.swipe_id ?? 0), active: true };
    const swipe_id = _.findIndex(msg.swipes ?? [], (text: any) => readMessageKey({ ...msg, mes: text ?? '' }) === mk);
    if (swipe_id !== -1) return { msg, swipe_id, active: false };
  }
  return null;
}

/** 某条消息执行完之后的状态（转义过的）；无法计算时返回 `null`。 */
export async function getStatAfter(mk: string): Promise<any | null> {
  await loadArchive(getEraData().meta);
  return getStatAtMK(mk);
}

/** 某条消息执行之前的状态（转义过的），与同步时回滚的结果一致；无法计算时返回 `null`。 */
export async function getStatBefore(mk: string): Promise<any | null> {
  const { stat, meta: stored } = getEraData();
  let meta = stored;
  const mks: (string | null)[] = _.get(meta, SEL_PATH, []);
  const index = mks.indexOf(mk);
  const last = mks[mks.length - 1];
  const previous = mks[index - 1];
  if (index === -1 || !last || (index > 0 && !previous) || _.compact(mks).length !== new Set(_.compact(mks)).size) {
    return null;
  }
  if (index <= getFoldedIndex(meta, mks)) {
    await loadArchive(meta);
    meta = expandArchive(meta);
    if (!meta || index <= getFoldedIndex(meta, mks)) return null;
  }
  return rollbackStatToMK(previous, last, stat, mks, _.get(meta, LOGS_PATH, {}));
}

/**
 * 从上一楼的状态重新计算整条消息（正文、旁路写入、钩子和 schema），返回没有生效的指令与被拦截的修改，
 * 与同步时的结果一致。之前的楼层必须已经同步完；无法计算该楼之前的状态时返回 `null`。
 */
export async function computeFloorIssues(
  msg: any,
): Promise<{ commandIssues: CommandIssue[]; schemaRejections: SchemaRejection[] } | null> {
  const mk = readMessageKey(msg);
  const before = await getStatBefore(mk);
  if (before === null) return null;
  const result = await ApplyVarChangeForMessage(
    { ...msg, mes: getMessageContent(msg) ?? '' },
    before,
    getEraData().meta,
    { 繁体转简体: settings.value.繁体转简体 },
    mk,
  );
  return { commandIssues: result.commandIssues, schemaRejections: result.schemaRejections };
}

/**
 * 试算整条消息：从上一楼的状态开始，像真正的同步那样执行它的正文、旁路写入、钩子和 schema。
 * 之前的楼层必须已经同步完。
 */
export interface FloorSimulator {
  /** 没有任何改动时的结果。 */
  baseline: SimulateResult;
  /**
   * 换成另一份正文、或追加旁路写入后的结果；`problems` 只含改动引起的新问题。
   * `compact` 是追加旁路写入时是否压缩（`appendApiOp` 的参数），必须与实际写入时相同：
   * 压缩会改变含 `$expr` 的写入的执行序号，也就改变它的骰点。默认不压缩。
   */
  run(change: { text?: string; ops?: ApiOp[]; compact?: boolean }): Promise<SimulateResult>;
}

/** @param text 作为基准的正文，默认是消息的正文。无法计算该楼之前的状态时返回 `null`。 */
export async function createFloorSimulator(msg: any, text?: string): Promise<FloorSimulator | null> {
  const mk = readMessageKey(msg);
  const before = await getStatBefore(mk);
  if (before === null) return null;
  const { meta } = getEraData();
  const base = { ...msg, mes: text ?? getMessageContent(msg) ?? '' };
  const baseline = await compute(base, before, meta, mk);
  return {
    baseline,
    async run(change) {
      let candidateMeta = meta;
      if (change.ops) {
        const record = change.ops.reduce(
          (current, op) => appendApiOp(current, op, change.compact ?? false),
          _.get(meta, [API_OPS_PATH, mk]),
        );
        candidateMeta = { ...meta, [API_OPS_PATH]: { ..._.get(meta, API_OPS_PATH), [mk]: record } };
      }
      const result = await compute({ ...base, mes: change.text ?? base.mes }, before, candidateMeta, mk);
      return { stat: result.stat, problems: newProblems(result.problems, baseline.problems) };
    },
  };
}

/**
 * 额外模型的试算：基准是没有额外模型输出的正文。
 * 无法计算该楼之前的状态时退回最新状态，`fallback` 为 `true`。
 * 输出按真实写入的形式（`appendExtraBlock`，包在 `<era_extra>` 中）拼接后试算：新聊天设置了指令外层标签时，
 * 裸露在正文后面的指令不会执行，校验就永远通过。
 */
export async function createExtraSimulator(
  msg: any,
): Promise<{ stat: any; fallback: boolean; check(blocks: string): Promise<SimulateProblem[]> }> {
  const text = stripExtraBlock(getMessageContent(msg) ?? '');
  const simulator = await createFloorSimulator(msg, text);
  if (!simulator) {
    const { stat } = getEraData();
    // 用该楼自己的 MK 作随机数种子，退回试算时 $expr 的骰点也与实际写入一致
    const seedMk = readMessageKey(msg) || undefined;
    return {
      stat,
      fallback: true,
      check: async blocks => (await simulateText(appendExtraBlock('', blocks), stat, seedMk)).problems,
    };
  }
  return {
    stat: simulator.baseline.stat,
    fallback: false,
    check: async blocks => (await simulator.run({ text: appendExtraBlock(text, blocks) })).problems,
  };
}
