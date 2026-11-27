/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；修复复审中发现的问题；新增读取未展开宏的原文的 getRawMessageContent；表达式 $expr 的稳定身份字段 exprId
 *       2026-11-26 新聊天解析前遮蔽思考块、可只认指令外层标签内的指令（maskCommandText），新增从文本解析指令的 parseCommandText
 *       2026-11-27 正文与额外模型输出的拼接抽成 appendExtraBlock，写入与试算共用；<era_extra> 不受正文思考遮蔽的影响；额外模型输出的提取按“思考标签”设置遮蔽；新增按解析方式取出会执行的指令块（extractExecutedBlocks）；指令带上来源标记 source（<era_extra>、ApiOps），只用于报告；
 *       <era_extra> 区段只认闭合、并且开头不在闭合的思考块里的块（findExtraRanges），正文的思考遮蔽、外层标签的例外与来源标记共用；去掉 <era_extra> 块时不跨过另一个 <era_extra>
 *       2026-11-27 工具调用 <EraFCall>：解析、计数、提取与剥离；keepEraBlocks（保留 ERA 写在正文里的块）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 消息处理模块
 * @description
 * 该文件提供了一系列用于处理、查询和更新酒馆消息对象的通用辅助函数。
 */

'use strict';

import { ERA_DATA_REGEX } from './constants';
import { getCurrentParseOptions, splitTagList } from '../core/version';
import type { CommandIssue } from '../core/crud/diagnostics';
import { escapeEraData, parseJsonl, stripComments } from './data';
import { settings } from './era_data';
import { Logger } from './log';
import { stripCodeFence, traditionalToSimplified } from './string';
import { parseCharacterMacros } from './text';
import { parseTolerant } from './tolerant_json';

const log = new Logger();

export function extractMessageIdFromDetail(detail: any): number | null {
  if (detail === null || detail === undefined) {
    log.debug('extractMessageIdFromDetail', 'detail 为空，无法解析 message_id。');
    return null;
  }

  if (typeof detail === 'number') {
    if (Number.isFinite(detail)) {
      log.debug('extractMessageIdFromDetail', '从 number detail 获取 message_id。', { message_id: detail });
      return detail;
    }
    log.debug('extractMessageIdFromDetail', 'number detail 非有限值，忽略。', { detail });
    return null;
  }

  if (typeof detail === 'string') {
    const parsed = Number(detail);
    if (Number.isFinite(parsed)) {
      log.debug('extractMessageIdFromDetail', '从 string detail 解析 message_id。', {
        raw: detail,
        message_id: parsed,
      });
      return parsed;
    }
    log.debug('extractMessageIdFromDetail', 'string detail 无法解析为有效数字，忽略。', { raw: detail });
    return null;
  }

  if (Array.isArray(detail) && detail.length > 0) {
    const parsed = Number(detail[0]);
    if (Number.isFinite(parsed)) {
      log.debug('extractMessageIdFromDetail', '从数组 detail[0] 解析 message_id。', {
        raw: detail[0],
        message_id: parsed,
      });
      return parsed;
    }
    log.debug('extractMessageIdFromDetail', '数组 detail[0] 无法解析为有效数字，忽略。', { raw: detail[0] });
    return null;
  }

  if (typeof detail === 'object') {
    if (typeof detail.message_id === 'number') {
      if (Number.isFinite(detail.message_id)) {
        log.debug('extractMessageIdFromDetail', '从对象 detail.message_id(number) 获取 message_id。', {
          message_id: detail.message_id,
        });
        return detail.message_id;
      }
      log.debug('extractMessageIdFromDetail', '对象 detail.message_id(number) 不是有限值，忽略。', {
        message_id: detail.message_id,
      });
      return null;
    }
    if (typeof detail.message_id === 'string') {
      const parsed = Number(detail.message_id);
      if (Number.isFinite(parsed)) {
        log.debug('extractMessageIdFromDetail', '从对象 detail.message_id(string) 解析 message_id。', {
          raw: detail.message_id,
          message_id: parsed,
        });
        return parsed;
      }
      log.debug('extractMessageIdFromDetail', '对象 detail.message_id(string) 无法解析为有效数字，忽略。', {
        raw: detail.message_id,
      });
      return null;
    }
    if (Array.isArray(detail.eventArgs) && detail.eventArgs.length > 0) {
      const parsed = Number(detail.eventArgs[0]);
      if (Number.isFinite(parsed)) {
        log.debug('extractMessageIdFromDetail', '从对象 detail.eventArgs[0] 解析 message_id。', {
          raw: detail.eventArgs[0],
          message_id: parsed,
        });
        return parsed;
      }
      log.debug('extractMessageIdFromDetail', '对象 detail.eventArgs[0] 无法解析为有效数字，忽略。', {
        raw: detail.eventArgs[0],
      });
      return null;
    }
  }

  log.debug('extractMessageIdFromDetail', '未能从事件 detail 中解析出有效的 message_id。', { detail });
  return null;
}

