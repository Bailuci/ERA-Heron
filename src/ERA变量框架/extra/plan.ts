/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。日期：2026-11-27。
 * 目的：正文前规划（路线图 1.8-3）
 *       2026-11-27 可选附上角色描述与用户人设（设置“附带角色信息”）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 正文前规划
 * @description
 * 检定、骰点放在正文之后结算，容易出现“正文写赢了、数值没过检定”。开启“正文前规划”后，玩家点击发送时，
 * ERA 先请求规划模型，按 `[era_plan]` 条目结算这一轮需要先确定的结果，把结果写成
 * `<era_plan>摘要与指令块</era_plan>` 追加在玩家消息末尾，再发送：
 * - 规划锚定在**玩家楼**：正文即事实来源，玩家消息里的指令发送时就执行；滑动 AI 回复时规划自然复用，骰点不会重掷。
 * - 规划发生在玩家楼有 MK 之前，所以规划里不能用 `$expr` 和工具调用（它们的随机数依赖 MK），只接受写出结果的普通指令。
 *   需要随机性时，提示词里附上 ERA 预先掷好的骰子。
 * - 剧情模型看不到被隐藏的 `<era_plan>`，生成前由 `injectPlanSummary` 把摘要注入提示词。
 */
'use strict';

import { simulateUserText } from '../core/simulate';
import { parseEraMacros } from '../macro/parse';
import { unescapeEraData } from '../utils/data';
import { getEraData, removeMetaFields } from '../utils/era_data';
import { Logger } from '../utils/log';
import {
  extractCommandBlocks,
  getMessageContent,
  isUserMessage,
  maskOutputThinking,
  stripCommandBlocks,
} from '../utils/message';
import { readPlanSummary, stripPlanBlock, SUMMARY_TAG } from './plan_block';
import { ExtraConfig } from './config';
import { describeActiveSchema } from './describe';
import { collectExtraEntries, describeCharacterInfo, ExtraEntry } from './prompt';
import { isRetryableError, retryDelay } from './runner';

const logger = new Logger();

export {
  appendPlanBlock,
  findPlanBlock,
  PLAN_BLOCK_PATTERN,
  PLAN_TAG,
  readPlanSummary,
  stripPlanBlock,
} from './plan_block';

export interface PlanResult {
  status: 'done' | 'no_change' | 'no_entries' | 'failed' | 'aborted';
  /** 给剧情模型看的结算摘要。 */
  summary: string;
  /** 要追加在玩家消息里的指令块。 */
  blocks: string;
  problems: string[];
  warnings: string[];
}

export interface PlanDeps {
  /** 请求规划模型；`api` 是第几个接口（0 是主接口，之后是备用接口）。 */
  generate(prompts: { role: string; content: string }[], api: number): Promise<string>;
  sleep?(ms: number, signal: { aborted: boolean }): Promise<void>;
}

/** 预先掷好的骰子：规划模型自己“随机”的结果并不随机。规划结果以字面数字写进正文，所以这里不需要可重放。 */
export function rollPlanDice(random: () => number = Math.random): string {
  const roll = (sides: number) => 1 + Math.floor(random() * sides);
  const d6 = [roll(6), roll(6), roll(6)];
  return `d20=${roll(20)}，d100=${roll(100)}，3d6=${d6.join('+')}=${_.sum(d6)}，另一个 d20=${roll(20)}`;
}

const HEADER = `你负责在写剧情之前，按规划规则结算玩家这一轮行动需要先确定的结果（检定、骰点、消耗等），不负责写剧情。
- 只依据下面的规划规则判断这一轮要不要结算；不需要时只输出 <VariableThink>无需规划</VariableThink>。
- 需要时输出：
  1. <${SUMMARY_TAG}>一两句话写清结算结果（成功还是失败、数值是多少），写剧情的模型会按它来写</${SUMMARY_TAG}>
  2. 对应的 <VariableInsert>、<VariableEdit>、<VariableDelete> 指令块，数值直接写结果。不要使用 $expr，也不要调用工具。
- 需要随机结果时，按顺序使用“可用的骰子”里的数值，不要自己编。
- 不要续写或复述剧情。`;

