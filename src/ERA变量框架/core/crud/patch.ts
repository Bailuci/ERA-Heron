/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复第三批改动在审查中发现的问题；修复复审中发现的问题
 *       2026-11-27 新聊天里 VariablePatch 不能改动已有的 $meta
 *       2026-11-28 新聊天：remove、用别的类型的值 replace 时检查其中受保护的内容；move / copy 不能改掉目标的 $meta
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 路径式指令模块
 * @description
 * 处理 `<VariablePatch>`：一个由操作对象组成的数组，语义参照 JSON Patch (RFC 6902)，按顺序执行。
 * 它弥补了 `<VariableInsert>` / `<VariableEdit>` / `<VariableDelete>` 难以表达的操作：
 * 有则改无则插、整体替换对象、数组增删、移动、复制、文本追加、开关切换。
 *
 * - 每个操作独立执行，失败的操作被跳过并报告，不影响其他操作。
 * - `$meta` 的 `updatable` / `necessary` / `unInsertAble` 保护和 `$template` 同样生效。
 * - 数组的增删以“整体替换数组”的形式记入日志，因此可以精确回滚。
 * - 数组中的对象按脚本设置 `数组内保留对象` 存放，与其他指令一致；移动和复制保持原样。
 */
'use strict';

import { escapeEraData, escapeEraKey, sanitizeArrays, unescapeEraData } from '../../utils/data';
import { mergeReserved } from '../schema';
import { resolveArithmetic } from './arithmetic';
import { CommandIssue, findProtectedInside, isReadonlyKey, reportIssue } from './diagnostics';
import { applyInsertAtLevel } from './insert/insert';

const FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'];

/** 操作名的别名，兼容 JSON Patch 和 MVU 的写法。 */
const OP_ALIASES: Record<string, string> = {
  set: 'replace',
  update: 'replace',
  add: 'insert',
  increment: 'delta',
  inc: 'delta',
  delete: 'remove',
  unset: 'remove',
  rename: 'move',
};

class PatchFailure extends Error {}

interface PatchOptions {
  /** 是否允许修改以 `_` 开头的只读字段。 */
  allowReadonly: boolean;
  /** 值来自已有的变量（移动、复制），保持原样存放。 */
  raw?: boolean;
  /** 补全后的保护规则（新聊天）：路径不能指向 `$meta`，整体替换时不能改掉已有的 `$meta`。 */
  strict?: boolean;
}

const META_LOCKED = 'VariablePatch 不能改动 $meta，解除保护请用 VariableInsert / VariableEdit / VariableDelete 的写法';

/** 整体替换后，原来的各级 `$meta` 有没有被改掉或丢掉。 */
function changesMeta(old: any, next: any): boolean {
  if (!_.isPlainObject(old) || !_.isPlainObject(next)) return false;
  if (_.has(old, '$meta') && !_.isEqual(old.$meta, next.$meta)) return true;
  return Object.keys(old).some(key => key !== '$meta' && key !== '$template' && changesMeta(old[key], next[key]));
}

/** 解析路径：`/a/b`（JSON Pointer，`~1` 表示 `/`，`~0` 表示 `~`），或 `a.b`。返回未转义的各级键。 */
export function parsePatchPath(path: unknown): string[] {
  if (Array.isArray(path)) return path.map(String);
  if (typeof path !== 'string') throw new PatchFailure('路径必须是文本');
  const text = path.trim();
  if (text === '' || text === '/') throw new PatchFailure('路径为空');
  let segments = text.startsWith('/')
    ? text
        .slice(1)
        .split('/')
        .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    : text.split('.');
  segments = segments.flatMap(segment => {
    // `列表[0]` 与其他指令一样表示数组下标
    const match = /^([^[\]]+)((?:\[\d+\])+)$/.exec(segment.trim());
    return match ? [match[1].trim(), ...match[2].match(/\d+/g)!] : [segment.trim()];
  });
  if (segments[0] === 'stat_data') segments = segments.slice(1);
  if (segments.length === 0 || segments.some(segment => segment === '' || FORBIDDEN_KEYS.includes(segment))) {
    throw new PatchFailure(`路径无效: ${text}`);
  }
  return segments;
}

