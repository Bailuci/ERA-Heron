/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增脚本设置“日志保留楼层数”；新增更新钩子 Era.onBeforeApply / Era.onAfterApply；修复第二批改动在审查中发现的问题；新增折叠日志存档：旧楼日志存到单独文件，可回滚与查询，缺失时自动从头重放等；快速同步在未折叠时也检查楼层顺序
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 日志折叠模块
 * @description
 * 长聊天中 `EditLogs` 会持续增长。本模块把“边界楼”及之前的全部日志替换成边界楼的一条等效日志：
 * 对折叠时状态的每个顶层键记一条 `insert`。这样：
 *
 * - 从空状态正向应用到边界楼及之后的任意楼，结果与折叠前完全相同；
 * - 从末尾逆序回滚到初始状态，仍能清空全部由 ERA 写入的变量；
 * - 唯一做不到的是**停在边界楼之前**，因此分歧点落在边界楼及之前时，一律从第 0 楼按正文重放。
 *
 * 折叠标记按 MK 保存在 `ERAMetaData.FoldedThroughMk`。脚本设置 `日志保留楼层数` 只控制是否继续折叠；
 * 读取侧一律以标记是否存在为准，因此关闭设置后已折叠的聊天仍能正常工作，执行一次完全重算即可复原。
 */
'use strict';

import { EraConfig, FOLDED_MK_PATH, LOGS_PATH, SEL_PATH } from '../utils/constants';
import { parseEditLog } from '../utils/data';
import { Logger } from '../utils/log';
import { isUserMessage } from '../utils/message';
import { ApplyVarChangeForMessage } from './crud/patcher';
import { readMessageKey } from './key/mk';
import { applyForward, rollbackStatToMK } from './timetravel';

const logger = new Logger();

type Mks = (string | null)[];

/** 该索引处的 MK 存在，且在序列中只出现一次（酒馆的“复制消息”会产生重复的 MK）。 */
const isUniqueAt = (mks: Mks, index: number): boolean =>
  !!mks[index] && mks.indexOf(mks[index]) === index && mks.lastIndexOf(mks[index]) === index;

/** 边界楼的索引。未折叠返回 -1；标记的 MK 不在序列中时返回末楼索引（保守地视为全部已折叠）。 */
export function getFoldedIndex(meta: any, mks: Mks): number {
  const marker = _.get(meta, FOLDED_MK_PATH);
  if (!marker) return -1;
  const index = mks.indexOf(marker);
  return index === -1 ? mks.length - 1 : index;
}

/** 已折叠、且无法靠日志回滚到 `firstRecalcId` 之前时返回 0（从头重放），否则原样返回。 */
export function resolveRecalcStart(firstRecalcId: number, meta: any, mks: Mks): number {
  const marker = _.get(meta, FOLDED_MK_PATH);
  if (!marker) return firstRecalcId;

  const folded = getFoldedIndex(meta, mks);
  if (firstRecalcId <= folded) return 0;
  // 纯追加，不需要回滚
  if (firstRecalcId >= mks.length) return mks.includes(marker) ? firstRecalcId : 0;

  const trusted = isUniqueAt(mks, folded) && isUniqueAt(mks, firstRecalcId - 1) && isUniqueAt(mks, mks.length - 1);
  return trusted ? firstRecalcId : 0;
}

/**
 * 从头重放的起始状态：沿现存日志（含折叠日志）回滚到初始，从而保留日志无法解释的顶层键；
 * 无法可靠回滚时使用空对象。
 */
export function rollbackFoldedToInitial(stat: any, meta: any, mks: Mks): any {
  const folded = mks.indexOf(_.get(meta, FOLDED_MK_PATH));
  const last = mks.length - 1;
  if (folded === -1 || !isUniqueAt(mks, folded) || !isUniqueAt(mks, last)) return {};
  return rollbackStatToMK(undefined, mks[last]!, stat, mks, _.get(meta, LOGS_PATH, {}));
}

