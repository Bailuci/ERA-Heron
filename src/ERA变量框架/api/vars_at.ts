/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：新增按楼层读取变量的接口 Era.getVarsAt，让楼层状态栏能显示“那一楼当时”的值
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 按楼层读取变量
 * @description
 * 计算某一楼处理完之后的变量，结果与 `era:getSnapshotAtMId` / `era:getSnapshotAtMk` 相同，
 * 但直接返回 Promise，并且会先读取折叠日志的存档。只读，不写入任何数据。
 */
'use strict';

import { readMessageKey } from '../core/key/mk';
import { getStatAfter } from '../core/simulate';
import { SEL_PATH } from '../utils/constants';
import { unescapeEraData } from '../utils/data';
import { getEraData, removeMetaFields } from '../utils/era_data';
import { isUserMessage } from '../utils/message';

/** 楼层：消息 ID（可以用负数从末尾倒数）、MK，或 `{ message_id }` / `{ mk }`（同时给出时以 `mk` 为准）。 */
export type FloorRef = number | string | { mk?: string; message_id?: number };

export interface EraSnapshot {
  mk: string;
  message_id: number;
  is_user: boolean;
  /** 含 `$meta` 等内部字段。 */
  stat: any;
  /** 不含任何 `$` 开头的字段，适合展示。 */
  statWithoutMeta: any;
}

function parseFloorRef(where: FloorRef): { mk?: string; message_id?: number } {
  if (typeof where === 'number') return { message_id: where };
  if (typeof where === 'string') return { mk: where };
  if (_.isPlainObject(where)) return _.pick(where, ['mk', 'message_id']);
  return {};
}

/**
 * 某一楼处理完之后的变量。
 * @throws 楼层不存在、还没有计算到、或日志已折叠又没有存档时，Promise 失败并说明原因。
 */
export async function getVarsAt(where: FloorRef): Promise<EraSnapshot> {
  const ref = parseFloorRef(where);
  const messages: any[] = getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
  const selectedMks: (string | null)[] = _.get(getEraData().meta, SEL_PATH, []);

  let mk: string;
  let message_id: number;
  if (typeof ref.mk === 'string' && ref.mk !== '') {
    mk = ref.mk;
    message_id = selectedMks.indexOf(mk);
    if (message_id === -1) throw new Error(`MK "${mk}" 不存在，或该回复当前没有显示`);
  } else if (Number.isInteger(ref.message_id)) {
    const msg = messages.at(ref.message_id!);
    if (!msg) throw new Error(`消息 ${ref.message_id} 不存在`);
    message_id = msg.message_id;
    mk = readMessageKey(msg);
    if (!mk || selectedMks[message_id] !== mk) throw new Error(`消息 ${message_id} 的变量还没有计算完成`);
  } else {
    throw new Error('请提供消息 ID（整数）或 MK');
  }

  const stat = await getStatAfter(mk);
  if (stat === null) throw new Error(`无法计算消息 ${message_id} 的变量：该楼的日志已折叠，且没有可用的存档`);
  const message = messages[message_id];
  return {
    mk,
    message_id,
    is_user: message ? isUserMessage(message) : false,
    stat: unescapeEraData(stat),
    statWithoutMeta: unescapeEraData(removeMetaFields(stat)),
  };
}
