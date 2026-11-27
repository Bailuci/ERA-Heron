/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：变量结构一键修复：在最新 AI 楼上试算修复值，确认后用 atomic 提交写入，写入前核对、写入后可撤销
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 面板 - 变量结构一键修复
 * @description
 * 1. `prepareSchemaFix`：打开最新 AI 楼的试算器，按这一楼重新计算出的状态推导修复值（`core/schema_diag.ts`），
 *    用 `diffToOps` 转成 Patch 操作，再用**同一个**试算器试算，并对试算结果再做一次 safeParse，确认修复后合法。
 *    同时记下聊天 ID、这一楼的 MK、swipe、正文和旁路写入的版本。
 * 2. `applySchemaFix`：写入前核对上面记下的各项，任何一项变了就拒绝，请玩家重新诊断；
 *    然后 `Era.commit([{ patch }], { atomic: true, mk })`。**只写最新 AI 楼**：写到更早的楼层，后续楼层会在保护恢复后重算，历史变量会变。
 * 3. `undoSchemaFix`：撤销本次修复。修复前的状态本来就不合法，用 `Era.commit` 写反向操作会被 schema 拦截，
 *    因此改为从这一楼的旁路写入中移除刚写入的那一项（只在它之后没有新的写入时允许），再触发重算。
 */
'use strict';

import { Era } from '../api/global';
import { getActiveSchema } from '../api/schema_registry';
import { findApiWriteTarget } from '../core/key/mk';
import {
  diagnosePlain,
  diagnoseStat,
  SchemaDiagnosis,
  SchemaFixPlan,
  deriveSchemaFix,
  toSchemaView,
} from '../core/schema_diag';
import type { SimulateProblem } from '../core/simulate';
import { debouncedEmitApiWrite } from '../events/emitters/events';
import { toApiOps } from '../events/handlers/api/handler';
import { createTicket, registerTicket } from '../events/handlers/api/tickets';
import { API_OPS_PATH, ApiOp, ApiOpsRecord } from '../utils/constants';
import { getEraData, updateEraMetaData } from '../utils/era_data';
import { countCommandBlocks, getMessageContent } from '../utils/message';
import { openFloor } from './floor_preview';
import { diffToOps, WorkbenchOp } from './workbench';

/** 写入前要核对的楼层身份。 */
export interface FloorIdentity {
  chatId: string | undefined;
  mk: string;
  message_id: number;
  swipe_id: number;
  /** 生成预览时这一楼的正文。 */
  text: string;
  /** 生成预览时这一楼旁路写入的版本（`rev`），没有时为 0。 */
  rev: number;
}

export interface SchemaFixPreview extends FloorIdentity {
  /** 这一楼重新计算出的状态的诊断。 */
  diagnosis: SchemaDiagnosis;
  /** 修复计划；状态本来就合法时为 `null`。 */
  plan: SchemaFixPlan | null;
  /** 要提交的 Patch 操作。 */
  ops: WorkbenchOp[];
  /** 试算中这次修复引起的新问题（atomic 提交会因此放弃）。 */
  problems: SimulateProblem[];
  /** 试算结果的诊断；没有要提交的操作时为 `null`。 */
  after: SchemaDiagnosis | null;
  /** 可以提交：有操作、试算没有新问题、试算结果符合结构。 */
  ready: boolean;
}

export interface SchemaFixUndo extends Omit<FloorIdentity, 'text'> {
  /** 写入的那一项旁路写入。 */
  op: ApiOp;
}

const recordOf = (mk: string): ApiOpsRecord | undefined => _.get(getEraData().meta, [API_OPS_PATH, mk]);

/**
 * 诊断最新 AI 楼并生成修复预览，不写入任何数据。
 * @param manual 玩家手填的值：路径各段的 JSON（`JSON.stringify(segments)`）→ 值。
 */
export async function prepareSchemaFix(manual: Record<string, any> = {}): Promise<SchemaFixPreview> {
  const schema = getActiveSchema()?.schema;
  if (!schema) throw new Error('当前角色卡没有注册变量结构');
  const chatId = SillyTavern.getCurrentChatId?.();
  const floor = await openFloor();
  const identity: FloorIdentity = {
    chatId,
    mk: floor.mk,
    message_id: floor.message_id,
    swipe_id: floor.swipe_id,
    text: getMessageContent(floor.msg) ?? '',
    rev: recordOf(floor.mk)?.rev ?? 0,
  };
  const plain = toSchemaView(floor.simulator.baseline.stat);
  const diagnosis = diagnosePlain(schema, plain);
  if (diagnosis.valid && _.isEmpty(manual)) {
    return { ...identity, diagnosis, plan: null, ops: [], problems: [], after: diagnosis, ready: false };
  }
  const plan = deriveSchemaFix(schema, plain, manual);
  const { ops } = diffToOps(plain, plan.target);
  if (ops.length === 0) {
    return { ...identity, diagnosis, plan, ops, problems: [], after: null, ready: false };
  }
  const result = await floor.run([{ patch: ops }]);
  const after = diagnoseStat(schema, result.stat);
  return {
    ...identity,
    diagnosis,
    plan,
    ops,
    problems: result.problems,
    after,
    ready: result.problems.length === 0 && after.valid,
  };
}

