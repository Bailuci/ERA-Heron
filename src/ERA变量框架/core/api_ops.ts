/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增脚本设置“API写入不修改消息”；新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复第三批改动在审查中发现的问题；表达式 $expr 的稳定身份
 *       2026-11-26 旁路写入新增可选的来源 origin（Era.applyText 从文本解析的写入为 'text'），合并与压缩只在来源相同的写入之间进行
 *       2026-11-27 合并出的旁路写入指令标上 source: 'api'（只用于报告，{{ERA-issues}} 不把它们当成主模型写的）；旁路写入可以是工具调用；带幂等键的写入不合并、不压缩
 *       2026-11-28 旁路写入的位置把正文块与 <era_extra> 分开记（by: body、ax）；来源标记改为 api
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 旁路 API 写入模块
 * @description
 * 脚本设置 `API写入不修改消息` 开启后，`era:insert*` / `era:update*` / `era:delete*` 不再把指令块追加到消息正文，
 * 而是按 MK 保存在 `ERAMetaData.ApiOps` 中，由 `ApplyVarChangeForMessage` 在重算该消息时与正文指令一起执行。
 *
 * - `ApiOps` 与消息正文一样是**源数据**，不能从别处重建；同步只会更新其中的 `applied`。
 * - 重放只取决于数据是否存在，与设置无关，因此关闭设置后已有的写入仍然有效。
 * - 每次写入等价于一个指令块：钩子、schema、`$meta` 保护都照常生效。
 *
 * **位置**: 每条写入记录 `after`，即写入时该消息正文已有的指令块数（不含 `<era_extra>` 里的），重放时排在前 `after` 个正文指令块之后；
 * 写入时已经有额外模型的输出的，另记 `ax`，重放时排在它之后。
 * 若一律排在最后，之后通过“继续”或手动编辑追加的指令会被旧的 API 写入覆盖。
 *
 * 注意：`core/key/mk.ts` 不能导入本文件，否则会形成循环依赖。
 */
'use strict';

import { API_OPS_PATH, ApiOp, ApiOpsRecord } from '../utils/constants';
import { escapeEraData } from '../utils/data';
import { getEraData, updateEraMetaData } from '../utils/era_data';
import { Logger } from '../utils/log';
import { ApiPosition, EraCommand, ParseOptions, parseCommandText } from '../utils/message';
import { traditionalToSimplified } from '../utils/string';
import { parseCharacterMacros } from '../utils/text';
import { isArithmeticExpression } from './crud/arithmetic';
import type { CommandIssue } from './crud/diagnostics';
import { readMessageKey } from './key/mk';

const logger = new Logger();

const OP_TAGS: Partial<Record<ApiOp['type'], string>> = {
  insert: 'VariableInsert',
  edit: 'VariableEdit',
  delete: 'VariableDelete',
  patch: 'VariablePatch',
};

/**
 * 把挂在一条消息上的旁路写入写成指令块的样子，用来告诉更新模型“这些已经计入变量”。
 * 工具调用不列（它产生的改动要执行了才知道）；重复 `n` 次的写入只列一次并注明次数。
 */
export function describeApiOps(mk: string): string {
  const record: ApiOpsRecord | undefined = _.get(getEraData().meta, [API_OPS_PATH, mk]);
  if (!record || !Array.isArray(record.ops)) return '';
  return record.ops
    .flatMap(op => {
      const tag = OP_TAGS[op.type];
      if (!tag) return [];
      const times = (op.n ?? 1) > 1 ? `<!-- 执行了 ${op.n} 次 -->\n` : '';
      // Patch 的数据本来就是操作数组；其余指令一个对象一块，和正文里的写法一样
      const items = op.type === 'patch' ? [op.data] : _.castArray(op.data);
      return items.map(item => `${times}<${tag}>\n${JSON.stringify(item)}\n</${tag}>`);
    })
    .join('\n');
}

/** 单条消息的写入数达到该值时提示作者，前端应对滑块之类的高频写入做防抖。 */
const OPS_WARN_LENGTH = 300;

/**
 * 创建一条写入。宏与繁转简在写入时处理并固定下来，重放时不再处理：
 * 否则改名会悄悄改变历史，名字里的引号也会让数据无法解析。
 * @param at 写入在目标消息里的位置，参见 `apiPositionOf`。
 * @throws 数据无法用 JSON 表示时抛出异常。
 */
export function createApiOp(type: ApiOp['type'], data: any, at: ApiPosition, toSimplified: boolean): ApiOp {
  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new Error('写入的数据无法用 JSON 表示');
  }
  let text = parseCharacterMacros(json);
  if (toSimplified) text = traditionalToSimplified(text);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = JSON.parse(json); // 名字里含有引号等字符
  }
  return { type, data: parsed, ...positionFields(at) };
}

