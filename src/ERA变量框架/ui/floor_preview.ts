/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：面板提交前的试算改用楼内试算器（与 atomic 提交是同一个试算器），不再用 Era.simulate 把修改当成新的一楼
 *       2026-11-28 旁路写入的位置改用 apiPositionOf
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 面板 - 提交前试算
 * @description
 * 面板的修改都用 `Era.commit(..., { atomic: true })` 挂到最新 AI 楼的旁路写入上。提交前的试算必须与 atomic 提交的检查一致：
 * 从上一楼的状态开始，重新执行这一楼的正文、已有的旁路写入、钩子和 schema，再加上这次的修改。
 *
 * 不能用 `Era.simulate`：它把文本当成新的一楼，钩子会多执行一次，检查的也不是实际落盘的状态，
 * 有钩子的卡预览结果可能与实际提交不同。
 */
'use strict';

import { createFloorSimulator, FloorSimulator, SimulateResult } from '../core/simulate';
import { findApiWriteTarget } from '../core/key/mk';
import type { CommitOperation } from '../events/handlers/api/handler';
import { toApiOps } from '../events/handlers/api/handler';
import { apiPositionOf } from '../utils/message';

export interface FloorPreview {
  /** 写入的目标楼。 */
  mk: string;
  message_id: number;
  swipe_id: number;
  /** 没有这次修改时这一楼的结果。 */
  baseline: SimulateResult;
  /** 加上这次修改之后的结果；`problems` 只含这次修改引起的新问题（atomic 提交据此判断）。 */
  result: SimulateResult;
}

export interface OpenedFloor {
  msg: any;
  mk: string;
  message_id: number;
  swipe_id: number;
  simulator: FloorSimulator;
  /** 用这一楼的试算器试算一组写入。 */
  run(operations: CommitOperation | CommitOperation[]): Promise<SimulateResult>;
}

/**
 * 打开目标楼（默认是最后一条 AI 消息）的试算器。
 * @throws 没有可写入的消息，或该楼之前的日志已折叠、无法计算时。
 */
export async function openFloor(where: { mk?: string; message_id?: number } = {}): Promise<OpenedFloor> {
  const target = await findApiWriteTarget(where);
  if (!target) throw new Error('没有可以写入的消息');
  const simulator = await createFloorSimulator(target.msg);
  if (!simulator) throw new Error('该楼之前的日志已折叠，无法预先检查，提交也会被放弃');
  return {
    msg: target.msg,
    mk: target.mk,
    message_id: Number(target.msg.message_id),
    swipe_id: Number(target.msg.swipe_id ?? 0),
    simulator,
    run: operations => simulator.run({ ops: toApiOps(operations, apiPositionOf(target.msg)) }),
  };
}

/**
 * 在目标楼（默认是最后一条 AI 消息）上试算一组写入，不写入任何数据。
 * @throws 没有可写入的消息，或该楼之前的日志已折叠、无法计算时。
 */
export async function previewCommit(
  operations: CommitOperation | CommitOperation[],
  where: { mk?: string; message_id?: number } = {},
): Promise<FloorPreview> {
  toApiOps(operations, { after: 0, ax: false }); // 格式有误时先报告
  const floor = await openFloor(where);
  const result = await floor.run(operations);
  return {
    mk: floor.mk,
    message_id: floor.message_id,
    swipe_id: floor.swipe_id,
    baseline: floor.simulator.baseline,
    result,
  };
}