/**
 * @type {EraData} - 定义了存储在 `<era_data>` 块中的元数据结构。
 */
type EraData = {
  'era-message-key': string;
  'era-message-type': 'user' | 'assistant';
};

// ==================================================================
// 消息读取与解析
// ==================================================================

/**
 * **【获取消息内容】** 从酒馆的消息对象中安全地提取当前激活（被选中）的消息内容字符串。
 * 这个函数是 ERA 中所有消息内容读取的唯一入口，以确保逻辑统一和健壮性。
 * @param {TavernMessage} msg - 酒馆消息对象。
 * @returns {string | null} 当前激活的消息内容；如果无法获取，则返回 null。
 */
export function getMessageContent(msg: any): string | null {
  if (!msg) return null;

  let content: string | null = null;

  // 优先检查 .mes 属性，这是新版酒馆的规范
  if (typeof msg.mes === 'string') {
    content = msg.mes;
  }
  // 如果没有 .mes，则处理 swipes
  else if (Array.isArray(msg.swipes)) {
    const sid = Number(msg.swipe_id ?? 0);
    content = msg.swipes[sid] || null;
  }
  // 最后，作为兼容，检查旧版的 .message 属性
  else if (typeof msg.message === 'string') {
    content = msg.message;
  }

  if (content === null) {
    return null;
  }

  // 在返回内容前进行宏替换。
  // 这样做是因为酒馆自身的宏替换行为不一致：有时（如消息流式生成后）会替换，
  // 但有时（如聊天记录刚加载时）则不会，这会导致读取到的内容状态混乱。
  // 因此，我们统一在获取消息时手动执行一次宏替换，以确保数据的一致性。
  return parseCharacterMacros(content);
}

/**
 * **【获取消息原文】** 不展开宏的消息内容，与 `updateMessageContent` 写入的位置一致（有 swipes 时取当前 swipe）。
 * 需要修改正文再写回时必须用它：`getMessageContent` 会展开 `{{user}}` 等宏，写回去会把宏固定成当前的名字。
 */
export function getRawMessageContent(msg: any): string {
  if (!msg) return '';
  const raw = Array.isArray(msg.swipes) ? msg.swipes[Number(msg.swipe_id ?? 0)] : (msg.mes ?? msg.message);
  return typeof raw === 'string' ? raw : '';
}

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
      const eraData = {
        'era-message-key': keyMatch[1],
        'era-message-type': typeMatch[1] as 'user' | 'assistant',
      };
      log.debug('parseEraData', '成功解析 EraData', eraData);
      return eraData;
    }
    log.debug('parseEraData', '未能在 EraData 块中找到完整的键值对', { customFormatBlock });
    return null;
  } catch (e) {
    log.warn('parseEraData', '解析 EraData 块时发生异常', e);
    return null;
  }
}

/**
 * **【判断消息类型】** 根据消息内容中的 `era-message-type` 元数据或 `role` 属性判断是否为用户消息。
 * 优先信任注入的元数据。
 * @param {TavernMessage} msg - 酒馆消息对象。
 * @returns {boolean} 如果是用户消息，则返回 true。
 */
export function isUserMessage(msg: any): boolean {
  const content = getMessageContent(msg);
  const data = parseEraData(content);
  if (data) {
    return data['era-message-type'] === 'user';
  }
  // 回退到检查 role 属性
  return msg?.role === 'user';
}

/**
 * 从后向前查找并返回最后一条 AI 消息。
 * @returns {TavernMessage | null} 找到的 AI 消息对象，如果找不到则返回 null。
 */
export function findLastAiMessage(): any | null {
  const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
  if (!messages || messages.length === 0) {
    log.debug('findLastAiMessage', '聊天记录为空, 未找到任何消息。');
    return null;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isUserMessage(msg)) {
      log.debug('findLastAiMessage', `找到最后一条 AI 消息, ID: ${msg.message_id}`);
      return msg;
    }
  }

  log.debug('findLastAiMessage', '未在聊天记录中找到任何 AI 消息。');
  return null;
}

