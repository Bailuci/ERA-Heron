/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增可选的变量结构 schema 校验与全局接口 Era；修复 schema 校验在审查与实测中发现的问题；新增更新钩子 Era.onBeforeApply / Era.onAfterApply；修复第二批改动在审查中发现的问题等
 *       2026-11-27 拦截记录带上指令的来源标记 source，只用于报告
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - Schema 校验模块
 * @description
 * 为 ERA 提供**可选的**变量结构约束。角色卡作者可以注册一个 zod schema（或任何带 `safeParse` 的对象），
 * ERA 会在每个指令块应用之后用它检查 `stat_data`：
 *
 * 1. **纠正**：schema 的 `transform` / `coerce` / `prefault` 等产生的修正（如把 `"5"` 转成 `5`、
 *    把 150 钳制到 100、补全缺失的默认字段）会被写回变量。
 * 2. **拦截**：会让原本合法的状态变得不合法的修改会被丢弃，其余修改照常生效。
 *
 * **与回滚机制的关系**:
 * 纠正和拦截的结果全部体现在 `EditLog` 中——被拦截的条目不会进入日志，纠正产生的差异会作为额外的
 * `update` / `insert` / `delete` 条目追加到日志末尾。因此“逆序回滚，顺序重算”无需任何改动。
 *
 * **未注册 schema 时，本模块不会被调用，ERA 的行为与之前完全一致。**
 *
 * 本文件中的函数都是纯函数：schema 由参数传入，不读取任何全局状态。
 */
'use strict';

import { escapeEraData, unescapeEraData } from '../utils/data';
import { applyForward } from './timetravel';

/**
 * ERA 对 schema 的最小要求：一个 `safeParse` 方法。zod 的所有 schema 都满足。
 * 这里不直接依赖 zod 的类型，是因为 schema 由其他脚本（另一个 iframe、另一个 zod 实例）创建。
 */
export interface EraSchemaLike {
  safeParse(data: unknown): { success: boolean; data?: any; error?: any };
}

/** 一条被 schema 拦截的修改。 */
export interface SchemaRejection {
  /** 被拦截的操作类型。 */
  op: 'insert' | 'update' | 'delete';
  /** 被拦截的变量路径（已反转义，可直接展示）。 */
  path: string;
  /** 指令试图写入的值；`delete` 操作没有该字段。 */
  value?: any;
  /** schema 给出的错误说明。 */
  message: string;
  /** 来自哪种指令；由 afterApply 钩子引起时没有。 */
  origin?: 'text' | 'api' | 'hook' | 'tool';
  /** 指令的来源标记，参见 `EraCommand.source`；主模型写在正文里的指令没有。 */
  source?: 'extra' | 'api';
}

/** 校验时的可选行为。 */
export interface SchemaOptions {
  /**
   * 是否保留 schema 根对象上没有定义的键。
   * 为 `true` 时，纠正阶段不会删除 `stat_data` 顶层那些不在 schema 解析结果里的变量。
   */
  keepUnknownRootKeys?: boolean;
}

export interface SchemaCheckResult {
  /** 校验（拦截 + 纠正）之后的 `stat_data`。 */
  finalStat: any;
  /** 与 `finalStat` 对应的 `EditLog`。 */
  editLog: any[];
  /** 被拦截的修改。 */
  rejections: SchemaRejection[];
  /** schema 纠正所追加的日志条目数量。 */
  normalizedCount: number;
  /**
   * 未能执行校验的原因：
   * - `pre_invalid`: 修改前的状态本身就不符合 schema，无法判断是哪条修改造成的，因此全部放行。
   * - `schema_error`: schema 的 `safeParse` 抛出了异常。
   */
  skipped?: 'pre_invalid' | 'schema_error';
  /** `skipped` 时的错误说明。 */
  skippedMessage?: string;
}

/** ERA 自身使用的保留字段，不属于作者定义的变量结构，校验时需要剔除、写回时需要保留。 */
const RESERVED_KEYS = ['$meta', '$template'];
const isReservedKey = (key: string) => RESERVED_KEYS.includes(key);

/**
 * 递归移除 ERA 的保留字段（`$meta`、`$template`），返回新对象。
 * 与 `removeMetaFields` 不同，它保留其他以 `$` 开头的键，因为作者的 schema 可能会定义它们（如 `$time`）。
 */
