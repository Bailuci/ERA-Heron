/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增更新钩子 Era.onBeforeApply / Era.onAfterApply；修复第二批改动在审查中发现的问题；新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复第三批改动在审查中发现的问题；随机数抽到 utils 与表达式共用，ctx.math 提供确定性数学函数，保留 $expr 的稳定身份；钩子执行期间拒绝写入（重入保护，2026-11-26）
 *       2026-11-27 beforeApply 钩子保留指令的来源标记 source；指令可以是工具调用（type: 'call'）；保留正文指令的块序号
 *       2026-11-28 钩子看到的指令带只读的 origin / source
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 更新钩子执行模块
 * @description
 * 执行由角色卡脚本注册的更新钩子，并把钩子对变量的修改转换成普通的 `EditLog` 条目。
 *
 * - 钩子在 `ApplyVarChangeForMessage` 内部执行，因此重算历史消息时会再次执行；
 *   钩子必须是 `ctx` 的纯函数，需要随机数时使用 `ctx.random()`，三角、指数、对数用 `ctx.math`（各浏览器逐位一致）。
 * - 钩子的效果只存在于该消息的 `EditLog` 中，回滚逻辑无需改动，也不新增任何持久化数据。
 * - 只支持同步函数：同步流程在开头读取变量、在结尾写回，若在中途真正等待，
 *   用户切换聊天后会把一个聊天的变量写进另一个聊天。
 *
 * 本文件中的函数都是纯函数：钩子由参数传入，不读取任何全局状态。
 */
'use strict';

import { escapeEraData, unescapeEraData } from '../utils/data';
import { detMath, DetMath } from '../utils/det_math';
import { Logger } from '../utils/log';
import { EraCommand } from '../utils/message';
import { createSeededRandom } from '../utils/seeded_random';
import { runGuarded } from './reentry';
import { normalizeWith, stripReserved } from './schema';

const logger = new Logger();

export type HookPhase = 'before' | 'after';

export interface EraHookOptions {
  /** 数值小的先执行；相同时按 id 排序（与脚本加载顺序无关）。默认 0。 */
  order?: number;
}

export interface EraHookCommand {
  /** `call` 是工具调用 `<EraFCall>`，`data` 为 `[{ name, args }]`。 */
  type: 'insert' | 'edit' | 'delete' | 'patch' | 'call';
  data: any[];
  /**
   * 指令从哪里来（只读，改它没有效果）：`text` 正文里的指令，`api` 旁路写入（`Era.commit`、`Era.applyText`、写入事件），
   * `hook` 钩子生成，`tool` 工具返回。钩子自己新建的指令不用写。
   */
  origin?: 'text' | 'api' | 'hook' | 'tool';
  /** 更细的来源，只用于区分：`extra` 额外模型写进 `<era_extra>` 的指令，`api` 旁路写入。正文里的普通指令没有这一项。 */
  source?: string;
}

export interface EraAfterApplyContext {
  /** 本条消息的 MK，重算时不变；新的 swipe 有新的 MK。 */
  mk: string;
  /** 本条消息应用前的变量（副本，修改无效）。 */
  old_stat: any;
  /** 指令与 schema 纠正之后的变量。可原地修改，或整体赋值给 `ctx.stat`。 */
  stat: any;
  /** 本条消息执行的指令（副本）。`<VariableEdit>` 中的 `{"$expr": "..."}` 叶子原样出现，不是数字。 */
  commands: EraHookCommand[];
  /** 以 MK 和钩子 id 为种子的确定性随机数 [0, 1)。 */
  random(): number;
  /** 确定性数学函数，用法同 `Math`。不要直接用 `Math.sin/exp/log/pow` 或 `**`：各浏览器的末位可能不同。 */
  math: DetMath;
}

export interface EraBeforeApplyContext {
  /** 本条消息的 MK，重算时不变；新的 swipe 有新的 MK。 */
  mk: string;
  /** 本条消息应用前的变量（副本，修改无效）。 */
  old_stat: any;
  /**
   * 从正文中解析出的指令。可原地修改、删除、追加，或整体赋值给 `ctx.commands`。
   * `<VariableEdit>` 中的 `{"$expr": "..."}` 叶子原样出现（尚未求值），按数字处理指令的钩子要跳过它。
   */
  commands: EraHookCommand[];
  /** 以 MK 和钩子 id 为种子的确定性随机数 [0, 1)。 */
  random(): number;
  /** 确定性数学函数，用法同 `Math`。不要直接用 `Math.sin/exp/log/pow` 或 `**`：各浏览器的末位可能不同。 */
  math: DetMath;
}

