/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增 Era.math（确定性数学函数）与 Era.simulate 的 seedMk 选项；新增可选的变量结构 schema 校验与全局接口 Era；新增更新钩子 Era.onBeforeApply / Era.onAfterApply；修复第二批改动在审查中发现的问题；新增额外模型分步更新、等待式提交、试算与变量结构说明等；新增 Era.getVarsAt、Era.hasHook，注册失败时明确提示，Era.commit 参数检查；Era.extra.run 返回结果，新增 Era.extra.status()；新增条目过滤器 Era.registerEntryFilter / Era.hasEntryFilter；新增 Era.checkSchema（变量结构诊断），钩子执行期间拒绝写入接口（重入保护）
 *       2026-11-26 新增 Era.version、Era.features、Era.parseCommands、Era.applyText、Era.keepMessageKey
 *       2026-11-27 Era.keepMessageKey 同时保留分步更新写入的 <era_extra> 块；说明 Era.simulate 的 seedMk 只对应正文中的指令；<era_extra> 块的认法与 stripExtraBlock 共用（不跨过另一个 <era_extra>）
 *       2026-11-27 Era.applyText 在钩子里被拒绝时不再产生未处理的 rejection；新增 Era.registerTool / hasTool、Era.registerExprFn / hasExprFn；commit / applyText 的幂等键 key；Era.extra.plan / replan（正文前规划）；Era.setMessageText
 *       2026-11-27 registerExprFn 的说明：不能注册名为 call 的函数
 *       2026-11-27 更正条目过滤器在主生成中的调用时机说明
 *       2026-11-27 setMessageText / keepMessageKey 的楼层号越界时报错（酒馆助手会把越界的楼层号夹到首尾楼）
 *       2026-11-28 新增 Era.sync、Era.extra.autoRun / settings / planInjection
 *       2026-11-28 注册工具、公式函数后请求重算出错时仍返回注销函数
 *       2026-11-28 registerSchema 无效时返回空的注销函数；Era.extra.plan 先等分步更新；整理注释
 *       2026-11-28 simulate、checkSchema、extra.run、extra.abort 接受楼层号、MK 或对象
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 全局接口
 * @description
 * 通过酒馆助手的 `initializeGlobal('Era', ...)` 向其他脚本和前端界面暴露一组可直接调用的函数。
 * 这是对事件 API（`era:*`）的补充，原有事件全部保留。
 *
 * @example
 * // 在角色卡脚本中注册变量结构。不要用 z.coerce.number()：它会把 null、空字符串、true 变成数字，掩盖 AI 的错误
 * await waitGlobalInitialized('Era');
 * const Num = z.union([z.number(), z.string().trim().regex(/^[+-]?\d+(\.\d+)?$/).transform(Number)]);
 * const unregister = Era.registerSchema(
 *   z.object({
 *     player: z.object({ hp: Num.transform(v => _.clamp(v, 0, 100)) }),
 *   }),
 * );
 * $(window).on('pagehide', unregister);
 */
'use strict';

import { EraSchemaLike } from '../core/schema';
import { ERA_API_EVENTS, ERA_FEATURES, ERA_VERSION } from '../utils/constants';
import { unescapeEraData } from '../utils/data';
import { getEraData, removeMetaFields, settings } from '../utils/era_data';
import { Logger } from '../utils/log';
import { getMessageAt, getRawMessageContent, keepEraBlocks, parseCommandText } from '../utils/message';
import { parseCharacterMacros } from '../utils/text';
import { readMessageKey } from '../core/key/mk';
import { getCurrentParseOptions } from '../core/version';
import { EraAfterApplyContext, EraBeforeApplyContext, EraHookOptions, HookPhase } from '../core/hooks';
import { findMessageByMk, getStatAfter, simulateText } from '../core/simulate';
import { detMath } from '../utils/det_math';
import type { CommitDetail, CommitOperation, TextCommitDetail } from '../events/handlers/api/handler';
import { createTicket, EraWriteResult } from '../events/handlers/api/tickets';
import { pushToQueue, waitForQueueIdle } from '../events/queue';
import { guardWrite, rejectIfGuarded } from '../core/reentry';
import { diagnoseStat } from '../core/schema_diag';
import {
  abortExtra,
  ExtraRunResult,
  ExtraStatusSnapshot,
  getExtraStatus,
  getExtraSwitches,
  planInjectionOf,
  planText,
  PlanRunResult,
  replanLatest,
  runExtraAuto,
  runExtraManually,
  waitForJobs,
} from '../extra/controller';
import { describeActiveSchema } from '../extra/describe';
import { addEntryFilter, dropEntryFilter, EntryFilter, hasEntryFilter } from '../extra/entry_filter';
import { addHook, dropHook, hasHook } from './hook_registry';
import {
  addExprFn,
  addTool,
  dropExprFn,
  dropTool,
  ExprFnOptions,
  hasExprFn,
  hasTool,
  takeUnknownExtension,
  ToolDefinition,
} from './tool_registry';
import { clearActiveSchema, getActiveSchema, RegisterSchemaOptions, setActiveSchema } from './schema_registry';
import { EraSnapshot, FloorRef, getVarsAt } from './vars_at';
import type { CommandIssue } from '../core/crud/diagnostics';

