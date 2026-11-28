/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增更新钩子 Era.onBeforeApply / Era.onAfterApply；新增 Era.hasHook，供前端工具在 ERA 重载后补注册
 *       2026-11-28 切换角色卡的过渡态里注册的钩子归到当前角色卡
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 更新钩子注册表
 * @description
 * 保存当前注册的更新钩子。钩子只存在于内存中，由角色卡脚本在加载时注册、卸载时注销，
 * 并绑定在注册时的角色卡上；没有注册钩子时，ERA 的行为不变。
 */
'use strict';

import { EraHookOptions, HookPhase, RegisteredHook } from '../core/hooks';
import { Logger } from '../utils/log';
import { getCurrentOwner, isOwnedByCurrent } from './schema_registry';

const logger = new Logger();

let hooks: RegisteredHook[] = [];

/**
 * 注册钩子。同一阶段、同一 id 的钩子会被替换。
 * @returns 注册后的钩子；参数无效时返回 `null`（不抛出异常）。
 */
export function addHook(
  phase: HookPhase,
  id: unknown,
  fn: unknown,
  options: EraHookOptions = {},
): RegisteredHook | null {
  if (typeof id !== 'string' || id === '' || typeof fn !== 'function') {
    logger.error('addHook', '注册失败：id 必须是非空字符串，钩子必须是函数。', { id, fn });
    return null;
  }
  const hook: RegisteredHook = {
    id,
    phase,
    fn: fn as RegisteredHook['fn'],
    order: Number(options?.order) || 0,
    owner: getCurrentOwner(),
    notified: false,
  };
  hooks = hooks.filter(other => other.phase !== phase || other.id !== id);
  hooks.push(hook);
  logger.log('addHook', `已注册钩子 ${phase}:${id}。`);
  return hook;
}

/** 注销钩子。按对象身份判断，因此旧脚本实例的注销不会误删替换它的新钩子。 */
export function dropHook(hook: RegisteredHook): boolean {
  const before = hooks.length;
  hooks = hooks.filter(other => other !== hook);
  return hooks.length !== before;
}

/** 丢弃不属于当前角色卡的钩子，避免遗留的钩子改写其他角色卡的变量。 */
function purge() {
  const owner = getCurrentOwner();
  if (hooks.some(hook => !isOwnedByCurrent(hook, owner))) {
    logger.warn('purge', '当前角色卡与注册钩子时不同，已自动注销遗留的钩子。');
    hooks = hooks.filter(hook => isOwnedByCurrent(hook, owner));
  }
}

/** 获取某一阶段当前生效的钩子，按 `order`、再按 id 排序。 */
export function getActiveHooks(phase: HookPhase): RegisteredHook[] {
  purge();
  return hooks.filter(hook => hook.phase === phase).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/** 当前角色卡是否注册了该 id 的钩子；不指定阶段时任一阶段都算。 */
export function hasHook(id: string, phase?: HookPhase): boolean {
  purge();
  return hooks.some(hook => hook.id === id && (phase === undefined || hook.phase === phase));
}

export function hasActiveHooks(): boolean {
  purge();
  return hooks.length > 0;
}

/** 报告钩子错误：始终记录日志，每个钩子只弹窗提示一次。 */
export function reportHookError(hook: RegisteredHook, message: string): void {
  logger.error('reportHookError', `钩子 ${hook.phase}:${hook.id} 执行出错，其修改已被忽略: ${message}`);
  if (hook.notified) return;
  hook.notified = true;
  toastr.warning(_.escape(message), `[ERA] 钩子 ${_.escape(hook.id)} 执行出错，其修改已被忽略`, { escapeHtml: false });
}
