/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：API 写入与 forceSync 在事件队列中等待完成；修复第三批改动在审查中发现的问题；不再为调试日志在每个任务前读取整段聊天；用户消息含指令时发送后立即计算
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
'use strict';

import { ERA_API_EVENTS, ERA_EVENT_EMITTER } from 'ERA变量框架/utils/constants';
import { ensureMkForLatestMessage } from '../core/key/mk';
import { initializeExternalSettings } from '../initer/auto/settings';
import { ensurePlaceholder } from '../macro/placeholder';
import { logContext, Logger } from '../utils/log';
import {
  countCommandBlocks,
  extractMessageIdFromDetail,
  getMessageContentWithRetry,
  isUserMessage,
} from '../utils/message';
import { handleApiEvent } from './handlers/api/dispatcher';
import { handleSyncEvent } from './handlers/sync';
import { handleUpdateMkOnlyEvent } from './handlers/updateMkOnly';
import { EventJob, getEventGroup } from './merger';
import { ActionsTaken, DispatcherPayload } from './types';

const logger = new Logger();

// /**
//  * @constant {number} RENDER_EVENTS_TO_IGNORE_AFTER_MK_INJECTION
//  * @description 当 `ensureMessageKey` 注入一个新的 MK 后，需要忽略的由该操作触发的 `character_message_rendered` 事件的数量。
//  * 通常设置为 1，因为一次消息内容更新通常只会触发一次渲染事件。
//  */
// const RENDER_EVENTS_TO_IGNORE_AFTER_MK_INJECTION = 1;

// /**
//  * @interface IgnoreRule
//  * @description 定义了因 MK 注入而需要忽略后续渲染事件的规则。
//  */
// export interface IgnoreRule {
//   mk: string;
//   ignoreCount: number;
// }

/**
 * @interface ConsecutiveMkState
 * @description 定义了用于追踪同一个 MK 被连续处理次数的状态。
 */
export interface ConsecutiveMkState {
  mk: string | null;
  count: number;
}

/**
 * @var {ConsecutiveMkState | null} consecutiveMkState
 * @description 追踪同一个 MK 被连续处理次数的状态。
 * **作用域**: 跨批次持久化。在整个脚本生命周期内，记录字面意义上的“上一次”执行的 MK。
 */
let consecutiveMkState: ConsecutiveMkState | null = null;

// /**
//  * **【辅助函数】处理由 MK 注入触发的冗余渲染事件**
//  * @param eventType - 当前事件的类型。
//  * @param currentMk - 当前消息的 MK。
//  * @param mkToIgnore - 当前的忽略规则。
//  * @returns {{ shouldSkip: boolean; newIgnoreRule: IgnoreRule | null }} - 返回是否应跳过此事件，以及更新后的忽略规则。
//  */
// function handleRedundantRenderEvent(
//   eventType: string,
//   currentMk: string | null,
//   mkToIgnore: IgnoreRule | null,
// ): { shouldSkip: boolean; newIgnoreRule: IgnoreRule | null } {
//   if (mkToIgnore && eventType === tavern_events.CHARACTER_MESSAGE_RENDERED && currentMk === mkToIgnore.mk) {
//     logger.debug(
//      'handleRedundantRenderEvent',
//      `忽略由 MK (${mkToIgnore.mk}) 注入触发的冗余渲染事件。剩余忽略次数: ${mkToIgnore.ignoreCount - 1}`,
//     );
//     mkToIgnore.ignoreCount--;
//     if (mkToIgnore.ignoreCount <= 0) {
//       mkToIgnore = null; // 忽略次数用完，重置
//       logger.debug('handleRedundantRenderEvent', `忽略次数用完`);
//     }
//     return { shouldSkip: true, newIgnoreRule: mkToIgnore };
//   }
//   return { shouldSkip: false, newIgnoreRule: mkToIgnore };
// }

/**
 * **【辅助函数】更新连续处理计数**
 * @returns {number} - 返回更新后的连续处理次数。
 */
function updateConsecutiveMkCount(): number {
  const mk = logContext.mk;
  if (mk && consecutiveMkState && consecutiveMkState.mk === mk) {
    logger.debug(
      'updateConsecutiveMkCount',
      `连续处理写入/同步操作的 MK: ${mk}。旧计数: ${consecutiveMkState.count}，新计数: ${consecutiveMkState.count + 1}`,
    );
    consecutiveMkState.count++;
  } else {
    logger.debug(
      'updateConsecutiveMkCount',
      `新的写入/同步操作的 MK: ${mk}。重置计数为 1。前一个 MK 是: ${consecutiveMkState?.mk}`,
    );
    consecutiveMkState = { mk: mk, count: 1 };
  }
  return consecutiveMkState.count;
}