interface Target {
  /** 转义后的各级键。 */
  keys: string[];
  /** 日志使用的路径。 */
  path: string;
  /** 已存在的最深一级的值，以及它的深度（0 为根）。 */
  parent: any;
  last: string;
  exists: boolean;
}

const isIndex = (key: string) => /^\d+$/.test(key);

function locate(stat: any, segments: string[]): Target {
  const keys: string[] = [];
  let parent = stat;
  let node = stat;
  let exists = true;
  segments.forEach((segment, depth) => {
    const key = Array.isArray(node) && exists ? segment : escapeEraKey(segment);
    keys.push(key);
    parent = exists ? node : undefined;
    if (exists && Array.isArray(node) && depth === segments.length - 1 && key === '-') {
      exists = false;
    } else if (exists && Array.isArray(node) && !isIndex(key)) {
      if (depth < segments.length - 1 || key !== '-') throw new PatchFailure('数组的位置必须是数字或 -');
      exists = false;
    } else if (exists && _.isObject(node) && Object.prototype.hasOwnProperty.call(node, key)) {
      node = (node as any)[key];
    } else {
      exists = false;
    }
  });
  return { keys, path: keys.join('.'), parent, last: keys[keys.length - 1], exists };
}

const getAt = (stat: any, keys: string[]): any => (keys.length === 0 ? stat : _.get(stat, keys));

/** 从根到目标的每一级（不含目标自身）。 */
function ancestors(stat: any, keys: string[]): any[] {
  return keys.map((_key, depth) => getAt(stat, keys.slice(0, depth)));
}

function assertUpdatable(stat: any, keys: string[], includeSelf: boolean): void {
  const nodes = ancestors(stat, keys);
  if (includeSelf) nodes.push(getAt(stat, keys));
  if (nodes.some(node => _.get(node, ['$meta', 'updatable']) === false)) {
    throw new PatchFailure('受 $meta.updatable 保护，不能修改');
  }
}

function assertRemovable(stat: any, keys: string[]): void {
  const nodes = ancestors(stat, keys);
  if (nodes.some(node => _.get(node, ['$meta', 'necessary']) === 'all')) {
    throw new PatchFailure('受 $meta.necessary 保护，不能删除');
  }
  if (_.get(nodes[nodes.length - 1], ['$meta', 'necessary']) === 'children') {
    throw new PatchFailure('受 $meta.necessary 保护，不能删除');
  }
  const own = _.get(getAt(stat, keys), ['$meta', 'necessary']);
  if (own === 'self' || own === 'all') {
    throw new PatchFailure('受 $meta.necessary 保护，不能删除');
  }
}

function writeUpdate(stat: any, keys: string[], value: any, log: any[]): void {
  const old = getAt(stat, keys);
  if (_.isEqual(old, value)) return;
  log.push({ op: 'update', path: keys.join('.'), value_old: _.cloneDeep(old), value_new: _.cloneDeep(value) });
  _.set(stat, keys, _.cloneDeep(value)); // 不能与日志共享对象，后续操作会原地修改
}

/** 以“整体替换”的形式修改数组。 */
function writeArray(stat: any, keys: string[], change: (array: any[]) => void, log: any[]): void {
  assertUpdatable(stat, keys, true);
  const array = _.cloneDeep(getAt(stat, keys)) as any[];
  change(array);
  writeUpdate(stat, keys, array, log);
}

/** 有则整体替换，无则插入（自动补上缺失的父级，并应用 `$template`）。 */
function upsert(
  stat: any,
  segments: string[],
  value: any,
  log: any[],
  issues: CommandIssue[],
  options: PatchOptions,
): void {
  const target = locate(stat, segments);
  if (target.exists) {
    assertUpdatable(stat, target.keys, true);
    const old = getAt(stat, target.keys);
    // 用对象替换对象时保留原来的（包括各级子对象的）$meta / $template，除非新值自己带有
    let merged = _.isPlainObject(old) && _.isPlainObject(value) ? mergeReserved(old, value) : value;
    if (!options.allowReadonly) merged = keepReadonly(old, merged, target.path, issues);
    assertReplaceable(old, merged);
    if (options.strict) {
      // 移动、复制过来的值（raw）同样不能改掉目标上已有的 $meta
      if (changesMeta(old, merged)) throw new PatchFailure(META_LOCKED);
      // 用标量或数组换掉一个对象（或用别的值换掉数组）时，原来的内容整个丢掉：其中不能有受保护的内容
      const wholesale = _.isPlainObject(old) ? !_.isPlainObject(merged) : Array.isArray(old) && !Array.isArray(merged);
      if (wholesale) assertDroppable(old, options.allowReadonly);
    }
    writeUpdate(stat, target.keys, merged, log);
    return;
  }
  if (Array.isArray(target.parent)) {
    insertIntoArray(stat, target, value, log);
    return;
  }
  insertNew(stat, target.keys, value, log, issues, options);
}