const logger = new Logger();

/** `Era.sync` 最多等待的时间。 */
const SYNC_WAIT_MS = 20000;

/**
 * 注册失败是制卡时的错误用法，弹窗提示，让作者立即发现。
 * 为了不让已发布的卡因此停止运行，不抛出异常，仍返回一个什么都不做的注销函数。
 */
function reportRegisterError(title: string, message: string) {
  toastr.error(_.escape(message), `[ERA] ${title}`, { escapeHtml: false });
}

/** 请求 ERA 重算最新楼层，使变量按当前的 schema 状态刷新。 */
function requestLatestResync() {
  eventEmit(ERA_API_EVENTS.FORCE_SYNC, { mode: 'latest' });
}

export interface RegisterHookOptions extends EraHookOptions {
  /** 注册后是否立即同步一次，使最新楼层按新的钩子重算。默认 `true`。 */
  resync?: boolean;
}

/** 多个脚本在加载时先后注册钩子，合并成一次同步。 */
const requestResyncForHooks = _.debounce(() => eventEmit(ERA_API_EVENTS.FORCE_SYNC, { mode: 'auto' }), 50);

/**
 * 注册工具或公式函数后重算：之前因“未知工具 / 未知函数”失败过的，从头完全重算；
 * 否则与钩子相同（扩展的标识带版本号，新增或提高版本时同步会自行改为完全重算）。
 */
function requestResyncForExtension(kind: 'tool' | 'expr', name: string) {
  // 注册已经完成，请求重算时出任何问题都不能让注册接口抛错：调用方拿不到注销函数，工具却留在了内存里
  try {
    if (takeUnknownExtension(kind, name)) {
      eventEmit(ERA_API_EVENTS.FORCE_SYNC, { mode: 'full' });
    } else {
      requestResyncForHooks();
    }
  } catch (error: any) {
    logger.warn('requestResyncForExtension', `注册 ${name} 后请求重算失败：${error?.message ?? error}`);
  }
}

function registerHook(phase: HookPhase, id: string, fn: any, options: RegisterHookOptions = {}): () => void {
  guardWrite(phase === 'before' ? 'Era.onBeforeApply' : 'Era.onAfterApply');
  const hook = addHook(phase, id, fn, options);
  if (!hook) {
    reportRegisterError('钩子注册失败', `id 必须是非空字符串，钩子必须是函数（id: ${String(id)}）。`);
    return () => {};
  }
  if (options?.resync !== false) {
    requestResyncForHooks();
  }
  // 注销不触发同步，与 unregisterSchema 一致
  return () => {
    dropHook(hook);
  };
}

/** `Era.parseCommands` 解析出的一个指令块。 */
export interface ParsedCommand {
  type: 'insert' | 'edit' | 'delete' | 'patch' | 'call';
  /** 块中的数据，未转义；一个块可以有多个对象。工具调用是 `[{ name, args }]`。 */
  data: any[];
}

/** 把 `Era.commit` / `Era.applyText` 的选项复制成纯 JSON，并检查能否转换。 */
function copyOptions(options: unknown): Omit<CommitDetail, 'operations'> {
  if (options === undefined || options === null) return {};
  try {
    const picked = _.pick(JSON.parse(JSON.stringify(options)), ['mk', 'message_id', 'atomic', 'key']);
    if (picked.key !== undefined && (typeof picked.key !== 'string' || picked.key === '')) {
      throw new Error('key 必须是非空字符串');
    }
    return picked;
  } catch (error: any) {
    throw new Error(`选项无法转换成 JSON: ${error?.message ?? error}`);
  }
}

