/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；按目标楼的状态选择条目（条目过滤器、@@if）并渲染 EJS
 *       2026-11-27 注册了工具或公式函数时，提示词附上说明并允许 <EraFCall>
 *       2026-11-27 可选条目“ERA 表达式规则”视为内置的更新条目；聊天记录去掉旧卡的状态栏占位符；{{ERA-issues}} 展开为空
 *       2026-11-27 可选附上角色描述与用户人设（设置“附带角色信息”）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 额外模型的提示词
 * @description
 * 世界书条目按名字区分用途：
 * - 含 `[era_update]`：只发给负责更新变量的模型；`[era_update:组名]` 只发给对应分组的模型。
 * - 含 `[era_both]`：两边都发。
 * - 其他条目：只发给负责剧情的模型。
 * “ERA 变量操作规则”“ERA 变量意图说明”“ERA 表达式规则”等同于 `[era_update]`，因此旧卡无需改名。
 *
 * 条目按**目标楼**的状态选择和渲染：先由条目过滤器（`Era.registerEntryFilter`）决定，过滤器没有表态时按文件里的开关和关键字；
 * 开启 EJS 预处理且装有提示词模板插件时，再按 `@@if` 筛选、渲染 `<% %>`，最后剔除空条目。
 */
'use strict';

import { ERA_EXPR_RULE_ENTRY_NAME } from '../initer/manual/worldbook_entries/era_expr_rule';
import { ERA_VAR_INTENT_ENTRY_NAME } from '../initer/manual/worldbook_entries/era_var_intent';
import { ERA_VAR_OPERATION_RULE_ENTRY_NAME } from '../initer/manual/worldbook_entries/era_var_operation_rule';
import { parseEraMacros } from '../macro/parse';
import { stripStatusPlaceholderText } from '../macro/placeholder';
import { unescapeEraData } from '../utils/data';
import { removeMetaFields } from '../utils/era_data';
import { Logger } from '../utils/log';
import { getMessageContent, isUserMessage, stripCommandBlocks } from '../utils/message';
import { ExtraConfig } from './config';
import { describeActiveSchema, describeExprFns, describeTools } from './describe';
import { readPlanSummary } from './plan_block';
import { createEjsRenderer, Decorator, EjsRenderer, getEjsEngine, isSpecialEntry, parseDecorators } from './ejs';
import { applyEntryFilters, EntryFilterContext, getActiveEntryFilters } from './entry_filter';

const logger = new Logger();

export interface EntryTag {
  /** 只发给更新变量的模型。 */
  update: boolean;
  /** 只发给正文前规划的模型（1.8 起）。 */
  plan: boolean;
  /** ERA 自己的规则条目（变量操作规则、意图说明、表达式规则）。 */
  builtin: boolean;
  /** 两边都发。 */
  both: boolean;
  /** 分组名；空字符串表示不属于任何分组。 */
  group: string;
}

export function parseEntryTag(name: string): EntryTag {
  const match = /\[era_update(?:[:：]([^\]]*))?\]/i.exec(name ?? '');
  const builtin = [ERA_VAR_OPERATION_RULE_ENTRY_NAME, ERA_VAR_INTENT_ENTRY_NAME, ERA_EXPR_RULE_ENTRY_NAME].includes(
    (name ?? '').trim(),
  );
  return {
    update: match !== null || builtin,
    plan: /\[era_plan\]/i.test(name ?? ''),
    builtin,
    both: /\[era_both\]/i.test(name ?? ''),
    group: match?.[1]?.trim() ?? '',
  };
}

export interface ExtraEntry {
  name: string;
  content: string;
  order: number;
  group: string;
  /**
   * 已经由 ERA 渲染过 EJS：内容里的酒馆宏已在渲染前替换，之后只替换 ERA 宏。
   * 顺序与主生成一致：酒馆宏、EJS 都早于 ERA 宏。
   */
  rendered?: boolean;
}

