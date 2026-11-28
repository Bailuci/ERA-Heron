/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；请求失败时退避重试，不重试鉴权、参数错误，换用备用接口；按实测的 generateRaw 错误（只有状态文字）识别鉴权和参数错误；先算目标楼状态再选择和渲染条目，新增 warnings
 *       2026-11-27 “已执行的更新”按当前聊天的解析方式取真正会执行的指令块，与 hasOwnCommands 和同步一致；额外模型输出按“思考标签”设置遮蔽
 *       2026-11-28 问题说明改用 describeIssue
 *       2026-11-28 各组的输出合在一起再试算一次
 *       2026-11-28 “已执行的更新”一并列出挂在这一楼上的旁路写入
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 额外模型的一次解析
 * @description
 * 请求模型、校验输出、按需重试，最后把指令写回目标楼层。
 * 与模型和酒馆的交互由参数传入，因此可以单独测试。
 */
'use strict';

import { createExtraSimulator, findMessageByMk, findSwipeByMk } from '../core/simulate';
import { Logger } from '../utils/log';
import { describeApiOps } from '../core/api_ops';
import { describeIssue } from '../core/crud/diagnostics';
import { extractCommandBlocks, extractExecutedBlocks, getMessageContent, stripExtraBlock } from '../utils/message';
import { ExtraConfig } from './config';
import { buildExtraPrompts, collectExtraEntries, EJS_RENDER_BUDGET_MS, getGroups } from './prompt';

const logger = new Logger();

export interface ExtraDeps {
  /**
   * 请求模型。`signal.aborted` 为真时应尽快抛出异常。
   * @param api 使用第几个接口：0 是主接口，之后依次是备用接口。
   */
  generate(prompts: { role: string; content: string }[], group: string, api: number): Promise<string>;
  /** 把指令写到指定 MK 的消息中，生效后完成。 */
  write(mk: string, blocks: string): Promise<void>;
  onRetry?(group: string, problems: string[]): void;
  /** 重试前的等待；默认使用计时器，可以被 `signal` 中止。 */
  sleep?(ms: number, signal: { aborted: boolean }): Promise<void>;
}

export interface ExtraResult {
  status: 'done' | 'no_entries' | 'no_change' | 'aborted' | 'failed';
  /** 最终没有解决的问题。 */
  problems: string[];
  /**
   * 不影响结果判定的告警：条目过滤器出错、EJS 渲染出错或超时、写函数被调用、取不到目标楼之前的状态等。
   * 与 `problems` 分开：`problems` 会让“保留有效部分”模式把结果判成失败。
   */
  warnings: string[];
}

interface GroupOutput {
  blocks: string;
  problems: string[];
}

/** 请求失败后第 n 次（从 0 开始）退避等待的毫秒数：2、4、8…秒，最多 30 秒。 */
export const retryDelay = (n: number): number => Math.min(2000 * 2 ** n, 30000);

/**
 * HTTP 的状态文字。酒馆助手的 `generateRaw` 走自定义接口或代理预设时，接口返回 4xx、5xx 只抛出
 * `new Error(response.statusText)`，既没有状态码也没有数字（实测：401 为 `Unauthorized`、400 为 `Bad Request`）。
 */
const STATUS_TEXTS: Record<string, number> = {
  'bad request': 400,
  unauthorized: 401,
  'payment required': 402,
  forbidden: 403,
  'not found': 404,
  'method not allowed': 405,
  'not acceptable': 406,
  'request timeout': 408,
  conflict: 409,
  gone: 410,
  'payload too large': 413,
  'content too large': 413,
  'unprocessable entity': 422,
  'unprocessable content': 422,
  'too early': 425,
  'too many requests': 429,
  'internal server error': 500,
  'bad gateway': 502,
  'service unavailable': 503,
  'gateway timeout': 504,
};

