/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-27
 * 目的：新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；发给 AI 的提示词在监听器内直接替换宏，不再依赖事件队列的回调；宏的判断不区分大小写、允许空格；从发给 AI 的提示词中去掉状态栏占位符（没有更新规则的旧卡缺少对应的隐藏正则）
 *       2026-11-27 占位符的剥离抽成对单段文本的 stripStatusPlaceholderText（macro/placeholder.ts），与分步更新的提示词共用；旧卡的提示词同样去掉 <era_plan>
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
import { isQueueIdle, waitForQueueIdle } from '../events/queue';
import { ERA_EVENT_EMITTER, type WriteDonePayload } from '../utils/constants';
import { unescapeEraData } from '../utils/data';
import { getEraData, removeMetaFields, settings } from '../utils/era_data';
import { Logger } from '../utils/log';
import { stripPlanBlock } from '../extra/plan_block';
import { stripExtraBlock } from '../utils/message';
import { parseEraMacros } from './parse';
import { stripStatusPlaceholderText } from './placeholder';

export { parseEraMacros };

const logger = new Logger('MacroParser');

/** 文本中是否可能有 ERA 宏。与 `parseEraMacros` 的判断一致：不区分大小写，`{{` 后可以有空格。 */
const hasEraMacro = (text: unknown): text is string => typeof text === 'string' && /{{\s*ERA/i.test(text);

/** 提示词中的宏最多等待进行中的同步这么久（毫秒），超时后用当前的变量替换。 */
const PROMPT_SYNC_WAIT = 3000;

/**
 * 定义 `era:writeDone` 事件的处理函数。
 * 该函数会获取指定消息楼层的当前 HTML 内容，并重新解析其中的 ERA 宏。
 * @param payload - `era:writeDone` 事件的负载。
 */
const handleWriteDone = (payload: WriteDonePayload) => {
  // 在滑动回退操作后，不应触发宏的重新渲染，因为此时的消息内容是临时的。
  if (payload.actions.swipedRollback) {
    logger.debug('handleWriteDone', '检测到 swipedRollback，跳过宏刷新。');
    return;
  }

  const { message_id } = payload;

  if (typeof message_id !== 'number') {
    logger.warn('handleWriteDone', 'Event payload did not provide a valid message_id.');
    return;
  }

  try {
    const $messageDiv = retrieveDisplayedMessage(message_id);
    if (!$messageDiv.length) {
      // 消息可能不在当前可视区域内，这是正常情况，无需警告
      return;
    }

    const currentHtml = $messageDiv.html();

    // 如果当前 HTML 中不包含宏，则无需重新渲染
    if (!hasEraMacro(currentHtml)) {
      return;
    }

    const chatMessage = SillyTavern?.chat?.[message_id];
    const rawMessage = typeof chatMessage?.mes === 'string' ? chatMessage.mes : null;
    const messageHasMacro = hasEraMacro(rawMessage);
    const htmlHasMacro = hasEraMacro(currentHtml);

    if (!messageHasMacro && !htmlHasMacro) {
      return;
    }

    const parsedMessage = messageHasMacro ? parseEraMacros(rawMessage!, payload.stat, payload.statWithoutMeta) : null;
    const parsedHtml = htmlHasMacro ? parseEraMacros(currentHtml, payload.stat, payload.statWithoutMeta) : currentHtml;

    const messageChanged = parsedMessage !== null && parsedMessage !== rawMessage;
    const htmlChanged = parsedHtml !== currentHtml;

    if (!messageChanged && !htmlChanged) {
      return;
    }

    let hasUpdated = false;

    if (messageChanged) {
      const formatFn = typeof formatAsDisplayedMessage === 'function' ? formatAsDisplayedMessage : null;
      let formattedHtml: string | null = null;

      if (formatFn) {
        try {
          formattedHtml = formatFn(parsedMessage!, { message_id }) ?? null;
        } catch (formatError) {
          logger.warn('handleWriteDone', 'formatAsDisplayedMessage failed; falling back to DOM patch.', formatError);
        }
      }

      const updateMessageBlock = SillyTavern?.updateMessageBlock;
      if (typeof updateMessageBlock === 'function') {
        const patch: Record<string, unknown> = { mes: parsedMessage! };
        if (formattedHtml !== null) {
          patch.message = formattedHtml;
        }

        updateMessageBlock.call(SillyTavern, message_id, patch, { rerenderMessage: true });
        hasUpdated = true;
      } else if (formattedHtml !== null) {
        $messageDiv.html(formattedHtml);
        hasUpdated = true;
      }
    }

    if (!hasUpdated && htmlChanged) {
      const domPatched = replaceEraMacrosInElement($messageDiv, payload.stat, payload.statWithoutMeta);
      if (domPatched) {
        logger.debug('handleWriteDone', `Patched macros in-place for message_id: ${message_id}`);
        hasUpdated = true;
      }
    }

    if (hasUpdated) {
      logger.debug('handleWriteDone', `Successfully re-rendered macros for message_id: ${message_id}`);
    }
  } catch (error) {
    logger.error('handleWriteDone', `Failed to re-render macros for message_id: ${message_id}`, error);
  }
};

/**
 * 设置一个监听器，用于在 `era:writeDone` 事件触发时自动刷新消息中的宏。
 */
function setupMacroAutoRefresh() {
  eventOn(ERA_EVENT_EMITTER.WRITE_DONE, handleWriteDone);
  logger.log('setupMacroAutoRefresh', '监听到writeDone,开始对消息中的宏进行替换.');
}

/**
 * 移除宏自动刷新监听器，用于清理。
 */
function removeMacroAutoRefresh() {
  eventRemoveListener(ERA_EVENT_EMITTER.WRITE_DONE, handleWriteDone);
  logger.log('removeMacroAutoRefresh', 'Macro auto-refresh listener has been removed.');
}

function replaceEraMacrosInElement(
  $root: JQuery<HTMLElement>,
  statWithMeta?: object | null,
  statWithoutMeta?: object | null,
): boolean {
  let hasPatched = false;
  const quickMacroCheck = /{{\s*ERA/i;

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const original = node.nodeValue ?? '';
      if (!quickMacroCheck.test(original)) {
        return;
      }

      const replaced = parseEraMacros(original, statWithMeta, statWithoutMeta);
      if (replaced !== original) {
        node.nodeValue = replaced;
        hasPatched = true;
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const tagName = element.tagName;
    if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'TEXTAREA') {
      return;
    }

    const children = Array.from(node.childNodes);
    for (const child of children) {
      visit(child);
    }
  };

  $root.each((_, element) => {
    visit(element);
  });

  return hasPatched;
}

/** 用当前的变量替换提示词中的宏，口径与 `Era.getCurrentVars()` 一致。 */
function replacePromptMacros(prompt: SillyTavern.SendingMessage[]) {
  const { stat } = getEraData();
  const statWithMeta = unescapeEraData(stat);
  const statWithoutMeta = unescapeEraData(removeMetaFields(stat));
  for (const message of prompt) {
    if (!hasEraMacro(message.content)) continue;
    const originalContent = message.content;
    message.content = parseEraMacros(originalContent, statWithMeta, statWithoutMeta);
    if (originalContent !== message.content) {
      logger.debug('handleGenerateAfterData', `成功替换了 role: ${message.role} 消息中的 ERA 宏。`);
    }
  }
}

/**
 * 去掉提示词中历史 AI 消息里的状态栏占位符及其前面的空白，规则见 `stripStatusPlaceholderText`。
 * 范围与隐藏正则一致：只处理 AI 消息（`role: 'assistant'`，含多模态消息的文字部分）。
 */
export function stripStatusPlaceholder(
  prompt: SillyTavern.SendingMessage[],
  placeholder: string,
  appendEnabled = true,
) {
  const strip = (text: string) => stripStatusPlaceholderText(text, placeholder, appendEnabled);
  for (const message of prompt) {
    if (message.role !== 'assistant') continue;
    if (typeof message.content === 'string') {
      message.content = strip(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') part.text = strip(part.text);
      }
    }
  }
}

/**
 * 在发送到 AI 的数据准备好后，处理其中的 ERA 宏。
 *
 * 酒馆在序列化请求之前会等待监听器返回，因此替换必须在监听器返回（或它返回的 Promise 完成）之前做完：
 * - 事件队列空闲时，直接同步替换；
 * - 还有同步在进行（例如刚发送的消息、滑动重新生成的回退）时，返回一个 Promise，等同步完成后再替换，
 *   最多等待 `PROMPT_SYNC_WAIT` 毫秒，超时就用当前的变量替换。
 * @param generate_data - 包含提示词的对象。
 * @param dry_run - 是否为演习运行。
 */
export const handleGenerateAfterData = (
  generate_data: { prompt: SillyTavern.SendingMessage[] },
  dry_run: boolean,
): void | Promise<void> => {
  if (dry_run) {
    return;
  }

  // 额外模型的输出、正文前规划块不发给剧情模型（规划摘要另行注入）；旧卡的隐藏正则不认识它们的标签
  for (const message of generate_data.prompt) {
    if (typeof message.content === 'string' && message.content.includes('<era_extra>')) {
      message.content = stripExtraBlock(message.content);
    }
    if (typeof message.content === 'string' && message.content.includes('<era_plan>')) {
      message.content = stripPlanBlock(message.content);
    }
  }
  stripStatusPlaceholder(generate_data.prompt, settings.value.特殊符号值, settings.value.在ai消息尾部生成特殊符号);

  // 检查提示中是否真的有宏，没有就直接返回
  if (!generate_data.prompt.some(p => hasEraMacro(p.content))) {
    return;
  }

  if (isQueueIdle()) {
    replacePromptMacros(generate_data.prompt);
    return;
  }
  logger.debug('handleGenerateAfterData', '事件队列中还有任务，等待同步完成后再替换宏。');
  return waitForQueueIdle(PROMPT_SYNC_WAIT).then(idle => {
    if (!idle) logger.warn('handleGenerateAfterData', '等待同步超时，使用当前的变量替换提示词中的宏。');
    replacePromptMacros(generate_data.prompt);
  });
};

$(() => {
  /**
   * 注册 ERA 宏, 用于在发送给 AI 的消息中查询当前聊天的变量数据。
   * 根据用户需求，此宏仅在处理系统提示词（`role: 'system'`）时生效。
   *
   * - `{{ERA:path.to.data}}`: 查询并替换为**不含** `$meta` 的纯净数据。
   * - `{{ERA-withmeta:path.to.data}}`: 查询并替换为**包含** `$meta` 的原始数据。
   */
  /*
  registerMacroLike(/{{\s*ERA(-withmeta)?\s*:\s*([^}]+?)\s*}}/gi, (context, substring) => {
    // 只在宏的上下文角色为 'system' 时才进行解析。
    // 这确保了宏只在构建系统提示词（如世界书、角色卡设定等）时被替换。
    if (context.role === 'system') {
      logger.debug('registerMacroLike', '在系统提示词 (role=system) 中解析ERA宏', { substring });
      return parseEraMacros(substring);
    }

    // 对于其他角色（如 'user', 'assistant'）或角色未定义的情况，
    // 不解析宏，直接返回原始宏字符串。
    // 聊天消息中显示的宏将由 `handleWriteDone` 事件监听器负责刷新。
    return substring;
  });
  */

  // 监听 `GENERATE_AFTER_DATA` 事件，在提示词发送前处理 ERA 宏
  eventOn(tavern_events.GENERATE_AFTER_DATA, handleGenerateAfterData);

  // 设置宏自动刷新监听器
  setupMacroAutoRefresh();

  // 在卸载时清理监听器。虽然酒馆助手会自动清理，但显式移除是好习惯。
  $(window).on('pagehide', () => {
    removeMacroAutoRefresh();
    eventRemoveListener(tavern_events.GENERATE_AFTER_DATA, handleGenerateAfterData);
  });
});
