/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：重新设计面板：变量编辑工作台（搜索、节点编辑、粘贴 JSON 计算差异、提交前试算）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 面板 - 变量编辑工作台的纯函数
 * @description
 * 面板里对变量的修改先暂存为 `<VariablePatch>` 操作，提交时统一走 `Era.commit([{ patch }], { atomic: true })`，
 * 与指令、旁路写入一样记入历史，可以回滚。这里只做路径、差异和保护检查，不读写任何数据。
 */
'use strict';

/** 面板生成的路径操作，是 `<VariablePatch>` 的子集。 */
export type WorkbenchOp =
  | { op: 'replace'; path: string; value: any }
  | { op: 'insert'; path: string; value: any }
  | { op: 'remove'; path: string };

/** 保留键：面板不修改保护规则和模板。 */
export const RESERVED_KEYS = ['$meta', '$template'];

const isPlainObject = (value: any): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 把键序列编码为 JSON Pointer（`~` → `~0`，`/` → `~1`）。 */
export function toPointer(segments: (string | number)[]): string {
  return segments.map(segment => '/' + String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

/** 把 JSON Pointer 解码为键序列。 */
export function fromPointer(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .split('/')
    .slice(1)
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** 显示用的路径：`a.b[0].c`。 */
export function displayPath(pointer: string): string {
  const parts = fromPointer(pointer);
  if (parts.length === 0) return '（根）';
  return parts.map((part, index) => (/^\d+$/.test(part) ? `[${part}]` : index === 0 ? part : `.${part}`)).join('');
}

/** 读取路径上的值；不存在时返回 `undefined`。 */
export function getAt(root: any, segments: string[]): any {
  let node = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[Number(segment)] : node[segment];
  }
  return node;
}

/**
 * 在本地草稿上执行一个操作，与 ERA 的 Patch 语义一致的部分：
 * `replace` 覆盖或新建（缺失的父级补成对象），`insert` 在数组中插入（`-` 追加），`remove` 删除（数组元素前移）。
 * 草稿只用于显示，真正的结果以 `Era.simulate` / `Era.commit` 为准。
 * @returns 是否成功执行。
 */
export function applyLocal(root: any, op: WorkbenchOp): boolean {
  const segments = fromPointer(op.path);
  if (segments.length === 0) return false;
  const key = segments[segments.length - 1];
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return false;
    let next = Array.isArray(parent) ? parent[Number(segment)] : parent[segment];
    if (next === undefined && op.op === 'replace' && !Array.isArray(parent)) {
      next = {};
      parent[segment] = next;
    }
    parent = next;
  }
  if (parent === null || typeof parent !== 'object') return false;
  const value = 'value' in op ? _.cloneDeep(op.value) : undefined;
  if (Array.isArray(parent)) {
    const index = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0) return false;
    if (op.op === 'remove') {
      if (index >= parent.length) return false;
      parent.splice(index, 1);
    } else if (op.op === 'insert') {
      if (index > parent.length) return false;
      parent.splice(index, 0, value);
    } else {
      if (index > parent.length) return false;
      parent[index] = value;
    }
    return true;
  }
  if (op.op === 'remove') {
    if (!(key in parent)) return false;
    delete parent[key];
    return true;
  }
  parent[key] = value;
  return true;
}

/** 生成 `<VariablePatch>` 指令文本，用于 `Era.simulate` 试算。 */
export function opsToText(ops: WorkbenchOp[]): string {
  return `<VariablePatch>\n${JSON.stringify(ops, null, 2)}\n</VariablePatch>`;
}

export interface DiffResult {
  ops: WorkbenchOp[];
  /** 被忽略的保留键路径（`$meta` / `$template`）。 */
  ignored: string[];
}

/**
 * 计算把 `current` 变成 `next` 所需的操作。只比较普通键：`$meta`、`$template` 被忽略（保护规则不在这里改）。
 * 对象逐键比较；数组或类型不同的值整体替换（与 ERA 记录数组改动的方式一致）。
 */
export function diffToOps(current: any, next: any): DiffResult {
  if (!isPlainObject(next)) throw new Error('粘贴的内容必须是一个 JSON 对象（最外层是 { }）');
  const ops: WorkbenchOp[] = [];
  const ignored: string[] = [];
  const walk = (before: any, after: any, segments: string[]) => {
    for (const key of Object.keys(before)) {
      if (RESERVED_KEYS.includes(key)) continue;
      if (!(key in after)) ops.push({ op: 'remove', path: toPointer([...segments, key]) });
    }
    for (const key of Object.keys(after)) {
      const path = [...segments, key];
      if (RESERVED_KEYS.includes(key)) {
        if (!_.isEqual(before?.[key], after[key])) ignored.push(toPointer(path));
        continue;
      }
      if (!(key in before)) {
        ops.push({ op: 'replace', path: toPointer(path), value: after[key] });
      } else if (isPlainObject(before[key]) && isPlainObject(after[key])) {
        walk(before[key], after[key], path);
      } else if (!_.isEqual(before[key], after[key])) {
        ops.push({ op: 'replace', path: toPointer(path), value: after[key] });
      }
    }
  };
  walk(isPlainObject(current) ? current : {}, next, []);
  return { ops, ignored };
}

export interface ProtectionHint {
  level: 'block' | 'info';
  text: string;
}