/**
 * **【带重试获取消息内容】**
 * 尝试获取指定或最新AI消息的内容，如果初次获取为空，则会进行指定次数和间隔的重试。
 * 这主要用于应对酒馆消息在事件触发后可能存在的更新延迟。
 * @param {TavernMessage | number} [messageOrId] - （可选）酒馆消息对象或消息 ID。如果未提供，则自动查找最新的 AI 消息。
 * @param {number} [retries=3] - 最大重试次数。
 * @param {number} [delay=50] - 每次重试之间的等待时间（毫秒）。
 * @returns {Promise<string | null>} 成功则返回消息内容，重试后仍然失败则返回 null。
 */
export async function getMessageContentWithRetry(
  messageOrId?: any | number,
  retries: number = 20,
  delay: number = 50,
): Promise<string | null> {
  let msg: any;

  if (messageOrId) {
    if (typeof messageOrId === 'number') {
      const messages = getChatMessages(messageOrId, { include_swipes: true });
      msg = messages ? messages[0] : null;
    } else {
      msg = messageOrId;
    }
  } else {
    msg = findLastAiMessage();
  }

  if (!msg) {
    log.warn('getMessageContentWithRetry', '找不到有效的消息对象', { messageOrId });
    return null;
  }

  for (let i = 0; i < retries; i++) {
    const content = getMessageContent(msg);
    if (content) {
      return content;
    }
    log.log('getMessageContentWithRetry', `获取消息内容失败，将在 ${delay}ms 后重试 (第 ${i + 1} 次)`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  log.warn('getMessageContentWithRetry', `重试 ${retries} 次后仍无法获取消息内容`, { message_id: msg.message_id });
  return getMessageContent(msg); // 返回最后一次尝试的结果 (可能为 null)
}

// ==================================================================
// 消息写入
// ==================================================================

/**
 * **【通用】** 更新指定消息的内容。
 * 这个辅助函数封装了处理 `swipes` 和普通 `message` 的逻辑，提供一个统一的写入接口。
 * @param {any} message - 要更新的消息对象。
 * @param {string} newContent - 全新的消息内容。
 * @param {'none' | 'affected' | 'all'} [refresh='none'] - 更新后是否刷新消息。
 */
export async function updateMessageContent(
  message: any,
  newContent: string,
  refresh: 'none' | 'affected' | 'all' = 'none',
) {
  const updatePayload: { message_id: number; message?: string; swipes?: string[] } = {
    message_id: message.message_id,
  };

  if (Array.isArray(message.swipes)) {
    const sid = Number(message.swipe_id ?? 0);
    const newSwipes = [...message.swipes];
    newSwipes[sid] = newContent;
    updatePayload.swipes = newSwipes;
  } else {
    updatePayload.message = newContent;
  }

  await setChatMessages([updatePayload], { refresh });
}

/** 包裹额外模型输出的标签。 */
export const EXTRA_TAG = 'era_extra';

/**
 * 一个闭合的 `<era_extra>` 块（`appendExtraBlock` 写出的形式）。中间不能再有 `<era_extra>`：
 * 前面只有开始标签的同名字样（例如思考里提到这个标签）不会和后面真正的块连成一段。
 */
export const EXTRA_BLOCK_PATTERN = String.raw`<era_extra>(?:(?!<era_extra>)[\s\S])*?<\/era_extra>`;

/** 移除正文中额外模型的输出。 */
export function stripExtraBlock(text: string): string {
  return text.replace(new RegExp(String.raw`\s*${EXTRA_BLOCK_PATTERN}`, 'gi'), '');
}

/** 值里若含有 ERA 自己的标签，会让正文无法正确分段；用 JSON 的转义写法代替 `<`。 */
export const neutralizeExtraTags = (blocks: string): string =>
  blocks.replace(/<(?=\/?era_(?:extra|data)\b)/gi, '\\u003c');

/**
 * 把额外模型的输出拼到正文末尾，包在 `<era_extra>` 中；原有的 `<era_extra>` 先去掉。`blocks` 为空时只去掉原有的输出。
 * 写入（`events/handlers/api/extra_write.ts`）与试算（`core/simulate.ts` 的 `createExtraSimulator`）必须共用这个函数：
 * 新聊天设置了指令外层标签时只认标签内和 `<era_extra>` 中的指令，形式不同，试算的结果就与实际写入不同。
 */
export function appendExtraBlock(body: string, blocks: string): string {
  const base = stripExtraBlock(body).trimEnd();
  return blocks ? `${base}\n<${EXTRA_TAG}>\n${neutralizeExtraTags(blocks)}\n</${EXTRA_TAG}>` : base;
}

/**
 * 把原正文 `source` 里 ERA 写的块（`<era_data>` 与分步更新的 `<era_extra>`）补到新正文 `text` 末尾；
 * 新正文里已经有的那一种不再补。`Era.keepMessageKey` 与 `Era.setMessageText` 共用。
 */
export function keepEraBlocks(text: string, source: string): string {
  let result = String(text ?? '');
  const extraRegex = new RegExp(EXTRA_BLOCK_PATTERN, 'gi');
  const hasData = ERA_DATA_REGEX.test(result);
  const hasExtra = new RegExp(EXTRA_BLOCK_PATTERN, 'i').test(result);
  if (hasData && hasExtra) return result;
  const block = hasData ? undefined : String(source ?? '').match(ERA_DATA_REGEX)?.[0];
  if (block) result = `${result}\n${block}`;
  // 与分步更新写入的位置一致：<era_extra> 在正文最后
  for (const extra of hasExtra ? [] : (String(source ?? '').match(extraRegex) ?? [])) result = `${result}\n${extra}`;
  return result;
}

/** 移除正文中的指令块、思考块、ERA 元数据和正文前规划块，用于发给额外模型。 */
export function stripCommandBlocks(text: string): string {
  return stripExtraBlock(text)
    .replace(/<era_plan>[\s\S]*?<\/era_plan>/gi, '')
    .replace(/<(variable(?:think|insert|edit|delete|patch)|era_data)>[\s\S]*?<\/\1>/gi, '')
    .replace(new RegExp(CALL_PATTERN, 'gi'), '')
    .replace(/<\/?era_extra>/gi, '');
}

export interface ExtractedCommands {
  /** 全部指令块，按出现顺序拼接。 */
  text: string;
  hasCommands: boolean;
  hasThink: boolean;
  /** 有指令块没有闭合，通常是输出被截断。 */
  truncated: boolean;
}

/** 额外模型输出中要遮蔽的思考标签：脚本设置“思考标签”，并且总是包括 think、thinking。 */
function extraThinkTags(): string[] {
  return _.uniq(['think', 'thinking', ...splitTagList(settings.value.思考标签).map(tag => tag.toLowerCase())]);
}

/**
 * 把模型输出里思考标签的内容换成等长空格（配对规则见 `maskThinking`，包括接口丢掉开头 `<think>` 的情况）。
 * 供需要从输出里取其他标记的地方使用，例如正文前规划的摘要。
 */
export function maskOutputThinking(output: string, thinkTags: readonly string[] = extraThinkTags()): string {
  const chars = output.split('');
  maskThinking(output, chars, thinkTags);
  return chars.join('');
}

/**
 * 从模型的输出中取出指令块，丢弃其余内容。
 * 思考标签里的内容先遮蔽，配对规则与正文相同（见 `maskThinking`）：模型的思考里可能引用指令作为例子，
 * 有的接口会丢掉开头的 `<think>`。
 * @param thinkTags 要遮蔽的思考标签，默认是脚本设置“思考标签”加上 think、thinking。
 */
export function extractCommandBlocks(
  output: string,
  thinkTags: readonly string[] = extraThinkTags(),
): ExtractedCommands {
  const chars = output.split('');
  maskThinking(output, chars, thinkTags);
  const text = chars.join('');
  // 思考块整块匹配，使其中引用的指令不会被单独取出
  const regex = new RegExp(
    String.raw`<(Variable(Think|Insert|Edit|Delete|Patch))>[\s\S]*?<\/\1>|${CALL_PATTERN}`,
    'gi',
  );
  const blocks = [...text.matchAll(regex)];
  const commands = blocks.filter(block => block[2]?.toLowerCase() !== 'think').map(block => block[0]);
  return {
    text: commands.join('\n'),
    hasCommands: commands.length > 0,
    hasThink: commands.length < blocks.length,
    truncated: /<Variable(Insert|Edit|Delete|Patch)>|<EraFCall\b/i.test(text.replace(regex, '')),
  };
}

/**
 * 正文中按解析方式真正会执行的指令块（原文，按出现顺序用换行拼接）：思考块里的、外层标签外的都不算。
 * 用于告诉额外模型“已执行的更新”，与 `hasOwnCommands` 和同步的判断一致。
 */
export function extractExecutedBlocks(
  text: string,
  options: ParseOptions | undefined = getCurrentParseOptions(),
): string {
  return [...maskCommandText(text, options).matchAll(BLOCK_REGEX)]
    .filter(match => match[1] === undefined || match[3].trim() !== '')
    .map(match => match[0])
    .join('\n');
}

/** 消息正文中是否有指令（不含额外模型的输出）。按当前聊天的解析方式判断，思考块里的指令不算。 */
export function hasOwnCommands(msg: any, options: ParseOptions | undefined = getCurrentParseOptions()): boolean {
  const content = stripExtraBlock(getMessageContent(msg) ?? '');
  return extractAndParseCommands({ ...msg, mes: content }, false, undefined, options).length > 0;
}

/**
 * 定义了 ERA 指令的统一结构。
 */
export interface EraCommand {
  type: 'insert' | 'edit' | 'delete' | 'patch' | 'call';
  /** `patch` 与 `call`（`[{ name, args }]`）的数据未转义；其余已转义。 */
  data: any[];
  /** 来源，缺省为 `text`（消息正文）。`下划线只读` 只限制正文中的指令；`tool` 是工具产出的操作。 */
  origin?: 'text' | 'api' | 'hook' | 'tool';
  /** 在正文的全部指令块（含无法解析的）中的序号。 */
  block?: number;
  /** 早期版本是否会计入这条指令，用于解释早期保存的旁路写入的位置。 */
  legacy?: boolean;
  /**
   * 表达式 `$expr` 的随机数种子所用的稳定身份。正文指令没有（按路径的出现次数取种子）；
   * 旁路写入是 `api|<展开 n 后在本楼 ApiOps 中的执行序号>`，钩子新建的指令是 `hook|<钩子 id>|<序号>`。
   */
  exprId?: string;
  /**
   * 指令从哪里来，只用于报告（`{{ERA-issues}}` 不把它们当成主模型写的），不参与任何规则判断：
   * `extra` 是正文 `<era_extra>` 中额外模型的输出，`apiOps` 是 `ApiOps` 中的旁路写入（含 `Era.applyText`）。
   * 主模型自己写在正文里的指令没有。
   */
  source?: 'extra' | 'apiOps';
}

const COMMAND_REGEX =
  /<(Variable(Insert|Edit|Delete|Patch))>\s*(?=[\s\S]*?\S[\s\S]*?<\/\1>)((?:(?!<(?:era_data|Variable(?:Think|Insert|Edit|Delete|Patch))>|<\/\1>)[\s\S])*?)\s*<\/\1>/gi;

/**
 * 工具调用（1.8 起）：`<EraFCall name="工具名">{"参数": 1}</EraFCall>`，或自闭合的 `<EraFCall name="工具名" args='{"参数": 1}'/>`。
 * 捕获组：属性、标签体。
 */
export const CALL_PATTERN = String.raw`<EraFCall\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(?:\/>|>((?:(?!<EraFCall\b)[\s\S])*?)<\/EraFCall\s*>)`;

/**
 * 指令块与工具调用，按出现顺序。捕获组 1～3 是 `COMMAND_REGEX` 的（标签、类型、内容），4～5 是工具调用的（属性、标签体）。
 * 计数、定位与解析都用它，工具调用与指令块按同一套序号定位（旁路写入的 `after`）。
 */
const BLOCK_REGEX = new RegExp(`${COMMAND_REGEX.source}|${CALL_PATTERN}`, 'gi');

/** 读取 `<EraFCall>` 的一个属性（双引号或单引号）。 */
function readAttribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** 解析工具调用的参数文本；空文本是 `{}`，无法解析时返回 `undefined`。 */
function parseCallArgs(text: string): any {
  const trimmed = stripCodeFence(text.trim());
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const values = settings.value.宽松解析 ? parseTolerant(trimmed) : null;
    return values && values.length === 1 ? values[0] : undefined;
  }
}

/**
 * 正文中的指令块数，包括无法解析的。与能否解析无关，因此可以用来标记位置。
 *
 * 始终按**未遮蔽的原文**计数：旁路写入的位置（`ApiOp.after`）和 `EraCommand.block` 都用原文中的块序号，
 * 遮蔽思考块、外层标签只决定哪些块执行，不改变编号。这样新旧聊天、修改了思考标签设置之后，
 * 已保存的旁路写入都不会错位。
 */
export function countCommandBlocks(msg: any): number {
  return [...(getMessageContent(msg) ?? '').matchAll(BLOCK_REGEX)].length;
}

/** 解析方式，参见 `core/version.ts` 的 `getParseOptions`。缺省表示旧聊天的全文匹配。 */
export interface ParseOptions {
  /** 这些标签内的内容被替换成等长空格，其中的指令不执行。 */
  thinkTags?: readonly string[];
  /** 设置后只认该标签内部的指令（`<era_extra>` 中额外模型的输出除外）。 */
  outerTag?: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把 `[start, end)` 内除换行外的字符换成空格，保持长度与换行不变。 */
function maskRange(chars: string[], start: number, end: number) {
  for (let i = Math.max(0, start); i < Math.min(end, chars.length); i++) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}

/**
 * 遮蔽思考标签的内容（含标签本身）。
 * - 嵌套的思考标签按栈配对，不匹配的闭合标签忽略；
 * - 没有闭合的思考标签一直遮蔽到结尾（输出被截断）；
 * - 前面没有开始标签的闭合标签：接口丢掉了开头的 `<think>`，遮蔽从开头到它为止（额外模型的 `extractCommandBlocks` 同样如此）。
 */
function maskThinking(text: string, chars: string[], tags: readonly string[]) {
  if (tags.length === 0) return;
  const regex = new RegExp(`<(\\/?)\\s*(${tags.map(escapeRegExp).join('|')})(?=[\\s/>])[^>]*>`, 'gi');
  const stack: string[] = [];
  let start = 0;
  for (const match of text.matchAll(regex)) {
    const closing = !!match[1];
    const name = match[2].toLowerCase();
    const end = match.index + match[0].length;
    if (!closing) {
      if (stack.length === 0) start = match.index;
      stack.push(name);
    } else if (stack.length === 0) {
      maskRange(chars, 0, end);
    } else if (stack[stack.length - 1] === name) {
      stack.pop();
      if (stack.length === 0) maskRange(chars, start, end);
    }
  }
  if (stack.length > 0) maskRange(chars, start, text.length);
}

/**
 * 判断 `<era_extra>` 区段用的思考标签：解析方式的思考标签（旧聊天取脚本设置“思考标签”），并且总是包括 think、thinking。
 * 只用来排除写在思考里的块；遮蔽哪些思考块仍然只按解析方式。
 */
function extraRangeTags(options: ParseOptions | undefined): string[] {
  const tags = options ? (options.thinkTags ?? []) : splitTagList(settings.value.思考标签);
  return _.uniq(['think', 'thinking', ...tags.map(tag => tag.toLowerCase())]);
}

/**
 * 正文中分步更新写入的 `<era_extra>` 区段 `[start, end)`。只认 `appendExtraBlock` 写出的形式：
 * - 必须闭合（与 `stripExtraBlock` 一致）；只有开始标签的字样不算，也不会一直延伸到结尾；
 * - 开头落在闭合的思考块里的不算（主模型在思考里提到或举例）。思考块按 `maskThinking` 的规则配对，
 *   已认定的块整体跳过，其中的思考标签字样不参与配对；
 * - 开头落在没有闭合的思考标签之后的仍然算：主回复被截断，额外模型的输出照样追加在末尾；
 * - 前面没有开始标签的闭合思考标签（接口丢掉了开头的 `<think>`）之前的不算，与 `maskThinking` 遮蔽到它为止一致。
 *
 * 正文的思考遮蔽（`maskBodyThinking`）、外层标签的例外（`keepOuterTag`）与指令的来源标记（`parseCommandText`）共用它。
 */
function findExtraRanges(text: string, thinkTags: readonly string[]): [number, number][] {
  if (!/<era_extra>/i.test(text)) return [];
  const think = thinkTags.length
    ? String.raw`|<(\/?)\s*(${thinkTags.map(escapeRegExp).join('|')})(?=[\s/>])[^>]*>`
    : '';
  const regex = new RegExp(`(${EXTRA_BLOCK_PATTERN})${think}`, 'gi');
  const ranges: [number, number][] = [];
  // 落在还没闭合的思考块里的块：思考块闭合时丢弃，到结尾仍未闭合时保留
  let pending: [number, number][] = [];
  const stack: string[] = [];
  for (const match of text.matchAll(regex)) {
    if (match[1] !== undefined) {
      (stack.length > 0 ? pending : ranges).push([match.index, match.index + match[0].length]);
      continue;
    }
    const closing = !!match[2];
    const name = match[3].toLowerCase();
    if (!closing) {
      stack.push(name);
    } else if (stack.length === 0) {
      ranges.length = 0;
    } else if (stack[stack.length - 1] === name) {
      stack.pop();
      if (stack.length === 0) pending = [];
    }
  }
  return [...ranges, ...pending];
}

/**
 * 遮蔽正文的思考块，`<era_extra>` 区段（`findExtraRanges`）除外：额外模型的输出追加在正文末尾，正文里没有闭合的思考标签
 * （主回复被截断）不能把它一起遮蔽；`<era_extra>` 里的思考标签字样（例如值里的文字）也不影响正文。与 `keepOuterTag` 对它的例外一致。
 */
function maskBodyThinking(text: string, chars: string[], tags: readonly string[], ranges: [number, number][]) {
  if (tags.length === 0) return;
  if (ranges.length === 0) {
    maskThinking(text, chars, tags);
    return;
  }
  // 把 <era_extra> 区段换成空格再找思考标签，之后恢复这些区段的原文
  const body = text.split('');
  for (const [start, end] of ranges) maskRange(body, start, end);
  maskThinking(body.join(''), chars, tags);
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) chars[i] = text[i];
  }
}

