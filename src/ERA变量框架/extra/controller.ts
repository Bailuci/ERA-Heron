/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；修复复审中发现的问题；发送前等待只拦玩家的发送，脚本用 Era.extra.wait()；修复 [1] 形式的键在 Patch 中的回滚；发送前等待按重试与写入计算时限、放弃时提示；“继续”时取消该楼的解析；同一楼重新解析时不再误报旧任务的取消；写入使用单独的时限；run 返回结果，新增 status()；采用角色卡推荐的设置与备用接口；新增 warnings；写入已到正文但同步未完成时，发送前等待继续等同步（status().pendingSync）
 *       2026-11-27 正文前规划：发送前规划、生成前注入摘要、重新规划最新玩家楼；主生成移除 [era_plan] 条目；条目过滤器也用于主生成
 *       2026-11-27 主生成的条目过滤器只在真正的主生成期间运行和等待；强制纳入时关闭概率，不改写带粘性或冷却的条目；输入框有文字时不回退读取最新玩家楼的规划摘要
 *       2026-11-27 请求加上头部提示词、酒馆预设与流式请求（见 request.ts）；status().history 保留最近几次分步更新与规划的请求记录
 *       2026-11-27 主生成标记不再因斜杠命令等提前返回而卡住（还要求酒馆正处于生成中）；规划摘要只在与 GENERATION_STARTED 配对的 AFTER_COMMANDS 注入；带 ID 的停止不撤注入；切换聊天后旧聊天的结果不再写进新聊天
 *       2026-11-27 等待中的楼层按 getMessageAt 取；重新规划时不把 <era_data> 发给规划模型
 *       2026-11-28 新增 runExtraAuto、getExtraSwitches、planInjectionOf
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 额外模型的触发与中止
 * @description
 * 剧情回复完成并同步后，在后台请求额外模型更新变量，结果写回**那一楼**：
 * 期间可以继续阅读；按设置，发送下一条消息前会等它完成。
 * 目标楼层被重新生成、继续、删除，或切换聊天时，结果作废；只是滑到别的 swipe 时，结果仍写到原来那一条。
 */
'use strict';

import { readMessageKey } from '../core/key/mk';
import { findMessageByMk, findSwipeByMk, getStatBefore } from '../core/simulate';
import { createTicket } from '../events/handlers/api/tickets';
import { isQueueIdle, pushToQueue, waitForQueueIdle } from '../events/queue';
import {
  ERA_API_EVENTS,
  ERA_DATA_REGEX,
  ERA_EVENT_EMITTER,
  ExtraStatusPayload,
  WriteDonePayload,
} from '../utils/constants';
import { Logger } from '../utils/log';
import { findLastAiMessage, getMessageAt, getMessageContent, hasOwnCommands, isUserMessage } from '../utils/message';
import { ExtraConfig, getApiChain, isExtraEnabled, loadExtraConfig, resolveExtraConfig } from './config';
import { prepareRequest } from './request';
import { getExtraWorldbookNames, parseEntryTag } from './prompt';
import { applyEntryFilters, EntryFilterContext, getActiveEntryFilters } from './entry_filter';
import { unescapeEraData } from '../utils/data';
import { getEraData, removeMetaFields } from '../utils/era_data';
import { appendPlanBlock, formatPlanInjection, PlanResult, readPlanSummary, runPlan, stripPlanBlock } from './plan';
import { estimateRunMs, ExtraResult, runExtra } from './runner';
import { installSendGuard } from './send_guard';

const logger = new Logger();

/** 由玩家触发的、会产生剧情的生成类型。 */
const STORY_TYPES = ['normal', 'swipe', 'regenerate', 'continue', 'append', 'appendFinal'];
/** 会换掉最后一条回复的生成类型。 */
const REPLACE_TYPES = ['swipe', 'regenerate'];
/** 会改写最后一条回复正文的生成类型。 */
const CONTINUE_TYPES = ['continue', 'append', 'appendFinal'];

/**
 * 额外模型写入的时限。写入要在事件队列中排队，队列里可能有耗时的完全重算，因此比普通写入（20 秒）长得多；
 * 解析被取消时写入随之放弃，不靠这个时限。
 */
export const EXTRA_WRITE_TIMEOUT_MS = 120_000;

/** 可调整的时限（测试用）。 */
export const extraTimings = { writeMs: EXTRA_WRITE_TIMEOUT_MS };

/** 一次解析的结果。 */
export interface ExtraRunResult extends ExtraResult {
  mk: string;
  /** `done` 或 `no_change`。 */
  ok: boolean;
}

/** 最近一次结束的解析，只保存在内存中。 */
export interface ExtraLastRun {
  mk: string;
  ok: boolean;
  /** 失败或取消的原因。 */
  error?: string;
  /** 实际发送的提示词，每个分组保留最后一次请求。 */
  prompt?: { group: string; messages: { role: string; content: string }[] }[];
  /** 最后一次的原始回复；多个分组时每组前面有一行 `【分组 名字】`。 */
  rawReply?: string;
  finishedAt: number;
  status: ExtraResult['status'];
  problems: string[];
  /** 不影响结果判定的告警，见 `ExtraResult.warnings`。 */
  warnings: string[];
}

/** 请求记录中的一条：一次分步更新（`update`）或一次正文前规划（`plan`）。 */
export interface ExtraHistoryEntry {
  type: 'update' | 'plan';
  /** 分步更新的目标楼；规划时是玩家楼，发送前规划时玩家楼还没有 MK，为空字符串。 */
  mk: string;
  ok: boolean;
  status: ExtraResult['status'] | PlanResult['status'];
  error?: string;
  /** 实际发送的提示词（含头部提示词与预设条目），每个分组保留最后一次请求；规划的分组名为“规划”。 */
  prompt?: { group: string; messages: { role: string; content: string }[] }[];
  rawReply?: string;
  finishedAt: number;
  problems: string[];
  warnings: string[];
}