export function stripReserved(value: any): any {
  if (Array.isArray(value)) {
    return value.map(stripReserved);
  }
  if (_.isPlainObject(value)) {
    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      if (!isReservedKey(key)) {
        result[key] = stripReserved(value[key]);
      }
    }
    return result;
  }
  return value;
}

/** 将 zod 的错误对象（或任意异常）格式化为简短的多行文本。 */
export function formatSchemaError(error: any): string {
  const issues = error?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue: any) => {
        const path = Array.isArray(issue?.path) && issue.path.length > 0 ? issue.path.join('.') : '(根)';
        return `${path}: ${issue?.message ?? '不符合变量结构'}`;
      })
      .join('\n');
  }
  return String(error?.message ?? error ?? '不符合变量结构');
}

type ParseOutcome = { ok: true; data: any } | { ok: false; message: string; thrown: boolean };

/** 用 schema 解析一份（转义过的、带保留字段的）`stat_data`。 */
function parseStat(schema: EraSchemaLike, stat: any): ParseOutcome {
  try {
    const result = schema.safeParse(stripReserved(unescapeEraData(stat)));
    if (!result.success) {
      return { ok: false, message: formatSchemaError(result.error), thrown: false };
    }
    // 变量最终以 JSON 形式保存，这里先把解析结果规范成 JSON 能表示的样子，
    // 否则 Date 等类型每次都会与已保存的字符串“不相等”，在每条消息上反复产生日志。
    const data = JSON.parse(JSON.stringify(result.data ?? null));
    if (!_.isPlainObject(data)) {
      return { ok: false, message: 'schema 的解析结果必须是一个对象', thrown: false };
    }
    return { ok: true, data };
  } catch (error: any) {
    return { ok: false, message: String(error?.message ?? error), thrown: true };
  }
}

/** 键名能否作为 lodash 路径中的**单独一段**。含 `[`、`]` 等字符的键会被 lodash 拆成多段。 */
function isSafePathKey(key: string): boolean {
  const segments = _.toPath(key);
  return segments.length === 1 && segments[0] === key;
}

/**
 * 以 schema 的解析结果 `target` 为准，把 `current` 中的保留字段（`$meta`、`$template`）合并回去。
 * 用于需要整体替换一个值（数组、或键名无法用路径表达的对象）的场景，避免替换时丢掉保留字段。
 */
export function mergeReserved(current: any, target: any): any {
  if (_.isPlainObject(current) && _.isPlainObject(target)) {
    const result: Record<string, any> = {};
    for (const key of Object.keys(current)) {
      if (isReservedKey(key)) {
        result[key] = _.cloneDeep(current[key]);
      }
    }
    for (const key of Object.keys(target)) {
      if (target[key] !== undefined) {
        result[key] = mergeReserved(current[key], target[key]);
      }
    }
    return result;
  }
  if (Array.isArray(current) && Array.isArray(target) && current.length === target.length) {
    return target.map((item, index) => mergeReserved(current[index], item));
  }
  if (Array.isArray(current) && Array.isArray(target)) {
    // 长度变化时，内容没有改变的元素保留它原来的保留字段
    const unused = new Set(current.keys());
    return target.map(item => {
      const index = [...unused].find(i => _.isEqual(stripReserved(current[i]), item));
      if (index === undefined) return _.cloneDeep(item);
      unused.delete(index);
      return _.cloneDeep(current[index]);
    });
  }
  return _.cloneDeep(target);
}

export interface DiffOptions {
  /** 是否保留 `stat_data` 顶层那些不在解析结果里的键。 */
  keepUnknownRootKeys: boolean;
  /** 是否为解析结果里多出来的键（通常是 schema 的默认值）生成 `insert` 条目。 */
  allowInsert: boolean;
}

/** 如果整体替换后的值与当前值不同，则追加一条 `update` 条目。 */
function pushWholeUpdate(current: any, target: any, path: string, out: any[]): void {
  const merged = mergeReserved(current, target);
  // 以反转义后的值比较：数组内被字符串化的对象，转义前后写法不同但值相同
  if (!_.isEqual(unescapeEraData(current), unescapeEraData(merged))) {
    out.push({ op: 'update', path, value_old: _.cloneDeep(current), value_new: merged });
  }
}

