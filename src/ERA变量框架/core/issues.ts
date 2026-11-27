/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：读取最新 AI 楼没有生效的指令与原因（供 /era-issues 命令），按路径读取去掉 $meta 的变量（供 /era-get 命令）
 *       2026-11-27 与 {{ERA-issues}} 统一数据源：先读同步时记下的最新 AI 楼报告（core/latest_report.ts），没有报告时再从上一楼的状态重算；可输出给主模型的格式
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 指令问题与变量读取
 * @description
 * `/era-issues` 与 `{{ERA-issues}}` 用同一份数据：同步时记下的最新 AI 楼报告（`core/latest_report.ts`），
 * “最新 AI 楼”的判断也相同（`findLatestAiMessage`）。报告只在内存里，刷新页面后、下一次同步之前可能没有，
 * 这时 `/era-issues` 从上一楼的状态重算这一楼（与同步的结果一致）；`{{ERA-issues}}` 在提示词里同步替换，不能等待重算，
 * 没有报告时按没有问题处理。两者都是可以从正文重建的缓存，不是源数据。
 *
 * 两者的范围不同：`/era-issues` 给人看，列出这一楼的全部问题（含旁路写入、钩子、额外模型的输出，带 `origin` / `source`）；
 * `{{ERA-issues}}`（以及 `/era-issues format=model`）只列主模型自己写在正文里的指令，见 `issuesForModel`。
 */
'use strict';

import { getByRawKeys } from '../macro/parse';
import { unescapeEraData } from '../utils/data';
import { getEraData, removeMetaFields } from '../utils/era_data';
import { readMessageKey } from './key/mk';
import {
  buildFloorReport,
  findLatestAiMessage,
  FloorReport,
  formatIssuesForModel,
  getLatestReport,
  issuesForModel,
} from './latest_report';
import { computeFloorIssues, SimulateProblem } from './simulate';

export interface LatestIssues {
  /** 最新 AI 楼的消息 ID；聊天里没有 AI 消息时为 `null`。 */
  message_id: number | null;
  mk: string | null;
  /** 没有生效的指令（先列指令本身的问题，再列被变量结构拦截的修改）。 */
  problems: SimulateProblem[];
  /** 无法计算时的原因（例如该楼之前的日志已经折叠且存档缺失、还没有同步过）；能计算时没有。 */
  unavailable?: string;
}

/** 最新 AI 楼的报告，以及它在 `LatestIssues` 中的形式。 */
interface LatestFloor extends LatestIssues {
  report: FloorReport | null;
}

const toProblem = ({ path, reason, origin, source }: FloorReport['issues'][number]): SimulateProblem => ({
  path,
  reason,
  origin,
  ...(source === undefined ? {} : { source }),
});

/**
 * 最新 AI 楼的报告：先取同步时记下的报告，没有时从上一楼的状态重算。
 * 调用前应等待事件队列空闲，否则可能读到同步到一半的状态。
 */
async function collectLatestFloor(): Promise<LatestFloor> {
  const latest = findLatestAiMessage();
  if (!latest) return { message_id: null, mk: null, problems: [], report: null };
  const { message_id, mk } = latest;
  if (!mk) return { message_id, mk, problems: [], report: null, unavailable: '该楼还没有同步过' };
  let report = getLatestReport();
  if (report?.mk !== mk) {
    const msg = getChatMessages(message_id, { include_swipes: true })?.[0];
    const computed = msg && readMessageKey(msg) === mk ? await computeFloorIssues(msg) : null;
    if (!computed) return { message_id, mk, problems: [], report: null, unavailable: '无法还原该楼之前的变量' };
    report = buildFloorReport(
      SillyTavern.getCurrentChatId?.(),
      mk,
      message_id,
      computed.commandIssues,
      computed.schemaRejections,
    );
  }
  return { message_id, mk, problems: report.issues.map(toProblem), report };
}

/** 读取最新 AI 楼没有生效的指令与原因（全部来源）。调用前应等待事件队列空闲。 */
export async function collectLatestIssues(): Promise<LatestIssues> {
  return _.omit(await collectLatestFloor(), 'report');
}

/**
 * 最新 AI 楼中主模型自己写错的指令，格式与 `{{ERA-issues}}` 相同；没有问题时为空串。
 * 与宏的区别只在没有报告时：这里会重算，宏按没有问题处理。
 */
export async function describeLatestIssuesForModel(): Promise<string> {
  return formatIssuesForModel(issuesForModel((await collectLatestFloor()).report));
}

/** 把问题写成给人看的文字，每条一行（`- 路径：原因`）；没有问题时为空串。给主模型的格式见 `describeLatestIssuesForModel`。 */
export function formatIssues(issues: LatestIssues): string {
  if (issues.problems.length === 0) return '';
  return issues.problems.map(problem => `- ${problem.path || '（根）'}：${problem.reason}`).join('\n');
}

/**
 * 按路径读取当前变量（已反转义）。路径规则与 `{{ERA:路径}}` 宏一致；空路径或 `$ALLDATA` 表示全部变量。
 * @param withMeta 为 `true` 时保留 `$meta` 等以 `$` 开头的键，与 `{{ERA-withmeta:路径}}` 一致。
 * @returns 找不到时返回 `undefined`。
 */
export function readEraValue(path: string, withMeta = false): unknown {
  const { stat } = getEraData();
  const data = unescapeEraData(withMeta ? stat : removeMetaFields(stat));
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '$ALLDATA') return data;
  return _.get(data, trimmed) ?? getByRawKeys(data, trimmed);
}