const FEATURES: readonly string[] = Object.freeze([...ERA_FEATURES]);

/** 按楼层号、MK 或 `{ mk, message_id }` 找到当前聊天里的一楼；找不到时返回 `undefined`。 */
function findFloor(where: FloorRef): any {
  const mk = typeof where === 'string' ? where : _.isPlainObject(where) ? (where as any).mk : undefined;
  if (mk) return findMessageByMk(mk) ?? undefined;
  const id = typeof where === 'number' ? where : (where as any)?.message_id;
  return Number.isInteger(id) ? getMessageAt(id) : undefined;
}

/**
 * 把“哪一楼”换成 MK。接口统一接受楼层的消息 ID（可以用负数从末尾倒数）、MK 或 `{ mk, message_id }`；
 * 直接给 MK 时原样使用（可以是没有显示的 swipe）。
 * @throws 按楼层号找不到消息，或这一楼还没有 MK 时。
 */
function mkOfFloor(where: FloorRef): string {
  if (typeof where === 'string') return where;
  if (_.isPlainObject(where) && typeof (where as any).mk === 'string' && (where as any).mk) return (where as any).mk;
  const msg = findFloor(where);
  if (!msg) throw new Error('目标消息不存在');
  const mk = readMessageKey(msg);
  if (!mk) throw new Error('这一楼还没有被 ERA 登记（没有 MK），请等同步完成后再试');
  return mk;
}

/** `Era.sync` 的实际执行：把一次同步排进队列，等队列处理完。 */
async function syncNow(mode: 'auto' | 'latest' | 'full'): Promise<boolean> {
  if (!['auto', 'latest', 'full'].includes(mode)) throw new Error("mode 只能是 'auto'、'latest' 或 'full'");
  pushToQueue(ERA_API_EVENTS.FORCE_SYNC, { mode });
  return waitForQueueIdle(SYNC_WAIT_MS);
}

/** `Era.setMessageText` 的实际写入：排进 ERA 队列，改写正文后随同步完成。 */
async function setMessageTextNow(where: FloorRef, text: string): Promise<EraWriteResult> {
  if (typeof text !== 'string') throw new Error('text 必须是字符串');
  let mk = typeof where === 'string' ? where : _.isPlainObject(where) ? (where as any).mk : undefined;
  if (!mk) {
    const id = typeof where === 'number' ? where : (where as any)?.message_id;
    if (!Number.isInteger(id)) throw new Error('需要指定楼层：消息 ID 或 MK');
    const msg = getMessageAt(id);
    if (!msg) throw new Error('目标消息不存在');
    mk = readMessageKey(msg);
    if (!mk) throw new Error('这一楼还没有被 ERA 登记（没有 MK），请等同步完成后再改写');
  }
  const { ticket, promise } = createTicket();
  pushToQueue(ERA_API_EVENTS.WRITE_EXTRA, { mk, blocks: '', body: text }, ticket);
  return promise;
}

/** `Era.applyText` 的实际写入：排进 ERA 队列，按正文规则执行。 */
async function applyTextNow(text: string, options: Omit<CommitDetail, 'operations'>): Promise<EraWriteResult> {
  if (typeof text !== 'string') throw new Error('text 必须是字符串');
  const detail: TextCommitDetail = { ...copyOptions(options), text };
  const { ticket, promise } = createTicket();
  pushToQueue(ERA_API_EVENTS.COMMIT, detail, ticket);
  return promise;
}

async function commitOperations(
  operations: CommitOperation | CommitOperation[],
  options: Omit<CommitDetail, 'operations'>,
): Promise<EraWriteResult> {
  if (operations === undefined || operations === null) throw new Error('没有要写入的内容');
  let copy: CommitDetail['operations'];
  try {
    copy = JSON.parse(JSON.stringify(operations));
  } catch (error: any) {
    throw new Error(`写入的内容无法转换成 JSON: ${error?.message ?? error}`);
  }
  const detail = { ...options, operations: copy };
  const { ticket, promise } = createTicket();
  pushToQueue(ERA_API_EVENTS.COMMIT, detail, ticket);
  return promise;
}