/** 整体替换一个值时，不能改动或丢掉其中受保护的子节点。 */
function assertReplaceable(old: any, next: any): void {
  if (!_.isPlainObject(old)) return;
  const necessary = _.get(old, ['$meta', 'necessary']);
  for (const key of Object.keys(old)) {
    if (key === '$meta' || key === '$template') continue;
    const child = old[key];
    const kept = _.isPlainObject(next) && Object.prototype.hasOwnProperty.call(next, key);
    const own = _.get(child, ['$meta', 'necessary']);
    if (!kept && (necessary === 'all' || necessary === 'children' || own === 'self' || own === 'all')) {
      throw new PatchFailure(`其中的 ${unescapeEraData(key)} 受 $meta.necessary 保护，不能删除`);
    }
    const nextChild = kept ? next[key] : undefined;
    if (_.get(child, ['$meta', 'updatable']) === false && !_.isEqual(child, nextChild)) {
      throw new PatchFailure(`其中的 ${unescapeEraData(key)} 受 $meta.updatable 保护，不能修改`);
    }
    assertReplaceable(child, nextChild);
  }
}

/** 整体替换一个值时，保留其中以 `_` 开头的字段原来的值。 */
function keepReadonly(old: any, next: any, path: string, issues: CommandIssue[]): any {
  if (Array.isArray(old) && Array.isArray(next) && old.length === next.length) {
    return next.map((item, i) => keepReadonly(old[i], item, `${path}.${i}`, issues));
  }
  if (!_.isPlainObject(old)) return next;
  if (!_.isPlainObject(next)) {
    if (Object.keys(old).some(isReadonlyKey)) throw new PatchFailure('其中有以 _ 开头的只读字段');
    return next;
  }
  const result = { ...next };
  for (const key of Object.keys(old)) {
    const given = Object.prototype.hasOwnProperty.call(next, key);
    if (isReadonlyKey(key)) {
      if (given && !_.isEqual(next[key], old[key])) {
        reportIssue(issues, 'patch', `${path}.${key}`, '以 _ 开头的字段是只读的，已保留原来的值');
      }
      result[key] = _.cloneDeep(old[key]);
    } else if (given) {
      result[key] = keepReadonly(old[key], next[key], `${path}.${key}`, issues);
    }
  }
  return result;
}

function insertIntoArray(stat: any, target: Target, value: any, log: any[]): void {
  const parentKeys = target.keys.slice(0, -1);
  const { last } = target;
  if (last !== '-' && !isIndex(last)) throw new PatchFailure('数组的位置必须是数字或 -');
  writeArray(
    stat,
    parentKeys,
    array => {
      const index = last === '-' ? array.length : Number(last);
      if (index > array.length) throw new PatchFailure(`数组下标超出范围: ${last}`);
      array.splice(index, 0, value);
    },
    log,
  );
}

function insertNew(
  stat: any,
  keys: string[],
  value: any,
  log: any[],
  issues: CommandIssue[],
  options: PatchOptions,
): void {
  // 缺失的父级必须能够创建：已存在的最深一级必须是对象
  let depth = keys.length - 1;
  while (depth > 0 && getAt(stat, keys.slice(0, depth)) === undefined) depth--;
  const base = getAt(stat, keys.slice(0, depth));
  if (!_.isPlainObject(base)) {
    throw new PatchFailure(`父级不是对象: ${unescapeEraData(keys.slice(0, depth).join('.'))}`);
  }
  if (keys[keys.length - 1] === '-' && depth < keys.length - 1) {
    throw new PatchFailure('数组不存在，请先用 insert 创建数组');
  }
  // VariableInsert 的递归不会进入数组；路径经过数组时，直接从数组元素开始插入
  const start = ancestors(stat, keys.slice(0, depth + 1)).some(Array.isArray) ? depth : 0;
  const patch = _.reduceRight(keys.slice(start), (inner: any, key) => ({ [key]: inner }), value);
  const parent = start > 0 ? getAt(stat, keys.slice(0, start - 1)) : null;
  const before = log.length;
  const subIssues: CommandIssue[] = [];
  applyInsertAtLevel(stat, keys.slice(0, start).join('.'), patch, log, null, parent, subIssues, options.raw);
  if (log.length === before) {
    issues.push(...subIssues);
    if (subIssues.length === 0) throw new PatchFailure('插入没有生效');
  }
}

