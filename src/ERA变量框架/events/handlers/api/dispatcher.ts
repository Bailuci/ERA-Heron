/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25
 * 目的：API 写入与 forceSync 在事件队列中等待完成；新增额外模型分步更新、等待式提交、试算与变量结构说明；新增折叠日志存档：旧楼日志存到单独文件，可回滚与查询，缺失时自动从头重放
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
'use strict';

import { loadArchive } from '../../../core/log_archive';
import { ERA_API_EVENTS } from '../../../utils/constants';
import { getEraData } from '../../../utils/era_data';
import { EventJob } from '../../merger';
import { ActionsTaken, DispatcherPayload } from '../../types';
import { handleWriteExtra } from './extra_write';
import {
  commit,
  deleteByObject,
  deleteByPath,
  handleForceSync,
  handleGetCurrentVars,
  handleGetSnapshotAtMId,
  handleGetSnapshotAtMk,
  handleGetSnapshotsBetweenMIds,
  handleGetSnapshotsBetweenMks,
  handleRequestWriteDone,
  insertByObject,
  insertByPath,
  patch,
  updateByObject,
  updateByPath,
} from './handler';

/** 可能查询旧楼的事件，需要先读取折叠日志的存档。 */
const SNAPSHOT_EVENTS = new Set<string>([
  ERA_API_EVENTS.GET_SNAPSHOT_AT_MK,
  ERA_API_EVENTS.GET_SNAPSHOTS_BETWEEN_MKS,
  ERA_API_EVENTS.GET_SNAPSHOT_AT_MID,
  ERA_API_EVENTS.GET_SNAPSHOTS_BETWEEN_MIDS,
  ERA_API_EVENTS.COMMIT,
]);

export async function handleApiEvent(
  job: EventJob,
  actionsTaken: ActionsTaken,
  payload: DispatcherPayload,
): Promise<void> {
  const { type: eventType, detail } = job;
  actionsTaken.api = true;

  // 写入和同步必须等待完成：它们会读写消息正文和聊天变量，若与队列中的下一个任务交错执行，
  // 后一个会基于过期的内容写回，覆盖前一个的结果。
  if (SNAPSHOT_EVENTS.has(eventType)) await loadArchive(getEraData().meta);

  if (eventType === ERA_API_EVENTS.INSERT_BY_OBJECT) await insertByObject(detail);
  else if (eventType === ERA_API_EVENTS.UPDATE_BY_OBJECT) await updateByObject(detail);
  else if (eventType === ERA_API_EVENTS.INSERT_BY_PATH) await insertByPath(detail.path, detail.value);
  else if (eventType === ERA_API_EVENTS.UPDATE_BY_PATH) await updateByPath(detail.path, detail.value);
  else if (eventType === ERA_API_EVENTS.DELETE_BY_OBJECT) await deleteByObject(detail);
  else if (eventType === ERA_API_EVENTS.DELETE_BY_PATH) await deleteByPath(detail.path);
  else if (eventType === ERA_API_EVENTS.GET_CURRENT_VARS) handleGetCurrentVars(detail);
  else if (eventType === ERA_API_EVENTS.GET_SNAPSHOT_AT_MK) handleGetSnapshotAtMk(detail);
  else if (eventType === ERA_API_EVENTS.GET_SNAPSHOTS_BETWEEN_MKS) handleGetSnapshotsBetweenMks(detail);
  else if (eventType === ERA_API_EVENTS.GET_SNAPSHOT_AT_MID) handleGetSnapshotAtMId(detail);
  else if (eventType === ERA_API_EVENTS.GET_SNAPSHOTS_BETWEEN_MIDS) handleGetSnapshotsBetweenMIds(detail);
  else if (eventType === ERA_API_EVENTS.REQUEST_WRITE_DONE) handleRequestWriteDone();
  else if (eventType === ERA_API_EVENTS.PATCH) await patch(detail);
  else if (eventType === ERA_API_EVENTS.COMMIT) await commit(detail, job.ticket);
  else if (eventType === ERA_API_EVENTS.WRITE_EXTRA) await handleWriteExtra(detail, job.ticket);
  else if (eventType === ERA_API_EVENTS.FORCE_SYNC) await handleForceSync(job, actionsTaken, payload);
}
