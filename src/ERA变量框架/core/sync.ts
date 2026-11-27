/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：重算时不再对每条消息深拷贝全部元数据；新增可选的变量结构 schema 校验与全局接口 Era；修复 schema 校验在审查与实测中发现的问题；新增脚本设置“清理失效日志”等；同步返回结果状态，stat 与元数据一次写入；重算前不再深拷贝全部日志；；记录最新 AI 楼未生效的指令（{{ERA-issues}}），同步后校验最新状态并广播 era:schemaInvalid
 *       2026-11-26 新聊天在第一次重算前记下解析版本，每次写入记下写入版本，由更新的 ERA 写过的聊天提示一次
 *       2026-11-27 钩子、工具、公式函数统一判断；记下工具与公式函数的版本，新增或提高版本时完全重算；广播 era:toolResult
 *       2026-11-27 因未知工具或未知函数而失败的名字记进元数据（'missing'），换页面会话后注册时也完全重算一次
 *       2026-11-27 只对以前注册过的名字记 missing，AI 编造的名字不进元数据
 *       2026-11-28 问题说明改用 describeIssue
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
'use strict';

/**
 * @file 状态同步核心
 * @description 本文件中的 `resyncStateOnHistoryChange` 是 ERA 变量框架最核心的函数之一。
 * 它通过实现“逆序回滚，顺序重算”的逻辑，解决了因消息删除、切换分支 (swipe) 等操作导致的变量状态与消息历史不一致的棘手问题。
 *
 * ### 酒馆的奇特行为 (Feature, not a bug)
 *
 * 当删除一条 swipe (例如，带有变量 id=2 的消息) 时：
 * 1. **内容与变量错位**: 后一条 swipe (id=3) 的**内容**会“顶”到被删除的 swipe (id=2) 的位置上，但**变量**却保留了 id=2 的变量。
 * 2. **孤儿变量残留**: 原本的 swipe 3 消息虽然在界面上消失了，但它对应的**消息变量** (id=3) 仍然残留在聊天数据中，成为“孤儿变量”。
 * 3. **孤儿变量继承**: 如果用户此时再 swipe 一次，新生成的 swipe 3 将会**继承**这个残留的孤儿变量 (id=3)，导致新内容配旧变量，进一步加剧状态混乱。
 * 4. **结果**: 我们得到了一个内容是 id=3、变量是 id=2 的“混合”消息，并且还有一个 id=3 的孤儿变量随时可能被新消息继承，造成严重的状态不一致。
 *
 * ### 本函数的解决策略
 *
 * `resyncStateOnHistoryChange` 通过全面的状态比对来解决此问题：
 * 1. 在 `message_deleted`, `message_swiped` 等事件触发时被调用。
 * 2. 全面获取当前实际的消息列表，并与之前记录的 `SelectedMks` 序列进行比对。
 * 3. 精确找到第一个不一致的点（无论是删除、还是修改）。
 * 4. **逆序回滚**: 从后往前，将所有不一致的 `MK` 所引入的变量修改全部撤销。
 * 5. **顺序重算**: 从不一致点开始，根据当前消息的**实际内容**，重新计算并写入变量。
 *
 * **最终效果**: 无论历史记录发生何种变化，变量状态都能被完美地自动修复，确保数据一致性。
 */

import {
  API_OPS_PATH,
  EXTENSIONS_PATH,
  CommandErrorPayload,
  ERA_EVENT_EMITTER,
  ERA_VERSION,
  FOLDED_MK_PATH,
  LOGS_PATH,
  SchemaErrorItem,
  SchemaErrorPayload,
  SEL_PATH,
  WRITTEN_WITH_PATH,
} from '../utils/constants';
import { parseEditLog } from '../utils/data';
import { getEraData, settings, stampNewChatMeta, updateEraData, updateEraMetaData } from '../utils/era_data';
import { Logger } from '../utils/log';
import { isUserMessage } from '../utils/message';
import { findFirstDirtyIndex } from './api_ops';
import { foldOldLogs, getFoldedIndex, isFastSyncSafe, resolveRecalcStart, rollbackFoldedToInitial } from './compaction';
import { describeIssue } from './crud/diagnostics';
import { ApplyVarChangeForMessage } from './crud/patcher';
import { getActiveHooks } from '../api/hook_registry';
import {
  getExtensionKeys,
  getExtensionVersions,
  getUnknownExtensions,
  hasActiveExtensions,
  MISSING_EXTENSION_VERSION,
} from '../api/tool_registry';
import { getActiveSchema } from '../api/schema_registry';
import { ARCHIVE_BATCH, archiveFoldedLogs, canArchive, expandArchive, loadArchive, resetArchive } from './log_archive';
import { dedupeMessageKeys, ensureMessageKey, readMessageKey } from './key/mk';
import { clearPendingApiWrites, findFirstPendingIndex } from './pending_api';
import { buildFloorReport, checkLatestSchema, FloorReport, recordFloorReports } from './latest_report';
import { rollbackStatToMK } from './timetravel';
import { warnIfWrittenByNewer } from './version';

