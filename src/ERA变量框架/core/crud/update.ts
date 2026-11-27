/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：VariableEdit 支持 +=、-=、*=、/= 增量运算；修复 update 日志记录过期旧值导致的回滚错误；新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复复审中发现的问题；新增表达式 $expr
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 变量编辑模块
 * @description
 * 该模块负责处理 `<VariableEdit>` 指令，实现对已存在变量的修改，并生成用于回滚的精确 `EditLog`。
 *
 * **设计理念**:
 * - **职责单一**: 模块只关心如何根据指令修改变量状态并生成日志，不关心指令从何而来。
 * - **精确日志**: `EditLog` 的准确性是回滚功能的基础，
 *   旧值一律取自修改发生前的实时状态。
 * - **容错性**: 当遇到无效路径（如尝试编辑不存在的路径）时，会跳过该条指令并继续处理其他有效指令，
 *   而不是中断整个写入过程。
 */
'use strict';

import { resolveKeyPath, sanitizeArrays, unescapeEraData } from '../../utils/data';
import { Logger } from '../../utils/log';
import { resolveArithmetic } from './arithmetic';
import { CommandIssue, isReadonlyKey, reportIssue } from './diagnostics';
import { evaluateExpr, ExprFnResolver, isExprLeaf } from './expr';

const logger = new Logger();

/** 表达式 `$expr` 求值所需的上下文，由 `patcher.ts` 按指令创建。 */
export interface EditExprContext {
  /** 本楼开始前的变量（转义过的），供 `@路径` 读取。 */
  oldStat: any;
  /**
   * 为一次 `$expr` 求值分配随机数种子。路径是反转义后的完整路径。
   * 每个目标为数字的 `$expr` 都调用一次，**求值失败也调用**，使后面的骰点不因前面的错误而平移。
   */
  seedFor(path: string): string;
  /** 函数解析器，默认只有内置函数。 */
  resolveFn?: ExprFnResolver;
}

/** 没有传入上下文时的默认值：种子按路径的出现次数分配，`@` 读本批指令开始前的变量。 */
function defaultExprContext(initialStat: any): EditExprContext {
  const occurrences = new Map<string, number>();
  return {
    oldStat: initialStat,
    seedFor(path) {
      const n = occurrences.get(path) ?? 0;
      occurrences.set(path, n + 1);
      return `|expr|${path}|${n}`;
    },
  };
}

