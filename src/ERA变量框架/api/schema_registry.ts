/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增可选的变量结构 schema 校验与全局接口 Era；修复 schema 校验在审查与实测中发现的问题；新增更新钩子 Era.onBeforeApply / Era.onAfterApply；修复第二批改动在审查中发现的问题
 *       2026-11-28 读不到角色卡时的标识与归属判断（isOwnedByCurrent）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - Schema 注册表
 * @description
 * 保存当前生效的变量结构 schema。schema 只存在于内存中，由角色卡脚本在加载时注册、卸载时注销。
 * 没有注册 schema 时，ERA 不做任何结构校验。
 */
'use strict';

import { EraSchemaLike } from '../core/schema';
import { Logger } from '../utils/log';

const logger = new Logger();

export interface RegisterSchemaOptions {
  /**
   * 是否保留 schema 根对象上未定义的键。默认 `true`。
   *
   * zod 的 `z.object` 默认会丢弃未定义的键。为了避免注册 schema 后误删作者没写进 schema 的顶层变量，
   * ERA 默认不会删除 `stat_data` 顶层那些不在 schema 解析结果里的键。设为 `false` 可关闭这一行为。
   * 注意：这只影响**顶层**，嵌套对象仍按 schema 自身的定义处理。
   */
  keepUnknownRootKeys?: boolean;
  /**
   * 变量完全为空时是否也补全 schema 的默认值。默认 `false`。
   *
   * 默认不补全，是因为变量为空通常意味着开场白还没初始化变量，此时写入默认值会让之后的
   * `<VariableInsert>` 因路径已存在而被忽略。如果角色卡不用 `<VariableInsert>` 初始化、
   * 完全依靠 schema 的默认值（`prefault` / `default`）来初始化变量，请设为 `true`。
   */
  fillDefaultsOnEmpty?: boolean;
  /** 注册后是否立即对最新楼层重新计算一次，使现有变量符合 schema。默认 `true`。 */
  resync?: boolean;
}

export interface ActiveSchema {
  schema: EraSchemaLike;
  /** 是否保留 `stat_data` 顶层那些不在 schema 解析结果里的键。 */
  keepUnknownRootKeys: boolean;
  /** 变量完全为空时是否也补全 schema 的默认值。 */
  fillDefaultsOnEmpty: boolean;
  /** 注册时所在的角色卡标识。 */
  owner: string;
}

let active: ActiveSchema | null = null;

/** 读不到当前角色卡时的标识：切换角色卡的过渡态里酒馆的上下文还没有就绪，或者没有打开任何角色卡。 */
export const UNKNOWN_OWNER = 'unknown';

/** 获取当前角色卡的标识，用于把 schema 和钩子绑定到注册它们的角色卡上；读不到时是 `UNKNOWN_OWNER`。 */
export function getCurrentOwner(): string {
  try {
    // 群聊中 characterId 会随正在发言的成员变化，因此以群组为准
    if (SillyTavern.groupId) return `group:${SillyTavern.groupId}`;
    const id = SillyTavern.characterId;
    const avatar = (SillyTavern.characters as any)?.[id as any]?.avatar;
    const owner = avatar ?? id;
    return owner === undefined || owner === null || owner === '' ? UNKNOWN_OWNER : String(owner);
  } catch {
    return UNKNOWN_OWNER;
  }
}

/**
 * 一项注册（schema、钩子、工具、公式函数、条目过滤器）是否仍然属于当前角色卡。
 * - 现在读不到角色卡：无法判断，先留着；
 * - 注册时读不到角色卡（脚本在切换角色卡的过渡态里注册）：归到现在这张卡名下。
 *   以前这种注册记在 `unknown` 名下，上下文就绪后被当成“上一张卡遗留的”清掉。
 */
export function isOwnedByCurrent(record: { owner: string }, current: string = getCurrentOwner()): boolean {
  if (current === UNKNOWN_OWNER) return true;
  if (record.owner === UNKNOWN_OWNER) record.owner = current;
  return record.owner === current;
}

/**
 * 获取当前生效的 schema；未注册时返回 `null`。
 *
 * schema 绑定在注册时的角色卡上。如果当前角色卡已经不是注册时的那张
 * （注册它的脚本被卸载却没有注销），schema 会被自动丢弃，避免它去改写其他角色卡的变量。
 */
export function getActiveSchema(): ActiveSchema | null {
  if (active && !isOwnedByCurrent(active)) {
    logger.warn('getActiveSchema', '当前角色卡与注册 schema 时不同，已自动注销遗留的 schema。');
    active = null;
  }
  return active;
}

/**
 * 注册变量结构 schema。重复注册会覆盖之前的 schema。
 * @returns 是否注册成功。
 */
export function setActiveSchema(source: unknown, options: RegisterSchemaOptions = {}): boolean {
  if (!source || typeof (source as any).safeParse !== 'function') {
    logger.error('setActiveSchema', '注册失败：schema 必须是带有 safeParse 方法的对象（例如 zod schema）。');
    return false;
  }

  active = {
    schema: source as EraSchemaLike,
    keepUnknownRootKeys: options.keepUnknownRootKeys !== false,
    fillDefaultsOnEmpty: options.fillDefaultsOnEmpty === true,
    owner: getCurrentOwner(),
  };
  logger.log('setActiveSchema', '变量结构 schema 注册成功。');
  return true;
}

/**
 * 注销 schema。
 * @param source 如果提供，则只有当前生效的 schema 正是它时才注销，避免误删别的脚本后注册的 schema。
 * @returns 是否确实注销了一个 schema。
 */
export function clearActiveSchema(source?: unknown): boolean {
  if (!active) return false;
  if (source !== undefined && active.schema !== source) return false;
  active = null;
  logger.log('clearActiveSchema', '变量结构 schema 已注销。');
  return true;
}
