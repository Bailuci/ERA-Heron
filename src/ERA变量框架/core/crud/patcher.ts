/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增可选的变量结构 schema 校验与全局接口 Era；修复 schema 校验在审查与实测中发现的问题；修复 update 日志记录过期旧值导致的回滚错误；新增更新钩子 Era.onBeforeApply / Era.onAfterApply等；表达式 $expr 的上下文与随机数种子
 *       2026-11-26 按聊天的解析版本解析正文（新聊天遮蔽思考块、可只认指令外层标签内的指令）
 *       2026-11-27 问题与拦截记录带上指令的来源标记 source（额外模型输出、旁路写入），只用于报告；执行工具调用 <EraFCall>，表达式可调用自定义公式函数
 *       2026-11-27 按聊天的解析版本把保护规则传给各指令
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 变量写入模块
 * @description
 * 该模块是 ERA 框架的“执行引擎”，负责将消息内容中的变量修改指令应用到实际的 `chat` 变量中。
 *
 * **设计理念**:
 * 变量的写入是一个严谨的过程，必须确保所有变更都被正确记录，以便后续的回滚和同步。
 * 此模块的核心职责是：
 * 1. **解析指令**: 从 AI 消息中提取 `<VariableInsert>` 和 `<VariableEdit>` 块。
 * 2. **顺序执行**: 确保同一消息内的多个指令块按顺序执行，且后续指令能感知到前面指令的结果。
 * 3. **生成日志**: 在应用变更的同时，调用 `recursive.ts` 中的递归函数来生成精确的 `EditLog`。
 * 4. **覆盖式日志写入**: 确保每个消息密钥（MK）对应的 `EditLog` 严格反映其当前内容，
 *    即使内容中没有任何指令（此时会写入空日志），也要覆盖旧日志，这是防止 `swipe` 造成数据污染的关键。
 *
 * **职责边界**:
 * - 本模块**只负责读取 MK**，不负责创建。创建 MK 的职责由上游的 `message_key.ts` 承担。
 * - `ApplyVarChangeForMessage` 函数**只负责写入变量和 `EditLog`**，不负责更新 `SelectedMks`。
 *   更新 `SelectedMks` 的职责被移交给了更上层的调用者（如 `ApplyVarChange` 或同步函数），
 *   以避免在同步循环中修改正在被读取的状态，这是一种重要的并发控制策略。
 */

'use strict';

import { getActiveHooks, reportHookError } from '../../api/hook_registry';
import { createExprFnResolver } from '../../api/tool_registry';
import { getActiveSchema } from '../../api/schema_registry';
import { readMessageKey } from '../../core/key/mk';
import { API_OPS_PATH, EraConfig } from '../../utils/constants';
import { settings } from '../../utils/era_data';
import { Logger } from '../../utils/log';
import { EraCommand, extractAndParseCommands, isUserMessage } from '../../utils/message';
import { processDeleteBlocks } from './delete';
import { processInsertBlocks } from './insert/insert';
import { interleaveApiOps } from '../api_ops';
import { getParseOptions, isStrictProtection } from '../version';
import { runAfterApplyHook, runBeforeApplyHook } from '../hooks';
import { runToolCall, TOOL_MAX_CALLS_PER_FLOOR, ToolCallResult } from '../tools';
import { applySchemaToBlock, normalizeStat, SchemaCheckResult, SchemaRejection } from '../schema';
import { CommandIssue } from './diagnostics';
import { processPatchBlocks } from './patch';
import { EditExprContext, processEditBlocks } from './update';

const logger = new Logger();

/**
 * 为一条消息创建表达式 `$expr` 的种子分配器。
 * - 正文指令：`${mk}|expr|${路径}|${该路径在本楼正文中的出现次数}`，失败的表达式也占一次；
 * - 旁路写入与钩子新建的指令有稳定身份 `exprId`（见 `EraCommand.exprId`）：`${mk}|expr|${exprId}|${路径}|${指令内出现次数}`。
 * 这样编辑前面的指令不会让后面路径的骰点整体平移，撤销或压缩旁路写入也不会让正文的骰点改变。
 */
