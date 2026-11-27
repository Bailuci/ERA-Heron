/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：钩子与工具的重入保护：执行期间拒绝所有写入入口，避免“提交 → 重算 → 钩子再提交”的无限循环
 *       合并时把 Era.applyText 纳入保护
 *       2026-11-27 说明条目过滤器（Era.registerEntryFilter）同样在保护下调用
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 重入保护
 * @description
 * 钩子（以及以后的工具）在每次同步、重算、试算时都会被执行。如果它在执行期间调用 `Era.commit` 或发出写入事件，
 * 写入会触发新一轮同步，新一轮同步又会执行钩子，形成“提交 → 重算 → 钩子再提交”的循环，`ApiOps` 无限增长。
 *
 * 分步更新的条目过滤器（`Era.registerEntryFilter`）也一样：每次分步更新都会调用，在其中调用 `Era.extra.run` 会无限重启，
 * 调用 `Era.commit` 会在每次分步更新时写入，因此同样在保护下调用（`extra/entry_filter.ts`）。
 *
 * 钩子、工具和过滤器都是同步函数，所以“执行期间”就是它们的同步调用栈：
 * - `runGuarded` 包住钩子的调用，期间 `isGuarded()` 为真；
 * - 所有写入入口在开头调用 `guardWrite(入口名)`：保护期间记下违规并抛出异常；
 * - `runGuarded` 结束时如果记到了违规（即使钩子自己捕获了异常），就把它当作钩子的错误，钩子的修改全部丢弃。
 *
 * 写入事件经酒馆的事件总线进入 ERA：酒馆的 `eventSource.emit` 会同步调用**第一个**监听器，
 * 之后的监听器要等前一个返回的 Promise 完成后才调用。ERA 用 `eventMakeFirst` 把写入事件的监听器放在第一位，
 * 因此钩子里发出的写入事件会在钩子的调用栈内到达 `guardEvent`，在入队前被拒绝。
 *
 * 新增写入入口（如 `Era.applyText`、`undoApiOps`、带 `text` 的 `Era.extra.run`）时，在入口开头调用 `guardWrite`，
 * 并把名字加进 `GUARDED_ENTRIES`；新增写入事件时加进 `GUARDED_EVENTS`。
 */
'use strict';

import { ERA_API_EVENTS } from '../utils/constants';

/** 受保护的接口名单（供文档和测试核对）。 */
export const GUARDED_ENTRIES = [
  'Era.commit',
  'Era.applyText',
  'Era.setMessageText',
  'Era.extra.run',
  'Era.extra.wait',
  'Era.extra.plan',
  'Era.extra.replan',
] as const;

/** 受保护的写入事件：钩子执行期间发出时不入队。 */
export const GUARDED_EVENTS: readonly string[] = [
  ERA_API_EVENTS.COMMIT,
  ERA_API_EVENTS.PATCH,
  ERA_API_EVENTS.INSERT_BY_OBJECT,
  ERA_API_EVENTS.UPDATE_BY_OBJECT,
  ERA_API_EVENTS.INSERT_BY_PATH,
  ERA_API_EVENTS.UPDATE_BY_PATH,
  ERA_API_EVENTS.DELETE_BY_OBJECT,
  ERA_API_EVENTS.DELETE_BY_PATH,
  ERA_API_EVENTS.FORCE_SYNC,
  ERA_API_EVENTS.WRITE_EXTRA,
];

/** 当前嵌套的保护层数，以及每层记到的违规入口。 */
const stack: { label: string; violations: string[] }[] = [];

/** 当前是否在钩子或工具的执行期间。 */
export function isGuarded(): boolean {
  return stack.length > 0;
}

/** 当前正在执行的钩子或工具的名字；不在保护期间时为空字符串。 */
export function currentGuardLabel(): string {
  return stack[stack.length - 1]?.label ?? '';
}

/** 保护期间被拒绝的写入。 */
export class ReentryError extends Error {
  constructor(entry: string, label: string) {
    super(
      `${label || '钩子'}执行期间不能调用 ${entry}：钩子和工具必须是纯函数，写入会形成“提交 → 重算 → 再提交”的循环`,
    );
    this.name = 'ReentryError';
  }
}

function recordViolation(entry: string): ReentryError {
  const error = new ReentryError(entry, currentGuardLabel());
  for (const frame of stack) frame.violations.push(entry);
  return error;
}

/**
 * 写入入口在开头调用：保护期间记下违规并抛出 `ReentryError`，其余时候什么都不做。
 * 对异步接口，抛出发生在第一次 `await` 之前，因此违规一定会被 `runGuarded` 记到。
 */
export function guardWrite(entry: string): void {
  if (stack.length === 0) return;
  throw recordViolation(entry);
}

/**
 * 异步写入入口用：保护期间返回一个已失败、但已标记为“已处理”的 Promise（钩子通常不会 await 它，
 * 不能让它变成未处理的 rejection）；其余时候返回 `null`，由调用方继续执行。
 */
export function rejectIfGuarded(entry: string): Promise<never> | null {
  if (stack.length === 0) return null;
  const promise = Promise.reject(recordViolation(entry));
  promise.catch(() => {});
  return promise;
}

/**
 * 写入事件入队前调用。保护期间返回 `true`（调用方应丢弃该事件），并记下违规；否则返回 `false`。
 */
export function guardEvent(type: string): boolean {
  if (stack.length === 0 || !GUARDED_EVENTS.includes(type)) return false;
  recordViolation(`eventEmit('${type}')`);
  return true;
}

/**
 * 在保护下执行 `fn`。`fn` 执行期间调用了写入入口时，抛出说明违规入口的异常（即使 `fn` 自己吞掉了写入接口抛出的异常）；
 * `fn` 本身抛出的异常原样抛出。
 * @param label 显示用的名字，例如 `钩子 卡.计算`。
 */
export function runGuarded<T>(label: string, fn: () => T): T {
  const frame = { label, violations: [] as string[] };
  stack.push(frame);
  let result: T;
  try {
    result = fn();
  } finally {
    const index = stack.lastIndexOf(frame);
    if (index !== -1) stack.splice(index, 1);
  }
  if (frame.violations.length > 0) {
    throw new ReentryError(_.uniq(frame.violations).join('、'), label);
  }
  return result;
}