/**
 * 只保留外层标签内部和 `<era_extra>` 区段（`findExtraRanges`）中的内容，其余遮蔽。`text` 应当已经遮蔽过思考块。
 * `<era_extra>` 区段里的外层标签字样不算。
 */
function keepOuterTag(text: string, chars: string[], tag: string, ranges: [number, number][]) {
  const name = escapeRegExp(tag);
  const regex = new RegExp(`<${name}(?=[\\s>])[^>]*>[\\s\\S]*?(?:<\\/${name}\\s*>|$)`, 'gi');
  const search = text.split('');
  for (const [start, end] of ranges) maskRange(search, start, end);
  const outer: [number, number][] = [...search.join('').matchAll(regex)].map(match => [
    match.index,
    match.index + match[0].length,
  ]);
  let kept = 0;
  for (const [start, end] of _.sortBy([...outer, ...ranges], range => range[0])) {
    maskRange(chars, kept, start);
    kept = Math.max(kept, end);
  }
  maskRange(chars, kept, text.length);
}

/**
 * 按解析方式遮蔽正文：思考块的内容、外层标签之外的内容都换成等长空格（保留换行），字符位置不变。
 * 没有解析方式（旧聊天）时原样返回。
 */
export function maskCommandText(text: string, options?: ParseOptions): string {
  if (!options || (_.isEmpty(options.thinkTags) && !options.outerTag)) return text;
  const chars = text.split('');
  const ranges = findExtraRanges(text, extraRangeTags(options));
  maskBodyThinking(text, chars, options.thinkTags ?? [], ranges);
  if (options.outerTag) keepOuterTag(chars.join(''), chars, options.outerTag, ranges);
  return chars.join('');
}