/** 说明中引用的表达式，过长时截断。 */
function describeExpr(source: string): string {
  const text = unescapeEraData(source);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function describeValue(value: any): string {
  if (Array.isArray(value)) return '数组';
  if (value === null) return 'null';
  if (typeof value === 'string') return `字符串 ${JSON.stringify(unescapeEraData(value)).slice(0, 40)}`;
  return `${typeof value} ${String(value)}`;
}

/**
 * **【内部辅助函数 | 递归编辑】**
 * 实现了 `<VariableEdit>` 的核心逻辑：**只修改已存在的路径**。
 *
 * **核心规则**:
 * 1. **路径必须存在**。如果指令中指定的路径在当前变量状态中不存在，则跳过该操作。
 * 2. **叶子节点操作**。只在遇到指令对象中的叶子节点（非对象值）时才执行实际的修改和日志记录。
 * 3. **旧值取自实时状态**。`value_old` 直接取修改发生前 `statData` 中的值，保证日志可以精确回滚。
 *
 * @param {any} statData - 要修改的状态数据对象 (会直接被修改)。
 * @param {string} basePath - 当前递归层级的基础路径。
 * @param {any} patchObj - 要应用的补丁对象。
 * @param {any[]} editLog - 用于收集变更记录的日志数组 (会直接被修改)。
 * @param {CommandIssue[]} issues - 用于收集没有生效的修改 (会直接被修改)。
 * @param {boolean} allowReadonly - 是否允许修改以 `_` 开头的只读字段。
 * @param {EditExprContext} exprCtx - 表达式 `$expr` 的上下文。
 */
async function applyEditAtLevel(
  statData: any,
  basePath: string,
  patchObj: any,
  editLog: any[],
  issues: CommandIssue[],
  allowReadonly: boolean,
  exprCtx: EditExprContext,
) {
  // --- 1. 路径和存在性检查 ---
  const currentNodeInVars = basePath ? _.get(statData, basePath) : statData;
  if (currentNodeInVars === undefined) {
    reportIssue(issues, 'edit', basePath, '路径不存在，VariableEdit 只能修改已存在的变量');
    logger.warn('applyEditAtLevel', `VariableEdit 跳过：路径不存在 -> ${basePath || '(root)'}`, {
      basePath,
      patchObj,
    });
    return;
  }

  // --- 2. 权限检查 (`updatable`) ---
  // 读取 updatable 标志，如果未定义，则默认为 true (允许更新)。
  const isUpdatable = _.get(currentNodeInVars, ['$meta', 'updatable'], true);

  // 定义豁免条件：只有当指令明确要将 updatable 从 false 改为 true 时，才允许操作。
  const isBypassingProtection =
    isUpdatable === false && // 当前是受保护的
    _.get(patchObj, ['$meta', 'updatable']) === true; // 且指令意图是明确地将其改为 true

  // 如果受保护且不满足豁免条件，则阻止整个子树的更新。
  if (isUpdatable === false && !isBypassingProtection) {
    reportIssue(issues, 'edit', basePath, '受 $meta.updatable 保护，不能修改');
    logger.warn(
      'applyEditAtLevel',
      `VariableEdit 失败：路径 <${basePath}> 受 "$meta.updatable: false" 保护，无法被修改。`,
      { basePath, patchObj, currentNodeInVars },
    );
    return; // 终止此分支的递归。
  }

  // --- 3. 递归或执行 ---
  // 遍历指令的键，以驱动递归。
  for (const key of Object.keys(patchObj)) {
    const subPath = resolveKeyPath(statData, basePath, key);
    const valNew = patchObj[key];

    if (!allowReadonly && isReadonlyKey(key)) {
      reportIssue(issues, 'edit', subPath, '以 _ 开头的字段是只读的');
      continue;
    }

    // **策略零：表达式**
    // 叶子是只有一个键的 {"$expr": "..."}，且目标当前值是有限数字时求值。
    // 其余情况保持 1.6 的行为：目标是对象时照旧递归（对象本身有 $expr 键就更新这个子键）。
    if (isExprLeaf(valNew) && _.has(statData, subPath)) {
      const current = _.get(statData, subPath);
      if (typeof current === 'number' && Number.isFinite(current)) {
        const seed = exprCtx.seedFor(unescapeEraData(subPath));
        const result = evaluateExpr(valNew.$expr, {
          stat: statData,
          oldStat: exprCtx.oldStat,
          seed,
          resolveFn: exprCtx.resolveFn,
        });
        if (!result.ok) {
          reportIssue(
            issues,
            'edit',
            subPath,
            `$expr 计算失败：${result.reason}（表达式：${describeExpr(valNew.$expr)}）`,
          );
          logger.warn('applyEditAtLevel', `VariableEdit 跳过：路径 <${subPath}> 的表达式无效 -> ${result.reason}`, {
            subPath,
            valNew,
          });
          continue;
        }
        _.set(statData, subPath, result.value);
        editLog.push({ op: 'update', path: subPath, value_old: current, value_new: result.value });
        continue;
      }
      if (!_.isPlainObject(current)) {
        // 1.6 中这里会因 `路径.$expr` 不存在而跳过；结果不变，只是说明更清楚
        reportIssue(issues, 'edit', subPath, `$expr 只能用于数字变量，当前值不是数字（${describeValue(current)}）`);
        continue;
      }
    }

    // **策略一：递归深入**
    // 如果指令的值是对象，则继续向内递归。
    if (_.isPlainObject(valNew)) {
      await applyEditAtLevel(statData, subPath, valNew, editLog, issues, allowReadonly, exprCtx);
      continue; // 继续处理下一个键。
    }

    // **策略二：执行更新 (叶子节点)**
    // 只有当指令的值不是对象时，才执行更新操作。

    // 路径合法性检查：确保要写入的完整路径是存在的。
    if (!_.has(statData, subPath)) {
      reportIssue(issues, 'edit', subPath, '路径不存在，VariableEdit 只能修改已存在的变量');
      logger.warn('applyEditAtLevel', `VariableEdit 失败：路径非法，无法写入 -> ${subPath}`, {
        subPath,
        valNew,
        statData,
      });
      continue;
    }

    // a. 读取旧值
    // statData 是“这条消息之前的状态 + 本条消息已执行的指令”，其实时值就是回滚应恢复到的值。
    // 同一条消息内对同一路径的连续修改会形成首尾相接的日志链，逆序回滚即可还原。
    const valOld = _.get(statData, subPath);

    // b. 解析增量运算（`+=`、`-=`、`*=`、`/=`）
    // 运算必须基于 statData 中的实时值，这样同一条消息内的连续运算才能正确累加。
    const arithmetic = resolveArithmetic(valNew, valOld);
    if (arithmetic.kind === 'invalid') {
      reportIssue(issues, 'edit', subPath, arithmetic.reason);
      logger.warn('applyEditAtLevel', `VariableEdit 跳过：路径 <${subPath}> 的运算无效 -> ${arithmetic.reason}`, {
        subPath,
        valNew,
      });
      continue;
    }

    const cleaned = arithmetic.kind === 'ok' ? arithmetic.value : sanitizeArrays(valNew); // 清理新值

    // c. 记录编辑意图
    // 即使新旧值相同，也记录 EditLog，以完整反映作者的编辑意图。
    // 这对于调试和历史追溯非常有用。
    _.set(statData, subPath, cleaned);
    editLog.push({
      op: 'update',
      path: subPath,
      value_old: _.cloneDeep(valOld),
      value_new: _.cloneDeep(cleaned),
    });
  }
}

/**
 * 处理所有 `<VariableEdit>` 指令块，并返回修改后的状态和日志。
 * 这是一个纯函数，它接收初始状态并返回一个全新的结果对象，不会修改任何外部状态。
 *
 * @param {any[]} allEdits - 从消息中解析出的所有 edit 指令对象。
 * @param {any} initialStat - 操作开始前的初始 `stat` 对象。
 * @param exprCtx - 表达式 `$expr` 的上下文（随机数种子、本楼开始前的变量），由 `patcher.ts` 传入。
 * @returns {Promise<{ finalStat: any, editLog: any[] }>} 一个包含最终状态和生成日志的对象。
 */
export async function processEditBlocks(
  allEdits: any[],
  initialStat: any,
  issues: CommandIssue[] = [],
  allowReadonly = true,
  exprCtx: EditExprContext = defaultExprContext(initialStat),
): Promise<{ finalStat: any; editLog: any[] }> {
  if (!allEdits || allEdits.length === 0) {
    return { finalStat: _.cloneDeep(initialStat), editLog: [] };
  }

  // 创建初始状态的深拷贝，以避免副作用。
  const finalStat = _.cloneDeep(initialStat);
  const editLog: any[] = [];

  // 遍历所有 <VariableEdit> 指令块。
  for (const editRoot of allEdits) {
    if (!_.isPlainObject(editRoot) || _.isEmpty(editRoot)) continue;
    try {
      logger.debug('processEditBlocks', `处理 editRoot: `, editRoot);
      // 从根路径 '' 开始统一递归入口，保持逻辑一致性。
      // applyEditAtLevel 会直接修改 finalStat 和 editLog。
      await applyEditAtLevel(finalStat, '', editRoot, editLog, issues, allowReadonly, exprCtx);
    } catch (e: any) {
      logger.error('processEditBlocks', `处理 editRoot 失败: ${e?.message || e}`, {
        error: e,
        editRoot,
        finalStat,
      });
    }
  }

  logger.debug('processEditBlocks', '所有 VariableEdit 操作完成');
  return { finalStat, editLog };
}