/** 核对楼层身份；变了时抛出说明原因的异常。 */
async function assertSameFloor(expected: Omit<FloorIdentity, 'text' | 'rev'> & Partial<FloorIdentity>): Promise<any> {
  if (SillyTavern.getCurrentChatId?.() !== expected.chatId) throw new Error('聊天已切换，请重新诊断');
  const target = await findApiWriteTarget();
  if (!target || target.mk !== expected.mk || Number(target.msg.message_id) !== expected.message_id) {
    throw new Error('最新的 AI 消息已经变化（新消息、删除或重新生成），请重新诊断');
  }
  if (Number(target.msg.swipe_id ?? 0) !== expected.swipe_id) throw new Error('最新的 AI 消息切换了回复，请重新诊断');
  if (expected.text !== undefined && (getMessageContent(target.msg) ?? '') !== expected.text) {
    throw new Error('最新的 AI 消息被编辑过，请重新诊断');
  }
  if (expected.rev !== undefined && (recordOf(expected.mk)?.rev ?? 0) !== expected.rev) {
    throw new Error('最新的 AI 消息有了新的写入，请重新诊断');
  }
  return target.msg;
}

/**
 * 写入修复。写入前核对聊天、最新 AI 楼的 MK、swipe、正文和旁路写入的版本，任何一项变了就拒绝。
 * @param commit 提交函数，默认是 `Era.commit`（测试时替换）。
 * @returns 撤销所需的信息。
 */
export async function applySchemaFix(
  preview: SchemaFixPreview,
  commit: (operations: any, options: any) => Promise<unknown> = (operations, options) =>
    Era.commit(operations, options),
): Promise<SchemaFixUndo> {
  if (!preview.ready) throw new Error('修复预览没有通过检查，不能写入');
  const msg = await assertSameFloor(preview);
  const operations = [{ patch: preview.ops }];
  const [expected] = toApiOps(operations, countCommandBlocks(msg));
  await commit(operations, { atomic: true, mk: preview.mk });
  const record = recordOf(preview.mk);
  const last = _.last(record?.ops ?? []);
  if (!record || !last || !sameOp(last, expected)) {
    // 写入已完成，只是之后马上又有别的写入，无法安全撤销
    return {
      chatId: preview.chatId,
      mk: preview.mk,
      message_id: preview.message_id,
      swipe_id: preview.swipe_id,
      rev: -1,
      op: expected,
    };
  }
  return {
    chatId: preview.chatId,
    mk: preview.mk,
    message_id: preview.message_id,
    swipe_id: preview.swipe_id,
    rev: record.rev,
    op: expected,
  };
}

const sameOp = (a: ApiOp, b: ApiOp): boolean => _.isEqual(_.omit(a, ['n']), _.omit(b, ['n']));

/** 撤销是否还可行（不读写数据，只看记录）。 */
export function canUndoSchemaFix(undo: SchemaFixUndo | null | undefined): boolean {
  if (!undo || undo.rev < 0) return false;
  const record = recordOf(undo.mk);
  const last = _.last(record?.ops ?? []);
  return !!record && record.rev === undo.rev && !!last && sameOp(last, undo.op);
}

/**
 * 撤销本次修复：从这一楼的旁路写入中移除刚写入的那一项，等重算完成后返回。
 * 修复之后这一楼又有新的写入、或楼层已经变化时拒绝。
 */
export async function undoSchemaFix(undo: SchemaFixUndo): Promise<void> {
  if (undo.rev < 0) throw new Error('修复之后马上又有新的写入，无法撤销');
  // 旁路写入的版本在下面单独核对，给出“无法撤销”的说明
  await assertSameFloor(_.omit(undo, ['rev']));
  let rev = 0;
  await updateEraMetaData(meta => {
    const record: ApiOpsRecord | undefined = _.get(meta, [API_OPS_PATH, undo.mk]);
    const last = _.last(record?.ops ?? []);
    if (!record || record.rev !== undo.rev || !last || !sameOp(last, undo.op)) return meta;
    const ops = [...record.ops];
    if ((last.n ?? 1) > 1) {
      const n = (last.n ?? 1) - 1;
      ops[ops.length - 1] = n > 1 ? { ...last, n } : _.omit(last, ['n']);
    } else {
      ops.pop();
    }
    rev = record.rev + 1;
    _.set(meta, [API_OPS_PATH, undo.mk], { ...record, rev, ops });
    return meta;
  });
  if (rev === 0) throw new Error('修复之后这一楼又有新的写入，无法撤销；可以重新诊断');
  const { ticket, promise } = createTicket();
  registerTicket(ticket, undo.mk, rev);
  debouncedEmitApiWrite();
  await promise;
}