/**
 * 把一段文本中的指令解析成旁路写入（`origin: 'text'`），供 `Era.applyText` 使用。每个指令块是一条写入。
 * 数据在此时解析并固定下来（宏、繁转简都已处理），重放时不再解析文本。
 * @param at 写入在目标消息里的位置，参见 `apiPositionOf`。
 * @param options 目标聊天的解析方式：新聊天中思考块里的指令同样不执行。
 */
export function createTextApiOps(
  text: string,
  at: ApiPosition,
  toSimplified: boolean,
  options?: ParseOptions,
): { ops: ApiOp[]; issues: { path: string; reason: string }[] } {
  const issues: CommandIssue[] = [];
  const commands = parseCommandText(parseCharacterMacros(text ?? ''), toSimplified, issues, options, false);
  const ops = commands.map((command): ApiOp => ({
    type: command.type,
    data: command.data,
    ...positionFields(at),
    origin: 'text',
  }));
  return { ops, issues: issues.map(({ path, reason }) => ({ path, reason })) };
}

/** 位置写进 `ApiOp` 的字段。 */
const positionFields = (at: ApiPosition): Pick<ApiOp, 'after' | 'by' | 'ax'> => ({
  after: at.after,
  by: 'body',
  ...(at.ax ? { ax: true as const } : {}),
});

/** 两条写入的来源是否相同；缺省为 `api`。 */
const sameOrigin = (a: ApiOp, b: ApiOp): boolean => (a.origin ?? 'api') === (b.origin ?? 'api');

/**
 * 一条旁路写入在表达式 `$expr` 随机数种子中的稳定身份：展开 `n` 后在本楼 `ApiOps` 中的执行序号。
 * 压缩（`appendApiOp`）不会删除或越过含 `$expr` 的写入，相同写入合并成 `n` 后展开的序号也不变，因此该序号稳定。
 * 1.8 给写入加上提交编号后，有编号的记录改用“提交编号 + 展开 n 后的条内序号”，撤销前面的提交不会让后面的骰点平移。
 */
const apiExprId = (execIndex: number): string => `api|${execIndex}`;

/**
 * 正文里的指令 `command` 是否排在旁路写入 `op` 之前。三种记法各按自己的方式解释：
 * - `body`：正文指令看“正文块序号”；额外模型的输出整体排在前面还是后面，由写入时它是否已经存在决定；
 * - `block`：正文与额外模型的输出合在一起的块序号；
 * - 缺省：早期版本的计数。
 */
function precedes(command: EraCommand, op: ApiOp, legacy: number): boolean {
  if (op.by === 'body') return command.source === 'extra' ? op.ax === true : (command.body ?? 0) < op.after;
  if (op.by === 'block') return command.block! < op.after;
  return legacy < op.after;
}

/** 把旁路写入与正文指令按位置合并。 */
export function interleaveApiOps(text: EraCommand[], record?: ApiOpsRecord): EraCommand[] {
  if (!record || !Array.isArray(record.ops) || record.ops.length === 0) return text;
  const commands: EraCommand[] = [];
  let t = 0;
  let legacy = 0;
  let execIndex = 0;
  const take = () => {
    if (text[t].legacy) legacy++;
    commands.push(text[t++]);
  };
  for (const op of record.ops) {
    if (op.by === 'body') {
      // 两个条件都要满足：排在前 after 个正文块之后，写入时已有额外模型输出的还要排在它之后。
      // 正文指令之间、正文与额外模型输出之间的先后保持原样，所以取“最后一条必须在它前面的指令”之后
      const last = _.findLastIndex(text, command => precedes(command, op, legacy));
      while (t <= last) take();
    } else {
      while (t < text.length && precedes(text[t], op, legacy)) take();
    }
    for (let i = 0; i < (op.n ?? 1); i++) {
      // 每次都新建，避免多条指令共享同一份数据
      commands.push({
        type: op.type,
        data:
          op.type === 'patch' || op.type === 'call'
            ? _.cloneDeep(_.castArray(op.data))
            : escapeEraData(_.castArray(op.data)),
        // 从文本解析的写入按正文指令处理（下划线只读等），缺省是旁路写入
        origin: op.origin === 'text' ? 'text' : 'api',
        exprId: apiExprId(execIndex++),
        // 只用于报告：Era.applyText 的写入虽然按正文规则执行，也不是主模型这一轮写的
        source: 'api',
      });
    }
  }
  while (t < text.length) take();
  return commands;
}

/**
 * 只修改一个叶子的简单编辑；`plain` 表示直接赋值（不是增量运算）。不是这种编辑时返回 `null`。
 * 从文本解析的写入（`origin: 'text'`）数据是数组；路径上有以 `_` 开头的键时不压缩：开启 `下划线只读` 时它们会被拒绝并报告。
 */