/**
 * 根据完整状态（含 `$meta`）提示操作可能遇到的保护。只是提示，最终以试算结果为准。
 * @param stat 含 `$meta` 的状态。
 * @param readonlyUnderscore 脚本设置 `下划线只读` 是否开启。
 */
export function protectionHints(stat: any, op: WorkbenchOp, readonlyUnderscore: boolean): ProtectionHint[] {
  const segments = fromPointer(op.path);
  const hints: ProtectionHint[] = [];
  let node = stat;
  for (let i = 0; i < segments.length; i++) {
    if (!isPlainObject(node) && !Array.isArray(node)) break;
    const meta = isPlainObject(node) ? (node as Record<string, any>).$meta : undefined;
    const isLast = i === segments.length - 1;
    if (isPlainObject(meta)) {
      const where = displayPath(toPointer(segments.slice(0, i)));
      if (meta.updatable === false && op.op === 'replace') {
        hints.push({ level: 'block', text: `${where} 设置了 $meta.updatable: false，修改会被拒绝` });
      }
      if (op.op === 'remove') {
        const necessary = meta.necessary;
        if (necessary === 'all' || (necessary === 'children' && isLast)) {
          hints.push({ level: 'block', text: `${where} 设置了 $meta.necessary: "${necessary}"，删除会被拒绝` });
        }
      }
      const adding = (op.op === 'replace' || op.op === 'insert') && getAt(stat, segments) === undefined;
      if (adding && (meta.unInsertAble === 'all' || (meta.unInsertAble === 'self' && isLast))) {
        hints.push({
          level: 'block',
          text: `${where} 设置了 $meta.unInsertAble: "${meta.unInsertAble}"，新增会被拒绝`,
        });
      }
    }
    node = Array.isArray(node) ? node[Number(segments[i])] : node[segments[i]];
  }
  const target = isPlainObject(node) ? node.$meta : undefined;
  if (op.op === 'remove' && isPlainObject(target) && ['self', 'all'].includes(target.necessary)) {
    hints.push({ level: 'block', text: `该节点设置了 $meta.necessary: "${target.necessary}"，删除会被拒绝` });
  }
  if (op.op === 'replace' && isPlainObject(target) && target.updatable === false) {
    hints.push({ level: 'block', text: '该节点设置了 $meta.updatable: false，修改会被拒绝' });
  }
  if (readonlyUnderscore && segments.some(segment => segment.startsWith('_'))) {
    hints.push({ level: 'info', text: '以 _ 开头的字段：“下划线只读”只限制 AI 的指令，面板提交不受限制' });
  }
  return _.uniqBy(hints, 'text');
}

/** 试算报告的问题是否只是 `下划线只读` 造成的（面板提交属于旁路写入，不受此限制）。 */
export function isUnderscoreOnlyProblem(problem: { path: string; reason: string }): boolean {
  return /下划线|只读/.test(problem.reason) && /(^|[./[])_/.test(problem.path);
}

export type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'json';

export function kindOf(value: any): ValueKind {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'json';
}

/** 把编辑框中的文本按选择的类型转换成值；无法转换时抛出异常。 */
export function parseInput(text: string, kind: ValueKind): any {
  switch (kind) {
    case 'string':
      return text;
    case 'number': {
      const trimmed = text.trim();
      const value = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(value)) throw new Error('请输入有效的数字');
      return value;
    }
    case 'boolean':
      if (text === 'true') return true;
      if (text === 'false') return false;
      throw new Error('请选择 true 或 false');
    case 'null':
      return null;
    default:
      try {
        return JSON.parse(text);
      } catch (error: any) {
        throw new Error(`JSON 格式错误：${error?.message ?? error}`);
      }
  }
}

/** 值的单行预览。 */
export function preview(value: any, max = 80): string {
  let text: string;
  if (value === undefined) text = 'undefined';
  else if (typeof value === 'string') text = JSON.stringify(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 搜索：返回匹配的节点路径，以及需要展开的祖先路径（不含匹配节点自身）。按键名、路径（`a.b.c`）或原始值匹配，不区分大小写。
 * @param limit 最多匹配的数量，避免超大状态下卡顿。
 */
export function searchTree(
  root: any,
  query: string,
  limit = 500,
): { matches: Set<string>; ancestors: Set<string>; truncated: boolean } {
  const needle = query.trim().toLowerCase();
  const matches = new Set<string>();
  const ancestors = new Set<string>();
  let truncated = false;
  if (!needle) return { matches, ancestors, truncated };
  const walk = (node: any, segments: string[], dotted: string) => {
    if (truncated) return;
    const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node);
    for (const [key, value] of entries) {
      if (truncated) return;
      if (RESERVED_KEYS.includes(key)) continue;
      const childSegments = [...segments, key];
      const childDotted = Array.isArray(node) ? `${dotted}[${key}]` : dotted ? `${dotted}.${key}` : key;
      const isContainer = value !== null && typeof value === 'object';
      const hit =
        key.toLowerCase().includes(needle) ||
        childDotted.toLowerCase().includes(needle) ||
        (!isContainer && String(value).toLowerCase().includes(needle));
      if (hit) {
        matches.add(toPointer(childSegments));
        for (let i = 0; i < childSegments.length; i++) ancestors.add(toPointer(childSegments.slice(0, i)));
        if (matches.size >= limit) {
          truncated = true;
          return;
        }
      }
      if (isContainer) walk(value, childSegments, childDotted);
    }
  };
  if (root !== null && typeof root === 'object') walk(root, [], '');
  return { matches, ancestors, truncated };
}