/**
 * **【任务执行器】**
 * 负责执行单个事件任务，包含所有前置、后置处理和错误捕获。
 * @param {EventJob} job - 要执行的事件任务。
 * @param {any} _mkToIgnore - (已弃用) 当前的忽略规则。
 * @returns {Promise<any>} - (已弃用) 返回更新后的忽略规则。
 */
export async function dispatchAndExecuteTask(job: EventJob, _mkToIgnore: any): Promise<any> {
  const { type: eventType } = job;
  const eventGroup = getEventGroup(eventType);
  let message_id: number | null = null;
  const eventDetail = job.detail;
  // 在每轮任务开始时，初始化操作记录器
  const actionsTaken: ActionsTaken = {
    rollback: false,
    apply: false,
    resync: false,
    api: false,
    apiWrite: false,
    editedResync: false,
    swipedRollback: false,
  };

  try {
    // **入口保障**: 尝试获取最新消息内容，内置的重试和延迟机制可以应对酒馆消息更新延迟。
    // 等待式写入不需要最新消息已有内容：生成刚开始时最新消息是空的，等待只会拖慢它
    const initialContent = job.ticket ? '' : await getMessageContentWithRetry();
    if (initialContent === null) {
      //logger.warn('dispatchAndExecuteTask', '无法获取任何消息内容，ERA 框架停止运行。');
      //return null;
    }

    const latestMessage = getChatMessages(-1, { include_swipes: true })?.[0];
    if (!latestMessage) {
      logger.warn('dispatchAndExecuteTask', '无法获取最新消息，跳过任务执行。');
      job.ticket?.reject(new Error('没有可以写入的消息'));
      return null;
    }

    let mk: string;
    let msgId: number | null;
    // let isNewKey: boolean;

    // 对于大多数 API 事件和 combo_swipe_and_regenerate 事件，我们不应该注入新的 MK 或占位符。
    // 但 era:forceSync 是个例外，它虽然是 API 事件，但其行为更像一个同步事件，需要最新的 MK 作为上下文。
    const isApiBypassEvent = getEventGroup(eventType) === 'API' && eventType !== ERA_API_EVENTS.FORCE_SYNC;

    if (eventType === 'combo_swipe_and_regenerate' || isApiBypassEvent) {
      logger.log('dispatchAndExecuteTask', `检测到 ${eventType} 事件，跳过 MK 和占位符注入。`);
      msgId = latestMessage.message_id;
      mk = ''; // 使用空字符串作为回退
      // isNewKey = false;
    } else {
      // **前置保障**: 确保最新消息有 MK 并设置日志上下文。
      logger.log('dispatchAndExecuteTask', '调用 ensureMkForLatestMessage');
      const { mk: newMk, message_id: newMsgId } = await ensureMkForLatestMessage(latestMessage);

      if (!newMk || newMsgId === null) {
        logger.warn('dispatchAndExecuteTask', '无法获取有效的 MK 或消息 ID，跳过任务执行。');
        return null;
      }
      mk = newMk;
      msgId = newMsgId;
      // isNewKey = newIsNewKey;

      // **前置保障**: 确保 AI 消息有占位符
      logger.log('dispatchAndExecuteTask', '调用 ensurePlaceholder');
      await ensurePlaceholder(msgId);
    }

    if (msgId === null) {
      logger.warn('dispatchAndExecuteTask', '无法获取有效的消息 ID，跳过任务执行。');
      return null;
    }
    logContext.mk = mk;
    message_id = msgId;

    const is_user = isUserMessage(latestMessage);

    // // 如果 ensureMkForLatestMessage 刚刚注入了一个新的 MK，就创建或更新忽略规则。
    // if (isNewKey && mk) {
    //   mkToIgnore = {
    //     mk: mk,
    //     ignoreCount: RENDER_EVENTS_TO_IGNORE_AFTER_MK_INJECTION,
    //   };
    // }

    // // **核心优化**: 检查并处理由 MK 注入触发的冗余渲染事件。
    // logger.debug('dispatchAndExecuteTask', '调用 handleRedundantRenderEvent');
    // const { shouldSkip, newIgnoreRule } = handleRedundantRenderEvent(eventType, mk, mkToIgnore);
    // mkToIgnore = newIgnoreRule; // 更新忽略规则的状态
    // if (shouldSkip) {
    //   // 如果事件被忽略，则直接返回，不更新连续处理计数
    //   return mkToIgnore;
    // }

    logger.log('dispatchAndExecuteTask', `执行任务: ${eventType} (分组: ${eventGroup})`);

    // **任务分发**
    // v3.1 优化：payload 仅包含最核心的上下文，其他数据由下游函数自行获取。
    const payload: DispatcherPayload = {
      mk: mk,
      message_id: message_id,
      is_user: is_user,
      actions: actionsTaken,
      consecutiveProcessingCount: 1, // 初始值
    };

    switch (eventGroup) {
      case 'INIT':
        logger.log('dispatchAndExecuteTask', '调用 initializeExternalSettings');
        initializeExternalSettings();
        // 为了兼容旧版酒馆的swipe逻辑，这里也调用同步
        payload.consecutiveProcessingCount = updateConsecutiveMkCount();
        logger.log('dispatchAndExecuteTask', '调用 handleSyncEvent for INIT');
        await handleSyncEvent(job, actionsTaken, payload);
        break;
      case 'SYNC':
        if (eventType === ERA_EVENT_EMITTER.API_WRITE) {
          actionsTaken.apiWrite = true;
        }
        payload.consecutiveProcessingCount = updateConsecutiveMkCount();
        logger.log('dispatchAndExecuteTask', '调用 handleSyncEvent for SYNC');
        await handleSyncEvent(job, actionsTaken, payload);
        break;
      case 'API':
        logger.log('dispatchAndExecuteTask', '调用 handleApiEvent');
        await handleApiEvent(job, actionsTaken, payload);
        break;
      case 'UPDATE_MK_ONLY':
        // 用户消息里的指令在之后的重算中会被执行；发送时就计算，首次结果才与从头重算一致
        if (is_user && countCommandBlocks(latestMessage) > 0) {
          logger.log('dispatchAndExecuteTask', '用户消息含有指令块，按同步处理');
          payload.consecutiveProcessingCount = updateConsecutiveMkCount();
          await handleSyncEvent(job, actionsTaken, payload);
          break;
        }
        logger.log('dispatchAndExecuteTask', '调用 handleUpdateMkOnlyEvent');
        await handleUpdateMkOnlyEvent(mk);
        break;
      case 'DIRECTED_SYNC': {
        payload.consecutiveProcessingCount = updateConsecutiveMkCount();

        if (eventType === 'combo_swipe_and_regenerate') {
          // 处理“滑动并重新生成”事件
          actionsTaken.swipedRollback = true;
          const targetedMessageId = message_id - 1; // 目标是前一条消息
          const stopAtTarget = true; // 滑动后，同步应该在目标处停止

          logger.log(
            'dispatchAndExecuteTask',
            `处理 combo_swipe_and_regenerate 事件，目标消息 ID: ${targetedMessageId}, stopAtTarget: ${stopAtTarget}`,
          );

          if (targetedMessageId < 0) {
            logger.warn('dispatchAndExecuteTask', '无法对第一条消息执行滑动回退，按普通同步处理。');
            await handleSyncEvent(job, actionsTaken, payload);
          } else {
            await handleSyncEvent(job, actionsTaken, payload, targetedMessageId, stopAtTarget);
          }
        } else if (eventType === tavern_events.MESSAGE_EDITED) {
          // 处理“消息编辑”事件
          actionsTaken.editedResync = true;
          const targetedMessageId = extractMessageIdFromDetail(eventDetail);
          const stopAtTarget = false; // 编辑后，同步应该完整执行到最新状态

          logger.log(
            'dispatchAndExecuteTask',
            `处理 MESSAGE_EDITED 事件，目标消息 ID: ${targetedMessageId}, stopAtTarget: ${stopAtTarget}`,
          );

          if (targetedMessageId === null || targetedMessageId < 0) {
            logger.warn('dispatchAndExecuteTask', 'MESSAGE_EDITED 事件缺少或无效的 message_id，按普通同步处理。', {
              eventDetail,
            });
            await handleSyncEvent(job, actionsTaken, payload);
          } else {
            await handleSyncEvent(job, actionsTaken, payload, targetedMessageId, stopAtTarget);
          }
        } else {
          // 处理未知的定向同步事件
          logger.warn(
            'dispatchAndExecuteTask',
            `接收到未明确处理的 DIRECTED_SYNC 事件: ${eventType}，按普通同步处理。`,
          );
          await handleSyncEvent(job, actionsTaken, payload);
        }
        break;
      }
    }
  } catch (error) {
    logger.error('dispatchAndExecuteTask', `事件 ${eventType} 处理异常: ${error}`, error);
    job.ticket?.reject(error as Error);
  } finally {
    // 清理日志上下文，为下一个事件做准备
    logContext.mk = '';

    // **节流**: 在每个独立任务后都进行短暂等待，确保酒馆底层有时间完成其异步操作。
    //暂时取消等待逻辑，提高即时性。
    //await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}