function createExprContexts(mk: string | null, oldStat: any): (command: EraCommand) => EditExprContext {
  const textOccurrences = new Map<string, number>();
  // 自定义公式函数：每楼取一次当前注册的函数
  const resolveFn = createExprFnResolver();
  const take = (counter: Map<string, number>, path: string): number => {
    const n = counter.get(path) ?? 0;
    counter.set(path, n + 1);
    return n;
  };
  return command => {
    const prefix = command.exprId === undefined ? `${mk ?? ''}|expr|` : `${mk ?? ''}|expr|${command.exprId}|`;
    const counter = command.exprId === undefined ? textOccurrences : new Map<string, number>();
    return { oldStat, seedFor: path => `${prefix}${path}|${take(counter, path)}`, resolveFn };
  };
}

/**
 * 执行 `<VariablePatch>`，并用 schema 检查结果。整体不合法时以**操作**为单位取舍，而不是以日志条目为单位：
 * 移动由删除和插入两条日志组成，只接受其中一条会丢数据；数组的每条日志都是整个数组，会带上之前被拒绝的元素。
 */
async function runPatchCommand(
  data: any[],
  stat: any,
  issues: CommandIssue[],
  allowReadonly: boolean,
  strict: boolean,
): Promise<SchemaCheckResult> {
  const active = getActiveSchema();
  const wholeIssues: CommandIssue[] = [];
  const whole = await processPatchBlocks(data, stat, wholeIssues, allowReadonly, strict);
  const check: SchemaCheckResult =
    active && whole.editLog.length > 0
      ? applySchemaToBlock(active.schema, stat, whole.finalStat, whole.editLog, active)
      : { ...whole, rejections: [], normalizedCount: 0 };
  if (!active || check.rejections.length === 0) {
    issues.push(...wholeIssues);
    return check;
  }

  let currentStat = stat;
  const editLog: any[] = [];
  let pending: { op: any; rejections: SchemaRejection[] }[] = _.flattenDeep(data).map(op => ({ op, rejections: [] }));
  let first = true;
  // 只有被 schema 拒绝的操作会在其他操作生效后重试（理由同 applySchemaToBlock）；
  // 其余的操作各执行一次，否则会打乱顺序
  for (let progress = true; progress && pending.length > 0; first = false) {
    progress = false;
    const rest: typeof pending = [];
    for (const { op, rejections } of pending) {
      const result = await processPatchBlocks([op], currentStat, first ? issues : [], allowReadonly, strict);
      if (result.editLog.length === 0) {
        if (!first) rest.push({ op, rejections });
        continue;
      }
      const trial = applySchemaToBlock(active.schema, currentStat, result.finalStat, result.editLog, active);
      if (trial.rejections.length > 0) {
        rest.push({ op, rejections: trial.rejections });
        continue;
      }
      currentStat = trial.finalStat;
      editLog.push(...trial.editLog);
      progress = true;
    }
    pending = rest;
  }
  return {
    ...check,
    finalStat: currentStat,
    editLog,
    rejections: pending.flatMap(item => item.rejections.slice(0, 1)),
  };
}

/**
 * **【核心计算函数 - 纯粹】**
 *
 * **设计理念**:
 * 这是一个纯函数，是整个变量修改流程的计算核心。它遵循“输入决定输出”的原则，不执行任何读写全局状态的副作用。
 * 它的职责非常单一：接收一条消息和当前的状态，然后计算出这条消息会如何改变这个状态，并返回最终结果。
 *
 * **调用者职责**:
 * 调用此函数的外部代码（如 `ApplyVarChange` 或 `resyncStateOnHistoryChange`）必须负责：
 * 1. **准备输入**: 在调用前，获取有效的消息对象 `msg`、初始状态 `initialStat` 和元数据 `meta`。
 * 2. **处理输出**: 接收函数返回的 `{ finalStat, finalEditLog }`，并负责将这些结果写入到全局状态中
 *    （例如，通过 `updateEraStatData` 和 `updateEraMetaData`）。
 *
 * @param {any} msg - 要处理的酒馆消息对象。
 * @param {any} initialStat - 操作开始前的 `stat_data`。
 * @param {any} meta - 包含 `EditLogs` 和 `SelectedMks` 的元数据对象。
 * @returns {Promise<{ finalStat: any; finalEditLog: any[] }>} 返回计算出的最终状态和为该消息生成的 EditLog。
 *   如果注册了变量结构 schema，`schemaRejections` 中会列出被 schema 拦截的修改。
 */