const matchesKey = (key: string | RegExp, text: string): boolean => {
  // 世界书中的正则可能来自另一个窗口，不能用 instanceof 判断
  if (_.isRegExp(key)) {
    key.lastIndex = 0;
    return key.test(text);
  }
  return key.trim() !== '' && text.toLowerCase().includes(key.toLowerCase());
};

/** 条目在给定文本下是否激活：蓝灯总是激活，绿灯按主要和次要关键字判断。 */
export function isEntryActive(entry: WorldbookEntry, text: string): boolean {
  if (!entry.enabled) return false;
  return matchesStrategy(entry, text);
}

/** 不看开关，只看蓝灯、绿灯的关键字。 */
function matchesStrategy(entry: WorldbookEntry, text: string): boolean {
  if (entry.strategy.type === 'constant') return true;
  if (entry.strategy.type !== 'selective') return false;
  if (!entry.strategy.keys.some(key => matchesKey(key, text))) return false;
  const { logic, keys } = entry.strategy.keys_secondary;
  if (keys.length === 0) return true;
  const hits = keys.map(key => matchesKey(key, text));
  switch (logic) {
    case 'and_all':
      return hits.every(Boolean);
    case 'not_all':
      return !hits.every(Boolean);
    case 'not_any':
      return !hits.some(Boolean);
    default:
      return hits.some(Boolean);
  }
}

/** 更新模型读取的世界书：全局、角色卡（群聊时为全部成员）、聊天、用户人设。 */
export function getExtraWorldbookNames(): string[] {
  const names: (string | null | undefined)[] = [];
  const collect = (get: () => (string | null | undefined)[]) => {
    try {
      names.push(...get());
    } catch (error) {
      logger.debug('getExtraWorldbookNames', '有世界书无法获取', error);
    }
  };
  const ofCharacter = (name: string) => () => {
    const bound = getCharWorldbookNames(name);
    return [bound.primary, ...bound.additional];
  };
  collect(() => getGlobalWorldbookNames());
  const group = SillyTavern.groupId && _.find(SillyTavern.groups, ['id', SillyTavern.groupId]);
  if (group) {
    for (const member of group.members ?? []) collect(ofCharacter(member));
  } else {
    collect(ofCharacter('current'));
  }
  collect(() => [getChatWorldbookName('current')]);
  collect(() => [_.get(SillyTavern, ['powerUserSettings', 'persona_description_lorebook'])]);
  return _.uniq(_.compact(names));
}

/** 渲染 EJS 的总时限：一次解析的所有条目共用。 */
export const EJS_RENDER_BUDGET_MS = 15_000;

export interface CollectOptions {
  /** 目标楼的 MK。 */
  mk?: string;
  /** 目标楼的状态（转义过的原始状态）；条目过滤器、`@@if` 和 EJS 都按它求值。 */
  stat?: any;
  /** 是否渲染 EJS（还要求装有并开启了提示词模板插件）。 */
  ejs?: boolean;
  /** 告警写在这里：过滤器出错、渲染出错或超时、写函数被调用等。 */
  warnings?: string[];
  /**
   * 收集给谁的条目：`extra`（默认）是分步更新，收 `[era_update]` 与 `[era_both]`；
   * `plan` 是正文前规划（1.8 起），收 `[era_plan]`、`[era_both]` 与 ERA 自己的规则条目，不分组。
   */
  purpose?: 'extra' | 'plan';
}

interface Candidate {
  entry: WorldbookEntry;
  group: string;
  order: number;
  decorators: Decorator[];
  /** 去掉装饰器之后的内容。 */
  content: string;
  /** 过滤器替换后的内容。 */
  replaced?: string;
}

/**
 * 收集发给更新模型的条目。
 * @param text 匹配关键字的文本，也是过滤器的 `ctx.text`。
 */
