/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；目标楼被删除或滑走时立即失败
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 等待式写入的凭据
 * @description
 * `Era.commit` 等接口返回 Promise，在写入被同步计算之后才完成。
 * 写入时登记凭据（目标 MK 和序号），每次同步结束后检查是否已经生效。
 */
'use strict';

import { isPendingApiWrite } from '../../../core/pending_api';
import { findSwipeByMk } from '../../../core/simulate';
import { API_OPS_PATH, SEL_PATH } from '../../../utils/constants';
import { unescapeEraData } from '../../../utils/data';
import { getEraData, removeMetaFields } from '../../../utils/era_data';

export interface EraWriteResult {
  /** 写入的消息的 MK。 */
  mk: string;
  stat: any;
  statWithoutMeta: any;
  /** 该楼已有同一幂等键的写入，这次没有写入（1.8 起）。 */
  skipped?: boolean;
}

export interface ApiTicket {
  chatId: string | undefined;
  mk?: string;
  /** 旁路写入的序号；正文写入没有序号。 */
  rev?: number;
  /** 已经完成或失败。尚未开始的写入据此放弃，不会在调用者得知失败之后才执行。 */
  settled: boolean;
  /** 因幂等键重复而没有写入。 */
  skipped?: boolean;
  resolve(result: EraWriteResult): void;
  reject(error: Error): void;
}

const pending = new Set<ApiTicket>();

export function createTicket(timeout = 20000): { ticket: ApiTicket; promise: Promise<EraWriteResult> } {
  const ticket = { chatId: SillyTavern.getCurrentChatId?.(), settled: false } as ApiTicket;
  const promise = new Promise<EraWriteResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      ticket.reject(
        new Error(ticket.mk ? '写入已保存，但同步没有在限定时间内完成' : '写入没有在限定时间内执行，已放弃'),
      );
    }, timeout);
    const finish = () => {
      clearTimeout(timer);
      pending.delete(ticket);
      ticket.settled = true;
    };
    ticket.resolve = result => {
      if (ticket.settled) return;
      finish();
      resolve(result);
    };
    ticket.reject = error => {
      if (ticket.settled) return;
      finish();
      reject(error);
    };
  });
  return { ticket, promise };
}

/** 写入开始之前调用：凭据已失效，或聊天已切换时抛出异常。 */
export function assertTicket(ticket: ApiTicket | undefined, chatId: string | undefined): void {
  if (ticket?.settled) throw new Error('写入已放弃');
  if (SillyTavern.getCurrentChatId?.() !== chatId || (ticket && ticket.chatId !== chatId)) {
    throw new Error('聊天已切换');
  }
}

export function registerTicket(ticket: ApiTicket, mk: string, rev?: number): void {
  if (ticket.settled) return;
  ticket.mk = mk;
  ticket.rev = rev;
  pending.add(ticket);
}

export function resolveTicket(ticket: ApiTicket, mk: string): void {
  const { stat } = getEraData();
  ticket.resolve({
    mk,
    stat: unescapeEraData(stat),
    statWithoutMeta: unescapeEraData(removeMetaFields(stat)),
    ...(ticket.skipped ? { skipped: true } : {}),
  });
}

/** 目标楼被删除或滑走时的错误信息。写入保存在该楼上，随它一起撤销。 */
export const TARGET_GONE_MESSAGE = '目标消息已被删除或切换到了其他回复，写入随该楼一起撤销（滑回该回复时会重新生效）';

/**
 * 同步完成后调用：已生效的凭据完成；聊天已切换、目标楼已被删除或滑走的凭据失败；其余继续等待
 * （例如目标楼还没有被同步到）。
 */
export function settleTickets(): void {
  if (pending.size === 0) return;
  const { meta } = getEraData();
  const selectedMks: (string | null)[] = _.get(meta, SEL_PATH, []);
  for (const ticket of [...pending]) {
    if (ticket.chatId !== SillyTavern.getCurrentChatId?.()) {
      ticket.reject(new Error('聊天已切换'));
      continue;
    }
    if (!selectedMks.includes(ticket.mk!)) {
      const found = findSwipeByMk(ticket.mk!);
      if (!found || !found.active) ticket.reject(new Error(TARGET_GONE_MESSAGE));
      continue;
    }
    const applied =
      ticket.rev === undefined
        ? !isPendingApiWrite(ticket.mk!)
        : _.get(meta, [API_OPS_PATH, ticket.mk!, 'applied'], -1) >= ticket.rev;
    if (applied) resolveTicket(ticket, ticket.mk!);
  }
}
