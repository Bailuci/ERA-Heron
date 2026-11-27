/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：修复“复制消息”产生重复 MK 导致的状态错误；新增脚本设置“API写入不修改消息”；修复第二批改动在审查中发现的问题；修复第三批改动在审查中发现的问题等；注入 MK 时保留正文中的宏
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 消息密钥 (MK) 管理模块
 * @description
 * 这个模块是 ERA 框架的基石，负责管理“消息密钥”（Message Key, MK）。
 *
 * **设计理念**:
 * ERA 的核心优势在于其鲁棒性，它通过将变量状态与 SillyTavern 不稳定的消息变量（message variables）
 * 解耦来实现这一点。MK 正是实现解耦的关键。
 *
 * MK 是一个由 **ERA 框架自身** 动态生成并**注入到消息内容字符串顶部**的唯一标识符。
 * 它就像一个不可变的“锚点”，随消息内容本身一起存在。ERA 的所有核心逻辑，包括变量追踪、
 * 回滚和同步，都围绕着识别和操作这些锚点来进行，而不是依赖于可能发生错位或被错误继承的消息变量。
 *
 * **MK 格式**:
 * MK 被包裹在一个独特的、类似 XML 的 `<era_data>` 标签中，其内部是一种**非标准**的类 JSON 格式，
 * 使用 `=` 作为分隔符，以避免与 AI 可能生成的标准 JSON 混淆。
 * e.g., `<era_data>{"era-message-key"="era_mk_...","era-message-type"="user"}</era_data>`
 * 这种设计（而不是用 HTML 注释 `<!-- -->`）是为了防止 MK 被其他可能移除注释的脚本无意中破坏。
 *
 * **核心功能**:
 * 1. **生成与注入**: `ensureMessageKey` 函数确保任何需要追踪的消息都拥有一个 MK。如果不存在，
 *    它会生成一个新的 MK 并注入到消息内容的开头。
 * 2. **解析与读取**: `readMessageKey` 函数提供了一个只读的接口，用于从消息内容中解析出 MK。
 * 3. **同步保障**: `updateLatestSelectedMk` 等函数确保核心数据结构 `SelectedMks` 与最新的
 *    消息状态保持一致，是框架自愈能力的重要组成部分。
 */

'use strict';

import { API_OPS_PATH, ERA_DATA_REGEX, ERA_DATA_TAG, SEL_PATH } from '../../utils/constants';
import { getEraData, updateEraMetaData } from '../../utils/era_data';
import { Logger } from '../../utils/log';
import { getMessageContent, getRawMessageContent, isUserMessage, updateMessageContent } from '../../utils/message';
import { rnd } from '../../utils/string';

const logger = new Logger();

/**
 * @type {EraData} - 定义了存储在 `<era_data>` 块中的元数据结构。
 */
type EraData = {
  'era-message-key': string;
  'era-message-type': 'user' | 'assistant';
};

// ==================================================================
// 内部辅助函数
// ==================================================================

/**
 * 从消息内容字符串中解析出 `EraData` 对象。这是一个只读操作。
 * @param {string | null | undefined} messageContent - 消息的内容字符串。
 * @returns {EraData | null} 解析成功则返回 `EraData` 对象，否则返回 null。
 */
