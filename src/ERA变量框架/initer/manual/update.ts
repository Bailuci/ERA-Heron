/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：面板：分步更新设置、重新解析、更新旧卡规则；补充文档与规则；修复第三批改动在审查中发现的问题；代码格式整理；更新旧卡时补上缺少的隐藏正则、升级未改动过的旧版意图说明条目、如实报告找不到规则条目或变量宏的情况
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file 手动初始化模块 - 更新旧卡
 * @description
 * 快速初始化只会补上缺少的内容，不会改动已有的。本模块把旧卡中的“ERA 变量操作规则”条目和 ERA 的隐藏正则
 * 更新到当前版本；被替换掉的条目和正则会另存为关闭的备份。
 *
 * 能下发到旧卡的只有：
 * - “ERA 变量操作规则”条目的正文；
 * - 数据、元数据、思考块三条隐藏正则的 find_regex（其余字段保留作者的设置）；
 * - 缺少的元数据、思考块、状态栏占位符隐藏正则（只对用过快速初始化、已有“ERA 数据隐藏正则”的卡补上）；
 * - 从未改动过的最早版本“ERA 变量意图说明”（只有一行注释）：在找不到任何变量宏时补上 <变量结构> 和 <当前变量>。
 * 作者改动过的意图说明、状态栏模板不会被改动。
 */
'use strict';

import { Logger } from '../../utils/log';
import { CHARACTER_REGEX } from '../../utils/regex';
import { getBoundWorldbookNames } from '../../utils/worldbook';
import { HIDE_ERA_DATA_REGEX } from './regex_objects/hide_era_data';
import { HIDE_ERA_METADATA_REGEX } from './regex_objects/hide_era_metadata';
import { HIDE_ERA_THINKING_REGEX } from './regex_objects/hide_era_thinking';
import { HIDE_STATUS_PLACEHOLDER_REGEX } from './regex_objects/hide_status_placeholder';
import { ERA_VAR_INTENT_ENTRY_NAME, eraVarIntentEntry } from './worldbook_entries/era_var_intent';
import {
  ERA_VAR_OPERATION_RULE_ENTRY_NAME,
  eraVarOperationRuleEntry,
} from './worldbook_entries/era_var_operation_rule';

const logger = new Logger();

export const BACKUP_SUFFIX = '（更新前的备份）';
const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim();

/** 会被更新 find_regex 的正则。 */
const UPDATABLE_REGEXES = [HIDE_ERA_DATA_REGEX, HIDE_ERA_METADATA_REGEX, HIDE_ERA_THINKING_REGEX];

/**
 * 卡里已有“ERA 数据隐藏正则”、但缺少时要补上的正则。
 * 最早一批卡（2025-10-27 的快速初始化）只有数据正则，由它同时隐藏 <era_data> 和 <VariableThink>；
 * 更新数据正则后，必须补上元数据和思考块正则，否则这两类标签会重新出现。
 */
const COMPANION_REGEXES = [HIDE_ERA_METADATA_REGEX, HIDE_ERA_THINKING_REGEX, HIDE_STATUS_PLACEHOLDER_REGEX];

/** 最早版本（5dc1a93 起至 1.5.0 之前）快速初始化写入的“ERA 变量意图说明”正文，只有一行不会发给 AI 的注释。 */
export const LEGACY_ERA_VAR_INTENT_CONTENT =
  '{{//请在这里补充对你设计的变量系统的说明，以便ai理解你的意图并正确的更新变量}}';

/** 当前意图说明模板中由 ERA 自动填入的两段（<变量结构> 与 <当前变量>）。 */
const INTENT_MACRO_SECTIONS = (() => {
  const template = normalize(eraVarIntentEntry.content as string);
  // 开头的填写说明里也提到了 <变量结构>，所以只认行首的
  return template.slice(template.search(/^<变量结构>/m));
})();

/** 能把变量内容发给 AI 的宏（与 macro/parser.ts 的匹配方式一致；`{{ERA-schema}}` 只有结构，不算）。 */
const VARIABLE_MACRO = /{{\s*ERA(-withmeta)?\s*:\s*[^}]+?\s*}}/i;

export interface UpdateResult {
  /** 更新了规则条目的世界书。 */
  worldbooks: string[];
  /** 更新了 find_regex 的正则。 */
  regexes: string[];
  /** 补上的缺少的正则。 */
  addedRegexes: string[];
  /** 为旧版“ERA 变量意图说明”补上变量宏的世界书。 */
  intentUpgraded: string[];
  /** 无法读取或更新的世界书。 */
  failed: string[];
  /** 已绑定的世界书数量。 */
  boundWorldbookCount: number;
  /** 已绑定的世界书中是否有“ERA 变量操作规则”条目（不论是否需要更新）。 */
  ruleEntryFound: boolean;
  /** 已启用的世界书条目或角色卡描述中是否有变量宏，如 `{{ERA:$ALLDATA}}`。 */
  variableMacroFound: boolean;
}