/** 整个丢掉 `node`（删除，或用别的类型的值覆盖）之前：它自己和它里面都不能有受保护的内容。 */
function assertDroppable(node: any, allowReadonly: boolean): void {
  const own = _.get(node, ['$meta', 'necessary']);
  if (own === 'self' || own === 'all') throw new PatchFailure('受 $meta.necessary 保护，不能删除');
  const reason = findProtectedInside(node, !allowReadonly);
  if (reason) throw new PatchFailure(reason);
}

/**
 * @param drop 值是不是真的丢掉了（`remove`）。移动（`move`）只是换个位置，不检查里面受保护的内容。
 */
function remove(stat: any, segments: string[], log: any[], drop?: PatchOptions): any {
  const target = locate(stat, segments);
  if (!target.exists) throw new PatchFailure('路径不存在');
  assertRemovable(stat, target.keys);
  if (drop?.strict) assertDroppable(getAt(stat, target.keys), drop.allowReadonly);
  const value = _.cloneDeep(getAt(stat, target.keys));
  if (Array.isArray(target.parent)) {
    if (!isIndex(target.last)) throw new PatchFailure('数组的位置必须是数字');
    writeArray(stat, target.keys.slice(0, -1), array => void array.splice(Number(target.last), 1), log);
  } else {
    log.push({ op: 'delete', path: target.path, value_old: _.cloneDeep(value) });
    _.unset(stat, target.keys);
  }
  return value;
}

function applyOne(stat: any, raw: any, log: any[], issues: CommandIssue[], options: PatchOptions): void {
  if (!_.isPlainObject(raw)) throw new PatchFailure('操作必须是对象');
  const name = String(raw.op ?? '')
    .trim()
    .toLowerCase();
  const op = OP_ALIASES[name] ?? name;
  const hasValue = Object.prototype.hasOwnProperty.call(raw, 'value');
  const requireValue = () => {
    if (!hasValue) throw new PatchFailure('缺少 value');
    return sanitizeArrays(escapeEraData(_.cloneDeep(raw.value)));
  };

  switch (op) {
    case 'replace':
      upsert(stat, parsePatchPath(raw.path), requireValue(), log, issues, options);
      return;
    case 'insert': {
      const segments = parsePatchPath(raw.path);
      const value = requireValue();
      const target = locate(stat, segments);
      if (Array.isArray(target.parent)) insertIntoArray(stat, target, asElement(value), log);
      else upsert(stat, segments, value, log, issues, options);
      return;
    }
    case 'append': {
      const target = locate(stat, parsePatchPath(raw.path));
      const value = requireValue();
      const old = target.exists ? getAt(stat, target.keys) : undefined;
      if (Array.isArray(old)) {
        writeArray(stat, target.keys, array => void array.push(asElement(value)), log);
      } else if (typeof old === 'string') {
        assertUpdatable(stat, target.keys, true);
        writeUpdate(stat, target.keys, old + String(value), log);
      } else {
        throw new PatchFailure('只能对数组或文本执行 append');
      }
      return;
    }
    case 'delta': {
      const target = locate(stat, parsePatchPath(raw.path));
      const value = requireValue();
      if (!target.exists) throw new PatchFailure('路径不存在');
      const old = getAt(stat, target.keys);
      const text = String(value).trim();
      const expression = /^[+\-*/]=/.test(text) ? text : `+=${text}`;
      const result = resolveArithmetic(expression, old);
      if (result.kind === 'invalid') throw new PatchFailure(result.reason);
      if (result.kind === 'none') throw new PatchFailure('当前值或增量不是数字');
      assertUpdatable(stat, target.keys, true);
      writeUpdate(stat, target.keys, result.value, log);
      return;
    }
    case 'toggle': {
      const target = locate(stat, parsePatchPath(raw.path));
      const old = target.exists ? getAt(stat, target.keys) : undefined;
      if (typeof old !== 'boolean') throw new PatchFailure('当前值不是布尔值');
      assertUpdatable(stat, target.keys, true);
      writeUpdate(stat, target.keys, !old, log);
      return;
    }
    case 'remove':
      remove(stat, parsePatchPath(raw.path), log, options);
      return;
    case 'move':
    case 'copy': {
      const from = parsePatchPath(raw.from);
      const to = parsePatchPath(raw.to ?? raw.path);
      if (_.isEqual(from, to)) return;
      if (op === 'move' && _.isEqual(to.slice(0, from.length), from)) throw new PatchFailure('不能移动到自身内部');
      // 在副本上完整执行，任何一步失败都不留下一半的结果
      const draft = _.cloneDeep(stat);
      const draftLog: any[] = [];
      const draftIssues: CommandIssue[] = [];
      let value: any;
      if (op === 'move') {
        value = remove(draft, from, draftLog);
      } else {
        const source = locate(draft, from);
        if (!source.exists) throw new PatchFailure('路径不存在');
        value = _.cloneDeep(getAt(draft, source.keys));
      }
      const target = locate(draft, to);
      if (Array.isArray(target.parent)) insertIntoArray(draft, target, value, draftLog);
      else upsert(draft, to, value, draftLog, draftIssues, { ...options, raw: true });
      if (draftIssues.length > 0) throw new PatchFailure(draftIssues[0].reason);
      replaceContent(stat, draft);
      log.push(...draftLog);
      return;
    }
    default:
      throw new PatchFailure(`未知的操作: ${name || '(空)'}`);
  }
}