/** FAST_SYNC 的附加条件：剩余楼层的顺序必须不变；被折叠楼的日志未知，不能当成空日志。 */
export function isFastSyncSafe(deleted: Mks, current: Mks, meta: any, mks: Mks): boolean {
  // 剩余楼层的顺序必须不变：酒馆可以上下移动楼层，移动本身没有同步事件，紧接着删除一条空日志楼时不能只改 SelectedMks
  if (
    !_.isEqual(
      current,
      mks.filter(mk => !deleted.includes(mk)),
    )
  ) {
    return false;
  }
  if (!_.get(meta, FOLDED_MK_PATH)) return true;
  const folded = getFoldedIndex(meta, mks);
  return !deleted.some(mk => mks.indexOf(mk) <= folded);
}

/**
 * 把最近 `keep` 楼之前的日志折叠到一楼。直接修改传入的 `meta`（调用方应传入副本）。
 *
 * 折叠后，这些楼只能靠正文重放，因此折叠前会逐楼确认“按当前正文重放”与“日志推出的状态”一致，
 * 在第一处不一致的楼层停下。这样即使有脚本或正则剥离了旧楼正文里的指令，也只是不再继续折叠，不会丢数据。
 *
 * @param verified 最前面有多少楼已经在之前的折叠中确认过（由存档还原、没有重算），不必再次重放。
 * @param batch 至少攒够这么多楼才折叠。
 */
export async function foldOldLogs(
  meta: any,
  messages: any[],
  keep: number,
  config: Partial<EraConfig>,
  verified = 0,
  batch = 1,
): Promise<void> {
  const mks: Mks = _.get(meta, SEL_PATH, []);
  const logs = _.get(meta, LOGS_PATH, {});
  const marker = _.get(meta, FOLDED_MK_PATH);
  const folded = marker ? mks.indexOf(marker) : -1;
  // 标记已不在序列中：下一次同步会从头重放并清除标记
  if (marker && folded === -1) return;

  let good = folded;
  let goodStat: any = folded >= 0 ? applyForward({}, parseEditLog(logs[marker])) : {};

  // 最后一条 AI 消息在普通同步中总会被重算，不能折叠，否则每次同步都会从头重放
  const lastAi = _.findLastIndex(messages, msg => !isUserMessage(msg));
  const end = Math.min(mks.length - 1 - keep, lastAi - 1);
  if (end - folded < batch) return;
  for (let i = folded + 1; i <= end; i++) {
    const mk = mks[i];
    if (!isUniqueAt(mks, i) || readMessageKey(messages[i]) !== mk) {
      logger.debug('foldOldLogs', `第 ${i} 楼的 MK 缺失或重复，停止折叠。`);
      break;
    }
    const next = applyForward(_.cloneDeep(goodStat), parseEditLog(logs[mk!]));
    if (
      i >= verified &&
      !_.isEqual((await ApplyVarChangeForMessage(messages[i], goodStat, meta, config, mk!)).finalStat, next)
    ) {
      logger.debug('foldOldLogs', `第 ${i} 楼按正文重放的结果与日志不一致，停止折叠。`);
      break;
    }
    // 折叠日志以顶层键作为路径；键名会被 lodash 拆成多段时无法表达，停在这里。
    if (Object.keys(next).some(key => !_.isEqual(_.toPath(key), [key]))) {
      logger.debug('foldOldLogs', `第 ${i} 楼存在无法作为路径的顶层键，停止折叠。`);
      break;
    }
    good = i;
    goodStat = next;
  }
  if (good === folded) return;

  for (let i = Math.max(folded, 0); i < good; i++) {
    delete logs[mks[i]!];
  }
  logs[mks[good]!] = Object.keys(goodStat).map(key => ({ op: 'insert', path: key, value_new: goodStat[key] }));
  _.set(meta, FOLDED_MK_PATH, mks[good]);
}