const logger = new Logger();

/** 能否靠日志回滚到 `start` 之前：它前一楼和末楼的 MK 都必须存在。 */
const canRollbackTo = (start: number, mks: (string | null)[]): boolean => !!mks[start - 1] && !!mks[mks.length - 1];

/** 如果 `start` 处是用户消息，返回它前面最近的一条 AI 消息；没有或无法回滚到那里时返回 `start`。 */
export const stepBackToAiMessage = (start: number, messages: any[], selectedMks: (string | null)[]): number => {
  let first = start;
  while (first > 0 && isUserMessage(messages[first])) first--;
  // 起点之前必须有 MK，否则 rollbackStatToMK 会一路回滚到初始状态
  return first > 0 && !selectedMks[first - 1] ? start : first;
};

/**
 * 注册了钩子时，把重算起点前移，保证没有 AI 消息漏算：
 * - 起点是用户消息时，退到它前面的 AI 消息（钩子只对 AI 消息生效）；
 * - 紧邻的、只登记过 MK 而从未计算过（没有日志记录）的 AI 消息一并重算。
 *
 * 折叠边界及之前的楼层没有逐楼日志，但都计算过，因此不会越过 `foldedIndex`。
 */
export const widenRecalcForHooks = (
  start: number,
  messages: any[],
  selectedMks: (string | null)[],
  allLogs: { [mk: string]: any },
  foldedIndex = -1,
): number => {
  let first = Math.min(start, messages.length - 1);
  while (first > Math.max(foldedIndex + 1, 0) && isUserMessage(messages[first])) first--;
  for (let i = first - 1; i > foldedIndex; i--) {
    if (isUserMessage(messages[i])) continue;
    if (_.has(allLogs, [selectedMks[i] as any])) break; // 空日志也算计算过
    first = i;
  }
  // 起点之前必须有 MK，否则 rollbackStatToMK 会一路回滚到初始状态
  return first > 0 && !selectedMks[first - 1] ? start : first;
};

/**
 * 只保留仍在 `selectedMks` 中的消息的日志。
 * @returns 新的日志对象，不修改传入的对象。
 */
export const pruneOrphanLogs = (
  allLogs: { [mk: string]: any },
  selectedMks: (string | null | undefined)[],
): { [mk: string]: any } => {
  const alive = new Set(selectedMks.filter(Boolean));
  return _.pickBy(allLogs, (_log, mk) => alive.has(mk));
};

/**
 * 最近一次“从第 0 楼重放”时生效的钩子和 schema。
 * 折叠后的聊天可能在角色卡脚本重新注册钩子、schema 之前就从头重放，丢掉它们对全部历史的影响；
 * 之后一旦有新的钩子或 schema 注册，就再完全重算一次。
 */
let lastReplay: { chat: string | undefined; active: string[] } | null = null;

const getActiveExtensions = (): string[] => [
  ...getActiveHooks('before').map(hook => `before:${hook.id}`),
  ...getActiveHooks('after').map(hook => `after:${hook.id}`),
  ...(getActiveSchema() ? ['schema'] : []),
  // 工具与公式函数带版本号：新增或提高版本都会触发完全重算
  ...getExtensionKeys(),
];

/** 上一次已弹窗提示过的 schema 拦截内容，用于避免同一条消息被重复同步时反复弹窗。 */
let lastNotifiedSchemaErrors = '';

/**
 * 报告本轮同步中被变量结构 schema 拦截的修改。
 * - 始终广播 `era:schemaError` 事件，供外部脚本处理。
 * - 只对最新一条消息的拦截弹窗提示，避免重算历史消息时刷屏。
 */