/** 请求记录最多保留的条数。 */
export const EXTRA_HISTORY_LIMIT = 10;

export interface ExtraStatusSnapshot {
  running: { mk: string; startedAt: number; attempt: number }[];
  last: ExtraLastRun | null;
  /** 最近几次分步更新与规划的记录，最新的在前；只在内存中，切换聊天时清空。 */
  history: ExtraHistoryEntry[];
  /** 额外模型的输出已经写进这些楼的正文，但同步还没算完；发送前等待会等它们。 */
  pendingSync: string[];
}

interface GroupRecord {
  /** 已发出的请求数。 */
  attempt: number;
  prompts?: { role: string; content: string }[];
  reply?: string;
}

interface Job {
  id: number;
  mk: string;
  /** 开始时的聊天代次，见 `chatEpoch`。 */
  epoch: number;
  config: ExtraConfig;
  startedAt: number;
  signal: { aborted: boolean };
  generationIds: Set<string>;
  groups: Map<string, GroupRecord>;
  /** 组织请求时的告警（预设读不到等）。 */
  warnings: Set<string>;
  /** 放弃尚未执行的写入。 */
  cancelWrite?: () => void;
  promise: Promise<ExtraRunResult>;
}

const jobs = new Map<string, Job>();
/** 每个 MK 最新一次解析的编号；被取代的旧解析结束时不再报告。 */
const latestJobId = new Map<string, number>();
let nextJobId = 1;
let lastRun: ExtraLastRun | null = null;
let history: ExtraHistoryEntry[] = [];
/**
 * 聊天代次：切换聊天时加一。分步更新和规划开始时记下它，结束时已经变了（中途切换了聊天）就丢弃结果：
 * 不写 lastRun、history、lastPlan，也不发状态事件，否则旧聊天的提示词和回复会出现在新聊天里。
 */
let chatEpoch = 0;

function pushHistory(entry: ExtraHistoryEntry): void {
  history = [entry, ...history].slice(0, EXTRA_HISTORY_LIMIT);
}
/** 已收到回复、等待 ERA 同步完成的楼层。 */
const waiting = new Set<number>();
/** 输出已写进正文、同步还没算完的楼层（MK）。事件队列空闲时说明已经算完。 */
const pendingSync = new Set<string>();

const emitStatus = (payload: ExtraStatusPayload) => eventEmit(ERA_EVENT_EMITTER.EXTRA_STATUS, payload);

const groupRecord = (job: Job, group: string): GroupRecord => {
  if (!job.groups.has(group)) job.groups.set(group, { attempt: 0 });
  return job.groups.get(group)!;
};

