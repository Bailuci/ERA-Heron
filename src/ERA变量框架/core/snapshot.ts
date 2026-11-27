/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增脚本设置“日志保留楼层数”；新增折叠日志存档：旧楼日志存到单独文件，可回滚与查询，缺失时自动从头重放；快照改为从当前变量回滚，与同步、当前变量的口径一致
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 状态快照模块
 * @description
 * 提供一个高级接口，用于获取任意历史时间点（由 MK 标记）的变量状态（stat）快照。
 */

'use strict';

import { LOGS_PATH, SEL_PATH } from '../utils/constants';
import { getEraData } from '../utils/era_data';
import { Logger } from '../utils/log';
import { getFoldedIndex } from './compaction';
import { expandArchive } from './log_archive';
import { calculateAllStatsBetweenMks, calculateStatAt, rollbackStatToMK } from './timetravel';

const logger = new Logger();

/** 目标在折叠边界之前、且存档已读取时，返回还原了逐楼日志的元数据。 */
function getMetaFor(targetMK?: string): any {
  const { meta } = getEraData();
  const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);
  const index = targetMK ? selectedMks.indexOf(targetMK) : 0;
  return index < getFoldedIndex(meta, selectedMks) ? (expandArchive(meta) ?? meta) : meta;
}

/**
 * 某条消息执行完之后的状态：与同步的回滚口径一致，从当前变量沿日志回滚到目标楼，
 * 因此会保留日志无法解释的键（例如脚本直接写入 stat_data 的字段），末楼的快照就是当前变量。
 * MK 序列有缺失或重复、无法可靠回滚时，退回到从空对象正向推算。
 */
function statAt(targetMK: string, selectedMks: (string | null)[], allLogs: { [mk: string]: string }): object {
  const last = selectedMks[selectedMks.length - 1];
  const known = _.compact(selectedMks);
  if (last && new Set(known).size === known.length) {
    return rollbackStatToMK(targetMK, last, getEraData().stat, selectedMks, allLogs);
  }
  return calculateStatAt(targetMK, selectedMks, allLogs);
}

/**
 * 获取指定 MK 时间点的变量状态（stat）快照。
 * 这是一个高级接口，它会自动获取全局数据并调用纯计算函数。
 *
 * @param {string} targetMK - 目标状态对应的消息密钥 (MK)。
 * @returns {object | null} - 计算出的目标 stat 对象。如果找不到 MK 或发生错误，则返回 null。
 */
export function getStatAtMK(targetMK: string): object | null {
  try {
    const meta = getMetaFor(targetMK);
    const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);
    const allLogs: { [mk: string]: string } = _.get(meta, LOGS_PATH, {});

    if (!targetMK) {
      logger.error('getStatAtMK', `目标 MK 不能为空。`, { targetMK });
      return null;
    }

    // 检查 targetMK 是否有效
    if (!selectedMks.includes(targetMK)) {
      logger.error('getStatAtMK', `提供的 targetMK "${targetMK}" 无效或不存在于 selectedMks 中。`, {
        targetMK,
        selectedMks,
      });
      return null;
    }

    // 折叠边界之前的逐楼日志已不存在，无法计算
    if (selectedMks.indexOf(targetMK) < getFoldedIndex(meta, selectedMks)) {
      logger.warn('getStatAtMK', `MK "${targetMK}" 的日志已被折叠，无法获取快照。`);
      return null;
    }

    const statAtTarget = statAt(targetMK, selectedMks, allLogs);

    return statAtTarget;
  } catch (error: any) {
    logger.error('getStatAtMK', `计算状态快照时出错: ${error?.message || error}`, {
      error,
      targetMK,
      eraData: getEraData(),
    });
    return null;
  }
}

/**
 * 获取两个 MK（包含）之间的所有 stat 快照。
 * 这是一个高级接口，它会自动处理边界情况并调用纯计算函数。
 * @param {string} [startMk] - 起始 MK。如果为空，则从第一条消息开始。
 * @param {string} [endMk] - 结束 MK。如果为空，则到最后一条消息结束。
 * @returns {{mk: string, message_id: number, stat: object}[] | null} - 包含每个快照及其元数据的数组，或在出错时返回 null。
 */
export function getStatsBetweenMKs(
  startMk?: string,
  endMk?: string,
): { mk: string; message_id: number; stat: object }[] | null {
  try {
    const meta = getMetaFor(startMk);
    const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);
    const allLogs: { [mk: string]: string } = _.get(meta, LOGS_PATH, {});

    const validMks = selectedMks.filter((mk): mk is string => !!mk);
    if (validMks.length === 0) {
      return [];
    }

    // 检查 startMk 是否有效
    if (startMk && !validMks.includes(startMk)) {
      logger.error('getStatsBetweenMKs', `提供的 startMk "${startMk}" 无效或不存在于 selectedMks 中。`, {
        startMk,
        validMks,
      });
      return null;
    }

    // 检查 endMk 是否有效
    if (endMk && !validMks.includes(endMk)) {
      logger.error('getStatsBetweenMKs', `提供的 endMk "${endMk}" 无效或不存在于 selectedMks 中。`, {
        endMk,
        validMks,
      });
      return null;
    }

    let actualStartMk = startMk || validMks[0];
    const actualEndMk = endMk || validMks[validMks.length - 1];

    // 折叠边界之前的逐楼日志已不存在，只返回边界楼及之后的部分
    const foldedIndex = getFoldedIndex(meta, selectedMks);
    if (selectedMks.indexOf(actualEndMk) < foldedIndex) {
      return [];
    }
    if (selectedMks.indexOf(actualStartMk) < foldedIndex) {
      actualStartMk = selectedMks[foldedIndex] as string;
    }

    const results = calculateAllStatsBetweenMks(
      actualStartMk,
      actualEndMk,
      selectedMks,
      allLogs,
      statAt(actualStartMk, selectedMks, allLogs),
    );
    return results;
  } catch (error: any) {
    logger.error('getStatsBetweenMKs', `计算批量快照时出错: ${error?.message || error}`, {
      error,
      startMk,
      endMk,
      eraData: getEraData(),
    });
    return null;
  }
}
