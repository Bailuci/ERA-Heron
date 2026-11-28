/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：追加占位符时保留正文中的宏
 *       2026-11-27 从单段 AI 消息中去掉状态栏占位符的 stripStatusPlaceholderText（原在 macro/parser.ts，主生成与分步更新的提示词共用）
 *       2026-11-28 核对按楼层号取回的消息是不是这一楼
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
'use strict';

import { Logger } from '../utils/log';
import { settings } from '../utils/era_data';
import { isUserMessage, getMessageContent, getRawMessageContent, updateMessageContent } from '../utils/message';

/**
 * @file ERA 变量框架 - 状态占位符宏
 * @description 监听消息接收事件，并确保消息中存在用于渲染状态UI的占位符。
 */

const logger = new Logger();

/** `特殊符号值` 的默认值，也是“ERA 状态栏占位符隐藏正则”匹配的内容。 */
export const DEFAULT_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

/**
 * 从一段 AI 消息中去掉状态栏占位符（脚本设置 `特殊符号值`）及其前面的空白。
 * 占位符只用于显示；新卡由“ERA 状态栏占位符隐藏正则”去掉，没有点“更新旧卡的规则”的旧卡缺少这条正则，
 * 每条历史 AI 消息都会带着它发给 AI（主生成与分步更新都是）。新卡的正则已经去掉时这里不会再匹配到。
 *
 * 只应用于 AI 消息，不碰系统提示词、世界书、预设和用户输入里作者自己写的文字。自定义的 `特殊符号值` 只在
 * `在ai消息尾部生成特殊符号` 开启时处理（此时才是 ERA 自己追加的）；默认值始终处理，因为旧消息里可能留着以前追加的占位符。
 */
export function stripStatusPlaceholderText(
  text: string,
  placeholder: string = settings.value.特殊符号值,
  appendEnabled: boolean = settings.value.在ai消息尾部生成特殊符号,
): string {
  if (!placeholder.trim()) return text;
  if (!appendEnabled && placeholder !== DEFAULT_PLACEHOLDER) return text;
  // 与隐藏正则一致：不区分大小写
  return text.replace(new RegExp(String.raw`\s*` + _.escapeRegExp(placeholder), 'gi'), '');
}

/**
 * **【占位符保障】**
 * 确保指定 ID 的 AI 消息末尾存在用于渲染状态 UI 的占位符。
 * 如果占位符不存在，则会自动添加。
 * @param {number} message_id - 要检查和处理的消息的 ID。
 */
export async function ensurePlaceholder(message_id: number) {
  const funcName = 'ensurePlaceholder';
  logger.debug(funcName, `执行占位符保障，消息 ID: ${message_id}`);

  if (!settings.value.在ai消息尾部生成特殊符号) {
    logger.debug(funcName, '功能未启用，已跳过。');
    return;
  }
  logger.debug(funcName, '功能已启用，继续执行。');

  const chat_message = getChatMessages(message_id, { include_swipes: true })[0];
  // 酒馆助手会把越界的楼层号夹到末楼：取回来的不是这一楼（它已经被删掉）时不处理
  if (!chat_message || Number(chat_message.message_id) !== Number(message_id)) {
    logger.warn(funcName, `无法找到消息 ID: ${message_id} 对应的消息。`);
    return;
  }
  logger.debug(funcName, `获取到消息对象 (ID: ${message_id})`, chat_message);

  if (isUserMessage(chat_message)) {
    logger.debug(funcName, `消息 ${message_id} 是用户消息，已跳过。`);
    return;
  }
  logger.debug(funcName, `消息 ${message_id} 是 AI 消息，继续处理。`);

  const placeholder = settings.value.特殊符号值;
  const currentContent = getMessageContent(chat_message);
  logger.debug(funcName, '读取到消息内容:', { content: currentContent });
  logger.debug(funcName, '使用的占位符:', { placeholder });

  if (currentContent && currentContent.includes(placeholder)) {
    logger.debug(funcName, '消息已包含占位符，无需操作。');
    return;
  }

  // 在原文后追加：getMessageContent 会展开宏，写回去会把 {{user}} 等宏固定成当前的名字
  const newMessage = getRawMessageContent(chat_message).trimEnd() + '\n' + placeholder;
  logger.debug(funcName, '准备更新消息，添加占位符。', { newMessage });

  try {
    await updateMessageContent(chat_message, newMessage, 'affected');
    logger.debug(funcName, '消息更新成功。');
  } catch (error) {
    logger.error(funcName, '更新消息时发生错误。', error);
  }
}