/** 给剧情模型的说明：规划结果已经计入变量。 */
export function formatPlanInjection(summary: string): string {
  return `<本轮结算>\n${summary}\n以上结果已经计入变量。正文按这个结果来写，不要改写结果，也不要再输出对应的变量指令。\n</本轮结算>`;
}

interface PlanInput {
  /** 玩家这一轮要发送的文字（不含规划块）。 */
  input: string;
  /** 已有的消息，最后一条是上一轮 AI 回复。 */
  messages: any[];
  entries: ExtraEntry[];
  /** 当前变量（转义过的）。 */
  stat: any;
  config: ExtraConfig;
  dice: string;
  feedback?: { output: string; problems: string[] };
}

/** 发给规划模型的一段聊天：去掉指令块；玩家楼里已有的规划只留摘要。 */
function formatHistory(msg: any): string {
  const raw = getMessageContent(msg) ?? '';
  const summary = isUserMessage(msg) ? readPlanSummary(raw) : '';
  const text = stripCommandBlocks(stripPlanBlock(raw)).trim();
  return summary ? `${text}\n（本轮结算：${summary}）` : text;
}

export function buildPlanPrompts(input: PlanInput): { role: 'system' | 'assistant' | 'user'; content: string }[] {
  const stat = unescapeEraData(input.stat);
  const statWithoutMeta = unescapeEraData(removeMetaFields(input.stat));
  const render = (text: string) => substitudeMacros(parseEraMacros(text, stat, statWithoutMeta, { issues: false }));
  const prompts: { role: 'system' | 'assistant' | 'user'; content: string }[] = [{ role: 'system', content: HEADER }];
  for (const entry of input.entries) {
    prompts.push({
      role: 'system',
      content: entry.rendered ? parseEraMacros(entry.content, stat, statWithoutMeta) : render(entry.content),
    });
  }
  if (input.config.附带角色信息 === '开启') {
    const info = describeCharacterInfo();
    if (info) prompts.push({ role: 'system', content: info });
  }
  const schema = describeActiveSchema();
  if (schema) prompts.push({ role: 'system', content: `<变量结构>\n${schema}\n</变量结构>` });
  prompts.push({ role: 'system', content: `<当前变量>\n${JSON.stringify(statWithoutMeta)}\n</当前变量>` });
  const recent = input.messages.slice(-input.config.聊天楼层数);
  const lines = recent.map(formatHistory).filter(Boolean);
  if (lines.length > 0) prompts.push({ role: 'user', content: `<之前的剧情>\n${lines.join('\n\n')}\n</之前的剧情>` });
  prompts.push({
    role: 'user',
    content: `<玩家这一轮的行动>\n${input.input}\n</玩家这一轮的行动>\n<可用的骰子>${input.dice}</可用的骰子>${
      input.config.附加要求 ? `\n${input.config.附加要求}` : ''
    }`,
  });
  if (input.feedback) {
    prompts.push({ role: 'assistant', content: input.feedback.output });
    prompts.push({
      role: 'user',
      content: `上面的输出有以下问题，请修正后重新输出完整的结果：\n${input.feedback.problems.map(p => `- ${p}`).join('\n')}`,
    });
  }
  return prompts;
}

