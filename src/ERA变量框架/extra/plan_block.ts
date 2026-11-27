/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。日期：2026-11-27。
 * 目的：正文前规划的 <era_plan> 块：读取、去掉与拼接（路线图 1.8-3）
 */
'use strict';

import { getCurrentParseOptions } from '../core/version';

export const PLAN_TAG = 'era_plan';
export const SUMMARY_TAG = 'PlanSummary';
/** 一个闭合的 `<era_plan>` 块。 */
export const PLAN_BLOCK_PATTERN = String.raw`<era_plan>(?:(?!<era_plan>)[\s\S])*?<\/era_plan>`;

/** 取出正文中的 `<era_plan>` 块（最后一个）。 */
export function findPlanBlock(text: string): string | null {
  const all = String(text ?? '').match(new RegExp(PLAN_BLOCK_PATTERN, 'gi'));
  return all ? all[all.length - 1] : null;
}

/** 规划块里的摘要；没有时为空字符串。 */
export function readPlanSummary(text: string): string {
  const block = findPlanBlock(text);
  const match = block && new RegExp(`<${SUMMARY_TAG}>([\\s\\S]*?)<\\/${SUMMARY_TAG}>`, 'i').exec(block);
  return match ? match[1].trim() : '';
}

/** 去掉正文中的规划块。 */
export function stripPlanBlock(text: string): string {
  return String(text ?? '').replace(new RegExp(String.raw`\s*${PLAN_BLOCK_PATTERN}`, 'gi'), '');
}

/**
 * 把规划结果拼到玩家消息末尾，原有的规划块先去掉。新聊天设置了指令外层标签时，指令块包在外层标签里，
 * 否则不会执行（与写入事件追加到正文的指令块相同）。
 */
export function appendPlanBlock(text: string, summary: string, blocks: string): string {
  const base = stripPlanBlock(text).trimEnd();
  if (!summary && !blocks) return base;
  const outerTag = getCurrentParseOptions()?.outerTag;
  const commands = blocks && outerTag ? `<${outerTag}>\n${blocks}\n</${outerTag}>` : blocks;
  const parts = [summary ? `<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>` : '', commands].filter(Boolean);
  return `${base}\n<${PLAN_TAG}>\n${parts.join('\n')}\n</${PLAN_TAG}>`;
}