export const ApplyVarChangeForMessage = async (
  msg: any,
  initialStat: any,
  meta: any,
  config: Partial<EraConfig> = {},
  /** 由调用方确保过的 MK。消息刚被注入 MK 时 `msg` 里还读不到，必须由调用方传入。 */
  ensuredMk?: string,
): Promise<{
  finalStat: any;
  finalEditLog: any[];
  mk: string | null;
  schemaRejections: SchemaRejection[];
  commandIssues: CommandIssue[];
  /** 本楼的工具调用结果，按执行顺序。 */
  toolResults: ToolCallResult[];
}> => {
  logger.debug('ApplyVarChangeForMessage (Pure)', `开始计算消息 (ID: ${msg.message_id})...`);
  const mk = ensuredMk || readMessageKey(msg);
  logger.debug('ApplyVarChangeForMessage (Pure)', `获取到当前消息mk`, mk);
  try {
    logger.debug('ApplyVarChangeForMessage (Pure)', `开始提取并解析指令...`);
    const commandIssues: CommandIssue[] = [];
    // 保护规则按聊天的解析版本决定：旧聊天重算时结果不变
    const strict = isStrictProtection(meta);
    // 1. 从消息中提取、解析并转义所有指令，得到一个按顺序排列的指令数组。
    //    旁路 API 写入在这里与正文指令合并，之后的流程（钩子、schema、日志）不区分两者。
    let commands: EraCommand[] = interleaveApiOps(
      extractAndParseCommands(msg, config.繁体转简体, commandIssues, getParseOptions(meta)),
      mk ? _.get(meta, [API_OPS_PATH, mk]) : undefined,
    );
    let lastApiEntry: any = null;

    // 钩子只对非用户消息执行：用户消息平时只登记 MK、不参与计算，只有重算时才会经过这里，
    // 在用户消息上执行钩子会让重算的结果与首次不同。
    const allowHooks = !isUserMessage(msg);
    for (const hook of allowHooks ? getActiveHooks('before') : []) {
      const result = runBeforeApplyHook(hook, commands, initialStat, mk);
      if (result.error) reportHookError(hook, result.error);
      commands = result.commands;
    }

    let currentStat = initialStat;
    const accumulatedLogs: any[] = [];
    // `@路径` 读的是本楼开始前的值：早于本楼所有旁路写入，也早于本楼的 schema 默认值补全
    const exprContextFor = createExprContexts(mk, initialStat);

    // 变量结构 schema 是可选的；未注册时以下与 schema 相关的逻辑全部跳过。
    const activeSchema = getActiveSchema();
    const schemaRejections: SchemaRejection[] = [];
    const reportSchemaSkip = (check: SchemaCheckResult) => {
      if (check.skipped === 'schema_error') {
        logger.error(
          'ApplyVarChangeForMessage (Pure)',
          `变量结构 schema 执行出错，本次未做校验: ${check.skippedMessage}`,
        );
      } else if (check.skipped === 'pre_invalid') {
        logger.debug(
          'ApplyVarChangeForMessage (Pure)',
          `修改前的变量本就不符合 schema，本次修改全部放行: ${check.skippedMessage}`,
        );
      }
    };

    /**
     * 用 schema 对当前状态做一次完整纠正（包括补全默认值），并把产生的日志并入本条消息。
     * 变量为空（只有 ERA 保留字段也算空）时默认跳过：此时变量通常还没被开场白初始化，
     * 提前写入默认值会导致之后的 <VariableInsert> 因路径已存在而被忽略。
     * 完全依靠 schema 默认值来初始化变量的角色卡，可以在注册时开启 `fillDefaultsOnEmpty`。
     */
    const isStatEmpty = () => _.isEmpty(_.omit(currentStat, ['$meta', '$template']));
    const normalizeWithSchema = () => {
      if (!activeSchema) return;
      if (isStatEmpty() && !activeSchema.fillDefaultsOnEmpty) return;
      const check = normalizeStat(activeSchema.schema, currentStat, activeSchema);
      reportSchemaSkip(check);
      currentStat = check.finalStat;
      accumulatedLogs.push(...check.editLog);
    };

    logger.debug('ApplyVarChangeForMessage (Pure)', '开始按顺序处理指令...', commands);

    // 2. 按顺序处理指令。工具调用产出的操作紧接着它执行，看到的是执行到这里时的变量。
    const toolResults: ToolCallResult[] = [];
    let toolCalls = 0;
    const runCall = async (command: EraCommand): Promise<void> => {
      const call = command.data[0] ?? {};
      const fail = (reason: string): void => {
        commandIssues.push({
          type: 'call',
          path: String(call.name ?? ''),
          reason,
          origin: command.origin ?? 'text',
          ...(command.source ? { source: command.source } : {}),
        });
      };
      // 用户消息平时不参与计算，与钩子相同，不执行工具
      if (!allowHooks) return fail('用户消息里的工具调用不执行');
      if (++toolCalls > TOOL_MAX_CALLS_PER_FLOOR) return fail(`每楼最多执行 ${TOOL_MAX_CALLS_PER_FLOOR} 次工具调用`);
      // 旁路写入与钩子新建的调用有稳定身份 exprId；正文调用按块序号（钩子改写指令时也保留）
      const seed =
        command.exprId !== undefined
          ? `${mk ?? ''}|tool|${command.exprId}`
          : `${mk ?? ''}|tool|text|${call.name}|${command.block ?? `n${toolCalls}`}`;
      const { commands: produced, result } = runToolCall(
        call,
        currentStat,
        initialStat,
        mk ?? '',
        seed,
        command.source,
      );
      toolResults.push(result);
      if (!result.ok) return fail(result.error ?? '工具执行失败');
      for (const sub of produced) await applyCommand(sub);
    };
    const applyCommand = async (command: EraCommand): Promise<void> => {
      if (command.type === 'call') return runCall(command);
      let result;
      const issueStart = commandIssues.length;
      const rejectionStart = schemaRejections.length;
      const isApi = command.origin === 'api';
      const allowReadonly =
        isApi || command.origin === 'hook' || command.origin === 'tool' || !settings.value.下划线只读;
      switch (command.type) {
        case 'insert':
          result = await processInsertBlocks(command.data, currentStat, commandIssues);
          logger.debug('ApplyVarChangeForMessage (Pure)', '处理 Insert 指令完成', {
            inputStat: currentStat,
            outputStat: result.finalStat,
            log: result.editLog,
          });
          break;
        case 'edit':
          // <VariableEdit> 只能修改已存在的路径。先补全 schema 的默认值，
          // 这样仅由默认值提供的字段在它出现的同一条消息里也能被修改。
          normalizeWithSchema();
          result = await processEditBlocks(
            command.data,
            currentStat,
            commandIssues,
            allowReadonly,
            exprContextFor(command),
            strict,
          );
          logger.debug('ApplyVarChangeForMessage (Pure)', '处理 Edit 指令完成', {
            inputStat: currentStat,
            outputStat: result.finalStat,
            log: result.editLog,
          });
          break;
        case 'delete':
          result = await processDeleteBlocks(command.data, currentStat, commandIssues, allowReadonly, strict);
          logger.debug('ApplyVarChangeForMessage (Pure)', '处理 Delete 指令完成', {
            inputStat: currentStat,
            outputStat: result.finalStat,
            log: result.editLog,
          });
          break;
        case 'patch':
          normalizeWithSchema();
          {
            const check = await runPatchCommand(command.data, currentStat, commandIssues, allowReadonly, strict);
            reportSchemaSkip(check);
            if (check.rejections.length > 0) {
              logger.warn('ApplyVarChangeForMessage (Pure)', '以下修改不符合变量结构，已被拦截', check.rejections);
              schemaRejections.push(...check.rejections);
            }
            result = { finalStat: check.finalStat, editLog: check.editLog };
          }
          break;
        default:
          logger.warn('ApplyVarChangeForMessage (Pure)', '遇到未知的指令类型', command);
          return; // 跳过未知指令
      }

      // 用已注册的 schema 拦截非法修改，并写回 schema 的纠正结果
      if (activeSchema && command.type !== 'patch' && result.editLog && result.editLog.length > 0) {
        const check = applySchemaToBlock(
          activeSchema.schema,
          currentStat,
          result.finalStat,
          result.editLog,
          activeSchema,
        );
        reportSchemaSkip(check);
        if (check.rejections.length > 0) {
          logger.warn('ApplyVarChangeForMessage (Pure)', '以下修改不符合变量结构，已被拦截', check.rejections);
          schemaRejections.push(...check.rejections);
        }
        result = { finalStat: check.finalStat, editLog: check.editLog };
      }

      // 记下问题来自正文、旁路写入还是钩子；source 只用于报告，不参与规则判断
      for (const item of [...commandIssues.slice(issueStart), ...schemaRejections.slice(rejectionStart)]) {
        item.origin = command.origin ?? 'text';
        if (command.source) item.source = command.source;
      }

      // 更新当前状态，为下一条指令做准备
      currentStat = result.finalStat;
      // 累积日志。旁路写入对同一路径的连续 update 合并成一条，回滚与正向应用的结果不变；正文指令的日志不合并。
      for (const entry of result.editLog ?? []) {
        const last = accumulatedLogs[accumulatedLogs.length - 1];
        if (
          isApi &&
          last &&
          last === lastApiEntry &&
          last.op === 'update' &&
          entry.op === 'update' &&
          last.path === entry.path
        ) {
          lastApiEntry = { ...last, value_new: entry.value_new };
          accumulatedLogs[accumulatedLogs.length - 1] = lastApiEntry;
        } else {
          accumulatedLogs.push(entry);
          lastApiEntry = isApi ? entry : null;
        }
      }
    };
    for (const command of commands) await applyCommand(command);

    // 3. 整条消息的指令都执行完之后，用 schema 做一次完整纠正（包括补全默认值）。
    //    - 放在最后做，是为了不让默认值抢在同一条消息后面的 <VariableInsert> 之前占位。
    //    - 没有指令的消息同样会执行，这样刚注册的 schema 能立即生效。
    normalizeWithSchema();

    // 4. 执行 afterApply 钩子。变量为空时不执行：此时变量还没被开场白初始化，
    //    提前写入会让之后的 <VariableInsert> 因路径已存在而被忽略。
    const afterHooks = allowHooks && !isStatEmpty() ? getActiveHooks('after') : [];
    for (const hook of afterHooks) {
      const result = runAfterApplyHook(hook, currentStat, initialStat, commands, mk);
      if (result.error) {
        reportHookError(hook, result.error);
        continue;
      }
      if (result.editLog.length === 0) continue;

      let { finalStat: nextStat, editLog: nextLog } = result;
      if (activeSchema) {
        const check = applySchemaToBlock(activeSchema.schema, currentStat, nextStat, nextLog, activeSchema);
        reportSchemaSkip(check);
        if (check.rejections.length > 0) {
          logger.warn(
            'ApplyVarChangeForMessage (Pure)',
            `钩子 ${hook.id} 的以下修改不符合变量结构，已被拦截`,
            check.rejections,
          );
          schemaRejections.push(...check.rejections);
        }
        nextStat = check.finalStat;
        nextLog = check.editLog;
      }
      currentStat = nextStat;
      accumulatedLogs.push(...nextLog);
    }
    // 补回被钩子删掉的默认值
    if (afterHooks.length > 0) normalizeWithSchema();

    // 5. 返回最终计算结果
    logger.debug('ApplyVarChangeForMessage (Pure)', '所有指令处理完成', {
      finalStat: currentStat,
      finalEditLog: accumulatedLogs,
    });
    return { finalStat: currentStat, finalEditLog: accumulatedLogs, mk, schemaRejections, commandIssues, toolResults };
  } catch (err: any) {
    logger.error('ApplyVarChangeForMessage (Pure)', `变量计算异常: ${err?.message || err}`, {
      error: err,
      message: msg,
      initialStat,
      meta,
    });
    // 在异常情况下，返回未修改的初始状态和空日志，以防止破坏后续流程。
    return { finalStat: initialStat, finalEditLog: [], mk, schemaRejections: [], commandIssues: [], toolResults: [] };
  }
};