const isRuleEntry = (entry: WorldbookEntry) => entry.name.trim() === ERA_VAR_OPERATION_RULE_ENTRY_NAME;

const isLegacyIntentEntry = (entry: WorldbookEntry) =>
  entry.enabled &&
  entry.name.trim() === ERA_VAR_INTENT_ENTRY_NAME &&
  normalize(entry.content) === LEGACY_ERA_VAR_INTENT_CONTENT;

const hasVariableMacro = (entries: WorldbookEntry[]) =>
  entries.some(entry => entry.enabled && VARIABLE_MACRO.test(entry.content ?? ''));

/** 备份条目：去掉 uid（由酒馆分配新的），名字加后缀并关闭。 */
const backupOf = (entry: WorldbookEntry) =>
  ({ ..._.omit(entry, ['uid']), name: entry.name.trim() + BACKUP_SUFFIX, enabled: false }) as any;

/** 角色卡描述等字段里是否有变量宏（作者也可能把宏写在这里）。 */
function characterHasVariableMacro(): boolean {
  try {
    const card = getCharData('current') as any;
    if (!card) return false;
    const fields = [
      card.description,
      card.personality,
      card.scenario,
      card.data?.system_prompt,
      card.data?.post_history_instructions,
    ];
    return fields.some(field => typeof field === 'string' && VARIABLE_MACRO.test(field));
  } catch (error) {
    logger.debug('characterHasVariableMacro', '读取角色卡失败', error);
    return false;
  }
}

async function updateRuleEntries(result: UpdateResult, contents: Map<string, WorldbookEntry[]>): Promise<void> {
  const content = eraVarOperationRuleEntry.content as string;
  const isOutdated = (entry: WorldbookEntry) => isRuleEntry(entry) && normalize(entry.content) !== normalize(content);

  for (const name of contents.keys()) {
    const entries = contents.get(name)!;
    if (entries.some(isRuleEntry)) result.ruleEntryFound = true;
    if (!entries.some(isOutdated)) continue;
    try {
      // 备份与更新在同一次写入中完成，不会只完成一半
      const updated = await updateWorldbookWith(name, latest => [
        ...latest.map(entry => (isOutdated(entry) ? { ...entry, content } : entry)),
        ...latest.filter(isOutdated).map(backupOf),
      ]);
      contents.set(name, updated);
      result.worldbooks.push(name);
    } catch (error) {
      logger.warn('updateRuleEntries', `无法更新世界书“${name}”`, error);
      result.failed.push(name);
    }
  }
}

/**
 * 卡里找不到任何变量宏时，把第一条从未改动过的最早版本意图说明升级为带 <变量结构> 和 <当前变量> 的版本。
 * 作者改过的意图说明无法可靠地自动修改，只在结果里提示。
 */
async function upgradeLegacyIntent(result: UpdateResult, contents: Map<string, WorldbookEntry[]>): Promise<void> {
  if (result.variableMacroFound) return;
  const name = [...contents.keys()].find(name => contents.get(name)!.some(isLegacyIntentEntry));
  if (name === undefined) return;
  const content = `${LEGACY_ERA_VAR_INTENT_CONTENT}\n\n${INTENT_MACRO_SECTIONS}`;
  try {
    await updateWorldbookWith(name, latest => {
      const index = latest.findIndex(isLegacyIntentEntry);
      if (index === -1) return latest;
      return [...latest.map((entry, i) => (i === index ? { ...entry, content } : entry)), backupOf(latest[index])];
    });
    result.intentUpgraded.push(name);
    result.variableMacroFound = true;
  } catch (error) {
    logger.warn('upgradeLegacyIntent', `无法更新世界书“${name}”`, error);
    if (!result.failed.includes(name)) result.failed.push(name);
  }
}