/** 错误对象里的 HTTP 状态码：先看 `status` 等字段，再从消息里找三位数，最后按整条消息是否是状态文字判断；都没有时为 0。 */
export function getErrorStatus(error: any): number {
  const status = Number(error?.status ?? error?.response?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 100) return status;
  const message = String(error?.message ?? error ?? '');
  const digits = /(?<![\d.])([45]\d\d)(?![\d.])/.exec(message)?.[1];
  if (digits) return Number(digits);
  return (
    STATUS_TEXTS[
      message
        .trim()
        .replace(/^error:\s*/i, '')
        .toLowerCase()
    ] ?? 0
  );
}

/**
 * 请求失败是否值得重试。超时、限流（429）、服务器错误（5xx）、网络错误可以重试；
 * 鉴权、参数等其他 4xx 错误重试也不会成功。错误对象可以用 `retryable` 明确指定。
 */
export function isRetryableError(error: any): boolean {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const code = getErrorStatus(error);
  if (code < 400) return true; // 没有状态码：多半是网络错误
  return code >= 500 || [408, 409, 425, 429].includes(code);
}

/** 可以被中止的等待。 */
function pause(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise(resolve => {
    let left = ms;
    const tick = () => {
      if (signal.aborted || left <= 0) return resolve();
      const step = Math.min(left, 100);
      left -= step;
      setTimeout(tick, step);
    };
    tick();
  });
}

/** 一个分组最多发出的请求数：首次、每次重试，以及每个备用接口各一次。 */
export const maxRequests = (config: ExtraConfig): number => config.重试次数 + 1 + config.备用接口.length;

/** 一次解析最长可能持续的毫秒数（不含写入）：渲染条目用完时限，每次请求都超时，并且每次重试前都退避。 */
export function estimateRunMs(config: ExtraConfig): number {
  let total = maxRequests(config) * config.超时秒数 * 1000;
  if (config.EJS预处理 === '自动') total += EJS_RENDER_BUDGET_MS;
  for (let n = 0; n < config.重试次数; n++) total += retryDelay(n);
  return total;
}

async function runGroup(
  base: Parameters<typeof buildExtraPrompts>[0],
  check: (blocks: string) => Promise<{ path: string; reason: string }[]>,
  deps: ExtraDeps,
  signal: { aborted: boolean },
): Promise<GroupOutput> {
  let feedback: { output: string; problems: string[] } | undefined;
  // 重试不一定更好：保留问题最少的一次有指令的输出
  let best: GroupOutput | undefined;
  let problems: string[] = [];
  const apiCount = 1 + base.config.备用接口.length;
  let api = 0;
  let retries = 0;
  /** 连续请求失败的次数，决定退避时间。 */
  let failures = 0;

  for (let first = true; !signal.aborted; first = false) {
    if (!first) deps.onRetry?.(base.group, problems);
    try {
      const output = await deps.generate(buildExtraPrompts({ ...base, feedback }), base.group, api);
      failures = 0;
      const extracted = extractCommandBlocks(output);
      if (!extracted.hasCommands && !extracted.truncated && extracted.hasThink) return { blocks: '', problems: [] };

      problems = [];
      if (extracted.truncated) problems.push('有指令块没有闭合，输出可能被截断');
      if (extracted.hasCommands) {
        problems.push(...(await check(extracted.text)).map(describeIssue));
        if (!best || problems.length < best.problems.length) best = { blocks: extracted.text, problems };
        if (problems.length === 0) return best;
      } else if (!extracted.truncated) {
        problems.push('没有输出任何指令块；如果没有变化，请只输出 <VariableThink>无变化</VariableThink>');
      }
      feedback = { output, problems };
    } catch (error: any) {
      if (signal.aborted) break;
      // 请求本身失败：重试时仍附带更早一次的输出和问题
      problems = [`请求失败: ${error?.message ?? error}`];
      logger.warn('runGroup', problems[0]);
      // 还有备用接口时立即换用，不占重试次数
      if (api < apiCount - 1) {
        api++;
        continue;
      }
      if (!isRetryableError(error) || retries >= base.config.重试次数) break;
      retries++;
      await (deps.sleep ?? pause)(retryDelay(failures++), signal);
      continue;
    }
    if (retries >= base.config.重试次数) break;
    retries++;
  }
  return best ?? { blocks: '', problems };
}