function parseEraData(messageContent: string | null | undefined): EraData | null {
  if (typeof messageContent !== 'string') {
    return null;
  }
  const match = messageContent.match(ERA_DATA_REGEX);
  if (!match || !match[1]) {
    return null;
  }
  try {
    // 由于 MK 块内部是自定义的 `{"key"="value"}` 格式，不能使用 JSON.parse。
    // 必须使用正则表达式进行宽松匹配来提取键值。
    const customFormatBlock = match[1];
    const keyMatch = customFormatBlock.match(/"era-message-key"\s*=\s*"(.*?)"/);
    const typeMatch = customFormatBlock.match(/"era-message-type"\s*=\s*"(.*?)"/);

    if (keyMatch?.[1] && typeMatch?.[1]) {
      return {
        'era-message-key': keyMatch[1],
        'era-message-type': typeMatch[1] as 'user' | 'assistant',
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ==================================================================
// 导出的核心函数
// ==================================================================

/**
 * **【读取 MK】** 从一个消息对象中只读地提取其消息密钥（MK）。
 * 这个函数经过特别优化，以应对滑动（swipe）等场景下消息对象结构不一致的问题。
 * 它会全面检查消息的 `mes`、`message` 以及 `swipes` 数组中的每一个元素，直到找到第一个有效的 MK 为止。
 * @param {TavernMessage} msg - 酒馆消息对象。
 * @returns {string} 找到的 MK；如果不存在，则返回空字符串。
 */
export function readMessageKey(msg: any): string {
  if (!msg) return '';
  //logger.debug('readMessageKey', '开始获取mk');
  // 核心逻辑：始终且仅根据 getMessageContent 的结果来解析 MK。
  const content = getMessageContent(msg);
  //logger.debug('readMessageKey', '拿到消息内容', content);
  const mk = parseEraData(content)?.['era-message-key'] || '';
  //logger.debug('readMessageKey', '从消息内容中获取到mk', mk);
  // 移除遍历其他 swipes 的错误逻辑。如果当前激活的内容没有 MK，就必须返回空字符串，
  // 以强制 ensureMessageKey 生成新的 MK。
  return mk;

  /*
   * ==================================================================
   * 【已废弃的兼容逻辑】 - 2025/10/02
   *
   * 以下代码块是为了兼容旧版酒馆的一个特性：一个消息的多个 swipe 可能共享同一个底层消息变量，
   * 因此 MK 可能存在于任何一个 swipe 中。
   *
   * **废弃原因**:
   * 在当前的 ERA 架构中，每个 swipe 都被视为独立的内容。如果当前激活的 swipe 内容中没有 MK，
   * 就意味着它是一个全新的、需要被赋予新 MK 的消息。此时若继续查找并返回其他 swipe 的旧 MK，
   * 将会导致 `ensureMessageKey` 错误地认为新消息已有 MK，从而跳过必要的“生成新 MK”流程。
   * 这正是导致 swipe 新消息时无法正确写入变量的根本原因。
   *
   * 因此，该兼容逻辑已被注释掉，以确保 `readMessageKey` 的行为与当前架构的设计意图保持一致。
   * ==================================================================
   */
  // const mkFromCurrent = parseEraData(content)?.['era-message-key'];
  // if (mkFromCurrent) {
  //   return mkFromCurrent;
  // }
  // if (Array.isArray(msg.swipes)) {
  //   for (const swipeContent of msg.swipes) {
  //     const mkFromSwipe = parseEraData(swipeContent)?.['era-message-key'];
  //     if (mkFromSwipe) {
  //       return mkFromSwipe;
  //     }
  //   }
  // }
  // const mkFromMessage = parseEraData(msg.message)?.['era-message-key'];
  // if (mkFromMessage) {
  //   return mkFromMessage;
  // }
  // return '';
}

const isGenerating = (): boolean => typeof builtin !== 'undefined' && !!builtin.duringGenerating?.();

/** 生成过程中由 ERA 注入的 MK：流式输出会用新文本覆盖它，不能用来挂靠旁路 API 写入。 */
let provisionalKey = '';
export const clearProvisionalKey = () => {
  provisionalKey = '';
};

/**
 * **【旁路 API 写入的目标】** 通常是最后一条 AI 消息，与把指令块追加到正文时一致；
 * 正在流式输出、MK 尚不稳定的消息除外。没有可用的 AI 消息时使用最后一条其他消息。
 * @param where 指定目标；找不到、或正在流式输出时抛出异常。
 */
export async function findApiWriteTarget(
  where: { mk?: string; message_id?: number } = {},
): Promise<{ msg: any; mk: string } | null> {
  const load = (): any[] => getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
  let messages = load();
  // 否则写入会随复制来的 MK 被执行两次
  if (await dedupeMessageKeys(messages)) messages = load();

  const generating = isGenerating();
  const last = _.last(messages);
  const isStreaming = (msg: any): boolean => {
    if (!generating || msg !== last || isUserMessage(msg)) return false;
    const mk = readMessageKey(msg);
    return !mk || mk === provisionalKey;
  };

  let target: any;
  if (where.mk !== undefined || where.message_id !== undefined) {
    target =
      where.mk !== undefined
        ? messages.find(msg => readMessageKey(msg) === where.mk)
        : Number.isInteger(where.message_id)
          ? messages.at(where.message_id!)
          : undefined;
    if (!target) throw new Error('目标消息不存在');
    if (isStreaming(target)) throw new Error('目标消息仍在生成中');
  } else {
    const candidates = messages.filter(msg => !isStreaming(msg));
    target = _.findLast(candidates, msg => !isUserMessage(msg)) ?? _.last(candidates);
    if (!target) return null;
  }
  const { mk, isNew } = await ensureMessageKey(target);
  if (!mk) return null;
  // 刚注入 MK 时，手里的消息对象里还没有它
  const msg = isNew ? (load().find(item => readMessageKey(item) === mk) ?? target) : target;
  return { msg, mk };
}

/**
 * **【确保 MK 存在】**
 * 这是本模块最核心的函数。它检查一个消息是否已拥有 MK，如果尚未拥有，则为其生成一个新的 MK 并注入到消息内容中。
 * 这是解决“鸡生蛋/蛋生鸡”问题的关键：在对变量进行任何操作之前，必须先确保有一个可供依附的锚点（MK）。
 *
 * @param {TavernMessage} msg - 目标消息对象 (必须包含 `message_id`, `role`, 以及 `message` 或 `swipes`)。
 * @returns {Promise<{mk: string, isNew: boolean}>} 返回包含 MK 和一个布尔值的对象，该布尔值指示是否创建了新的 MK。
 */
export async function ensureMessageKey(msg: any): Promise<{ mk: string; isNew: boolean }> {
  if (!msg || typeof msg.message_id !== 'number' || !msg.role) {
    logger.warn('ensureMessageKey', `无效的消息对象结构，无法确保Key。`, { msg });
    return { mk: '', isNew: false };
  }

  // 1. 使用增强的 readMessageKey 检查是否已存在 MK
  const existingMk = readMessageKey(msg);
  if (existingMk) {
    return { mk: existingMk, isNew: false }; // 已存在，直接返回
  }

  // 2. 生成新的 MK 和元数据块
  const newMk = `era_mk_${Date.now()}_${rnd()}`;
  const messageType = msg.role === 'user' ? 'user' : 'assistant';
  const dataString = `<${ERA_DATA_TAG}>{"era-message-key"="${newMk}","era-message-type"="${messageType}"}</${ERA_DATA_TAG}>`;

  if (messageType === 'assistant' && isGenerating()) provisionalKey = newMk;

  logger.debug('ensureMessageKey', `为消息 (ID: ${msg.message_id}) 注入新的Key: ${newMk}`);

  // 3. 构造新的消息内容并统一调用更新函数
  // 在原文后追加：getMessageContent 会展开宏，写回去会把 {{user}} 等宏固定成当前的名字
  const newContent = getRawMessageContent(msg) + '\n' + dataString;

  // 使用从 utils.ts 导入的通用函数来更新消息，该函数已封装了处理 swipes 的逻辑。
  await updateMessageContent(msg, newContent);

  return { mk: newMk, isNew: true };
}

/**
 * **【消除重复 MK】**
 * 酒馆的“复制消息”会连同正文中的 MK 一起复制，使两楼拥有相同的 MK、共用同一条日志，
 * 导致之后的回滚和重算出错。这里为重复的后一楼换上新的 MK。
 *
 * @param messages 当前所有消息，按楼层顺序排列。
 * @returns 是否修改过任何消息；修改后调用者应重新获取消息列表。
 */
export async function dedupeMessageKeys(messages: any[]): Promise<boolean> {
  const seen = new Set<string>();
  const renamed: [string, string][] = [];
  for (const msg of messages) {
    const mk = readMessageKey(msg);
    if (!mk) continue;
    if (!seen.has(mk)) {
      seen.add(mk);
      continue;
    }
    const newMk = `era_mk_${Date.now()}_${rnd()}`;
    logger.warn('dedupeMessageKeys', `消息 (ID: ${msg.message_id}) 的 MK 与之前的楼层重复，换成新的 MK: ${newMk}`);
    // 直接替换原文：getMessageContent 会展开宏，写回去会把 {{user}} 等宏固定成当前的名字
    await updateMessageContent(msg, getRawMessageContent(msg).replaceAll(mk, newMk));
    seen.add(newMk);
    renamed.push([mk, newMk]);
  }
  if (renamed.length === 0) return false;

  // 复制出来的楼层应当重放同样的旁路 API 写入，就像正文中的指令块会被一起复制一样
  if (!_.isEmpty(_.get(getEraData().meta, API_OPS_PATH))) {
    await updateEraMetaData(meta => {
      const apiOps = _.get(meta, API_OPS_PATH, {});
      for (const [oldMk, newMk] of renamed) {
        if (apiOps[oldMk]) apiOps[newMk] = { ..._.cloneDeep(apiOps[oldMk]), applied: 0 };
      }
      return meta;
    });
  }
  return true;
}

/**
 * **【确保最新消息的 MK】**
 * 这是一个便捷函数，专门用于确保当前聊天记录中的最后一条消息拥有 MK。
 * 它通常在监听到新消息生成等事件时被调用，以确保新消息能被 ERA 系统正确追踪。
 * @param {any} msg - 从 `getChatMessages(-1)` 获取的最新消息对象。
 * @returns {Promise<{mk: string, message_id: number | null, isNewKey: boolean}>} 返回包含 MK、消息 ID 和一个布尔值的对象，该布尔值指示是否创建了新的 MK。
 */
export const ensureMkForLatestMessage = async (
  msg: any,
): Promise<{
  mk: string;
  message_id: number | null;
  isNewKey: boolean;
}> => {
  try {
    // 保留此日志，因为它对于调试事件触发时的消息状态至关重要。
    logger.debug('ensureMkForLatestMessage', `接收到的最新消息对象 (msg)`, msg);

    if (!msg || typeof msg.message_id !== 'number') {
      logger.warn('ensureMkForLatestMessage', '无效的最新消息对象或其ID，退出', { latestMessage: msg });
      return { mk: '', message_id: null, isNewKey: false };
    }

    // ensureMessageKey 会返回最终的 MK 和一个布尔值
    const { mk, isNew } = await ensureMessageKey(msg);
    logger.debug('ensureMkForLatestMessage', `已为最新消息 ${msg.message_id} 确保 MK 存在。 (是否新建: ${isNew})`);
    return { mk, message_id: msg.message_id, isNewKey: isNew };
  } catch (err: any) {
    logger.error('ensureMkForLatestMessage', `确保MK时异常: ${err?.message || err}`, {
      error: err,
      latestMessage: msg, // 使用传入的 msg 对象进行日志记录
    });
    return { mk: '', message_id: null, isNewKey: false };
  }
};

/**
 * **【更新最新已选 MK】**
 * 这是一个“保险”函数，用于在每次事件处理的最后，强制校准 `SelectedMks` 数组中关于**最新消息**的记录。
 * 它确保即使在复杂的异步流程中，`SelectedMks` 的尾部也始终与实际的最新消息保持严格同步。
 * @param {string} mk - 要更新的最新消息的 MK。
 * @returns {Promise<void>}
 */
export const updateLatestSelectedMk = async (mk: string) => {
  const msg = getChatMessages(-1, { include_swipes: true })?.[0];
  if (!msg || typeof msg.message_id !== 'number') return;

  if (!mk) return;

  // 同步过程中最新消息的 MK 可能已被更换（参见 dedupeMessageKeys），以消息中的实际 MK 为准
  mk = readMessageKey(msg) || mk;

  // 已经一致时不写入：每次写入都会让酒馆重新保存一次聊天变量
  if (_.get(getEraData().meta, [SEL_PATH, msg.message_id]) === mk) return;

  // 更新 ERAMetaData 中的 SelectedMks 数组
  await updateEraMetaData(meta => {
    const selectedMks = _.get(meta, SEL_PATH, []);
    // 只有在记录不一致时才执行写操作，以优化性能
    if (selectedMks[msg.message_id] !== mk) {
      selectedMks[msg.message_id] = mk;
      _.set(meta, SEL_PATH, selectedMks);
    }
    return meta;
  });
};
