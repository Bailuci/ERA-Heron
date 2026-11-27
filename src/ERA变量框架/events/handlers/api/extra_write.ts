/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；入队移到 extra/controller.ts，消除循环依赖
 *       2026-11-27 拼接正文与输出改用与试算共用的 appendExtraBlock；也用于重新规划时替换玩家楼的 <era_plan>；Era.setMessageText 整体改写正文
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 额外模型输出的写入
 * @description
 * 额外模型的输出写在**目标楼层的正文**末尾，包在 `<era_extra>` 中：正文是变量的事实来源，
 * 因此 swipe、删除、编辑、完全重算、导出聊天都能正常工作；重新解析时整块替换。
 * 写入必须经过事件队列，避免与同步交错；入队由 `extra/controller.ts` 负责（本文件不引用队列，避免循环依赖）。
 */
'use strict';

import { markPendingApiWrite } from '../../../core/pending_api';
import { findSwipeByMk } from '../../../core/simulate';
import { Logger } from '../../../utils/log';
import { appendPlanBlock } from '../../../extra/plan_block';
import { appendExtraBlock, keepEraBlocks, updateMessageContent } from '../../../utils/message';
import { debouncedEmitApiWrite } from '../../emitters/events';
import { ApiTicket, assertTicket, registerTicket, resolveTicket } from './tickets';

const logger = new Logger();

/** 由事件队列调用。 */
export async function handleWriteExtra(
  detail: { mk: string; blocks: string; plan?: { summary: string }; body?: string },
  ticket?: ApiTicket,
): Promise<void> {
  try {
    assertTicket(ticket, SillyTavern.getCurrentChatId?.());
    const target = findSwipeByMk(detail.mk);
    if (!target) throw new Error('目标消息已不存在');
    const { msg, swipe_id, active } = target;
    // 使用原文而不是展开宏之后的内容，避免把 {{user}} 固定成当前的名字
    const raw: string = (Array.isArray(msg.swipes) ? msg.swipes[swipe_id] : msg.message) ?? '';
    // 与试算（createExtraSimulator）用同一个函数拼接，两边的解析结果才一致
    // 重新规划（1.8 起）：替换玩家楼里的 <era_plan>
    // Era.setMessageText：整体改写正文，保留 ERA 写在原正文里的块
    const next =
      detail.body !== undefined
        ? keepEraBlocks(detail.body, raw)
        : detail.plan
          ? appendPlanBlock(raw, detail.plan.summary, detail.blocks)
          : appendExtraBlock(raw, detail.blocks);
    if (next !== raw) {
      // 整体改写时显示的内容变了，要重新渲染这一楼；只追加隐藏块时不用
      await updateMessageContent({ ...msg, swipe_id }, next, detail.body !== undefined && active ? 'affected' : 'none');
    }
    if (!active) {
      // 暂时没有显示的 swipe 不影响当前的变量，滑回来时会按正文计算
      if (ticket) resolveTicket(ticket, detail.mk);
      return;
    }
    markPendingApiWrite(detail.mk);
    if (ticket) registerTicket(ticket, detail.mk);
    debouncedEmitApiWrite();
  } catch (error: any) {
    logger.warn('handleWriteExtra', `写入失败: ${error?.message ?? error}`);
    ticket?.reject(error);
  }
}