export async function collectExtraEntries(text: string, options: CollectOptions = {}): Promise<ExtraEntry[]> {
  const warnings = options.warnings ?? [];
  const filters = getActiveEntryFilters();
  const engine = options.ejs ? getEjsEngine() : null;
  let filterCtx: EntryFilterContext | undefined;
  const getFilterCtx = (): EntryFilterContext =>
    (filterCtx ??= {
      stat: unescapeEraData(removeMetaFields(_.cloneDeep(options.stat ?? {}))),
      statRaw: _.cloneDeep(options.stat ?? {}),
      text,
      mk: options.mk ?? '',
      purpose: options.purpose ?? 'extra',
    });

  const candidates: Candidate[] = [];
  for (const world of getExtraWorldbookNames()) {
    let entries: WorldbookEntry[];
    try {
      entries = await getWorldbook(world);
    } catch (error) {
      logger.warn('collectExtraEntries', `无法读取世界书“${world}”`, error);
      continue;
    }
    for (const entry of entries) {
      const tag = parseEntryTag(entry.name);
      const forPlan = options.purpose === 'plan';
      if (forPlan ? !tag.plan && !tag.both && !tag.builtin : !tag.update && !tag.both) continue;
      // 过滤器在开关检查之前运行：被过滤器管理的条目，文件里的开关只是过滤器不表态时的默认值
      const { decision, content: replaced } =
        filters.length > 0
          ? applyEntryFilters({ ..._.cloneDeep(entry), world }, getFilterCtx(), warnings, filters)
          : { decision: 'default' as const, content: undefined };
      if (decision === 'exclude') continue;
      const parsed = parseDecorators(entry.content);
      const names = parsed.decorators.map(item => item.name);
      if (decision === 'default') {
        // 酒馆自己的装饰器：@@activate 无视关键字，@@dont_activate 不激活
        if (!entry.enabled || names.includes('@@dont_activate')) continue;
        if (!names.includes('@@activate') && !matchesStrategy(entry, text)) continue;
      }
      candidates.push({
        entry,
        group: forPlan ? '' : tag.group,
        order: entry.position.order,
        decorators: parsed.decorators,
        content: parsed.content,
        replaced,
      });
    }
  }

  const result: ExtraEntry[] = [];
  let renderer: EjsRenderer | null | undefined;
  const deadline = Date.now() + EJS_RENDER_BUDGET_MS;
  // 按 order 依次处理：EJS 的 define 在同一个环境里按顺序生效
  for (const item of _.sortBy(candidates, 'order')) {
    const { entry } = item;
    const base = { name: entry.name, order: item.order, group: item.group };
    if (item.replaced !== undefined) {
      if (item.replaced.trim()) result.push({ ...base, content: item.replaced });
      continue;
    }
    if (!engine) {
      // 不渲染 EJS 时与以前一样发原文
      if (item.content.trim()) result.push({ ...base, content: item.content });
      continue;
    }
    if (isSpecialEntry(entry.name, item.decorators)) continue;
    const condition = item.decorators.find(decorator => decorator.name === '@@if');
    const needsRender = item.content.includes('<%');
    if ((condition || needsRender) && renderer === undefined) {
      try {
        renderer = await createEjsRenderer(engine, options.stat ?? {}, { mk: options.mk ?? '' }, warnings, deadline);
      } catch (error: any) {
        renderer = null;
        warnings.push(`无法准备 EJS 渲染环境，含 EJS 或 @@if 的条目没有发送: ${error?.message ?? error}`);
      }
    }
    if (condition) {
      if (!renderer) continue;
      try {
        if (!(await renderer.test(condition.arg, entry.name))) continue;
      } catch (error: any) {
        warnings.push(`条目“${entry.name}”的 @@if 求值出错，按不满足处理: ${error?.message ?? error}`);
        continue;
      }
    }
    if (!needsRender) {
      if (item.content.trim()) result.push({ ...base, content: item.content });
      continue;
    }
    if (!renderer) continue;
    // 与主生成一致：酒馆宏（含 {{// }} 注释）先于 EJS 替换
    let code = substitudeMacros(item.content);
    if (item.decorators.some(decorator => decorator.name === '@@private')) {
      code = `<% await (async () => { %>${code}<% })(); %>`;
    }
    try {
      const content = await renderer.render(code, entry.name);
      if (content.trim()) result.push({ ...base, content, rendered: true });
    } catch (error: any) {
      // 不能保留原文：会把 JS 源码原样发给更新模型
      warnings.push(`条目“${entry.name}”的 EJS 渲染失败，没有发送: ${error?.message ?? error}`);
    }
  }
  return result;
}