const reportSchemaErrors = (errors: SchemaErrorItem[], lastMessageId: number) => {
  if (errors.length === 0) {
    lastNotifiedSchemaErrors = '';
    return;
  }

  const payload: SchemaErrorPayload = { errors };
  eventEmit(ERA_EVENT_EMITTER.SCHEMA_ERROR, payload);

  const latestErrors = errors.filter(error => error.message_id === lastMessageId);
  if (latestErrors.length === 0) return;

  const signature = JSON.stringify(latestErrors);
  if (signature === lastNotifiedSchemaErrors) return;
  lastNotifiedSchemaErrors = signature;

  // schema 的错误说明本身已带有具体的字段路径（比被拦截的日志路径更精确），这里只取第一行。
  const lines = latestErrors.slice(0, 3).map(error => error.message.split('\n')[0]);
  if (latestErrors.length > 3) {
    lines.push(`……共 ${latestErrors.length} 处`);
  }
  toastr.warning(lines.map(line => _.escape(line)).join('<br>'), '[ERA] 部分变量修改不符合变量结构，已忽略', {
    escapeHtml: false,
  });
};

let lastNotifiedCommandErrors = '';

/** 报告没有生效的指令：始终广播 `era:commandError`；按设置对最新一条消息弹窗提示。 */
const reportCommandErrors = (errors: CommandErrorPayload['errors'], lastMessageId: number) => {
  if (errors.length === 0) {
    lastNotifiedCommandErrors = '';
    return;
  }
  eventEmit(ERA_EVENT_EMITTER.COMMAND_ERROR, { errors } satisfies CommandErrorPayload);

  const latest = errors.filter(error => error.message_id === lastMessageId);
  const signature = JSON.stringify(latest);
  if (!settings.value.指令失败提示 || latest.length === 0 || signature === lastNotifiedCommandErrors) return;
  lastNotifiedCommandErrors = signature;
  const lines = latest.slice(0, 3).map(describeIssue);
  if (latest.length > 3) lines.push(`……共 ${latest.length} 处`);
  toastr.warning(lines.map(line => _.escape(line)).join('<br>'), '[ERA] 部分变量指令没有生效', { escapeHtml: false });
};

/**
 * 读取消息的 MK（用户消息同样有 MK）；没有时返回 null。
 * @param msg 消息对象
 * @returns MK 字符串或 null
 */
const getMkFromMsg = (msg: any): string | null => {
  const key = readMessageKey(msg);
  if (!key) return null;

  return key;
};

/**
 * 检查一组 MK 对应的 EditLog 是否都为空
 * @param mks MK 列表
 * @param metaData 要检查的元数据对象
 * @returns 如果所有 EditLog 都为空则返回 true
 */
const checkEditLogsAreEmpty = (mks: (string | null)[], metaData: any): boolean => {
  for (const mk of mks) {
    if (!mk) continue; // 跳过 null (用户消息)
    const editLogRaw = _.get(metaData, [LOGS_PATH, mk]);
    const editLog = parseEditLog(editLogRaw);
    if (editLog.length > 0) {
      return false; // 发现一个非空 log，直接返回 false
    }
  }
  return true; // 所有 log 都为空
};

/**
 * 比较当前消息历史与最后已知状态，以找到分歧的第一个点。
 * 这决定了变量应从何处开始重新计算。
 * 它还包括一个优化，如果仅删除了没有变量更改的消息，则执行“快速同步”。
 *
 * @param allMessages 当前所有消息的列表。
 * @param oldSelectedMks 上次同步状态下的消息密钥 (MK) 列表。
 * @param initialMeta 上次同步状态下的元数据，用于检查 EditLogs。
 * @param forceFullResync 如果为 true，则强制从头开始重新计算。
 * @param hasDirtyOps 是否有尚未执行的旁路 API 写入，有则不能走快速同步。
 * @returns 一个描述所需操作的对象。
 */