export const Era = {
  /** ERA-Heron 的版本号，例如 `'2.0.2'`（原版 ERA 没有该字段）。 */
  version: ERA_VERSION as string,

  /**
   * 当前版本提供的功能，例如 `Era.features.includes('applyText')`。只读。
   * 判断版本请用 `开发工具/era.ts` 的 `requireEra`。
   */
  features: FEATURES,

  /**
   * 注册变量结构 schema（zod schema 或任何带 `safeParse` 的对象）。重复注册会覆盖之前的 schema。
   *
   * 注册后，ERA 会在每个指令块应用后：
   * - 把 schema 的 `coerce` / `transform` / `prefault` 结果写回变量；
   * - 丢弃会让合法状态变得不合法的修改，并通过 `era:schemaError` 事件报告。
   *
   * schema 应当是幂等的：`Schema.parse(Schema.parse(x))` 应与 `Schema.parse(x)` 相同。
   *
   * @returns 注销函数；建议在脚本卸载（`pagehide`）时调用。schema 无效时弹窗提示、不注册，可用 `hasSchema()` 确认。
   */
  registerSchema(schema: EraSchemaLike, options: RegisterSchemaOptions = {}): () => void {
    // 注册会在稍后触发一次重算：钩子、工具里注册的话，重算又会执行它们，再注册、再重算
    guardWrite('Era.registerSchema');
    const registered = setActiveSchema(schema, options);
    if (!registered) {
      reportRegisterError('变量结构注册失败', 'schema 必须是带有 safeParse 方法的对象（例如 zod schema）。');
      // 没有注册成功就不能返回会注销的函数：schema 是 undefined 时它会把别人已经注册的结构清掉
      return () => {};
    } else if (options?.resync !== false) {
      requestLatestResync();
    }
    return () => {
      Era.unregisterSchema(schema);
    };
  },

  /**
   * 注销变量结构 schema。
   * @param schema 如果提供，则只有当前生效的 schema 正是它时才注销。
   * @returns 是否确实注销了一个 schema。
   */
  unregisterSchema(schema?: EraSchemaLike): boolean {
    return clearActiveSchema(schema);
  },

  /**
   * 注册钩子：每条 AI 消息的指令解析出来之后、执行之前调用，可以修改、删除或追加指令。
   * 钩子必须是同步的、只依赖 `ctx` 的纯函数，因为重算历史消息时会再次执行。
   * @param id 钩子的标识，建议使用 “角色卡.功能”；同一 id 重复注册会替换之前的钩子。
   * @returns 注销函数；应在脚本卸载（`pagehide`）时调用。参数无效时弹窗提示、不注册，可用 `hasHook(id)` 确认。
   */
  onBeforeApply(id: string, hook: (ctx: EraBeforeApplyContext) => void, options?: RegisterHookOptions): () => void {
    return registerHook('before', id, hook, options);
  },

  /**
   * 注册钩子：每条 AI 消息的指令执行、schema 纠正之后调用，可以修改 `ctx.stat`。
   * 修改会作为普通条目记入该消息的 `EditLog`。其余要求与 `onBeforeApply` 相同。
   * @returns 注销函数；应在脚本卸载（`pagehide`）时调用。
   */
  onAfterApply(id: string, hook: (ctx: EraAfterApplyContext) => void, options?: RegisterHookOptions): () => void {
    return registerHook('after', id, hook, options);
  },

  /**
   * 当前角色卡是否注册了该 id 的钩子。
   * @param phase `'before'` / `'after'`；省略时任一阶段都算。
   */
  hasHook(id: string, phase?: HookPhase): boolean {
    return hasHook(id, phase);
  },

  /**
   * 注册条目过滤器：按变量决定世界书条目发不发、发什么内容，不改世界书文件。分步更新（`ctx.purpose` 为 `extra`）按**目标楼**的状态，
   * 正文前规划（`plan`）与主生成（`main`，1.8 起，玩家触发的剧情生成加载世界书时）按最新的状态。
   * 在文件里的开关之前运行，返回 `true` 可以纳入文件里关闭的条目。
   * 返回 `false` 排除，`true` 纳入，字符串表示纳入并替换内容，其他值表示不表态（按文件的开关和关键字）。
   * 过滤器必须是同步的、只依赖参数的纯函数；出错或返回 Promise 时忽略它的结果并记入 `warnings`。
   * @param name 过滤器的名字，同名的会被替换；多个过滤器按名字顺序调用。
   * @returns 注销函数；应在脚本卸载（`pagehide`）时调用。参数无效时弹窗提示、不注册，可用 `hasEntryFilter(name)` 确认。
   */
  registerEntryFilter(name: string, filter: EntryFilter): () => void {
    guardWrite('Era.registerEntryFilter');
    const registered = addEntryFilter(name, filter);
    if (!registered) {
      reportRegisterError('条目过滤器注册失败', `名字必须是非空字符串，过滤器必须是函数（名字: ${String(name)}）。`);
      return () => {};
    }
    return () => {
      dropEntryFilter(registered);
    };
  },

  /** 当前角色卡是否注册了该名字的条目过滤器。 */
  hasEntryFilter(name: string): boolean {
    return hasEntryFilter(name);
  },

  /**
   * 注册工具（1.8 起）：AI 在正文里写 `<EraFCall name="工具名">{"参数": 1}</EraFCall>`，ERA 按位置调用 `handler`，
   * 它读到“执行到这里时”的变量，返回普通的变量操作（格式同 `Era.commit`）。重算时重新执行。
   * `handler` 必须是同步的、只依赖参数的纯函数；随机数用 `ctx.random()`，三角、指数用 `ctx.math`。
   * @param name 工具名：字母、数字、下划线和中文，同名的会被替换。
   * @returns 注销函数；应在脚本卸载（`pagehide`）时调用。参数无效时弹窗提示、不注册，可用 `hasTool(name)` 确认。
   */
  registerTool(name: string, definition: ToolDefinition): () => void {
    guardWrite('Era.registerTool');
    const tool = addTool(name, definition);
    if (typeof tool === 'string') {
      reportRegisterError('工具注册失败', tool);
      return () => {};
    }
    requestResyncForExtension('tool', tool.name);
    return () => {
      dropTool(tool);
    };
  },

  /** 当前角色卡是否注册了该名字的工具。 */
  hasTool(name: string): boolean {
    return hasTool(name);
  },

  /**
   * 注册自定义公式函数（1.8 起），在 `$expr` 里像内置函数一样调用，例如 `{"$expr": "伤害(roll(1, 6), 防御)"}`。
   * `fn` 只接收数字、返回有限数字，必须是同步纯函数（需要读变量的用 `registerTool`）。不能与内置函数同名，也不能叫 `call`（保留给存成变量的公式）。
   * 改了公式时提高 `options.version`，ERA 会完全重算一次。
   * @returns 注销函数；参数无效时弹窗提示、不注册，可用 `hasExprFn(name)` 确认。
   */
  registerExprFn(name: string, fn: (...args: number[]) => number, options?: ExprFnOptions): () => void {
    guardWrite('Era.registerExprFn');
    const entry = addExprFn(name, fn, options);
    if (typeof entry === 'string') {
      reportRegisterError('公式函数注册失败', entry);
      return () => {};
    }
    requestResyncForExtension('expr', entry.name);
    return () => {
      dropExprFn(entry);
    };
  },

  /** 当前角色卡是否注册了该名字的自定义公式函数。 */
  hasExprFn(name: string): boolean {
    return hasExprFn(name);
  },

  /**
   * 按顺序提交一组写入，在写入被计算之后完成。不修改消息正文（等同于开启 `API写入不修改消息`）。
   * @example
   * const { statWithoutMeta } = await Era.commit([
   *   { edit: { player: { gold: '-=3' } } },
   *   { patch: [{ op: 'insert', path: '/player/bag/-', value: '面包' }] },
   * ], { atomic: true });
   * @param options `mk` / `message_id` 指定楼层，默认是最后一条 AI 消息；同时给出时以 `mk` 为准，`message_id` 可以用负数从末尾倒数。
   *   `atomic` 为真时，有任何一项不能生效就全部放弃。
   * @throws 失败时 Promise 带有说明原因的 `Error`，见 doc/05 的失败表格。
   */
  commit(
    operations: CommitOperation | CommitOperation[],
    options: Omit<CommitDetail, 'operations'> = {},
  ): Promise<EraWriteResult> {
    // 钩子执行期间拒绝：返回已处理的失败 Promise，钩子不 await 也不会产生未处理的 rejection
    return rejectIfGuarded('Era.commit') ?? commitOperations(operations, options);
  },

  /**
   * 试算一段含指令的文本，不写入任何数据。按当前聊天的解析方式解析，与 AI 消息正文相同。
   * @param mk 在哪一楼之后的状态上试算，默认是最新状态；该楼的状态无法计算时抛出异常。
   * @param options.seedMk 表达式 `random()` / `roll()` 与钩子随机数按哪个 MK 取种子。默认不对应任何消息，骰点仅供参考。
   *   指定时，骰点与“这段文本出现在该楼正文里”时相同。`Era.applyText` / `Era.commit` 的旁路写入按写入序号取种子，
   *   骰点与此不同；要预览旁路写入的结果，请用 `atomic: true` 提交（预检不通过时不写入）。
   */
  async simulate(
    text: string,
    where?: FloorRef,
    options: { seedMk?: string } = {},
  ): Promise<{ stat: any; problems: { path: string; reason: string }[] }> {
    const mk = where === undefined ? undefined : mkOfFloor(where);
    const stat = mk === undefined ? getEraData().stat : await getStatAfter(mk);
    if (stat === null) throw new Error('无法计算该楼的状态：MK 不存在，或日志已被折叠');
    const result = await simulateText(text, stat, options?.seedMk || undefined);
    return {
      stat: unescapeEraData(removeMetaFields(result.stat)),
      problems: result.problems.map(({ path, reason }) => ({ path, reason })),
    };
  },

  /**
   * 解析一段文本中的指令块，不执行、不写入。与 AI 消息正文的解析方式相同：宏已展开，按设置繁转简、宽松解析；
   * 当前聊天是 1.7 起新建的聊天时，思考标签里的指令不算，设置了指令外层标签时只认标签内的指令。
   * @returns `commands` 是按出现顺序的指令块（数据未转义）；`problems` 是无法解析的块。
   */
  parseCommands(text: string): { commands: ParsedCommand[]; problems: { path: string; reason: string }[] } {
    const issues: CommandIssue[] = [];
    const commands = parseCommandText(
      parseCharacterMacros(String(text ?? '')),
      settings.value.繁体转简体,
      issues,
      getCurrentParseOptions(),
      false,
    );
    return {
      commands: commands.map(({ type, data }) => ({ type, data: _.cloneDeep(data) })),
      problems: issues.map(({ path, reason }) => ({ path, reason })),
    };
  },

  /**
   * 把一段文本中的指令应用到一楼，不修改正文。解析方式与 `parseCommands` 相同；指令保存为旁路写入（`origin: 'text'`），
   * 按正文指令的规则执行（例如 `下划线只读` 会限制它们），之后的重算不再重新解析文本。在写入被计算之后完成。
   * @param options 与 `Era.commit` 相同：`mk` / `message_id` 指定楼层，默认是最后一条 AI 消息；`atomic` 为真时，
   *   有任何一条不能生效（含无法解析的块）就全部放弃。
   * @throws 文本中没有可以执行的指令时，以及 `Era.commit` 的各种失败情况。
   */
  applyText(text: string, options: Omit<CommitDetail, 'operations'> = {}): Promise<EraWriteResult> {
    // 钩子执行期间拒绝，与 Era.commit 相同：不包在 async 里，否则钩子不 await 时外层 Promise 会成为未处理的 rejection
    return rejectIfGuarded('Era.applyText') ?? applyTextNow(text, options);
  },

  /**
   * 请求一次同步并等它完成，相当于可以等待的 `era:forceSync`。
   * 脚本删楼、切换 swipe（酒馆助手的 `deleteChatMessages`、`setChatMessages` 默认不通知 ERA）之后调用，再读变量或建下一楼。
   * @param mode `'auto'`（默认，按聊天记录的变化决定重算范围）、`'latest'`（只重算最新一楼）或 `'full'`（从第一楼完全重算）。
   * @returns `true` 表示同步已经完成；`false` 表示到了时限还没有完成。
   */
  sync(mode: 'auto' | 'latest' | 'full' = 'auto'): Promise<boolean> {
    return rejectIfGuarded('Era.sync') ?? syncNow(mode);
  },

  /**
   * 前端改写楼层正文时保留 ERA 写在正文里的块：
   * - 该楼的 MK（`<era_data>` 块）。MK 丢失后，该楼的旁路写入会在下次完全同步时被当作孤儿清除；
   * - 分步更新写入的 `<era_extra>` 块（额外模型的输出）。丢失后，额外模型写入的变量会随之回滚；
   * - 正文前规划写在玩家消息里的 `<era_plan>` 块。丢失后，规划写入的变量会随之回滚。
   * 新的正文已经含有某种块时，这种块不再补（不会重复）。
   * @param text 新的正文。
   * @param from 原来的正文，或楼层的消息 ID（可以用负数从末尾倒数）。
   * @returns 补上原来的 `<era_data>`、`<era_extra>`、`<era_plan>` 块的正文；原来也没有时原样返回。
   * @throws `from` 是楼层号而这一楼不存在时抛出错误。
   * @example
   * await setChatMessages([{ message_id: 0, message: Era.keepMessageKey(newText, 0) }]);
   */
  keepMessageKey(text: string, from: string | number): string {
    if (typeof from !== 'number') return keepEraBlocks(text, String(from ?? ''));
    const msg = getMessageAt(from);
    if (!msg) throw new Error('目标消息不存在');
    return keepEraBlocks(text, getRawMessageContent(msg));
  },

  /**
   * 改写一楼的正文，保留 ERA 写在原正文里的块（`<era_data>`、`<era_extra>`、玩家消息里的 `<era_plan>`），并按新正文重新计算变量，算完后返回。
   * 酒馆助手的 `setChatMessages` 改写正文后酒馆不发出消息修改事件，ERA 不会自动重算；用这个接口不需要自己再请求同步。
   * 只是往某一楼写变量时不要改正文，用 `Era.applyText` / `Era.commit`。
   * @param where 楼层的消息 ID（可以用负数从末尾倒数）、MK，或 `{ mk, message_id }`。
   * @throws 找不到这一楼、这一楼还没有被 ERA 登记（没有 MK）时 Promise 失败。
   */
  setMessageText(where: FloorRef, text: string): Promise<EraWriteResult> {
    return rejectIfGuarded('Era.setMessageText') ?? setMessageTextNow(where, text);
  },

  /** 确定性数学函数，用法同 `Math`，各浏览器逐位一致；钩子里也可以用 `ctx.math`。 */
  math: detMath,

  /** 当前注册的变量结构的文字说明，包含类型、枚举值和范围；没有注册时为空字符串。宏为 `{{ERA-schema}}`。 */
  describeSchema: describeActiveSchema,

  /** 额外模型解析。 */
  extra: {
    /**
     * 重新解析指定 MK 的消息；不指定时解析最后一条 AI 消息。解析结束后返回结果；
     * 被同一楼的新一次解析取代或被取消时 `status` 为 `aborted`。找不到消息时 Promise 失败。
     */
    run: (where?: FloorRef): Promise<ExtraRunResult> =>
      rejectIfGuarded('Era.extra.run') ??
      (async () => runExtraManually(where === undefined ? undefined : mkOfFloor(where)))(),
    /** 取消正在进行的解析。 */
    abort: (where?: FloorRef): void => {
      if (where === undefined) return abortExtra();
      let mk: string;
      try {
        mk = mkOfFloor(where);
      } catch {
        return; // 楼层已经不在了，没有可以取消的
      }
      abortExtra(mk);
    },
    /**
     * 等待正在进行的解析完成；没有时立即完成。脚本自行触发生成之前可以先等待它。
     * 时限按重试次数、超时和写入计算；返回 `false` 表示到了时限或玩家点击提示框放弃了等待。
     */
    wait: (): Promise<boolean> => rejectIfGuarded('Era.extra.wait') ?? waitForJobs(),
    /** 同步查询正在进行的解析和最近一次解析的结果（含实际提示词与原始回复，只保存在内存中）。 */
    status: (): ExtraStatusSnapshot => getExtraStatus(),
    /**
     * 正文前规划（1.8 起）：按 `[era_plan]` 条目为一段玩家文字做规划，返回追加了 `<era_plan>` 的文本，不写入任何内容。
     * 脚本、快速回复自己发送消息时用它；玩家点击发送时由“正文前规划”设置自动进行。
     */
    plan: (text: string): Promise<PlanRunResult> =>
      rejectIfGuarded('Era.extra.plan') ??
      (async () => {
        // 上一楼的分步更新还没写回时，规划会按旧的变量结算；与玩家点击发送时一样先等它完成
        await waitForJobs();
        return planText(text);
      })(),
    /**
     * 按自动触发的同样条件解析一楼：没有开启分步更新、是玩家消息、正文自己带有指令时不请求，返回 `null`。
     * 自己建楼的前端在建好 AI 楼之后调用（脚本建的楼不会触发自动解析）；成功和无变化时不弹提示。
     * @throws 找不到这一楼、这一楼还没有 MK 时 Promise 失败。
     */
    autoRun: (where: FloorRef): Promise<ExtraRunResult | null> =>
      rejectIfGuarded('Era.extra.autoRun') ??
      (async () => {
        const msg = findFloor(where);
        if (!msg) throw new Error('目标消息不存在');
        return runExtraAuto(msg);
      })(),
    /** 分步更新（`update`）与正文前规划（`plan`）当前实际生效的开关。只读，不含接口地址和密钥。 */
    settings: (): { update: boolean; plan: boolean } => getExtraSwitches(),
    /**
     * 玩家消息里的规划对应的注入文字，与原生发送时 ERA 注入给剧情模型的逐字相同；没有规划时返回空字符串。
     * 自己调用 `generate()` 的前端用它把结算结果告诉剧情模型（`generate()` 不会自动注入）。
     * @param from 玩家消息的正文，或它的楼层号（可以用负数从末尾倒数）。
     */
    planInjection: (from: string | number): string => {
      if (typeof from !== 'number') return planInjectionOf(String(from ?? ''));
      const msg = getMessageAt(from);
      if (!msg) throw new Error('目标消息不存在');
      return planInjectionOf(getRawMessageContent(msg));
    },
    /** 重新规划最新一条玩家消息，替换其中的 `<era_plan>`（1.8 起）。出错时弹窗提示并返回 `null`。 */
    replan: (): Promise<PlanRunResult | null> => rejectIfGuarded('Era.extra.replan') ?? replanLatest(),
  },

  /**
   * 检查变量是否符合当前注册的变量结构，只读。
   * 修改前的变量已经不符合结构时，ERA 照常放行之后的修改（无法判断是哪条修改造成的），并广播 `era:schemaInvalid`；
   * 可以用它确认问题，再用面板“诊断”页的一键修复处理。
   * @param mk 检查哪一楼处理完之后的变量，默认是最新的变量；该楼的状态无法计算时 Promise 失败。
   * @returns `issues` 中 `kind` 为 `missing` 表示缺必填字段（多半是 schema 升级新增了字段），`invalid` 表示类型或取值不符。
   */
  async checkSchema(where?: FloorRef): Promise<EraSchemaCheckResult> {
    const mk = where === undefined ? undefined : mkOfFloor(where);
    const stat = mk === undefined ? getEraData().stat : await getStatAfter(mk);
    if (stat === null) throw new Error('无法计算该楼的状态：MK 不存在，或日志已被折叠');
    const { registered, valid, issues, error } = diagnoseStat(getActiveSchema()?.schema, stat);
    return {
      registered,
      valid,
      issues: issues.map(({ kind, path, message }) => ({ kind, path, message })),
      ...(error === undefined ? {} : { error }),
    };
  },

  /** 当前是否注册了变量结构 schema。 */
  hasSchema(): boolean {
    return getActiveSchema() !== null;
  },

  /**
   * 某一楼处理完之后的变量，用于让楼层里的状态栏显示“那一楼当时”的值。只读。
   * 与 `era:getSnapshotAtMId` / `era:getSnapshotAtMk` 的结果相同，会先读取折叠日志的存档。
   * @param where 消息 ID（可以用负数从末尾倒数）、MK，或 `{ message_id }` / `{ mk }`。
   * @throws 楼层不存在、还没有计算到、或日志已折叠又没有存档时，Promise 失败。
   * @example
   * const { statWithoutMeta } = await Era.getVarsAt(getCurrentMessageId());
   */
  getVarsAt(where: FloorRef): Promise<EraSnapshot> {
    return getVarsAt(where);
  },

  /**
   * 同步获取当前最新的变量。与 `era:getCurrentVars` 事件返回的 `stat` / `statWithoutMeta` 一致，
   * 但不需要监听 `era:queryResult`。
   */
  getCurrentVars(): { stat: any; statWithoutMeta: any } {
    const { stat } = getEraData();
    return {
      stat: unescapeEraData(stat),
      statWithoutMeta: unescapeEraData(removeMetaFields(stat)),
    };
  },
};

export type EraGlobal = typeof Era;

/** `Era.checkSchema` 的结果。 */
export interface EraSchemaCheckResult {
  /** 是否注册了变量结构；没有注册时 `valid` 为真。 */
  registered: boolean;
  valid: boolean;
  issues: { kind: 'missing' | 'invalid'; path: string; message: string }[];
  /** schema 的 safeParse 抛出异常时的说明。 */
  error?: string;
}

$(() => {
  initializeGlobal('Era', Era);
  logger.log('initializeGlobal', '已共享全局接口 Era。');
});