/** 分组名列表；没有任何分组时返回一个空名字的默认分组。 */
export function getGroups(entries: ExtraEntry[]): string[] {
  const groups = _.uniq(entries.map(entry => entry.group).filter(Boolean)).sort();
  return groups.length > 0 ? groups : [''];
}

/**
 * 角色描述与用户人设（酒馆的 `{{description}}`、`{{persona}}`）。展开后为空，或宏没有被替换（仍是原样文本）时不加。
 * 设置“附带角色信息”开启时附在提示词里；没有任何内容时为空字符串。
 */
export function describeCharacterInfo(): string {
  const read = (macro: string): string => {
    try {
      const text = String(substitudeMacros(macro) ?? '').trim();
      return text === macro ? '' : text;
    } catch {
      return '';
    }
  };
  const description = read('{{description}}');
  const persona = read('{{persona}}');
  return _.compact([
    description && `<角色描述>\n${description}\n</角色描述>`,
    persona && `<用户人设>\n${persona}\n</用户人设>`,
  ]).join('\n');
}

const buildHeader = (allowPatch: boolean, allowCall: boolean): string => `你负责根据最新一段剧情更新变量，不负责写剧情。
- 只依据“最新剧情”中实际发生的事更新变量，更早的剧情仅供理解，其中的变化已经记录过了。
- 只输出 <VariableThink> 以及 <VariableInsert>、<VariableEdit>、<VariableDelete>${allowPatch ? '、<VariablePatch>' : ''}${allowCall ? '、<EraFCall>' : ''} 指令块，不要续写或复述剧情。
- 即使下面的规则要求输出正文，也不要输出正文。
- 如果没有任何变量需要更新，只输出 <VariableThink>无变化</VariableThink>。`;

/**
 * 发给模型的一段聊天：去掉指令块和思考块，并应用酒馆的提示词正则。
 * AI 消息还要去掉状态栏占位符，规则与主生成相同（旧卡缺少占位符隐藏正则，见 `stripStatusPlaceholderText`）。
 */
function formatMessage(msg: any, depth: number): string {
  const user = isUserMessage(msg);
  const raw = getMessageContent(msg) ?? '';
  let text = stripCommandBlocks(raw);
  // 正文前规划（1.8 起）：规划块里的指令已经计入变量，只把摘要告诉更新模型
  const summary = user ? readPlanSummary(raw) : '';
  if (summary) text = `${text.trimEnd()}\n（本轮已结算：${summary}）`;
  if (!user) text = stripStatusPlaceholderText(text);
  text = text.trim();
  try {
    return formatAsTavernRegexedString(text, user ? 'user_input' : 'ai_output', 'prompt', {
      depth,
    }).trim();
  } catch {
    return text;
  }
}

export interface PromptInput {
  /** 到目标楼层为止的消息，按顺序排列，最后一条是目标。 */
  messages: any[];
  entries: ExtraEntry[];
  group: string;
  /** 目标楼层没有额外模型输出时的状态（转义过的），含它自己的指令和旁路写入。 */
  stat: any;
  /** 目标楼层自己已有的指令块。 */
  executed: string;
  config: ExtraConfig;
  /** 上一次输出及其问题；首次请求时没有。 */
  feedback?: { output: string; problems: string[] };
}