function parseSimpleEdit(op: ApiOp): { path: string[]; plain: boolean } | null {
  if (op.type !== 'edit') return null;
  const keys: string[] = [];
  let node = op.origin === 'text' && Array.isArray(op.data) && op.data.length === 1 ? op.data[0] : op.data;
  while (_.isPlainObject(node)) {
    const own = Object.keys(node);
    if (own.length !== 1) return null;
    keys.push(Object.keys(escapeEraData({ [own[0]]: 0 }))[0]);
    node = node[own[0]];
  }
  const path = _.toPath(keys.join('.'));
  if (
    path.length === 0 ||
    path.some(key => key === '' || key === 'length' || /^\d+$/.test(key) || key.startsWith('$'))
  ) {
    return null;
  }
  if (op.origin === 'text' && path.some(key => key.startsWith('_'))) return null;
  return { path, plain: !isArithmeticExpression(node) };
}

const isPrefix = (a: string[], b: string[]): boolean => a.length <= b.length && a.every((key, i) => key === b[i]);

/**
 * 追加一条写入，返回新的记录（不修改入参）。
 *
 * 相邻的相同写入总是合并为重复次数 `n`（重放时仍作为 n 个独立的块执行）。
 * `compact` 为真时，直接赋值还会取代同一路径上更早的简单编辑，使高频写入只占 O(路径数) 的空间。
 * 合并与压缩都只在来源（`origin`）相同的写入之间进行：来源决定 `下划线只读` 等规则是否适用。
 *
 * 以下合并**不能**做：
 * - 对 `+=` 求和：每一步都可能被钳制，当前值可能是文本，小数还有舍入；
 * - 注册了 schema 时丢弃被覆盖的赋值：`hp=50` 之后被拒绝的 `hp='abc'` 必须留下 50；
 * - 注册了钩子时丢弃被覆盖的赋值：钩子能看到 `ctx.commands`。
 */
export function appendApiOp(record: ApiOpsRecord | undefined, op: ApiOp, compact: boolean): ApiOpsRecord {
  const ops = [...(record?.ops ?? [])];
  const next: ApiOpsRecord = { rev: (record?.rev ?? 0) + 1, applied: record?.applied ?? 0, ops };
  const edit = compact && op.key === undefined ? parseSimpleEdit(op) : null;
  const keyed = (item: ApiOp) => item.key !== undefined;

  for (let i = ops.length - 1; i >= 0; i--) {
    const prev = ops[i];
    // 带幂等键的写入要留着记录 key，不合并也不被取代
    if (
      prev.after !== op.after ||
      prev.by !== op.by ||
      !!prev.ax !== !!op.ax ||
      !sameOrigin(prev, op) ||
      keyed(prev) ||
      keyed(op)
    ) {
      break;
    }
    const prevEdit = edit && parseSimpleEdit(prev);
    if (edit?.plain && prevEdit && _.isEqual(prevEdit.path, edit.path)) {
      ops.splice(i, 1); // 被新的赋值覆盖
      continue;
    }
    if ((i === ops.length - 1 || prevEdit) && prev.type === op.type && _.isEqual(prev.data, op.data)) {
      ops[i] = { ...prev, n: (prev.n ?? 1) + 1 };
      return next;
    }
    if (!edit || !prevEdit || isPrefix(edit.path, prevEdit.path) || isPrefix(prevEdit.path, edit.path)) break;
  }

  ops.push(op);
  if (ops.length === OPS_WARN_LENGTH) {
    logger.warn('appendApiOp', `单条消息的 API 写入已达 ${OPS_WARN_LENGTH} 条，请考虑对高频写入做防抖。`);
  }
  return next;
}

/** 第一条含有尚未执行的旁路写入的消息索引；没有时返回 -1。 */
export function findFirstDirtyIndex(messages: any[], apiOps?: { [mk: string]: ApiOpsRecord }): number {
  if (_.isEmpty(apiOps)) return -1;
  return messages.findIndex(msg => {
    const record = apiOps![readMessageKey(msg)];
    return !!record && record.rev > record.applied;
  });
}

/** 所有消息的所有 swipe 中出现过的 MK。 */
export function collectAliveMks(messages: any[]): Set<string> {
  const alive = new Set<string>();
  for (const msg of messages) {
    for (const text of [msg.mes, msg.message, ...(msg.swipes ?? [])]) {
      if (typeof text !== 'string') continue;
      for (const match of text.matchAll(/"era-message-key"\s*=\s*"(.*?)"/g)) alive.add(match[1]);
    }
  }
  return alive;
}

/** 清除已不属于任何楼层、任何 swipe 的旁路写入。 */
export async function pruneApiOps(): Promise<void> {
  await updateEraMetaData(meta => {
    const apiOps = _.get(meta, API_OPS_PATH);
    if (_.isEmpty(apiOps)) return meta;
    const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: true });
    if (_.isEmpty(messages)) return meta;
    const alive = collectAliveMks(messages);
    const kept = _.pickBy(apiOps, (_record, mk) => alive.has(mk));
    if (_.isEmpty(kept)) _.unset(meta, API_OPS_PATH);
    else _.set(meta, API_OPS_PATH, kept);
    return meta;
  });
}