export interface RegisteredHook {
  id: string;
  phase: HookPhase;
  fn: (ctx: any) => any;
  order: number;
  /** 注册时所在的角色卡标识。 */
  owner: string;
  /** 是否已经弹窗提示过该钩子的错误。 */
  notified: boolean;
}

const toJson = (value: any): any => JSON.parse(JSON.stringify(value));

/** 把钩子抛出的任何东西转换成非空的说明。 */
const describeError = (error: any): string => {
  try {
    return String(error?.message || error) || '未知错误';
  } catch {
    return '未知错误';
  }
};

/** 钩子看到的变量：反转义、去掉 ERA 保留字段、JSON 规范化的全新副本。 */
const toHookView = (stat: any): any => toJson(stripReserved(unescapeEraData(stat)));

/**
 * 确定性随机数：FNV-1a 哈希作为种子的 mulberry32。每次调用钩子都新建，因此重算时序列相同。
 * 实现在 `utils/seeded_random.ts`，与表达式 `$expr` 共用。
 */
export const createHookRandom = createSeededRandom;

/** 标记指令的来源。用 Symbol 键：钩子用 `{ ...command }` 复制时会保留，又不会出现在数据里。 */
const ORIGIN = Symbol('era-origin');
/** 标记指令的 `exprId`（表达式随机数种子的稳定身份），做法同 `ORIGIN`。 */
const EXPR_ID = Symbol('era-expr-id');
/** 标记指令的 `source`（只用于报告），做法同 `ORIGIN`。 */
const SOURCE = Symbol('era-source');
/** 标记正文指令的块序号（工具调用的随机数种子用它），做法同 `ORIGIN`。 */
const BLOCK = Symbol('era-block');

/** 钩子看到的指令。`patch` 与 `call` 的数据本来就没有转义。 */
const isRaw = (type: string) => type === 'patch' || type === 'call';
const toCommandView = (commands: EraCommand[]): EraHookCommand[] =>
  commands.map(({ type, data, origin, source }) => ({
    type,
    data: toJson(isRaw(type) ? data : unescapeEraData(data)),
    origin: origin ?? 'text',
    ...(source === undefined ? {} : { source }),
  }));

/**
 * 同步调用钩子；返回 thenable 视为错误。用鸭子类型判断，因为 Promise 可能来自另一个 iframe。
 * 钩子执行期间调用写入接口或发出写入事件会被拒绝，并让该钩子报错（见 `core/reentry.ts`）。
 */
function callHook(hook: RegisteredHook, ctx: any): void {
  const result = runGuarded(`钩子 ${hook.id} `, () => hook.fn(ctx));
  if (result && typeof result.then === 'function') {
    // 避免产生未处理的 rejection
    result.then(
      () => {},
      () => {},
    );
    throw new Error('钩子必须是同步函数，不能返回 Promise');
  }
}

/**
 * 执行一个 afterApply 钩子。钩子在自己的副本上操作，出错时丢弃该钩子的全部修改。
 * @param currentStat 当前的 `stat_data`（不会被修改）。
 * @param oldStat 本条消息应用前的 `stat_data`（不会被修改）。
 */