export function buildExtraPrompts(input: PromptInput): { role: 'system' | 'assistant' | 'user'; content: string }[] {
  const { messages, entries, group, config, feedback } = input;
  const stat = unescapeEraData(input.stat);
  const statWithoutMeta = unescapeEraData(removeMetaFields(input.stat));
  // 先替换 ERA 宏：它们要取目标楼层的状态，而不是最新状态。
  // {{ERA-issues}} 是主模型上一条回复的问题，额外模型有自己的重试，这里展开为空
  const eraMacros = (text: string) => parseEraMacros(text, stat, statWithoutMeta, { issues: false });
  const render = (text: string) => substitudeMacros(eraMacros(text));
  const renderEntry = (entry: ExtraEntry) => (entry.rendered ? eraMacros(entry.content) : render(entry.content));
  const selected = entries.filter(entry => entry.group === '' || entry.group === group);

  // 旧卡的规则没有提到 <VariablePatch> 时不使用它：旧卡的隐藏正则也不认识它，会直接显示在聊天里
  const allowPatch = selected.some(entry => entry.content.includes('VariablePatch'));
  const tools = describeTools();
  const prompts: { role: 'system' | 'assistant' | 'user'; content: string }[] = [
    { role: 'system', content: buildHeader(allowPatch, tools !== '') },
  ];
  for (const entry of selected) {
    prompts.push({ role: 'system', content: renderEntry(entry) });
  }
  if (config.附带角色信息 === '开启') {
    const info = describeCharacterInfo();
    if (info) prompts.push({ role: 'system', content: info });
  }
  // 工具与自定义公式函数的说明：条目里没有引用对应的宏时自动附上
  if (tools && !selected.some(entry => /{{\s*ERA-tools\s*}}/i.test(entry.content))) {
    prompts.push({
      role: 'system',
      content: `<工具>
${tools}
</工具>`,
    });
  }
  const exprFns = describeExprFns();
  if (exprFns && !selected.some(entry => /{{\s*ERA-exprFns\s*}}/i.test(entry.content))) {
    prompts.push({ role: 'system', content: exprFns });
  }
  const schema = describeActiveSchema();
  if (schema && !selected.some(entry => /{{\s*ERA-schema\s*}}/i.test(entry.content))) {
    prompts.push({ role: 'system', content: `<变量结构>\n${schema}\n</变量结构>` });
  }
  if (!selected.some(entry => /{{\s*ERA(-withmeta)?\s*:\s*\$ALLDATA\s*}}/i.test(entry.content))) {
    prompts.push({ role: 'system', content: `<当前变量>\n${JSON.stringify(statWithoutMeta)}\n</当前变量>` });
  }

  const recent = messages.slice(-config.聊天楼层数);
  const earlier = recent.slice(0, -1);
  if (earlier.length > 0) {
    const lines = earlier.map((msg, i) => formatMessage(msg, recent.length - 1 - i)).filter(Boolean);
    prompts.push({ role: 'user', content: `<之前的剧情>\n${lines.join('\n\n')}\n</之前的剧情>` });
  }
  const tail = [
    `<最新剧情>\n${formatMessage(recent[recent.length - 1], 0)}\n</最新剧情>`,
    input.executed
      ? `<已执行的更新>\n${input.executed}\n</已执行的更新>\n以上更新已经计入当前变量，不要重复，只补充遗漏的部分。`
      : '',
    config.附加要求.trim() ? render(config.附加要求.trim()) : '',
    group ? `这次只更新与“${group}”有关的变量，其余变量由别人负责，不要改动。` : '',
    '请根据最新剧情输出变量更新。',
  ];
  prompts.push({ role: 'user', content: _.compact(tail).join('\n\n') });

  if (feedback) {
    prompts.push({ role: 'assistant', content: feedback.output || '(空)' });
    prompts.push({
      role: 'user',
      content: `你的输出存在以下问题：\n${feedback.problems.map(line => `- ${line}`).join('\n')}\n请重新输出**完整的**、修正后的内容。`,
    });
  }
  return prompts;
}