/**
 * 比较当前变量 `current` 与 schema 解析结果 `target`，生成把前者变成后者所需的 `EditLog` 条目。
 *
 * - 两边都是对象时逐键递归，因此差异会尽量落在叶子路径上。
 * - `current` 中的保留字段（`$meta`、`$template`）不参与比较，也不会被删除。
 * - `target` 中值为 `undefined` 的键视为不存在。
 * - 数组作为整体比较和替换。
 * - 如果对象里有无法用路径表达的键（如含 `[`），该对象同样作为整体替换。
 */
function diffToLog(current: any, target: any, basePath: string, out: any[], options: DiffOptions): void {
  if (_.isPlainObject(current) && _.isPlainObject(target)) {
    const currentKeys = Object.keys(current).filter(key => !isReservedKey(key));
    const targetKeys = Object.keys(target).filter(key => target[key] !== undefined);
    let keys = _.union(currentKeys, targetKeys);

    if (keys.some(key => !isSafePathKey(key))) {
      if (basePath) {
        // 无法为这些键生成路径，把整个对象当作一个值来替换。
        pushWholeUpdate(current, target, basePath, out);
        return;
      }
      // 根对象无法整体替换，只能跳过这些键（包括解析结果中与它们对应的、转义后的键）。
      const unsafe = keys.filter(key => !isSafePathKey(key)).map(key => unescapeEraData(key));
      keys = keys.filter(key => isSafePathKey(key) && !unsafe.includes(unescapeEraData(key)));
    }

    for (const key of keys) {
      const path = basePath ? `${basePath}.${key}` : key;
      const inCurrent = currentKeys.includes(key);
      const inTarget = targetKeys.includes(key);

      if (inCurrent && !inTarget) {
        if (!basePath && options.keepUnknownRootKeys) continue;
        out.push({ op: 'delete', path, value_old: _.cloneDeep(current[key]) });
      } else if (!inCurrent && inTarget) {
        if (!options.allowInsert) continue;
        out.push({ op: 'insert', path, value_new: _.cloneDeep(target[key]) });
      } else {
        diffToLog(current[key], target[key], path, out, options);
      }
    }
    return;
  }

  if (basePath) {
    pushWholeUpdate(current, target, basePath, out);
  }
}

/**
 * 把 schema 的解析结果写回 `stat`，返回新的 `stat` 以及为此追加的日志条目。
 * @param stat 当前的 `stat_data`（不会被修改）。
 * @param parsedData schema 的解析结果（未转义）。
 */
export function normalizeWith(stat: any, parsedData: any, options: DiffOptions): { stat: any; extraLog: any[] } {
  const extraLog: any[] = [];
  diffToLog(stat, escapeEraData(parsedData), '', extraLog, options);
  if (extraLog.length === 0) {
    return { stat, extraLog };
  }
  return { stat: applyForward(_.cloneDeep(stat), extraLog), extraLog };
}

/**
 * **【完整纠正】** 用 schema 纠正一份 `stat_data`，包括补全 schema 的默认值。
 * 在一条消息的全部指令执行完之后调用一次。
 *
 * 如果当前状态不符合 schema，则原样返回。
 */
export function normalizeStat(schema: EraSchemaLike, stat: any, options: SchemaOptions = {}): SchemaCheckResult {
  const parsed = parseStat(schema, stat);
  if (!parsed.ok) {
    return {
      finalStat: stat,
      editLog: [],
      rejections: [],
      normalizedCount: 0,
      skipped: parsed.thrown ? 'schema_error' : 'pre_invalid',
      skippedMessage: parsed.message,
    };
  }
  const { stat: finalStat, extraLog } = normalizeWith(stat, parsed.data, {
    keepUnknownRootKeys: options.keepUnknownRootKeys === true,
    allowInsert: true,
  });
  return { finalStat, editLog: extraLog, rejections: [], normalizedCount: extraLog.length };
}