/**
 * 对指定 MK 的消息执行一次解析。
 * @param signal 外部中止信号；中止后不会写入任何内容。
 */
export async function runExtra(
  mk: string,
  config: ExtraConfig,
  deps: ExtraDeps,
  signal: { aborted: boolean },
): Promise<ExtraResult> {
  const msg = findMessageByMk(mk);
  const warnings: string[] = [];
  const end = (status: ExtraResult['status'], problems: string[] = []): ExtraResult => ({
    status,
    problems,
    warnings,
  });
  if (!msg) return end('aborted');
  const all: any[] = getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
  const messages = all.filter(item => item.message_id <= msg.message_id);
  const scanText = messages
    .slice(-config.聊天楼层数)
    .map(item => getMessageContent(item) ?? '')
    .join('\n');

  // 先算目标楼的状态，条目的选择和渲染都按它进行，而不是按最新状态
  const { stat, check, fallback } = await createExtraSimulator(msg);
  if (fallback) {
    warnings.push('无法计算该楼之前的状态（之前的楼层还没有同步完，或日志已折叠又没有存档），使用的是最新状态');
  }
  if (signal.aborted) return end('aborted');
  const entries = await collectExtraEntries(scanText, {
    mk,
    stat,
    ejs: config.EJS预处理 === '自动',
    warnings,
  });
  if (signal.aborted) return end('aborted');
  if (entries.length === 0) return end('no_entries');
  // 只列出真正执行了的指令：新聊天里思考块中的、外层标签外的指令没有执行，不能告诉模型“已经计入”
  // 界面挂在这一楼上的写入（`Era.commit`、`Era.applyText`）同样已经计入变量：一起列出，否则更新模型会照着剧情再扣一次
  const executed = _.compact([
    extractExecutedBlocks(stripExtraBlock(getMessageContent(msg) ?? '')),
    describeApiOps(mk),
  ]).join('\n');

  // 各分组互不依赖，同时请求；写入时按分组名的顺序拼接，结果与返回的先后无关
  const outputs = await Promise.all(
    getGroups(entries).map(group =>
      runGroup({ messages, entries, group, stat, executed, config }, check, deps, signal),
    ),
  );
  // 等待期间该楼可能已被删除，或切换了聊天；只是滑到了别的 swipe 时，结果仍写到原来那一条
  if (signal.aborted || !findSwipeByMk(mk)) return end('aborted');

  const problems = outputs.flatMap(output => output.problems);
  // 各组是分别试算的；合在一起才会暴露的问题（两组插入同一个路径、两组各扣一次超过了下限）要再查一遍
  const produced = outputs.filter(output => output.blocks);
  if (produced.length > 1 && problems.length === 0) {
    const joint = await check(produced.map(output => output.blocks).join('\n'));
    if (signal.aborted || !findSwipeByMk(mk)) return end('aborted');
    problems.push(...joint.map(issue => `分组之间有冲突：${describeIssue(issue)}`));
  }
  const blocks = outputs
    .filter(output => output.blocks && (config.失败处理 === '保留有效部分' || problems.length === 0))
    .map(output => output.blocks)
    .join('\n');
  if (!blocks) {
    if (problems.length > 0) {
      logger.warn('runExtra', '额外模型没有给出可用的变量更新', problems);
      return end('failed', problems);
    }
    // 重新解析的结果可能是“无变化”，此时也要清除上一次的输出
    await deps.write(mk, '');
    return end('no_change', problems);
  }
  await deps.write(mk, blocks);
  return end('done', problems);
}