const findDivergencePoint = (
  allMessages: any[],
  oldSelectedMks: (string | null)[],
  initialMeta: any,
  forceFullResync: boolean,
  hasDirtyOps: boolean,
): { type: 'FULL_RECALC'; recalcId: number } | { type: 'FAST_SYNC'; newSelectedMks: (string | null)[] } => {
  if (forceFullResync) {
    logger.debug('findDivergencePoint', '强制模式：设置重算起点为 0。');
    return { type: 'FULL_RECALC', recalcId: 0 };
  }

  const currentMks = allMessages.map(getMkFromMsg);

  // 1. 首先，无条件找到第一个分歧点
  let firstMismatch = -1;
  const minLength = Math.min(currentMks.length, oldSelectedMks.length);
  for (let i = 0; i < minLength; i++) {
    // 没有 MK 的 AI 消息从未计算过
    if (currentMks[i] !== oldSelectedMks[i] || (!currentMks[i] && !isUserMessage(allMessages[i]))) {
      firstMismatch = i;
      break;
    }
  }
  if (firstMismatch === -1 && currentMks.length !== oldSelectedMks.length) {
    firstMismatch = minLength;
  }

  // 2. 处理“无分歧”的情况
  if (firstMismatch === -1) {
    const recalcId = allMessages.length > 0 ? allMessages.length - 1 : 0;
    logger.debug('findDivergencePoint', `所有MK均匹配。启动模拟写入，强制重算最后一条消息 (ID: ${recalcId})。`);
    return { type: 'FULL_RECALC', recalcId };
  }

  // 3. 处理“有分歧”的情况
  const deletedMks = _.difference(oldSelectedMks, currentMks);
  const addedMks = _.difference(currentMks, oldSelectedMks);

  // 唯一的优化机会：纯粹的无害删除
  if (
    !hasDirtyOps &&
    addedMks.length === 0 &&
    deletedMks.length > 0 &&
    currentMks.every(Boolean) &&
    isFastSyncSafe(deletedMks, currentMks, initialMeta, oldSelectedMks) &&
    checkEditLogsAreEmpty(deletedMks, initialMeta)
  ) {
    logger.debug('findDivergencePoint', '检测到纯粹的无害删除。建议执行快速同步。');
    return { type: 'FAST_SYNC', newSelectedMks: currentMks };
  }

  // 所有其他情况（有害删除、有新增、混合更改）都必须从最早的分歧点重算
  logger.debug('findDivergencePoint', `检测到需要分歧点重算。将从最早的分歧点 (ID: ${firstMismatch}) 开始。`);
  return { type: 'FULL_RECALC', recalcId: firstMismatch };
};

/**
 * 同步的结果：
 * - `done`：已完成（包括聊天为空、无需写入的情况）；
 * - `aborted`：同步过程中切换了聊天，没有写入任何结果；
 * - `failed`：出错，没有写入任何结果。
 */
export type SyncStatus = 'done' | 'aborted' | 'failed';

/**
 * 当聊天记录发生变化（删除、切换分支）时，重新同步状态的核心函数
 * 实现了“逆序回滚，顺序重算”的逻辑。
 * 在没有检测到历史变化时，该函数还会自动回滚并重算最后一条消息，从而实现了“写入”操作的统一。
 * @param {boolean} [forceFullResync=false] - 如果为 true，则强制从头开始完全重算，忽略差异检测。
 * @param {number} [targetMessageId] - 如果提供，则将重算起点强制设置为此消息 ID。
 * @param {boolean} [stopAtTarget=false] - 如果为 true，重算将在处理完作为重算起点的消息后停止。
 */