/** 片段看起来确实是一份数据，而不是用花括号包起来的说明文字。 */
const looksLikeData = (text: string): boolean => /["'“‘`][^"'“”‘’`]*["'”’`]\s*[:：]/.test(text);

/**
 * 解析一个指令块的内容：先严格解析（JSON、JSONL、带注释），再按设置尝试修复解析失败的部分。
 * @returns 解析出的值；无法解析时 `data` 为 `null`。`partial` 表示有一部分内容无法还原。
 */
function parseCommandBlock(content: string, type: string): { data: any[] | null; partial: boolean; legacy: boolean } {
  const isPatch = type === 'patch';
  // 删除指令里的空对象表示删除整个节点，被截断的内容绝不能自动补全
  const isDelete = type === 'delete';
  const tolerant = settings.value.宽松解析;
  for (const text of isPatch ? [content, stripComments(content)] : [content]) {
    try {
      const data = _.castArray(JSON.parse(text));
      return { data: _.flattenDeep(data), partial: false, legacy: !isPatch && data.length > 0 };
    } catch {
      // 继续尝试其他写法
    }
  }

  if (isPatch && content.trimStart().startsWith('[')) {
    const values = tolerant ? parseTolerant(content) : null;
    return { data: values && _.flatten(values), partial: false, legacy: false };
  }

  const failures: { at: number; text: string }[] = [];
  const parsed = parseJsonl(content, failures);
  const legacy = !isPatch && parsed.length > 0;
  if (parsed.length === 0) {
    const values = tolerant ? parseTolerant(content, isDelete) : null;
    return { data: values && _.flatten(values), partial: false, legacy };
  }
  // 已经解析出来的部分保持不变，只修复失败的片段
  let partial = false;
  const result = [...parsed];
  for (const { at, text } of _.reverse(failures)) {
    if (!looksLikeData(text)) continue;
    const values = tolerant && !isDelete ? parseTolerant(text, true) : null;
    if (values) result.splice(at, 0, ..._.flatten(values));
    else partial = true;
  }
  return { data: result, partial, legacy };
}

/**
 * 从一段文本中提取并解析所有 ERA 指令块，按出现顺序返回。
 *
 * @param text 文本，宏应当已经展开。
 * @param toSimplified 是否将指令内容转换为简体中文。
 * @param issues 用于收集无法解析的指令块。
 * @param options 解析方式；缺省为旧聊天的全文匹配。指令块的序号 `block` 始终按未遮蔽的原文计数，参见 `countCommandBlocks`。
 * @param escape 是否转义数据（`patch` 除外）。`false` 时得到原样的数据，用于对外返回或保存为旁路写入。
 */
export function parseCommandText(
  text: string,
  toSimplified: boolean = false,
  issues?: CommandIssue[],
  options?: ParseOptions,
  escape: boolean = true,
): EraCommand[] {
  if (!text) return [];
  const masked = maskCommandText(text, options);
  // 遮蔽后仍能匹配的块，序号取原文中在它之前开始的块数；没有遮蔽时就是匹配的序号
  const rawStarts = masked === text ? null : [...text.matchAll(BLOCK_REGEX)].map(match => match.index);
  // 额外模型输出中的指令标上来源，只用于报告；旧聊天同样标记，不改变执行结果
  const extraRanges = findExtraRanges(text, extraRangeTags(options));
  const inExtra = (at: number) => extraRanges.some(([start, end]) => at >= start && at < end);
  const commands: EraCommand[] = [];

  // COMMAND_REGEX 包含负向先行断言，可以一次性、正确地提取出指令块，同时忽略所有嵌套的、不相关的标签。
  for (const [index, match] of [...masked.matchAll(BLOCK_REGEX)].entries()) {
    const block = rawStarts ? _.sortedIndex(rawStarts, match.index) : index;
    const sourceTag = inExtra(match.index) ? { source: 'extra' as const } : {};
    if (match[1] === undefined) {
      // 工具调用：参数原样保存（不转义），由工具执行时校验
      const attrs = match[4] ?? '';
      const name = readAttribute(attrs, 'name')?.trim() ?? '';
      let argsText = match[5] ?? readAttribute(attrs, 'args') ?? '';
      if (toSimplified) argsText = traditionalToSimplified(argsText);
      const args = parseCallArgs(argsText);
      if (!name || args === undefined) {
        issues?.push({
          type: 'call',
          path: name || match[0].slice(0, 80),
          reason: name ? `<EraFCall name="${name}"> 的参数不是合法的 JSON` : '<EraFCall> 缺少 name 属性',
          ...sourceTag,
        });
        continue;
      }
      commands.push({ type: 'call', data: [{ name, args }], block, ...sourceTag });
      continue;
    }
    const fullTagName = match[1]; // e.g., "VariableInsert"
    const type = match[2].toLowerCase() as EraCommand['type']; // insert / edit / delete / patch
    const blockContent = match[3]; // The content inside the tags

    // 1. 清理块内容
    const cleanedBlock = stripCodeFence(blockContent.trim());
    if (!cleanedBlock) {
      continue;
    }

    // 2. (可选) 繁转简
    const contentToParse = toSimplified ? traditionalToSimplified(cleanedBlock) : cleanedBlock;

    // 3. 解析内容
    const parsed = parseCommandBlock(contentToParse, type);
    const parsedData = parsed.data;
    if (parsedData === null || parsed.partial) {
      issues?.push({
        type: 'parse',
        path: contentToParse.slice(0, 80),
        reason: `<${fullTagName}> 的内容不是合法的 JSON`,
        ...sourceTag,
      });
    }
    if (!parsedData) {
      log.warn('extractAndParseCommands', '指令块的内容无法解析，已跳过。', { content: contentToParse });
      continue;
    }

    // 4. 转义数据以供内部处理
    commands.push({
      type,
      data: escape && type !== 'patch' ? escapeEraData(parsedData) : parsedData,
      block,
      legacy: parsed.legacy,
      ...sourceTag,
    });
  }
  return commands;
}

/**
 * 从消息对象中提取、解析并转义所有 ERA 指令块，并按其在消息中出现的顺序返回一个统一的数组。
 *
 * @param {any} msg - 酒馆消息对象。
 * @param {boolean} [toSimplified=false] - 是否将提取的指令内容转换为简体中文。
 * @param {CommandIssue[]} [issues] - 用于收集无法解析的指令块。
 * @param options 解析方式，参见 `core/version.ts` 的 `getParseOptions`；缺省为旧聊天的全文匹配。
 * @returns {EraCommand[]} - 包含所有指令的有序数组。
 */
export function extractAndParseCommands(
  msg: any,
  toSimplified: boolean = false,
  issues?: CommandIssue[],
  options?: ParseOptions,
): EraCommand[] {
  const commands = parseCommandText(getMessageContent(msg) || '', toSimplified, issues, options);
  if (commands.length === 0) {
    log.debug('extractAndParseCommands', `消息 (ID: ${msg.message_id}) 未检测到变量修改标签。`);
  } else {
    log.debug('extractAndParseCommands', '解析出的有序指令列表', commands);
  }
  return commands;
}
