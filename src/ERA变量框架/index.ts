/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增可选的变量结构 schema 校验与全局接口 Era；新增脚本设置“API写入不修改消息”；新增额外模型分步更新、等待式提交、试算与变量结构说明；新增折叠日志存档：旧楼日志存到单独文件，可回滚与查询，缺失时自动从头重放；显示 ERA-Heron 版本号；调整项目介绍与作者说法；；写入事件的监听器放在第一位，钩子执行期间发出的写入事件被拒绝（重入保护）
 *       2026-11-26 加载和切换聊天时检查角色卡变量“ERA最低版本”
 *       2026-11-28 停止带 generation_id 的生成时不清主生成的临时 MK
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 主入口与事件监听模块
 * @description
 * 该文件是整个 ERA 变量框架的起点。它的职责非常清晰和专一：
 * 1. **定义监听范围**: 声明框架所关心的所有事件类型。
 * 2. **注册监听器**: 为上述所有事件注册监听器。
 * 3. **统一派发**: 当任何一个被监听的事件触发时，它不进行任何逻辑处理，
 *    而是立即将该事件（包括事件类型和附带数据）原封不动地推入到 `event_queue.ts`
 *    中的事件处理队列中。
 *
 * 这种设计体现了良好的**关注点分离**原则：`index.ts` 只负责“听”，而 `event_queue.ts`
 * 负责“思考”和“行动”。这使得事件的来源和处理逻辑完全解耦，非常清晰且易于维护。
 */

'use strict';

import { clearProvisionalKey } from './core/key/mk';
import { ERA_VERSION } from './utils/constants';
import { deleteArchive } from './core/log_archive';
import { checkCardRequirement } from './core/version';
import { EVENT_GROUPS } from './events/merger';
import { GUARDED_EVENTS } from './core/reentry';
import { pushExternalEvent, pushToQueue } from './events/queue';

// 导入查询模块, 以注册 {{ERA:...}} 宏
import './macro/parser';
import './macro/placeholder';

// 导入全局接口模块, 以共享 `Era` 全局对象
import './api/global';

// 导入额外模型模块, 以监听生成事件
import './extra/controller';

// 导入 UI 模块
import './ui';

console.info(`[ERA] ERA-Heron ${ERA_VERSION}（基于 ERA 变量框架二次开发，作者 白鹭辞）`);

// ===============================
// 事件监听器注册
// ===============================

/**
 * @const {string[]} eventsToListen
 * @description 定义了所有需要被 ERA 框架监听的事件。
 */
const eventsToListen = [
  ...EVENT_GROUPS.INIT,
  ...EVENT_GROUPS.SYNC,
  ...EVENT_GROUPS.API,
  ...EVENT_GROUPS.UPDATE_MK_ONLY,
  ...EVENT_GROUPS.COLLISION_DETECTORS,
  ...EVENT_GROUPS.COMBO_STARTERS,
  ...EVENT_GROUPS.DIRECTED_SYNC,
];

// 遍历事件列表，为每个事件注册一个回调函数。
// 这个回调函数是所有事件的统一入口。
eventsToListen.forEach(ev => {
  // `eventOn` 是酒馆助手提供的全局函数，用于注册事件监听。
  // 当事件 `ev` 触发时，回调函数被调用，并将事件类型 `ev` 和事件详情 `detail` 推入队列。
  const listener = (detail: any) => pushExternalEvent(ev, detail);
  // 酒馆只同步调用第一个监听器：写入事件的监听器放在第一位，钩子里发出的写入事件才能在钩子的调用栈内被识别并拒绝
  if (GUARDED_EVENTS.includes(ev) && typeof eventMakeFirst === 'function') eventMakeFirst(ev, listener);
  else eventOn(ev, listener);
});

// 生成开始或结束后，生成过程中注入的 MK 不再是临时的
eventOn(tavern_events.GENERATION_STARTED, (_type: any, _option: any, dry_run: boolean) => {
  if (!dry_run) clearProvisionalKey();
});
eventOn(tavern_events.GENERATION_ENDED, clearProvisionalKey);
// 酒馆助手的生成（分步更新、规划、其他脚本）被停止时带着它的 generation_id，那不是主生成
eventOn(tavern_events.GENERATION_STOPPED, ((id?: unknown) => {
  if (typeof id !== 'string') clearProvisionalKey();
}) as any);

eventOn(tavern_events.CHAT_DELETED, (chatId: string) => deleteArchive(chatId));

// 角色卡在角色卡变量 `ERA最低版本` 中声明的依赖：当前 ERA 低于它时提示一次
eventOn(tavern_events.CHAT_CHANGED, () => checkCardRequirement());
$(() => checkCardRequirement());

// 为酒馆助手脚本界面中的手动按钮注册监听器。
// 点击按钮时，同样是向队列中推入一个特定类型的事件。
eventOn(getButtonEvent('写入变量修改'), () => pushToQueue('manual_write'));
eventOn(getButtonEvent('手动同步状态'), () => pushToQueue('manual_sync'));
eventOn(getButtonEvent('强制完全重算'), () => pushToQueue('manual_full_sync'));