export const resyncStateOnHistoryChange = async (
  forceFullResync = false,
  targetMessageId?: number,
  stopAtTarget = false,
): Promise<SyncStatus> => {
  try {
    if (forceFullResync) {
      logger.warn('resyncStateOnHistoryChange', '强制完全重算模式已启动！');
    } else {
      logger.debug('resyncStateOnHistoryChange', '聊天记录变更，启动状态同步...');
    }

    // 获取脚本设置并构建 config
    const config = {
      繁体转简体: settings.value.繁体转简体,
    };

    // 核心假设：getChatMessages 会重新生成 message_id，使其保持从 0 开始的连续序列。
    // 同步过程中可能切换聊天：为另一个聊天算出的结果绝不能写入当前聊天，届时直接放弃，
    // 新聊天会由 CHAT_CHANGED 触发自己的同步。
    const chatId = SillyTavern.getCurrentChatId?.();
    const isChatSwitched = () => {
      const switched = SillyTavern.getCurrentChatId?.() !== chatId;
      if (switched) logger.warn('resyncStateOnHistoryChange', '同步过程中切换了聊天，放弃本次结果。');
      return switched;
    };

    let allMessages = getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
    if (await dedupeMessageKeys(allMessages ?? [])) {
      allMessages = getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
    }
    logger.debug('resyncStateOnHistoryChange', '获取到的 allMessages:', () => allMessages);

    const activeExtensions = getActiveExtensions();
    if (lastReplay && lastReplay.chat !== chatId) {
      lastReplay = null;
    } else if (lastReplay && !stopAtTarget && _.difference(activeExtensions, lastReplay.active).length > 0) {
      forceFullResync = true;
      targetMessageId = undefined;
    }

    // 在函数开始时一次性获取所有数据
    const { stat: initialStat, meta: storedMeta } = getEraData();
    let initialMeta = storedMeta;
    warnIfWrittenByNewer(storedMeta, chatId);
    // 工具与公式函数的版本记在元数据里：新注册的或提高了版本的，历史要按新逻辑完全重算一次（跨页面会话也有效）
    const extensionVersions = getExtensionVersions();
    const storedVersions: Record<string, string> = _.get(storedMeta, EXTENSIONS_PATH, {});
    if (!stopAtTarget && Object.entries(extensionVersions).some(([name, v]) => storedVersions[name] !== v)) {
      forceFullResync = true;
      targetMessageId = undefined;
    }
    // oldSelectedMks 从 initialMeta 派生
    const oldSelectedMks: (string | null)[] = _.cloneDeep(_.get(initialMeta, SEL_PATH, []));

    logger.debug(
      'resyncStateOnHistoryChange',
      `状态快照: oldSelectedMks.length=${oldSelectedMks.length}, allMessages.length=${allMessages?.length ?? 0}`,
    );

    if (!allMessages || allMessages.length === 0) {
      logger.debug('resyncStateOnHistoryChange', '当前聊天记录为空，不执行任何操作，同步终止。');
      return 'done';
    }

    // 第一条含有尚未执行的旁路 API 写入的消息
    const dirtyOpsIndex = findFirstDirtyIndex(allMessages, _.get(initialMeta, API_OPS_PATH));
    // 第一条被 API 追加过指令块、但还没有重新计算的消息
    const pendingIndex = findFirstPendingIndex(allMessages.map(getMkFromMsg));
    const dirtyIndex = _.min([dirtyOpsIndex, pendingIndex].filter(index => index !== -1)) ?? -1;

    // 旧版 ERA 在“复制消息”后可能已经留下重复的 MK，它们的日志互相覆盖、无法用来回滚，只能丢弃后从头重放
    const knownMks = oldSelectedMks.filter(Boolean);
    const hasDuplicateMks = new Set(knownMks).size !== knownMks.length;

    // 1. 找出分歧点
    let divergence:
      { type: 'FULL_RECALC'; recalcId: number } | { type: 'FAST_SYNC'; newSelectedMks: (string | null)[] };
    if (typeof targetMessageId === 'number' && Number.isFinite(targetMessageId)) {
      const normalizedTargetId = Number(targetMessageId);
      logger.debug(
        'resyncStateOnHistoryChange',
        `检测到定向同步请求，直接以消息 ID ${normalizedTargetId} 作为重算起点。`,
      );
      divergence = { type: 'FULL_RECALC', recalcId: normalizedTargetId };
    } else {
      divergence = findDivergencePoint(
        allMessages,
        oldSelectedMks,
        initialMeta,
        forceFullResync,
        dirtyIndex !== -1 || hasDuplicateMks,
      );
    }

    // 2. 处理分歧结果
    if (divergence.type === 'FAST_SYNC') {
      if (isChatSwitched()) return 'aborted';
      logger.debug('resyncStateOnHistoryChange', '执行快速同步...');
      await updateEraMetaData(meta => {
        _.set(meta, SEL_PATH, divergence.newSelectedMks);
        return meta;
      });
      logger.debug('resyncStateOnHistoryChange', '快速同步完成，仅修正 SelectedMks 数组。');
      return 'done';
    }

    let firstRecalcId = divergence.recalcId;
    const stopId = firstRecalcId; // 定向同步的终点，不随起点前移
    if (targetMessageId !== undefined) {
      // 目标之前若有楼层与记录不一致（例如刚执行过 rollbackTo），必须从那里开始，否则这些楼层会被跳过或重复计算
      const mismatch = allMessages.findIndex((msg, i) => !oldSelectedMks[i] || getMkFromMsg(msg) !== oldSelectedMks[i]);
      if (mismatch !== -1) firstRecalcId = Math.min(firstRecalcId, mismatch);
    }
    if (dirtyIndex !== -1) firstRecalcId = Math.min(firstRecalcId, dirtyIndex);
    const appliedRevs: Record<string, number> = {};

    // 只删除了末尾消息时，重算起点会落在消息列表之外，下面的重算循环一次都不会执行。
    // 没有 schema 时这正是想要的结果（回滚被删消息即可）；但注册了 schema 后，
    // 被删消息的日志里可能带有 schema 的纠正（如补全的默认值），回滚后状态会不再符合 schema。
    // 因此改为从最后一条剩余消息开始重算，让它重新做一次纠正。
    if (firstRecalcId >= allMessages.length && allMessages.length > 0 && getActiveSchema()) {
      firstRecalcId = allMessages.length - 1;
    }

    // API 写入把指令追加在最后一条 AI 消息上。如果它后面还有用户消息，只重算末楼会漏掉这次写入，
    // 因此起点是用户消息时，退到它前面的 AI 消息。（定向同步的起点由调用方指定，不能前移。）
    if (targetMessageId === undefined && firstRecalcId < allMessages.length) {
      firstRecalcId = stepBackToAiMessage(firstRecalcId, allMessages, oldSelectedMks);
    }

    if (!stopAtTarget && hasActiveExtensions()) {
      firstRecalcId = widenRecalcForHooks(
        firstRecalcId,
        allMessages,
        oldSelectedMks,
        _.get(initialMeta, LOGS_PATH, {}),
        getFoldedIndex(initialMeta, oldSelectedMks),
      );
    }

    // 3. 执行逆序回滚（内存中）
    // 确定重算的起始状态。默认为初始状态。
    let statForRecalc = initialStat;
    // 旧日志已折叠、且需要回滚到折叠边界及之前时，改为从第 0 楼按正文重放。
    let recalcStart = hasDuplicateMks ? 0 : resolveRecalcStart(firstRecalcId, initialMeta, oldSelectedMks);
    let verified = 0;
    const folded = getFoldedIndex(initialMeta, oldSelectedMks);
    if (recalcStart === 0 && firstRecalcId > 0 && firstRecalcId <= folded && !hasDuplicateMks && !forceFullResync) {
      // 起点在折叠边界之前：存档可用时先还原，就不必从头重放
      await loadArchive(initialMeta);
      if (isChatSwitched()) return 'aborted';
      const expanded = expandArchive(initialMeta);
      const start = expanded ? resolveRecalcStart(firstRecalcId, expanded, oldSelectedMks) : 0;
      if (start > 0 && canRollbackTo(start, oldSelectedMks)) {
        initialMeta = expanded;
        recalcStart = start;
        verified = start;
      }
    }
    // 起点之前或末尾的 MK 缺失时，无法知道要回滚到哪里，只能从头计算
    const replayWithoutFold =
      !hasDuplicateMks &&
      !_.get(initialMeta, FOLDED_MK_PATH) &&
      recalcStart > 0 &&
      recalcStart < oldSelectedMks.length &&
      !canRollbackTo(recalcStart, oldSelectedMks);
    if (replayWithoutFold) recalcStart = 0;
    const replayFromStart = recalcStart === 0 && !!_.get(initialMeta, FOLDED_MK_PATH);
    if (hasDuplicateMks) {
      logger.warn('resyncStateOnHistoryChange', '聊天记录中存在重复的 MK，丢弃日志并从头重放。');
      statForRecalc = {};
    } else if (replayFromStart) {
      statForRecalc = rollbackFoldedToInitial(initialStat, initialMeta, oldSelectedMks);
    } else if (replayWithoutFold) {
      const lastMk = _.findLast(oldSelectedMks, Boolean);
      statForRecalc = lastMk
        ? rollbackStatToMK(undefined, lastMk, initialStat, oldSelectedMks, _.get(initialMeta, LOGS_PATH, {}))
        : initialStat;
    } else if (firstRecalcId > -1 && firstRecalcId < oldSelectedMks.length) {
      const allLogs: { [mk: string]: string } = _.get(initialMeta, LOGS_PATH, {});
      const currentMK = oldSelectedMks[oldSelectedMks.length - 1];
      const targetMK = firstRecalcId > 0 ? oldSelectedMks[firstRecalcId - 1] : undefined;

      if (currentMK) {
        logger.debug('resyncStateOnHistoryChange', `准备一次性回滚。从: ${currentMK}, 到: ${targetMK || '初始状态'}`);
        // 回滚结果作为重算的起点
        statForRecalc = rollbackStatToMK(targetMK, currentMK, initialStat, oldSelectedMks, allLogs);
        logger.debug('resyncStateOnHistoryChange', '逆序回滚完成（内存中）。');
      }
    }

    // 4. 从不匹配点开始，顺序重新应用变量修改，并构建新的 selectedMks
    logger.debug('resyncStateOnHistoryChange', `从 ID ${firstRecalcId} 开始顺序重算...`);
    const newSelectedMks: (string | null)[] = oldSelectedMks.slice(0, recalcStart); // 继承匹配部分

    // 为重算过程创建一个 meta 的可变副本。
    // 只复制会被修改的部分：下游只替换顶层字段、整楼替换或删除 EditLogs 中的条目，不会原地修改单条日志，
    // 深拷贝全部日志会让每次回复的开销随聊天长度增长。
    let metaForRecalc = { ...initialMeta, [LOGS_PATH]: { ..._.get(initialMeta, LOGS_PATH, {}) } };
    // 新聊天：在第一次计算之前记下解析版本，使这次计算与之后的重算按同一种方式解析
    if (_.isEmpty(storedMeta)) stampNewChatMeta({}, metaForRecalc);
    if (replayFromStart) {
      // 日志会随循环全部重建，折叠标记不再有效
      _.unset(metaForRecalc, FOLDED_MK_PATH);
      resetArchive(metaForRecalc);
    }
    if (hasDuplicateMks) {
      _.set(metaForRecalc, LOGS_PATH, {});
    }
    const schemaErrors: SchemaErrorItem[] = [];
    const commandErrors: CommandErrorPayload['errors'] = [];
    // 本次计算过的 AI 楼的报告（{{ERA-issues}}），写入成功后才记录
    const floorReports: FloorReport[] = [];

    for (let i = recalcStart; i < allMessages.length; i++) {
      // 如果是定向同步，并且已经处理完目标消息，则中止循环
      if (stopAtTarget && i > stopId) {
        logger.debug('resyncStateOnHistoryChange', `定向同步完成，已处理至目标消息 ID: ${stopId}。中止重算。`);
        break;
      }
      const msg = allMessages[i];

      // --- 关键修复 ---
      // 为本次计算创建一个拥有正确历史范围的“上下文元数据”。
      // 1. 继承到目前为止已重算的所有日志。
      //    这里只做浅拷贝：下游只读取 EditLogs 和 SelectedMks，不会修改它们，
      //    而对每条消息都深拷贝全部日志会让完全重算的开销随楼层数平方增长。
      // 2. 关键：将上下文中的 selectedMks 严格限制为当前消息之前的部分。
      //    newSelectedMks 在每次循环开始时，都代表了从 0 到 i-1 的正确历史。
      const contextMeta = { ...metaForRecalc, [SEL_PATH]: newSelectedMks.slice(0, i) };
      // --- 修复结束 ---

      let ensuredMkForCurrent: string | null = readMessageKey(msg) || null;
      if (!ensuredMkForCurrent) {
        logger.debug('resyncStateOnHistoryChange', `当前消息id: ${msg?.message_id ?? 'unknown'}) 缺少 MK。为其生成.`);
        // 注入 MK 会写回正文，绝不能写进另一个聊天
        if (isChatSwitched()) return 'aborted';
        try {
          const { mk: ensuredMk } = await ensureMessageKey(msg);
          ensuredMkForCurrent = ensuredMk;
          //mk注入程序只会为消息增加mk，所以不需要刷新消息
        } catch (ensureError: any) {
          logger.error('resyncStateOnHistoryChange', `mk注入失败，跳过消息`, {
            ensureError,
            message_id: msg?.message_id,
          });
          continue;
        }
      }

      // 调用当前消息的变量写入
      const { finalStat, finalEditLog, schemaRejections, commandIssues, toolResults } = await ApplyVarChangeForMessage(
        msg,
        statForRecalc,
        contextMeta,
        config,
        ensuredMkForCurrent ?? undefined,
      );
      for (const rejection of schemaRejections) {
        schemaErrors.push({ mk: ensuredMkForCurrent, message_id: i, ...rejection });
      }

      for (const issue of commandIssues) {
        commandErrors.push({ mk: ensuredMkForCurrent, message_id: i, ...issue });
      }
      if (ensuredMkForCurrent && !isUserMessage(msg)) {
        floorReports.push(
          buildFloorReport(chatId, ensuredMkForCurrent, i, commandIssues, schemaRejections, toolResults),
        );
      }

      newSelectedMks[i] = ensuredMkForCurrent;
      // 没有记录时也记 0，这样同步期间新写入的内容仍会被视为尚未执行
      if (ensuredMkForCurrent) {
        appliedRevs[ensuredMkForCurrent] = _.get(metaForRecalc, [API_OPS_PATH, ensuredMkForCurrent, 'rev'], 0);
      }

      // 更新状态，为下一次循环做准备
      statForRecalc = finalStat;
      // 将新生成的日志写入主 metaForRecalc 对象，为下一次循环的 clone 做准备
      _.set(metaForRecalc, [LOGS_PATH, ensuredMkForCurrent], finalEditLog);
    }
    logger.debug('resyncStateOnHistoryChange', '顺序重算完成。');

    // 5. 循环结束后，一次性将最终计算出的状态写入全局
    // statForRecalc 已经是最终的 stat
    // metaForRecalc 包含了正确的日志，我们只需要更新 SEL_PATH
    _.set(metaForRecalc, SEL_PATH, newSelectedMks);
    _.set(metaForRecalc, WRITTEN_WITH_PATH, ERA_VERSION);

    // 被删除或被 swipe 掉的消息会留下再也不会被用到的日志：ERA 只通过 SelectedMks 读取日志，
    // 这些 MK 如果重新出现（例如滑回旧的 swipe），会被判定为分歧并按正文重算。
    // 定向同步（stopAtTarget）只是暂停在目标楼层，后面的楼层仍在聊天记录中，此时不清理。
    if (settings.value.清理失效日志 && !stopAtTarget) {
      _.set(metaForRecalc, LOGS_PATH, pruneOrphanLogs(_.get(metaForRecalc, LOGS_PATH, {}), newSelectedMks));
    }

    const keepLogs = Math.floor(settings.value.日志保留楼层数) || 0;
    if (keepLogs > 0 && !stopAtTarget) {
      if (!settings.value.折叠日志存档 || !chatId) {
        await foldOldLogs(metaForRecalc, allMessages, keepLogs, config, verified);
      } else if (canArchive()) {
        const candidate = { ...metaForRecalc, [LOGS_PATH]: { ..._.get(metaForRecalc, LOGS_PATH, {}) } };
        await foldOldLogs(candidate, allMessages, keepLogs, config, verified, ARCHIVE_BATCH);
        // 切换聊天后 characterId 等已经变化，不能再保存
        if (isChatSwitched()) return 'aborted';
        if (await archiveFoldedLogs(metaForRecalc, candidate, chatId)) metaForRecalc = candidate;
      }
    }

    if (isChatSwitched()) return 'aborted';
    let written = false;
    await updateEraData(current => {
      // 写入前再确认一次：写入回调可能晚于上面的检查执行
      if (isChatSwitched()) return current;
      // ApiOps 是源数据：以写入瞬间的实时值为准，只更新 applied
      const live = _.get(current.meta, API_OPS_PATH);
      if (live) {
        for (const mk of Object.keys(appliedRevs)) {
          if (live[mk]) live[mk].applied = Math.min(appliedRevs[mk], live[mk].rev);
        }
        metaForRecalc[API_OPS_PATH] = live;
      } else {
        _.unset(metaForRecalc, API_OPS_PATH);
      }
      // 以前注册过（元数据里有真实版本）、这次因没注册而失败的名字记为 missing：它再注册时版本不相等，完全重算一次
      // （跨页面会话也有效）。从未注册过的名字（AI 编造的工具名、函数名）不记：它第一次注册时元数据里没有记录，
      // 本来就会完全重算。比较时只看已注册的扩展，一直没注册的 missing 不会触发重算
      const missing = Object.fromEntries(
        getUnknownExtensions()
          .filter(key => storedVersions[key] !== undefined && storedVersions[key] !== MISSING_EXTENSION_VERSION)
          .map(key => [key, MISSING_EXTENSION_VERSION]),
      );
      // 定向同步只算到目标楼，不能当作已经按当前版本算过全部历史
      if (!stopAtTarget && !_.isEmpty(extensionVersions)) {
        metaForRecalc[EXTENSIONS_PATH] = { ...storedVersions, ...missing, ...extensionVersions };
      } else if (!_.isEmpty(missing)) {
        metaForRecalc[EXTENSIONS_PATH] = { ...storedVersions, ...missing };
      }
      written = true;
      return { stat: statForRecalc, meta: metaForRecalc };
    });
    if (!written) return 'aborted';
    recordFloorReports(floorReports);
    const toolFloors = floorReports.filter(report => report.toolResults.length > 0);
    if (toolFloors.length > 0) {
      eventEmit(ERA_EVENT_EMITTER.TOOL_RESULT, {
        results: toolFloors.map(({ mk, message_id, toolResults }) => ({ mk, message_id, calls: toolResults })),
      });
    }
    if (replayFromStart || replayWithoutFold || hasDuplicateMks || (forceFullResync && lastReplay)) {
      lastReplay = { chat: chatId, active: activeExtensions };
    } else if (verified > 0) {
      // 只重算了一部分：更早的楼层可能是在缺少某些扩展时算的，不能因此当作已经应用过
      const active = lastReplay ? _.intersection(lastReplay.active, activeExtensions) : activeExtensions;
      lastReplay = { chat: chatId, active };
    }
    if (!stopAtTarget) clearPendingApiWrites(newSelectedMks.slice(recalcStart));
    logger.debug('resyncStateOnHistoryChange', '状态同步完成。');

    reportSchemaErrors(schemaErrors, allMessages.length - 1);
    reportCommandErrors(commandErrors, allMessages.length - 1);
    checkLatestSchema(getActiveSchema()?.schema, statForRecalc, chatId, {
      mk: newSelectedMks[allMessages.length - 1] ?? null,
      message_id: allMessages.length - 1,
    });
    return 'done';
  } catch (error: any) {
    logger.error('resyncStateOnHistoryChange', `状态同步时发生严重错误: ${error?.message || error}`, error);
    return 'failed';
  }
};