export function runAfterApplyHook(
  hook: RegisteredHook,
  currentStat: any,
  oldStat: any,
  commands: EraCommand[],
  mk: string,
): { finalStat: any; editLog: any[]; error?: string } {
  try {
    const before = toHookView(currentStat);
    const ctx: EraAfterApplyContext = {
      mk,
      old_stat: toHookView(oldStat),
      stat: _.cloneDeep(before),
      commands: toCommandView(commands),
      random: createHookRandom(`${mk}|after|${hook.id}`),
      math: detMath,
    };
    callHook(hook, ctx);

    const target = toJson(ctx.stat ?? null); // 从 ctx 读取，支持整体赋值
    if (!_.isPlainObject(target)) {
      throw new Error('ctx.stat 必须是对象');
    }
    if (_.isEqual(before, target)) {
      return { finalStat: currentStat, editLog: [] };
    }
    for (const key of Object.keys(target)) {
      const escaped = Object.keys(escapeEraData({ [key]: 0 }))[0];
      if (!_.isEqual(_.toPath(escaped), [escaped]) && !_.isEqual(target[key], before[key])) {
        logger.warn('runAfterApplyHook', `钩子 ${hook.id} 写入的顶层键 "${key}" 无法作为路径，已忽略`);
      }
    }
    // 必须再次剔除保留字段：否则钩子写入的 $meta 会产生 insert 日志，回滚时会删掉真正的 $meta。
    const { stat, extraLog } = normalizeWith(currentStat, stripReserved(target), {
      keepUnknownRootKeys: false,
      allowInsert: true,
    });
    return { finalStat: stat, editLog: extraLog };
  } catch (error: any) {
    return { finalStat: currentStat, editLog: [], error: describeError(error) };
  }
}

/** 执行一个 beforeApply 钩子，返回（可能被修改过的）指令。出错时返回原来的指令。 */
export function runBeforeApplyHook(
  hook: RegisteredHook,
  commands: EraCommand[],
  oldStat: any,
  mk: string,
): { commands: EraCommand[]; error?: string } {
  try {
    const before = toCommandView(commands);
    const ctx: EraBeforeApplyContext = {
      mk,
      old_stat: toHookView(oldStat),
      commands: _.cloneDeep(before).map((command, i) =>
        Object.assign(command, {
          [ORIGIN]: commands[i].origin ?? 'text',
          [EXPR_ID]: commands[i].exprId,
          [SOURCE]: commands[i].source,
          [BLOCK]: commands[i].block,
        }),
      ),
      random: createHookRandom(`${mk}|before|${hook.id}`),
      math: detMath,
    };
    callHook(hook, ctx);

    const target = toJson(ctx.commands ?? null);
    if (!Array.isArray(target)) {
      throw new Error('ctx.commands 必须是数组');
    }
    // 钩子自己创建的指令没有标记
    const origins: EraCommand['origin'][] = _.map(ctx.commands, command => (command as any)?.[ORIGIN] ?? 'hook');
    const exprIds: (string | undefined)[] = _.map(ctx.commands, command => (command as any)?.[EXPR_ID]);
    const sources: EraCommand['source'][] = _.map(ctx.commands, command => (command as any)?.[SOURCE]);
    const blockIds: (number | undefined)[] = _.map(ctx.commands, command => (command as any)?.[BLOCK]);
    if (_.isEqual(before, target)) {
      return { commands };
    }

    const result: EraCommand[] = [];
    // 钩子新建的指令：表达式种子用 `${mk}|expr|hook|${hook.id}|序号`；复制出的同一身份加上重复序号，互不相同
    let created = 0;
    const seen = new Map<string, number>();
    const assignExprId = (i: number): string | undefined => {
      if (origins[i] === 'hook' && exprIds[i] === undefined) return `hook|${hook.id}|${created++}`;
      const id = exprIds[i];
      if (id === undefined) return undefined;
      const count = seen.get(id) ?? 0;
      seen.set(id, count + 1);
      return count === 0 ? id : `${id}|dup${count}`;
    };
    for (const [i, command] of target.entries()) {
      const data = _.isPlainObject(command?.data) ? [command.data] : command?.data;
      const blocks = Array.isArray(data) ? data.filter(block => _.isPlainObject(block)) : [];
      if (!['insert', 'edit', 'delete', 'patch', 'call'].includes(command?.type) || blocks.length === 0) {
        logger.warn('runBeforeApplyHook', `钩子 ${hook.id} 给出了无效的指令，已忽略`, command);
        continue;
      }
      const exprId = assignExprId(i);
      result.push({
        type: command.type,
        data: isRaw(command.type) ? blocks : escapeEraData(blocks),
        origin: origins[i],
        ...(exprId === undefined ? {} : { exprId }),
        ...(sources[i] === undefined ? {} : { source: sources[i] }),
        ...(blockIds[i] === undefined ? {} : { block: blockIds[i] }),
      });
    }
    return { commands: result };
  } catch (error: any) {
    return { commands, error: describeError(error) };
  }
}