async function updateRegexes(result: UpdateResult): Promise<void> {
  const current = _.keyBy(UPDATABLE_REGEXES, 'script_name');
  const isOutdated = (regex: TavernRegex) =>
    _.has(current, [regex.script_name]) && regex.find_regex !== current[regex.script_name].find_regex;
  const missingCompanions = (regexes: TavernRegex[]) =>
    regexes.some(regex => regex.script_name === HIDE_ERA_DATA_REGEX.script_name)
      ? COMPANION_REGEXES.filter(companion => !regexes.some(regex => regex.script_name === companion.script_name))
      : [];

  const existing = getTavernRegexes(CHARACTER_REGEX);
  const outdated = existing.filter(isOutdated);
  const missing = missingCompanions(existing);
  if (outdated.length === 0 && missing.length === 0) return;

  await updateTavernRegexesWith(
    regexes => [
      ...regexes.map(regex =>
        isOutdated(regex) ? { ...regex, find_regex: current[regex.script_name].find_regex } : regex,
      ),
      ...regexes
        .filter(isOutdated)
        .map(regex => ({ ...regex, id: '', script_name: regex.script_name + BACKUP_SUFFIX, enabled: false })),
      // id 留空，由酒馆生成
      ...missingCompanions(regexes).map(regex => ({ ...regex, id: '', scope: 'character' }) as TavernRegex),
    ],
    CHARACTER_REGEX,
  );
  result.regexes = outdated.map(regex => regex.script_name);
  result.addedRegexes = missing.map(regex => regex.script_name);
}

let running: Promise<UpdateResult> | null = null;

/** 更新旧卡的规则和正则。正在更新时返回同一个结果，不会重复备份。 */
export function updateEraRules(): Promise<UpdateResult> {
  running ??= (async () => {
    const result: UpdateResult = {
      worldbooks: [],
      regexes: [],
      addedRegexes: [],
      intentUpgraded: [],
      failed: [],
      boundWorldbookCount: 0,
      ruleEntryFound: false,
      variableMacroFound: false,
    };

    const contents = new Map<string, WorldbookEntry[]>();
    const names = await getBoundWorldbookNames();
    result.boundWorldbookCount = names.length;
    for (const name of names) {
      try {
        contents.set(name, await getWorldbook(name));
      } catch (error) {
        logger.warn('updateEraRules', `无法读取世界书“${name}”`, error);
        result.failed.push(name);
      }
    }

    await updateRuleEntries(result, contents);
    result.variableMacroFound = [...contents.values()].some(hasVariableMacro) || characterHasVariableMacro();
    await upgradeLegacyIntent(result, contents);
    await updateRegexes(result);
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

export interface UpdateReport {
  /** 已完成的更新，每项一句话。 */
  updated: string[];
  /** 需要作者处理的问题，每项一句话。 */
  warnings: string[];
  /** 没有更新任何内容，也没有问题。 */
  upToDate: boolean;
}

const quote = (names: string[]) => `“${names.join('”“')}”`;

/** 把更新结果写成给作者看的文字，面板直接显示。 */
export function describeUpdateResult(result: UpdateResult): UpdateReport {
  const updated: string[] = [];
  const warnings: string[] = [];

  if (result.worldbooks.length > 0) {
    updated.push(`已更新世界书${quote(result.worldbooks)}中的“${ERA_VAR_OPERATION_RULE_ENTRY_NAME}”，原内容已备份。`);
  }
  if (result.intentUpgraded.length > 0) {
    updated.push(
      `已在世界书${quote(result.intentUpgraded)}的“${ERA_VAR_INTENT_ENTRY_NAME}”中补上 <变量结构> 和 <当前变量> 两段，原内容已备份。`,
    );
  }
  if (result.regexes.length > 0) updated.push(`已更新正则${quote(result.regexes)}，原内容已备份。`);
  if (result.addedRegexes.length > 0) updated.push(`已补上缺少的正则${quote(result.addedRegexes)}。`);

  if (result.failed.length > 0) {
    warnings.push(`世界书${quote(result.failed)}无法读取或更新，可能已不存在。`);
  }
  if (result.boundWorldbookCount === 0) {
    warnings.push('当前角色卡没有绑定世界书，找不到 ERA 的规则条目。请先点“ERA 快速初始化”。');
  } else if (!result.ruleEntryFound && result.failed.length < result.boundWorldbookCount) {
    warnings.push(
      `已绑定的世界书中没有名为“${ERA_VAR_OPERATION_RULE_ENTRY_NAME}”的条目，规则没有更新。` +
        '如果这张卡还没有用过 ERA，请先点“ERA 快速初始化”；如果改过条目名，请改回原名（中间有一个空格）。',
    );
  }
  // 卡里没有规则条目时，先按上一条提示初始化，不再重复提示变量宏
  if (!result.variableMacroFound && result.ruleEntryFound) {
    warnings.push(
      '已启用的世界书条目和角色卡描述中都没有 {{ERA:$ALLDATA}} 这类变量宏：在默认的“随 AI 输出”模式下，AI 看不到当前变量。' +
        `请在“${ERA_VAR_INTENT_ENTRY_NAME}”末尾加上 <当前变量>{{ERA:$ALLDATA}}</当前变量>（见 doc/01-快速上手.md）。如果宏写在预设里，可以忽略这条提示。`,
    );
  }

  return { updated, warnings, upToDate: updated.length === 0 && warnings.length === 0 };
}