async function generateOnce(
  job: Job,
  prompts: { role: string; content: string }[],
  group: string,
  apiIndex: number,
): Promise<string> {
  const { config } = job;
  const chain = getApiChain(config, group);
  const api = chain[Math.min(apiIndex, chain.length - 1)];
  const generation_id = `era_extra_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = groupRecord(job, group);
  record.attempt++;
  const warnings: string[] = [];
  const prepared = prepareRequest(prompts as any, config, api, 'update', group, warnings);
  warnings.forEach(warning => job.warnings.add(warning));
  record.prompts = prepared.prompts.map(({ role, content }) => ({ role, content }));
  record.reply = undefined;
  job.generationIds.add(generation_id);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = generateRaw({
      generation_id,
      should_silence: true,
      ...(prepared.should_stream ? { should_stream: true } : {}),
      ordered_prompts: prepared.prompts,
      max_chat_history: 0,
      custom_api: prepared.custom_api as any,
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        stopGenerationById(generation_id);
        reject(Object.assign(new Error(`超过 ${config.超时秒数} 秒没有完成`), { retryable: true }));
      }, config.超时秒数 * 1000);
    });
    const result: any = await Promise.race([request, timeout]);
    if (job.signal.aborted) throw new Error('已取消');
    const text = typeof result === 'string' ? result : String(result?.content ?? result?.text ?? '');
    record.reply = text;
    if (!text.trim()) throw new Error('返回了空内容');
    return text;
  } catch (error: any) {
    record.reply ??= `（请求失败：${error?.message ?? error}）`;
    throw error;
  } finally {
    clearTimeout(timer);
    job.generationIds.delete(generation_id);
  }
}

/** 把指令写到指定 MK 的消息中；`blocks` 为空时清除上一次的输出。生效后完成。 */
async function writeForJob(job: Job, mk: string, blocks: string): Promise<void> {
  if (job.signal.aborted) throw new Error('已取消');
  const { ticket, promise } = createTicket(extraTimings.writeMs);
  job.cancelWrite = () => ticket.reject(new Error('已取消'));
  pushToQueue(ERA_API_EVENTS.WRITE_EXTRA, { mk, blocks }, ticket);
  try {
    await promise;
  } catch (error: any) {
    // 已经写进正文、只是同步还没算完：下一次同步会按正文计算，结果与写入一致，不算失败；
    // 但发送前等待要等它算完，否则主生成的宏拿到的是旧值
    if (ticket.mk && !job.signal.aborted) {
      logger.warn('writeForJob', `已写入正文，同步完成后生效: ${error?.message ?? error}`);
      if (!isQueueIdle()) pendingSync.add(mk);
      return;
    }
    throw error;
  } finally {
    job.cancelWrite = undefined;
  }
}

function notify(result: ExtraResult, manual: boolean) {
  const detail = result.problems
    .slice(0, 3)
    .map(line => _.escape(line.split('\n')[0].slice(0, 120)))
    .join('<br>');
  const options = { escapeHtml: false };
  if (result.status === 'failed') {
    toastr.error(`${detail}<br>可以在 ERA 面板中重新解析。`, '[ERA] 变量更新失败', options);
  } else if (result.status === 'done' && result.problems.length > 0) {
    toastr.warning(detail, '[ERA] 变量已更新，但部分指令没有生效', options);
  } else if (manual && result.status === 'done') {
    toastr.success('变量已更新', '[ERA]');
  } else if (manual && result.status === 'no_change') {
    toastr.info('没有需要更新的变量', '[ERA]');
  } else if (manual && result.status === 'no_entries') {
    toastr.warning('当前角色卡没有发给更新模型的世界书条目（名字含 [era_update]）', '[ERA]');
  }
}

function recordLastRun(job: Job, result: ExtraResult): void {
  const groups = [...job.groups.entries()].filter(([, record]) => record.prompts);
  const ok = result.status === 'done' || result.status === 'no_change';
  const run: ExtraLastRun = {
    mk: job.mk,
    ok,
    error: ok ? undefined : result.problems.join('\n') || (result.status === 'aborted' ? '已取消' : result.status),
    prompt: groups.length > 0 ? groups.map(([group, record]) => ({ group, messages: record.prompts! })) : undefined,
    rawReply:
      groups.length === 0
        ? undefined
        : groups.length === 1
          ? groups[0][1].reply
          : groups.map(([group, record]) => `【分组 ${group || '默认'}】\n${record.reply ?? ''}`).join('\n\n'),
    finishedAt: Date.now(),
    status: result.status,
    problems: [...result.problems],
    warnings: [...(result.warnings ?? [])],
  };
  lastRun = run;
  pushHistory({ type: 'update', ..._.cloneDeep(run) });
}

/** 对指定 MK 的消息启动一次解析；同一条消息的上一次解析会被取消。 */
export function startExtra(mk: string, manual = false): Promise<ExtraRunResult> {
  abortExtra(mk);
  const job = {
    id: nextJobId++,
    mk,
    epoch: chatEpoch,
    config: resolveExtraConfig(loadExtraConfig()),
    startedAt: Date.now(),
    signal: { aborted: false },
    generationIds: new Set<string>(),
    groups: new Map(),
    warnings: new Set<string>(),
  } as Job;
  const message_id = findMessageByMk(mk)?.message_id ?? -1;
  jobs.set(mk, job);
  latestJobId.set(mk, job.id);
  job.promise = (async () => {
    emitStatus({ mk, message_id, status: 'started' });
    let result: ExtraResult;
    try {
      result = await runExtra(
        mk,
        job.config,
        {
          generate: (prompts, group, api) => generateOnce(job, prompts, group, api),
          write: (target, blocks) => writeForJob(job, target, blocks),
          onRetry: (_group, problems) => {
            if (latestJobId.get(mk) === job.id && job.epoch === chatEpoch)
              emitStatus({ mk, message_id, status: 'retry', problems });
          },
        },
        job.signal,
      );
    } catch (error: any) {
      logger.error('startExtra', `额外模型解析出错: ${error?.message ?? error}`, error);
      result = {
        status: job.signal.aborted ? 'aborted' : 'failed',
        problems: [String(error?.message ?? error)],
        warnings: [],
      };
    }
    if (job.signal.aborted) result = { ...result, status: 'aborted' };
    if (job.warnings.size > 0) result = { ...result, warnings: _.uniq([...result.warnings, ...job.warnings]) };
    if (jobs.get(mk) === job) jobs.delete(mk);
    // 被同一楼的新一次解析取代时不再报告，否则监听者会在新解析进行中看到“已取消”
    const latest = latestJobId.get(mk) === job.id;
    if (latest) latestJobId.delete(mk);
    // 中途切换了聊天：结果属于旧聊天，不记录、不报告
    if (latest && job.epoch === chatEpoch) {
      recordLastRun(job, result);
      emitStatus({ mk, message_id, status: result.status, problems: result.problems, warnings: result.warnings });
      if (result.status !== 'aborted') notify(result, manual);
    }
    return { mk, ok: result.status === 'done' || result.status === 'no_change', ...result };
  })();
  return job.promise;
}

/**
 * 手动解析指定 MK 的消息，省略时为最后一条 AI 消息；不要求开启分步更新。
 * 找不到消息时抛出异常。
 */
export async function runExtraManually(mk?: string): Promise<ExtraRunResult> {
  let target = mk;
  if (target === undefined) {
    const msg = findLastAiMessage();
    target = msg ? readMessageKey(msg) : '';
    if (!target) throw new Error('没有可以解析的 AI 消息');
    toastr.info('正在请求额外模型更新变量…', '[ERA]');
  } else if (!findMessageByMk(target)) {
    throw new Error(`找不到 MK 为 ${target} 的消息（可能已删除，或不是当前显示的 swipe）`);
  }
  return startExtra(target, true);
}

/**
 * 按自动触发的同样条件解析一楼：没有开启分步更新、是玩家消息、正文自己带有指令时不请求，返回 `null`。
 * 给自己建楼的前端用（脚本建的楼不会触发自动解析）。成功和无变化时不弹提示，与自动解析相同。
 */
export async function runExtraAuto(msg: any): Promise<ExtraRunResult | null> {
  const mk = msg ? readMessageKey(msg) : '';
  if (!mk) throw new Error('这一楼还没有被 ERA 登记（没有 MK），请等同步完成后再解析');
  if (!isExtraEnabled() || isUserMessage(msg) || hasOwnCommands(msg)) return null;
  return startExtra(mk, false);
}

/** 分步更新与正文前规划当前实际生效的开关（已经合并角色卡推荐、默认值，规划在群聊里不生效）。 */
export const getExtraSwitches = (): { update: boolean; plan: boolean } => ({
  update: isExtraEnabled(),
  plan: isPlanEnabled(),
});

/** 一段玩家消息里的规划，对应要注入给剧情模型的那段文字；没有规划摘要时是空字符串。 */
export const planInjectionOf = (text: string): string => {
  const summary = readPlanSummary(String(text ?? ''));
  return summary ? formatPlanInjection(summary) : '';
};

// ============================ 正文前规划（1.8 起） ============================

export interface PlanRunResult extends PlanResult {
  /** 追加了规划块的文本；没有规划结果时是原文（已去掉旧的规划块）。 */
  text: string;
}

let planning: { aborted: boolean } | null = null;
let lastPlan: (PlanRunResult & { at: number }) | null = null;
/** 规划失败后，同样的文字再点一次发送时跳过规划。 */
let skipPlanFor: string | null = null;

/** 当前是否开启正文前规划。群聊不规划。 */
export const isPlanEnabled = (): boolean => resolveExtraConfig().正文前规划 === '开启' && !SillyTavern.groupId;

/** 一次规划的请求记录：最后一次请求的提示词与回复、组织请求时的告警。 */
interface PlanRecord {
  prompts?: { role: string; content: string }[];
  reply?: string;
  warnings: Set<string>;
}

async function requestPlan(
  config: ExtraConfig,
  prompts: { role: string; content: string }[],
  apiIndex: number,
  signal: { aborted: boolean },
  record: PlanRecord = { warnings: new Set() },
): Promise<string> {
  const chain = getApiChain(config, 'plan');
  const api = chain[Math.min(apiIndex, chain.length - 1)];
  const generation_id = `era_plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const warnings: string[] = [];
  const prepared = prepareRequest(prompts as any, config, api, 'plan', '', warnings);
  warnings.forEach(warning => record.warnings.add(warning));
  record.prompts = prepared.prompts.map(({ role, content }) => ({ role, content }));
  record.reply = undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = generateRaw({
      generation_id,
      should_silence: true,
      ...(prepared.should_stream ? { should_stream: true } : {}),
      ordered_prompts: prepared.prompts,
      max_chat_history: 0,
      custom_api: prepared.custom_api as any,
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        stopGenerationById(generation_id);
        reject(Object.assign(new Error(`超过 ${config.超时秒数} 秒没有完成`), { retryable: true }));
      }, config.超时秒数 * 1000);
    });
    const result: any = await Promise.race([request, timeout]);
    if (signal.aborted) throw new Error('已取消');
    const text = typeof result === 'string' ? result : String(result?.content ?? result?.text ?? '');
    record.reply = text;
    if (!text.trim()) throw new Error('返回了空内容');
    return text;
  } catch (error: any) {
    record.reply ??= `（请求失败：${error?.message ?? error}）`;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 为一段玩家文字做正文前规划，返回追加了规划块的文本。不写入任何内容（`Era.extra.plan`）。
 * @param history 规划依据的历史消息，默认是当前聊天的全部消息。
 */
export async function planText(text: string, history?: any[], baseStat?: any, mk = ''): Promise<PlanRunResult> {
  if (planning) planning.aborted = true;
  const signal = { aborted: false };
  planning = signal;
  const epoch = chatEpoch;
  // 重新规划时传进来的是玩家楼的原文，里面的消息密钥不该发给规划模型
  const input = stripPlanBlock(String(text ?? ''))
    .replace(new RegExp(ERA_DATA_REGEX.source, 'g'), '')
    .trimEnd();
  try {
    const config = resolveExtraConfig();
    const messages = history ?? getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
    const record: PlanRecord = { warnings: new Set() };
    const raw = await runPlan(
      input,
      messages,
      config,
      { generate: (prompts, api) => requestPlan(config, prompts, api, signal, record) },
      signal,
      baseStat,
    );
    const result = record.warnings.size > 0 ? { ...raw, warnings: _.uniq([...raw.warnings, ...record.warnings]) } : raw;
    const run: PlanRunResult = {
      ...result,
      text: result.status === 'done' ? appendPlanBlock(input, result.summary, result.blocks) : input,
    };
    // 中途切换了聊天：不把旧聊天的规划记进新聊天
    if (epoch !== chatEpoch) return run;
    lastPlan = { ...run, at: Date.now() };
    // 没有 [era_plan] 条目时没有发出请求，不记录，否则每次发送都会多一条
    if (result.status !== 'no_entries') recordPlan(mk, result, record);
    return run;
  } finally {
    if (planning === signal) planning = null;
  }
}

function recordPlan(mk: string, result: PlanResult, record: PlanRecord): void {
  const ok = result.status === 'done' || result.status === 'no_change';
  pushHistory({
    type: 'plan',
    mk,
    ok,
    status: result.status,
    error: ok ? undefined : result.problems.join('\n') || (result.status === 'aborted' ? '已取消' : result.status),
    prompt: record.prompts ? [{ group: '规划', messages: _.cloneDeep(record.prompts) }] : undefined,
    rawReply: record.reply,
    finishedAt: Date.now(),
    problems: [...result.problems],
    warnings: [...result.warnings],
  });
}

/** 最近一次规划的结果（只在内存中）。 */
export const getLastPlan = () => (lastPlan ? _.cloneDeep(lastPlan) : null);

/**
 * 重新规划最新一条玩家消息，替换其中的 `<era_plan>`；它后面已有 AI 回复时，需要玩家重新生成。
 * 出错时弹出提示，不抛出异常。
 */
export async function replanLatest(): Promise<PlanRunResult | null> {
  try {
    const all: any[] = getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
    const index = _.findLastIndex(all, msg => isUserMessage(msg));
    if (index < 0) throw new Error('没有玩家消息');
    const msg = all[index];
    const mk = readMessageKey(msg);
    if (!mk) throw new Error('这条玩家消息还没有登记，请稍后再试');
    // 依据这条玩家消息之前的变量：最新变量已经计入了它原来的规划和之后的回复
    const before = await getStatBefore(mk);
    if (before === null)
      throw new Error('无法计算这条玩家消息之前的变量（之前的楼层还没有同步完，或日志已折叠又没有存档）');
    toastr.info('正在重新规划…', '[ERA]');
    const result = await planText(getMessageContent(msg) ?? '', all.slice(0, index), before, mk);
    if (result.status === 'aborted') return result;
    if (result.status === 'failed') throw new Error(`规划失败：${result.problems[0] ?? '未知原因'}`);
    if (result.status === 'no_entries') throw new Error('角色卡没有 [era_plan] 条目');
    const { ticket, promise } = createTicket(extraTimings.writeMs);
    pushToQueue(ERA_API_EVENTS.WRITE_EXTRA, { mk, blocks: result.blocks, plan: { summary: result.summary } }, ticket);
    await promise;
    toastr.success(
      index < all.length - 1 ? '已重新规划。这条消息后面已有回复，需要重新生成才会按新的结果写。' : '已重新规划。',
      '[ERA]',
    );
    return result;
  } catch (error: any) {
    toastr.warning(_.escape(String(error?.message ?? error)), '[ERA]');
    return null;
  }
}

/** 发送前规划：返回新的文本，`null` 表示不发送，`undefined` 表示照原样发送。 */
async function planBeforeSend(text: string): Promise<string | null | undefined> {
  toastr.info('正在进行正文前规划…', '[ERA]');
  const result = await planText(text);
  if (result.status === 'done') return result.text;
  if (result.status === 'aborted') return null;
  if (result.status === 'failed') {
    skipPlanFor = stripPlanBlock(text);
    toastr.warning(
      `${_.escape(`正文前规划失败：${result.problems[0] ?? '未知原因'}`)}<br>消息没有发送；再点一次发送将跳过规划直接发送。`,
      '[ERA]',
      { escapeHtml: false },
    );
    return null;
  }
  return result.text === text ? undefined : result.text;
}

/** 这一次发送是否要规划；规划失败后同样的文字再发送一次时跳过。 */
function shouldPlan(text: string): boolean {
  if (!isPlanEnabled() || text.trim() === '') return false;
  if (skipPlanFor !== null && skipPlanFor === stripPlanBlock(text)) {
    skipPlanFor = null;
    return false;
  }
  return true;
}

/**
 * 生成前把这一轮的规划摘要注入提示词：`<era_plan>` 被隐藏正则从提示词里去掉了，剧情模型要靠它知道结算结果。
 * 普通发送时玩家消息还在输入框里；滑动、重新生成、继续时取最新的玩家楼（它后面只能是正在重写的这一条回复）。
 */
export function injectPlanSummary(type: string, dryRun: boolean): void {
  if (dryRun) return;
  // 上一次的注入可能因生成中途失败而残留，每次生成前先撤掉
  uninjectPrompts([PLAN_INJECTION_ID]);
  if (!STORY_TYPES.includes(type)) return;
  const input = type === 'normal' ? readSendTextarea() : '';
  let summary = readPlanSummary(input);
  // 普通发送且输入框有文字时，这一轮的玩家消息就是输入框里的文字：它没有规划块就是没有规划，
  // 不能回退去读最新玩家楼，那是上一轮的摘要
  if (!summary && input.trim() === '') {
    // 滑动、重新生成、继续：最新玩家楼后面只能是正在重写的这一条回复；
    // 输入框为空的普通生成（/trigger、生成失败后再点发送）：最新一条就是玩家楼
    const all: any[] = getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
    const index = _.findLastIndex(all, msg => isUserMessage(msg));
    const limit = type === 'normal' ? all.length - 1 : all.length - 2;
    if (index >= 0 && index >= limit) summary = readPlanSummary(getMessageContent(all[index]) ?? '');
  }
  if (!summary) return;
  // 不用 once：酒馆助手在任何一次生成结束（包括其他脚本的 generateRaw）时就撤销 once 注入，可能早于这次组装提示词。
  // 改为生成结束或停止时撤掉，下一次生成前也会先撤掉
  injectPrompts([
    {
      id: PLAN_INJECTION_ID,
      position: 'in_chat',
      depth: 0,
      role: 'system',
      content: formatPlanInjection(summary),
      should_scan: false,
    },
  ]);
}

const PLAN_INJECTION_ID = 'era_plan';

/** 重新解析最后一条 AI 消息（不要求开启额外模型）。出错时弹出提示，不抛出异常。 */
export async function rerunExtraForLatest(): Promise<ExtraRunResult | null> {
  try {
    return await runExtraManually();
  } catch (error: any) {
    toastr.warning(String(error?.message ?? error), '[ERA]');
    return null;
  }
}

/** 取消解析；不指定 MK 时取消全部。 */
export function abortExtra(mk?: string): void {
  for (const job of [...jobs.values()]) {
    if (mk !== undefined && job.mk !== mk) continue;
    job.signal.aborted = true;
    jobs.delete(job.mk);
    job.cancelWrite?.();
    for (const id of job.generationIds) stopGenerationById(id);
  }
}

/** 正在进行的解析和最近一次结束的解析。 */
export function getExtraStatus(): ExtraStatusSnapshot {
  settlePendingSync();
  return {
    running: [...jobs.values()].map(job => ({
      mk: job.mk,
      startedAt: job.startedAt,
      attempt: Math.max(0, ...[...job.groups.values()].map(record => record.attempt)),
    })),
    last: lastRun && _.cloneDeep(lastRun),
    history: _.cloneDeep(history),
    pendingSync: [...pendingSync],
  };
}

/** 事件队列空闲时，已写入正文的输出都已算完。 */
function settlePendingSync(): void {
  if (pendingSync.size > 0 && isQueueIdle()) pendingSync.clear();
}

/** 楼层已经不存在的解析不必继续。 */
function abortDeadJobs(): void {
  for (const mk of [...jobs.keys()]) {
    if (!findSwipeByMk(mk)) abortExtra(mk);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 只收到回复、还没有开始解析的楼层，最多等这么久让它同步。 */
const SYNC_WAIT_MS = 10_000;

/** 等待最长时间：每个解析都用完全部重试并写入，再留一点余量。 */
const waitLimitMs = (): number =>
  Math.max(estimateRunMs(resolveExtraConfig()), ...[...jobs.values()].map(job => estimateRunMs(job.config))) +
  extraTimings.writeMs * 2 +
  SYNC_WAIT_MS;

/**
 * 等待已收到的回复全部解析完。没有需要等待的解析时立即完成。
 * 时限按重试次数、超时和写入计算；等待期间点击提示框可以不再等待。
 * @returns 全部完成时为 `true`；到了时限或玩家放弃等待时为 `false`。
 */
export async function waitForJobs(): Promise<boolean> {
  abortDeadJobs();
  if (!hasPending()) return true;
  let stopped = false;
  const toast = toastr.info('正在等待变量更新完成…（点击此处不再等待）', '[ERA]', {
    timeOut: 0,
    extendedTimeOut: 0,
    onclick: () => void (stopped = true),
  });
  const timer = setTimeout(() => (stopped = true), waitLimitMs());
  try {
    let idle = 0;
    while (!stopped) {
      if (jobs.size > 0) {
        idle = 0;
        await Promise.race([sleep(100), Promise.allSettled([...jobs.values()].map(job => job.promise))]);
        // 让刚同步的楼层有机会开始解析
        if (jobs.size === 0) await sleep(50);
        continue;
      }
      settlePendingSync();
      if (pendingSync.size > 0) {
        // 写入已到正文、同步还在排队：等它算完（时限由外层的计时器控制）
        await sleep(100);
        continue;
      }
      if (waiting.size === 0) break;
      if (idle * 100 >= SYNC_WAIT_MS) {
        waiting.clear(); // 一直没有被同步的楼层，不能让之后的每次发送都等它
        break;
      }
      idle++;
      await sleep(100);
    }
  } finally {
    clearTimeout(timer);
    toastr.clear(toast);
  }
  settlePendingSync();
  const finished = jobs.size === 0 && pendingSync.size === 0;
  // 放弃等待后不再为这些楼层拦下之后的每一次发送（同 waiting）
  if (!finished) pendingSync.clear();
  return finished;
}

const isWaitingEnabled = (): boolean => resolveExtraConfig().等待方式 === '发送前等待';
const hasPending = (): boolean => {
  settlePendingSync();
  return jobs.size > 0 || waiting.size > 0 || pendingSync.size > 0;
};

/**
 * 正在进行的主生成（玩家触发的、非 dry run 的剧情生成）。由酒馆的 `GENERATION_STARTED` 置上，
 * `GENERATION_ENDED` / `GENERATION_STOPPED` 清除。
 * 世界书加载（`WORLDINFO_ENTRIES_LOADED`）也会由 dry run（统计 token）、quiet 生成、切换聊天时的预加载、
 * 酒馆助手的 generate / generateRaw（含 ERA 自己的分步更新和规划请求）触发，这些都不是主生成：
 * 酒馆助手的生成不发出酒馆的 `GENERATION_STARTED`，不会置上标记。
 *
 * 酒馆的 `Generate` 发出 `GENERATION_STARTED` 后可能提前返回（输入框是斜杠命令、没有连接后端等），
 * 这时既不发 `GENERATION_ENDED` 也不发 `GENERATION_STOPPED`，标记会留下来。因此：输入框是斜杠命令时不置标记；
 * 使用标记时还要求酒馆正处于生成中（见 `isTavernGenerating`）。
 */
let mainGeneration: { type: string; at: number } | null = null;

/**
 * 等待注入规划摘要的那次主生成：`GENERATION_STARTED` 置上，紧随其后的 `GENERATION_AFTER_COMMANDS` 消费。
 * 酒馆助手的 generateRaw 也发出 `GENERATION_AFTER_COMMANDS`（不发 `GENERATION_STARTED`），没有配对的不注入。
 */
let pendingPlanInjection: { at: number } | null = null;

/** `GENERATION_STARTED` 之后超过这么久才到的 `GENERATION_AFTER_COMMANDS` 不算同一次生成。 */
export const PLAN_INJECTION_PAIR_MS = 15_000;

/** 输入框里的文字（酒馆页面的 `#send_textarea`）。 */
function readSendTextarea(): string {
  try {
    return String($('#send_textarea')?.val?.() ?? '');
  } catch {
    return '';
  }
}

/**
 * 酒馆是否正处于生成中：`deactivateSendButtons` 在 `document.body.dataset.generating` 上置 `'true'`，
 * `activateSendButtons` 删除它。它在 `Generate` 处理完斜杠命令、检查过后端连接之后才置上，世界书加载在它之后。
 * 脚本运行在 iframe 里，要读酒馆页面（`window.parent`）的 document。
 */
export function isTavernGenerating(): boolean {
  try {
    const page: Window = window.parent ?? window;
    return page.document?.body?.dataset?.generating === 'true';
  } catch {
    return false;
  }
}

/** 酒馆的 `GENERATION_STARTED`：只有非 dry run 的剧情生成算主生成；输入框是斜杠命令的普通发送不算。 */
export function noteGenerationStarted(type: string, dryRun: boolean): void {
  if (dryRun) return;
  const command = type === 'normal' && readSendTextarea().trim().startsWith('/');
  mainGeneration = STORY_TYPES.includes(type) && !command ? { type, at: Date.now() } : null;
  pendingPlanInjection = mainGeneration && { at: mainGeneration.at };
}

/**
 * 酒馆的 `GENERATION_ENDED` / `GENERATION_STOPPED`。
 * 酒馆助手停止某个生成（包括 ERA 自己的请求超时）时也发出 `GENERATION_STOPPED`，但带着生成 ID（字符串），
 * 那不是主生成结束，不清除标记。
 */
export function noteGenerationEnded(generationId?: unknown): void {
  if (typeof generationId === 'string') return;
  mainGeneration = null;
  pendingPlanInjection = null;
}

/** 当前是否处在主生成中：有标记，并且酒馆正处于生成中。 */
export const isMainGenerating = (): boolean => mainGeneration !== null && isTavernGenerating();

/**
 * 酒馆的 `GENERATION_AFTER_COMMANDS`：只在紧随主生成的 `GENERATION_STARTED` 之后注入规划摘要，配对一次即失效。
 */
export function onGenerationAfterCommands(type: string, dryRun: boolean): void {
  if (dryRun) return;
  const pending = pendingPlanInjection;
  pendingPlanInjection = null;
  if (!pending || Date.now() - pending.at > PLAN_INJECTION_PAIR_MS) return;
  try {
    injectPlanSummary(type, dryRun);
  } catch (error) {
    logger.warn('injectPlanSummary', '注入规划摘要失败', error);
  }
}

/** 酒馆的 `GENERATION_ENDED` / `GENERATION_STOPPED`：撤掉规划摘要；带生成 ID 的停止不是主生成结束，不撤。 */
export function removePlanInjection(generationId?: unknown): void {
  if (typeof generationId === 'string') return;
  uninjectPrompts([PLAN_INJECTION_ID]);
}

/**
 * 每一次世界书加载：移除只发给其他模型的条目——开启额外模型时移除 `[era_update]` 条目，`[era_plan]` 条目总是移除
 * （1.8 起，它们只发给规划模型）。这些模型的提示词由 ERA 自行组织。
 * 条目过滤器只在主生成期间运行（也只有这时等待同步），其余加载不运行、不等待。
 */
export async function filterLores(lores: Record<string, any[]>): Promise<void> {
  removeOtherModelEntries(lores);
  if (!isMainGenerating()) return;
  await applyMainEntryFilters(lores);
}

/** 主生成等待 ERA 同步的最长时间，与提示词里的宏相同。 */
const MAIN_FILTER_SYNC_WAIT = 3000;

/**
 * 条目过滤器也用于主生成（1.8 起）：主生成加载世界书时，按最新变量在内存里选择条目，不写世界书文件。
 * 酒馆为每次加载新建条目列表（`getSortedEntries`），在这里删除条目、修改开关和内容只影响这一次生成。
 * 先等 ERA 算完（例如滑动时的回滚），否则读到的是回滚前的变量。
 *
 * 过滤器返回 `false` 时这次不发送。返回 `true` 或字符串时“纳入”：打开条目、设为常驻（不看关键字）、
 * 关闭概率；但这不保证发送——延迟（delay）、分组、递归设置和上下文预算仍按酒馆的规则生效。
 * 酒馆在这个事件之后才对条目内容算 hash 来记粘性（sticky）与冷却（cooldown）的计时，
 * 改写这类条目会让计时对不上，因此带粘性或冷却的条目只允许排除，纳入或替换内容被忽略并记一条警告。
 */
export async function applyMainEntryFilters(lores: Record<string, any[]>): Promise<void> {
  const active = getActiveEntryFilters();
  if (active.length === 0) return;
  if (!isQueueIdle() && !(await waitForQueueIdle(MAIN_FILTER_SYNC_WAIT))) {
    logger.warn('applyMainEntryFilters', '等待变量同步超时，条目过滤器使用当前的变量');
  }
  const raw = _.cloneDeep(getEraData().stat ?? {});
  const all: any[] = getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
  const recent = all.slice(-resolveExtraConfig().聊天楼层数);
  const last = all[all.length - 1];
  const ctx: EntryFilterContext = {
    stat: unescapeEraData(removeMetaFields(_.cloneDeep(raw))),
    statRaw: raw,
    text: recent.map(msg => getMessageContent(msg) ?? '').join('\n'),
    mk: last ? readMessageKey(last) : '',
    purpose: 'main',
  };
  const warnings: string[] = [];
  for (const list of Object.values(lores ?? {})) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      const entry = {
        ..._.cloneDeep(item),
        world: String(item?.world ?? ''),
        uid: Number(item?.uid),
        name: String(item?.comment ?? ''),
        content: String(item?.content ?? ''),
        enabled: !item?.disable,
      };
      const { decision, content } = applyEntryFilters(entry, ctx, warnings, active);
      if (decision === 'exclude') {
        list.splice(i, 1);
      } else if (decision === 'include') {
        if (hasTimedEffect(item)) {
          warnings.push(
            `条目「${entry.name}」（${entry.world || '?'} #${entry.uid}）带粘性或冷却，主生成中只能排除，纳入或替换内容被忽略`,
          );
          continue;
        }
        item.disable = false;
        item.constant = true;
        item.useProbability = false;
        if (content !== undefined) item.content = content;
      }
    }
  }
  for (const warning of warnings) logger.warn('applyMainEntryFilters', warning);
}

/** 条目带粘性（sticky）或冷却（cooldown）：酒馆按条目的 hash 记它们的计时。 */
const hasTimedEffect = (item: any): boolean => Number(item?.sticky) > 0 || Number(item?.cooldown) > 0;

/**
 * 开启额外模型时移除 `[era_update]` 条目，`[era_plan]` 条目总是移除（只发给规划模型）。
 */
function removeOtherModelEntries(lores: Record<string, any[]>): void {
  const extra = isExtraEnabled();
  const names = getExtraWorldbookNames();
  for (const list of Object.values(lores ?? {})) {
    if (!Array.isArray(list)) continue;
    _.remove(list, entry => {
      const tag = parseEntryTag(String(entry?.comment ?? ''));
      if (tag.both || !(tag.plan || (extra && tag.update))) return false;
      // 其他模型读不到的世界书不能移除，否则谁都看不到
      return entry.world === undefined || names.includes(entry.world);
    });
  }
}

const getMessage = (message_id: number): any => {
  try {
    // 等待中的楼层可能已被删除：不能用 getChatMessages(楼层号)，它会把越界的楼层号夹到末楼
    return getMessageAt(message_id);
  } catch {
    return undefined;
  }
};

/** 某条消息的全部 swipe 的 MK。 */
const getSwipeMks = (msg: any): string[] =>
  _.compact((msg?.swipes ?? []).map((text: string) => readMessageKey({ ...msg, mes: text ?? '' })));

$(() => {
  loadExtraConfig();

  eventOn(tavern_events.WORLDINFO_ENTRIES_LOADED, filterLores as any);

  eventOn(tavern_events.MESSAGE_RECEIVED, (message_id: number, type?: string) => {
    if (isExtraEnabled() && type !== undefined && STORY_TYPES.includes(type)) waiting.add(Number(message_id));
  });

  eventOn(ERA_EVENT_EMITTER.WRITE_DONE, (payload: WriteDonePayload) => {
    settlePendingSync();
    // 同步事件会合并，报告的总是最后一楼，因此每次都检查全部等待中的楼层
    for (const message_id of [...waiting]) {
      const msg = getMessage(message_id);
      const mk = msg ? readMessageKey(msg) : '';
      if (msg && (!mk || !payload.selectedMks.includes(mk))) continue; // 还没有计算，等下一次
      waiting.delete(message_id);
      // 剧情模型自己已经输出了指令时，不再重复更新
      if (!mk || !isExtraEnabled() || isUserMessage(msg) || hasOwnCommands(msg)) continue;
      startExtra(mk);
    }
  });

  // 这里只取消、不等待：此时酒馆已进入生成流程却没有锁定界面，暂停它会造成重复生成、串聊天等问题
  eventOn(tavern_events.GENERATION_STARTED, (type: string, _option: any, dry_run: boolean) => {
    noteGenerationStarted(type, dry_run);
    if (dry_run) return;
    const replace = REPLACE_TYPES.includes(type);
    if (!replace && !CONTINUE_TYPES.includes(type)) return;
    // 最后一条回复即将被换掉或改写，它的解析不必继续，否则结果可能写进正在流式输出的正文；
    // 继续完成后会重新解析。更早的楼层不受影响
    const last = getMessage(-1);
    if (!last || isUserMessage(last)) return;
    waiting.delete(last.message_id);
    for (const mk of replace ? getSwipeMks(last) : _.compact([readMessageKey(last)])) abortExtra(mk);
  });

  const removeSendGuard = installSendGuard({
    shouldHold: () => isWaitingEnabled() && hasPending(),
    wait: waitForJobs,
    shouldPlan,
    plan: planBeforeSend,
  });

  // 酒馆助手的 generateRaw（其他脚本、ERA 自己的请求）也会发出这个事件，那不是主生成，不注入
  eventOn(tavern_events.GENERATION_AFTER_COMMANDS, ((type: string, _option: any, dry_run: boolean) =>
    onGenerationAfterCommands(type, dry_run)) as any);
  eventOn(tavern_events.GENERATION_ENDED, () => removePlanInjection());
  eventOn(tavern_events.GENERATION_STOPPED, ((id?: unknown) => removePlanInjection(id)) as any);
  eventOn(tavern_events.GENERATION_ENDED, () => noteGenerationEnded());
  eventOn(tavern_events.GENERATION_STOPPED, ((id?: unknown) => noteGenerationEnded(id)) as any);

  eventOn(tavern_events.MESSAGE_DELETED, (length: number) => {
    for (const message_id of [...waiting]) if (message_id >= Number(length)) waiting.delete(message_id);
    abortDeadJobs();
  });

  let chatId = SillyTavern.getCurrentChatId?.();
  eventOn(tavern_events.CHAT_CHANGED, () => {
    const next = SillyTavern.getCurrentChatId?.();
    if (next === chatId) return;
    chatId = next;
    chatEpoch++;
    mainGeneration = null;
    pendingPlanInjection = null;
    waiting.clear();
    pendingSync.clear();
    lastRun = null;
    history = [];
    lastPlan = null;
    skipPlanFor = null;
    if (planning) planning.aborted = true;
    abortExtra();
  });

  $(window).on('pagehide', () => {
    abortExtra();
    removeSendGuard();
  });
});
