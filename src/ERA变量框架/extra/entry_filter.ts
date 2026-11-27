/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：新增条目过滤器 Era.registerEntryFilter：分步更新按目标楼的状态选择和改写世界书条目
 *       2026-11-27 过滤器在重入保护下调用：执行期间调用写入接口（Era.commit、Era.extra.run 等）时忽略它的结果并记入 warnings
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 条目过滤器注册表
 * @description
 * 分步更新收集 `[era_update]` / `[era_both]` 条目时，按目标楼的状态调用过滤器，决定条目是否发给更新模型。
 * 过滤器与钩子一样只存在于内存中，绑定在注册时的角色卡上；必须是同步的纯函数。
 * 与钩子一样在重入保护下调用（`core/reentry.ts`）：每次分步更新都会调用过滤器，在其中写入会形成循环。
 */
'use strict';

import { getCurrentOwner } from '../api/schema_registry';
import { runGuarded } from '../core/reentry';
import { Logger } from '../utils/log';

const logger = new Logger();

/** 传给过滤器的条目（副本）。 */
export interface EntryFilterEntry {
  /** 所在的世界书。 */
  world: string;
  uid: number;
  name: string;
  content: string;
  /** 文件里的开关；有过滤器管理时，它只是过滤器没有表态时的默认值。 */
  enabled: boolean;
  [key: string]: any;
}

export interface EntryFilterContext {
  /** 目标楼的状态：去掉了 `$` 开头的字段，已反转义。只读。 */
  stat: any;
  /** 目标楼的原始状态（转义过的，含 `$meta` 等字段）。只读。 */
  statRaw: any;
  /** 用来匹配关键字的文本：到目标楼为止、最近几楼的正文。 */
  text: string;
  /** 目标楼的 MK。 */
  mk: string;
  /**
   * 给谁选条目：`extra` 分步更新（目标楼的状态），`plan` 正文前规划，`main` 主生成（1.8 起，最新的状态）。
   * 只想影响其中一种时按它判断，其余返回 `undefined`。
   */
  purpose: 'extra' | 'plan' | 'main';
}

/**
 * 返回 `false` 排除条目；`true` 强制纳入（即使文件里关闭了、关键字没有匹配）；
 * 字符串表示强制纳入并替换条目内容；其他值表示不表态。
 */
export type EntryFilter = (entry: EntryFilterEntry, ctx: EntryFilterContext) => boolean | string | void | undefined;

export interface RegisteredEntryFilter {
  name: string;
  fn: EntryFilter;
  owner: string;
}

let filters: RegisteredEntryFilter[] = [];

/** 注册过滤器；同名的会被替换。参数无效时返回 `null`。 */
export function addEntryFilter(name: unknown, fn: unknown): RegisteredEntryFilter | null {
  if (typeof name !== 'string' || name === '' || typeof fn !== 'function') {
    logger.error('addEntryFilter', '注册失败：名字必须是非空字符串，过滤器必须是函数。', { name, fn });
    return null;
  }
  const filter: RegisteredEntryFilter = { name, fn: fn as EntryFilter, owner: getCurrentOwner() };
  filters = filters.filter(other => other.name !== name);
  filters.push(filter);
  logger.log('addEntryFilter', `已注册条目过滤器 ${name}。`);
  return filter;
}

/** 注销过滤器。按对象身份判断，旧脚本实例的注销不会误删替换它的新过滤器。 */
export function dropEntryFilter(filter: RegisteredEntryFilter): boolean {
  const before = filters.length;
  filters = filters.filter(other => other !== filter);
  return filters.length !== before;
}

/** 当前角色卡生效的过滤器，按名字排序；不属于当前角色卡的遗留过滤器会被丢弃。 */
export function getActiveEntryFilters(): RegisteredEntryFilter[] {
  const owner = getCurrentOwner();
  if (filters.some(filter => filter.owner !== owner)) {
    logger.warn('getActiveEntryFilters', '当前角色卡与注册条目过滤器时不同，已自动注销遗留的过滤器。');
    filters = filters.filter(filter => filter.owner === owner);
  }
  return [...filters].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function hasEntryFilter(name: string): boolean {
  return getActiveEntryFilters().some(filter => filter.name === name);
}

export interface FilterDecision {
  /** `exclude` 排除；`include` 强制纳入；`default` 按文件的开关和关键字。 */
  decision: 'exclude' | 'include' | 'default';
  /** 过滤器替换后的内容；没有替换时为 `undefined`。 */
  content?: string;
}

/**
 * 依次调用过滤器：任一返回 `false` 即排除；返回字符串时替换内容，后面的过滤器看到替换后的内容。
 * 过滤器出错、返回 Promise，或者执行期间调用了写入接口（重入保护）时，忽略它的结果（按没有表态处理），并记入 `warnings`。
 */
export function applyEntryFilters(
  entry: EntryFilterEntry,
  ctx: EntryFilterContext,
  warnings: string[],
  active: RegisteredEntryFilter[] = getActiveEntryFilters(),
): FilterDecision {
  let decision: FilterDecision['decision'] = 'default';
  let content: string | undefined;
  for (const filter of active) {
    let result: unknown;
    try {
      // 执行期间调用 Era.commit、Era.extra.run 等写入接口时，runGuarded 抛出 ReentryError（即使过滤器自己捕获了）
      result = runGuarded(`条目过滤器 ${filter.name} `, () =>
        filter.fn(content === undefined ? entry : { ...entry, content }, ctx),
      );
    } catch (error: any) {
      warnings.push(`条目过滤器 ${filter.name} 处理“${entry.name}”时出错，已忽略它的结果: ${error?.message ?? error}`);
      continue;
    }
    if (result && typeof (result as any).then === 'function') {
      (result as Promise<unknown>).catch?.(() => {});
      warnings.push(`条目过滤器 ${filter.name} 返回了 Promise，已忽略它的结果：过滤器必须是同步函数`);
      continue;
    }
    if (result === false) return { decision: 'exclude' };
    if (result === true) decision = 'include';
    else if (typeof result === 'string') {
      decision = 'include';
      content = result;
    }
  }
  return { decision, content };
}
