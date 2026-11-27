/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：版本标识：解析版本（新聊天才遮蔽思考块、启用指令外层标签）、写入版本、角色卡变量“ERA最低版本”的检查
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 版本标识
 * @description
 * **解析版本**（`ERAMetaData.ParserVersion`）决定正文怎样解析成指令：
 * - 缺省（1.6 及更早建立的聊天）：全文匹配指令块，思考块里的指令也会执行，重算结果与旧版完全相同；
 * - 2（1.7 起新建的聊天）：先把思考标签的内容替换成等长空格；设置了 `指令外层标签` 时，只认该标签内部的指令。
 *
 * 新聊天是指 `ERAMetaData` 为空、ERA 从未写入过的聊天；它第一次写入元数据时记下解析版本，之后不再改变，
 * 因此同一个聊天的每次重算都按同一种方式解析。旧聊天永远不会被自动升级。
 *
 * **写入版本**（`ERAMetaData.WrittenWith`）只用于提示：由更新的 ERA 写过的聊天在旧版本中完全重算时结果可能不同。
 */
'use strict';

import { ERA_VERSION, PARSER_VERSION, PARSER_VERSION_PATH, WRITTEN_WITH_PATH } from '../utils/constants';
import { getEraData, settings } from '../utils/era_data';
import { Logger } from '../utils/log';
import type { ParseOptions } from '../utils/message';

const logger = new Logger();

/** 角色卡变量中声明所需 ERA 最低版本的键名。 */
export const CARD_MIN_VERSION_KEY = 'ERA最低版本';

/**
 * 比较两个版本号（`1.7`、`1.7.0`、`v1.7.0-beta.1` 都可以；缺少的段按 0 计，预发布后缀忽略）。
 * @returns 负数表示 a 较旧，0 表示相同，正数表示 a 较新；无法识别时返回 `NaN`。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (text: string): number[] | null => {
    const match = String(text ?? '')
      .trim()
      .match(/^v?(\d+(?:\.\d+){0,2})(?:[-+].*)?$/i);
    if (!match) return null;
    const parts = match[1].split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    return parts;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return NaN;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** 当前 ERA 的版本是否不低于 `required`；无法识别时返回 `false`。 */
export const isVersionAtLeast = (required: string, current: string = ERA_VERSION): boolean =>
  compareVersions(current, required) >= 0;

/**
 * 聊天的解析版本。
 * - 有标记时按标记（比当前版本认识的更新时，按当前最新的方式解析）；
 * - 没有标记但有元数据：1.6 及更早建立的聊天，返回 1；
 * - 元数据为空：ERA 从未写入过的新聊天，返回当前的解析版本。
 */
export function getParserVersion(meta: any): number {
  const marked = _.get(meta, PARSER_VERSION_PATH);
  if (typeof marked === 'number' && Number.isFinite(marked) && marked >= 1) {
    return Math.min(Math.floor(marked), PARSER_VERSION);
  }
  return _.isEmpty(meta) ? PARSER_VERSION : 1;
}

/** 只含解析版本的元数据，用于在当前聊天的解析方式下试算一段文本。 */
export const parserMetaOf = (meta: any): Record<string, number> => ({ [PARSER_VERSION_PATH]: getParserVersion(meta) });

/** 把逗号、顿号或空格分隔的标签列表拆开；可以带尖括号。 */
export function splitTagList(text: unknown): string[] {
  return _.uniq(
    String(text ?? '')
      .split(/[\s,，、;；]+/)
      .map(normalizeTagName)
      .filter(Boolean),
  );
}

/** `<ERA_Update>`、`</ERA_Update>` 都规范成 `ERA_Update`；含有无法作为标签名的字符时返回空字符串。 */
export function normalizeTagName(text: unknown): string {
  const name = String(text ?? '')
    .trim()
    .replace(/^<\/?\s*/, '')
    .replace(/\s*\/?>$/, '')
    .trim();
  return /^[\p{L}\p{N}_:.-]+$/u.test(name) ? name : '';
}

/**
 * 聊天的解析方式。旧聊天（解析版本 1）返回 `undefined`，即原来的全文匹配。
 * 思考标签和外层标签取自当前的脚本设置。
 */
export function getParseOptions(meta: any): ParseOptions | undefined {
  if (getParserVersion(meta) < 2) return undefined;
  return {
    thinkTags: splitTagList(settings.value.思考标签),
    outerTag: normalizeTagName(settings.value.指令外层标签) || undefined,
  };
}

/** 当前聊天的解析方式，参见 `getParseOptions`。 */
export const getCurrentParseOptions = (): ParseOptions | undefined => getParseOptions(getEraData().meta);

/** 已提示过“由更新的 ERA 写入”的聊天，每个聊天只提示一次。 */
const warnedChats = new Set<string>();

/**
 * 聊天最近一次由更新的 ERA 写入时提示一次：降级后完全重算，`$expr`、`origin: 'text'` 的旁路写入等新功能的结果会不同。
 * 只提示，不阻止。
 */
export function warnIfWrittenByNewer(meta: any, chatId: string | undefined): void {
  const writer = _.get(meta, WRITTEN_WITH_PATH);
  const parser = _.get(meta, PARSER_VERSION_PATH);
  const newerWriter = typeof writer === 'string' && compareVersions(writer, ERA_VERSION) > 0;
  const newerParser = typeof parser === 'number' && parser > PARSER_VERSION;
  if (!newerWriter && !newerParser) return;
  const key = String(chatId ?? '');
  if (warnedChats.has(key)) return;
  warnedChats.add(key);
  const message = `这个聊天由更新的 ERA（${newerWriter ? writer : `解析版本 ${parser}`}）写入过，当前是 ERA-Heron ${ERA_VERSION}。重算时新版本功能的结果可能不同，建议升级 ERA。`;
  logger.warn('warnIfWrittenByNewer', message);
  toastr.warning(_.escape(message), '[ERA] 版本较旧', { escapeHtml: false });
}

/** 已提示过版本不足的角色卡，每张卡只提示一次。 */
const warnedCards = new Set<string>();

/**
 * 读取角色卡变量 `ERA最低版本`；当前 ERA 低于它时提示一次。
 * @returns 角色卡声明的最低版本；没有声明、没有打开角色卡或值无法识别时为 `null`。
 */
export function checkCardRequirement(): string | null {
  let required: unknown;
  try {
    required = _.get(getVariables({ type: 'character' }), CARD_MIN_VERSION_KEY);
  } catch {
    return null; // 没有打开角色卡（例如群聊）
  }
  if (typeof required === 'number') required = String(required);
  if (typeof required !== 'string' || !required.trim()) return null;
  const comparison = compareVersions(ERA_VERSION, required);
  if (Number.isNaN(comparison)) {
    logger.warn('checkCardRequirement', `角色卡变量 ${CARD_MIN_VERSION_KEY} 的值无法识别: ${required}`);
    return null;
  }
  if (comparison < 0) {
    const card = String(SillyTavern.characterId ?? '');
    if (!warnedCards.has(card)) {
      warnedCards.add(card);
      toastr.warning(
        _.escape(
          `这张角色卡需要 ERA ${required.trim()} 以上，当前是 ERA-Heron ${ERA_VERSION}。请更新 ERA 脚本，否则部分功能不会生效。`,
        ),
        '[ERA] 版本过低',
        { escapeHtml: false },
      );
    }
  }
  return required.trim();
}