/** 作为数组元素存放的值。 */
const asElement = (value: any): any => sanitizeArrays([value])[0];

/** 把 `target` 的内容原地换成 `source`。 */
function replaceContent(target: any, source: any): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

/**
 * 执行 `<VariablePatch>` 中的全部操作。纯函数。
 * @param blocks 解析出的内容：操作对象，或操作对象的数组。未转义。
 * @param allowReadonly 是否允许修改以 `_` 开头的只读字段。
 * @param strict 补全后的保护规则（新聊天）：不能改动 `$meta`。
 */
export async function processPatchBlocks(
  blocks: any[],
  initialStat: any,
  issues: CommandIssue[] = [],
  allowReadonly = true,
  strict = false,
): Promise<{ finalStat: any; editLog: any[] }> {
  const finalStat = _.cloneDeep(initialStat);
  const editLog: any[] = [];
  for (const raw of _.flattenDeep(blocks) as any[]) {
    const label = typeof raw?.path === 'string' ? raw.path : String(raw?.from ?? '');
    const draftLog: any[] = [];
    const snapshot = _.cloneDeep(finalStat);
    try {
      if (strict) {
        // 文档一直写的是“Patch 不能解除保护”：已存在的 $meta（连同它内部）不能作为操作的目标或来源
        for (const path of [raw?.path, raw?.from, raw?.to]) {
          if (path === undefined) continue;
          const segments = parsePatchPath(path);
          const meta = segments.indexOf('$meta');
          if (meta !== -1 && locate(finalStat, segments.slice(0, meta + 1)).exists) throw new PatchFailure(META_LOCKED);
        }
      }
      if (!allowReadonly) {
        for (const path of [raw?.path, raw?.from, raw?.to]) {
          if (path === undefined) continue;
          const segments = parsePatchPath(path);
          // 已存在的只读字段，连同它内部的任何位置都不能改；可以新建还不存在的
          const readonly = segments.findIndex(isReadonlyKey);
          if (readonly !== -1 && locate(finalStat, segments.slice(0, readonly + 1)).exists) {
            throw new PatchFailure('以 _ 开头的字段是只读的');
          }
        }
      }
      applyOne(finalStat, raw, draftLog, issues, { allowReadonly, strict });
      editLog.push(...draftLog);
    } catch (error: any) {
      replaceContent(finalStat, snapshot);
      if (!(error instanceof PatchFailure)) throw error;
      reportIssue(issues, 'patch', label, error.message);
    }
  }
  return { finalStat, editLog };
}
