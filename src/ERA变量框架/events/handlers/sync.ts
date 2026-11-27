/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：修复 rollbackTo 之后状态错误；新增脚本设置“API写入不修改消息”；修复第二批改动在审查中发现的问题；新增额外模型分步更新、等待式提交、试算与变量结构说明；同步放弃或失败时不再更新末楼 MK、不发出 writeDone；合并后的任务保留完全重算与清理需求
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
'use strict';

import { pruneApiOps } from '../../core/api_ops';
import { readMessageKey, updateLatestSelectedMk } from '../../core/key/mk';
import { resyncStateOnHistoryChange } from '../../core/sync';
import { forceRenderRecentMessages } from '../../ui/patch';
import { Logger } from '../../utils/log';
import { emitWriteDoneEvent } from '../emitters/events';
import { EventJob, isFullSyncJob, needsPruneJob } from '../merger';
import { ActionsTaken, DispatcherPayload } from '../types';
import { settleTickets } from './api/tickets';

const logger = new Logger();

export async function handleSyncEvent(
  job: EventJob,
  actionsTaken: ActionsTaken,
  payload: DispatcherPayload,
  targetMessageId?: number,
  stopAtTarget = false,
): Promise<void> {
  const { type: eventType } = job;
  logger.debug('handleSyncEvent', `事件 ${eventType} 触发状态同步流程...`);
  const isFullSync = isFullSyncJob(job);
  const status = await resyncStateOnHistoryChange(isFullSync, targetMessageId, stopAtTarget);
  actionsTaken.resync = true;
  if (status !== 'done') {
    // 切换了聊天或同步出错：结果没有写入，也不能把（可能属于另一个聊天的）末楼 MK 写进 SelectedMks。
    // 检查等待式写入的凭据：属于已切换走的聊天的会被拒绝，其余的留到下一次成功的同步再结算。
    logger.warn('handleSyncEvent', `事件 ${eventType} 的同步没有完成（${status}），跳过后续处理。`);
    settleTickets();
    return;
  }
  // 在同步完成后，强制重新渲染消息以触发宏
  if (eventType != 'combo_sync') forceRenderRecentMessages();

  // 更新状态并发送事件
  // 定向同步停在目标楼层时，SelectedMks 也必须停在那里。
  // 否则补上的末楼 MK 会让下一次同步在“目标楼状态”上多回滚一次末楼的日志。
  if (!stopAtTarget) await updateLatestSelectedMk(payload.mk);
  // 载入聊天或完全重算时，清除已不属于任何楼层的旁路 API 写入
  if (!stopAtTarget && needsPruneJob(job)) await pruneApiOps();
  // 同步过程中该消息的 MK 可能已被更换（参见 dedupeMessageKeys）
  const latest = getChatMessages(payload.message_id, { include_swipes: true })?.[0];
  if (payload.mk && latest) payload.mk = readMessageKey(latest) || payload.mk;
  settleTickets();
  emitWriteDoneEvent(payload);
}