/**
 * **【拦截 + 纠正已有值】** 用 schema 检查一个指令块的执行结果。
 *
 * 处理流程：
 * 1. 指令块执行后的状态符合 schema → 只纠正已有的值。
 * 2. 不符合，且执行前的状态也不符合 → 无法归因，全部放行（`skipped: 'pre_invalid'`）。
 *    这保证了“变量还没初始化完整”或“中途才注册 schema”时不会把所有修改都卡死。
 * 3. 不符合，但执行前的状态符合 → 逐条重放该指令块的 `EditLog`，
 *    丢弃会让状态变得不合法的条目，保留其余条目，最后纠正已有的值。
 *
 * **这里不会补全 schema 的默认值**：同一条消息里后面的 `<VariableInsert>` 可能正要初始化那些字段，
 * 提前写入默认值会让它们因“路径已存在”而被忽略。默认值由 `normalizeStat` 在整条消息处理完后统一补全。
 *
 * @param schema 已注册的 schema。
 * @param prevStat 指令块执行前的 `stat_data`（不会被修改）。
 * @param nextStat 指令块执行后的 `stat_data`（不会被修改）。
 * @param editLog 指令块生成的 `EditLog`。
 */
export function applySchemaToBlock(
  schema: EraSchemaLike,
  prevStat: any,
  nextStat: any,
  editLog: any[],
  options: SchemaOptions = {},
): SchemaCheckResult {
  const diffOptions: DiffOptions = {
    keepUnknownRootKeys: options.keepUnknownRootKeys === true,
    allowInsert: false,
  };
  const unchanged = (skipped: SchemaCheckResult['skipped'], skippedMessage: string): SchemaCheckResult => ({
    finalStat: nextStat,
    editLog,
    rejections: [],
    normalizedCount: 0,
    skipped,
    skippedMessage,
  });

  // 1. 整体通过：只做纠正
  const post = parseStat(schema, nextStat);
  if (post.ok) {
    const { stat, extraLog } = normalizeWith(nextStat, post.data, diffOptions);
    return {
      finalStat: stat,
      editLog: extraLog.length > 0 ? [...editLog, ...extraLog] : editLog,
      rejections: [],
      normalizedCount: extraLog.length,
    };
  }
  if (post.thrown) {
    return unchanged('schema_error', post.message);
  }

  // 2. 执行前就不合法：无法归因，放行
  const pre = parseStat(schema, prevStat);
  if (!pre.ok) {
    return unchanged(pre.thrown ? 'schema_error' : 'pre_invalid', pre.message);
  }

  // 3. 逐条重放，丢弃造成不合法的条目
  let currentStat = _.cloneDeep(prevStat);
  let currentData = pre.data;
  const acceptedLog: any[] = [];
  // 一旦有条目没按原顺序生效，后续条目记录的 value_old 就可能与重放时的实际状态不符，需要重新取值。
  let diverged = false;

  let pending: { entry: any; message: string }[] = editLog.map(entry => ({ entry, message: '' }));
  // 被拒绝的条目会在其他条目生效后重试：跨字段约束（如 hp <= maxHp）下，
  // 单独应用不合法的条目，在同一指令块的其他条目生效后可能就合法了。
  for (;;) {
    const stillRejected: typeof pending = [];
    let acceptedInThisPass = 0;

    for (const item of pending) {
      let entry = item.entry;
      if (diverged && (entry.op === 'update' || entry.op === 'delete') && _.has(currentStat, entry.path)) {
        entry = { ...entry, value_old: _.cloneDeep(_.get(currentStat, entry.path)) };
      }
      const trialStat = applyForward(_.cloneDeep(currentStat), [entry]);
      const trial = parseStat(schema, trialStat);
      if (trial.ok) {
        currentStat = trialStat;
        currentData = trial.data;
        acceptedLog.push(entry);
        acceptedInThisPass++;
      } else {
        stillRejected.push({ entry: item.entry, message: trial.message });
        diverged = true;
      }
    }

    pending = stillRejected;
    if (pending.length === 0 || acceptedInThisPass === 0) break;
  }

  const rejections: SchemaRejection[] = pending.map(({ entry, message }) => {
    const rejection: SchemaRejection = {
      op: entry.op,
      path: unescapeEraData(String(entry.path ?? '')),
      message,
    };
    if (entry.op !== 'delete') {
      rejection.value = unescapeEraData(_.cloneDeep(entry.value_new));
    }
    return rejection;
  });

  const { stat, extraLog } = normalizeWith(currentStat, currentData, diffOptions);
  return {
    finalStat: stat,
    editLog: [...acceptedLog, ...extraLog],
    rejections,
    normalizedCount: extraLog.length,
  };
}