/** 检查规划模型的输出，返回摘要、指令块和问题。 */
async function checkOutput(
  output: string,
  stat: any,
): Promise<{ summary: string; blocks: string; problems: string[] }> {
  const extracted = extractCommandBlocks(output);
  // 摘要只在思考块之外找（模型的思考里常会提到这个标签名），并取最后一个完整的块
  const summaries = [
    ...maskOutputThinking(output).matchAll(
      new RegExp(`<${SUMMARY_TAG}>((?:(?!<${SUMMARY_TAG}>)[\\s\\S])*?)<\\/${SUMMARY_TAG}>`, 'gi'),
    ),
  ];
  const summary = summaries.at(-1)?.[1]?.trim() ?? '';
  const problems: string[] = [];
  if (extracted.truncated) problems.push('有指令块没有闭合，输出可能被截断');
  if (/<EraFCall\b/i.test(extracted.text)) problems.push('规划里不能调用工具，请直接写出结果');
  if (/\$expr/.test(extracted.text)) problems.push('规划里不能用 $expr，请直接写出计算结果');
  if (extracted.hasCommands && !summary) problems.push(`缺少 <${SUMMARY_TAG}>：请用一两句话写清结算结果`);
  if (!extracted.hasCommands && !extracted.hasThink && !summary) {
    problems.push('没有输出任何内容；不需要结算时只输出 <VariableThink>无需规划</VariableThink>');
  }
  if (problems.length === 0 && extracted.hasCommands) {
    // 按玩家消息的规则试算：玩家楼不执行钩子
    const result = await simulateUserText(extracted.text, stat);
    problems.push(...result.problems.map(({ path, reason }) => `${path}: ${reason}`));
  }
  return { summary, blocks: extracted.hasCommands ? extracted.text : '', problems };
}

/**
 * 为玩家这一轮的行动做一次规划。不写入任何内容，由调用方把结果拼进输入框或玩家楼。
 * @param messages 规划所依据的历史消息（不含这一轮的玩家消息）。
 */
export async function runPlan(
  input: string,
  messages: any[],
  config: ExtraConfig,
  deps: PlanDeps,
  signal: { aborted: boolean },
  /** 规划依据的变量（转义过的），默认是最新变量；重新规划旧的玩家楼时传入那一楼之前的变量。 */
  baseStat?: any,
): Promise<PlanResult> {
  const warnings: string[] = [];
  const end = (status: PlanResult['status'], extra: Partial<PlanResult> = {}): PlanResult => ({
    status,
    summary: '',
    blocks: '',
    problems: [],
    warnings,
    ...extra,
  });
  const stat = baseStat ?? getEraData().stat;
  const scanText = [...messages.slice(-config.聊天楼层数).map(msg => getMessageContent(msg) ?? ''), input].join('\n');
  const entries = await collectExtraEntries(scanText, {
    mk: '',
    stat,
    ejs: config.EJS预处理 === '自动',
    warnings,
    purpose: 'plan',
  });
  if (signal.aborted) return end('aborted');
  // 没有 [era_plan] 规划规则时不规划（只有共享设定、ERA 自己的规则条目不算）
  if (!entries.some(entry => /\[era_plan\]/i.test(entry.name))) return end('no_entries');

  const dice = rollPlanDice();
  const apiCount = 1 + config.备用接口.length;
  let api = 0;
  let retries = 0;
  let failures = 0;
  let feedback: PlanInput['feedback'];
  let problems: string[] = [];
  while (!signal.aborted) {
    try {
      const output = await deps.generate(
        buildPlanPrompts({ input, messages, entries, stat, config, dice, feedback }),
        api,
      );
      failures = 0;
      const checked = await checkOutput(output, stat);
      if (checked.problems.length === 0) {
        if (!checked.blocks && !checked.summary) return end('no_change');
        return end('done', { summary: checked.summary, blocks: checked.blocks });
      }
      problems = checked.problems;
      feedback = { output, problems };
    } catch (error: any) {
      if (signal.aborted) break;
      problems = [`请求失败: ${error?.message ?? error}`];
      logger.warn('runPlan', problems[0]);
      if (api < apiCount - 1) {
        api++;
        continue;
      }
      if (!isRetryableError(error) || retries >= config.重试次数) break;
      retries++;
      await (deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms))))(
        retryDelay(failures++),
        signal,
      );
      continue;
    }
    if (retries >= config.重试次数) break;
    retries++;
  }
  if (signal.aborted) return end('aborted');
  return end('failed', { problems });
}
