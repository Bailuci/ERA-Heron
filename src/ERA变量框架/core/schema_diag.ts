/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：变量结构诊断与一键修复：校验当前变量、问题分类（缺必填字段 / 类型不符），用黑盒 safeParse 推导修复值
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 变量结构诊断
 * @description
 * 修改前的状态已不合法时（`pre_invalid`），`core/schema.ts` 会整轮放行。合法状态不会被任何指令写坏，
 * 所以持续的 `pre_invalid` 基本只有两个来源：作者升级 schema 新增了必填字段，或者状态从来没合法过。
 * 这里只做**诊断和推导修复值**，不改变放行行为；修复由面板确认后用 `Era.commit(..., { atomic: true })` 写入最新 AI 楼。
 *
 * schema 由其他脚本创建，ERA 只能把它当成黑盒（只有 `safeParse`），修复值的推导全部靠“改一处、整份重新校验”：
 * 1. 数字字符串 ↔ 数字、`"true"` / `"false"` → 布尔这类不丢信息的强转；
 * 2. 删除非法的叶子，让 `default` / `prefault` 接管；
 * 3. 缺失的字段先试着补一个空对象 / 空数组（内层字段都有默认值时就能补全）；
 * 4. 逐级删除上层，让上层的 `prefault` 接管。
 * 一个候选只有让问题总数减少才会被采用。必填又没有默认值、上面都解决不了的，留给玩家手填。
 *
 * 本文件中的函数都是纯函数：schema 由参数传入，不读取任何全局状态。
 */
'use strict';

import { unescapeEraData } from '../utils/data';
import { EraSchemaLike, stripReserved } from './schema';

/** 一处不符合变量结构的问题。 */
export interface SchemaIssue {
  /**
   * - `missing`：缺必填字段，多半是 schema 升级新增了字段而旧存档里没有；
   * - `invalid`：值的类型或取值不符。
   */
  kind: 'missing' | 'invalid';
  /** 显示用的路径，如 `主角.背包[0].名字`；根是空字符串。 */
  path: string;
  /** 路径的各段，数组下标是数字。 */
  segments: (string | number)[];
  /** schema 给出的说明。 */
  message: string;
}

export interface SchemaDiagnosis {
  /** 是否注册了 schema。没有注册时 `valid` 为真。 */
  registered: boolean;
  /** 变量是否符合结构。 */
  valid: boolean;
  issues: SchemaIssue[];
  /** schema 的 `safeParse` 抛出了异常时的说明，此时 `valid` 为假、`issues` 为空。 */
  error?: string;
}

/** 显示用的路径：`a.b[0].c`。 */
export function formatIssuePath(segments: (string | number)[]): string {
  return segments
    .map((segment, index) => (typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`))
    .join('');
}

/** schema 看到的变量：反转义、去掉 ERA 保留字段（`$meta`、`$template`）的副本。 */
export function toSchemaView(stat: any): any {
  return stripReserved(unescapeEraData(stat ?? {}));
}

const hasPath = (root: any, segments: (string | number)[]): boolean => {
  let node = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, segment)) {
      return false;
    }
    node = node[segment as any];
  }
  return node !== undefined;
};

const toSegments = (path: unknown): (string | number)[] =>
  Array.isArray(path)
    ? path.filter(part => typeof part === 'string' || typeof part === 'number').map(part => part as string | number)
    : [];

type RawParse =
  { ok: true } | { ok: false; thrown: true; message: string } | { ok: false; thrown: false; issues: any[] };

function rawParse(schema: EraSchemaLike, plain: any): RawParse {
  try {
    const result = schema.safeParse(plain);
    if (result.success) return { ok: true };
    const issues = Array.isArray(result.error?.issues) ? result.error.issues : [];
    if (issues.length === 0) {
      return {
        ok: false,
        thrown: false,
        issues: [{ path: [], message: String(result.error?.message ?? '不符合变量结构') }],
      };
    }
    return { ok: false, thrown: false, issues };
  } catch (error: any) {
    return { ok: false, thrown: true, message: String(error?.message ?? error) };
  }
}

function toIssue(raw: any, plain: any): SchemaIssue {
  const segments = toSegments(raw?.path);
  return {
    kind: segments.length > 0 && !hasPath(plain, segments) ? 'missing' : 'invalid',
    path: formatIssuePath(segments),
    segments,
    message: String(raw?.message ?? '不符合变量结构'),
  };
}

/** 校验 schema 视角下的变量（`toSchemaView` 的结果）。 */
export function diagnosePlain(schema: EraSchemaLike | null | undefined, plain: any): SchemaDiagnosis {
  if (!schema) return { registered: false, valid: true, issues: [] };
  const parsed = rawParse(schema, plain);
  if (parsed.ok) return { registered: true, valid: true, issues: [] };
  if (parsed.thrown) return { registered: true, valid: false, issues: [], error: parsed.message };
  return { registered: true, valid: false, issues: parsed.issues.map(raw => toIssue(raw, plain)) };
}

/** 校验一份 `stat_data`（转义过的、带保留字段的）。 */
export function diagnoseStat(schema: EraSchemaLike | null | undefined, stat: any): SchemaDiagnosis {
  return diagnosePlain(schema, toSchemaView(stat));
}

/** 问题的签名：用于按聊天去重广播。只取路径和分类，说明文字可能随 zod 版本变化。 */
export function issueSignature(issues: SchemaIssue[]): string {
  return JSON.stringify(issues.map(issue => [issue.kind, issue.path]));
}

/** 修复计划中的一步。 */
export interface FixStep {
  /** `coerce` 强转，`delete` 删除（让默认值接管），`fill` 补空对象 / 空数组，`manual` 玩家手填。 */
  action: 'coerce' | 'delete' | 'fill' | 'manual';
  /** 显示用的路径。 */
  path: string;
  segments: (string | number)[];
  /** 修改前的值；原来不存在时没有该字段。 */
  before?: any;
  /** 修改后的值；`delete` 没有该字段。 */
  after?: any;
  /** 这一步针对的问题。 */
  reason: string;
}

export interface SchemaFixPlan {
  /** 修复后的变量（schema 视角，不含保留字段）。 */
  target: any;
  steps: FixStep[];
  /** 修复后仍然存在的问题（需要玩家手填）。 */
  remaining: SchemaIssue[];
  /** 修复后是否已经符合结构。 */
  valid: boolean;
  /** schema 抛出异常时的说明。 */
  error?: string;
}

const clone = (value: any): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function getAtPath(root: any, segments: (string | number)[]): any {
  let node = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment as any];
  }
  return node;
}

/** 删除路径上的值：数组元素用 splice，对象键用 delete。成功时返回 `true`。 */
function removeAtPath(root: any, segments: (string | number)[]): boolean {
  if (segments.length === 0) return false;
  const parent = getAtPath(root, segments.slice(0, -1));
  const key = segments[segments.length - 1];
  if (Array.isArray(parent) && typeof key === 'number' && key < parent.length) {
    parent.splice(key, 1);
    return true;
  }
  if (_.isPlainObject(parent) && Object.prototype.hasOwnProperty.call(parent, key)) {
    delete parent[key];
    return true;
  }
  return false;
}

/** 写入路径上的值，缺失的上层补成对象。上层存在但不是容器时失败。 */
function setAtPath(root: any, segments: (string | number)[], value: any): boolean {
  if (segments.length === 0) return false;
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (node[segment as any] === undefined) node[segment as any] = typeof segments[i + 1] === 'number' ? [] : {};
    node = node[segment as any];
    if (node === null || typeof node !== 'object') return false;
  }
  node[segments[segments.length - 1] as any] = value;
  return true;
}

/** 不丢信息的强转候选。 */
function coercions(value: any): any[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const result: any[] = [];
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) {
      result.push(Number(trimmed));
    }
    if (trimmed === 'true' || trimmed === 'false') result.push(trimmed === 'true');
    return result;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  return [];
}

interface Candidate {
  step: Omit<FixStep, 'reason'>;
  apply(root: any): boolean;
}

function candidatesFor(root: any, raw: any): Candidate[] {
  const segments = toSegments(raw?.path);
  const list: Candidate[] = [];
  const exists = segments.length > 0 && hasPath(root, segments);
  const current = exists ? getAtPath(root, segments) : undefined;
  const path = formatIssuePath(segments);

  // 严格对象里多出来的键
  if (raw?.code === 'unrecognized_keys' && Array.isArray(raw?.keys)) {
    for (const key of raw.keys) {
      const keySegments = [...segments, String(key)];
      if (!hasPath(root, keySegments)) continue;
      list.push({
        step: {
          action: 'delete',
          path: formatIssuePath(keySegments),
          segments: keySegments,
          before: clone(getAtPath(root, keySegments)),
        },
        apply: target => removeAtPath(target, keySegments),
      });
    }
  }

  if (exists) {
    for (const value of coercions(current)) {
      list.push({
        step: { action: 'coerce', path, segments, before: clone(current), after: value },
        apply: target => setAtPath(target, segments, value),
      });
    }
    list.push({
      step: { action: 'delete', path, segments, before: clone(current) },
      apply: target => removeAtPath(target, segments),
    });
  } else if (segments.length > 0) {
    for (const value of [{}, []]) {
      list.push({
        step: { action: 'fill', path, segments, after: value },
        apply: target => setAtPath(target, segments, clone(value)),
      });
    }
  }

  // 逐级删除上层（不删除根）
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const parent = segments.slice(0, depth);
    if (!hasPath(root, parent)) continue;
    list.push({
      step: {
        action: 'delete',
        path: formatIssuePath(parent),
        segments: parent,
        before: clone(getAtPath(root, parent)),
      },
      apply: target => removeAtPath(target, parent),
    });
  }
  return list;
}

/** 单次推导最多尝试的轮数，避免异常的 schema 让面板卡住。 */
const MAX_ROUNDS = 100;

/**
 * 推导修复值。
 * @param plain schema 视角下的变量（`toSchemaView` 的结果，不会被修改）。
 * @param manual 玩家手填的值：路径各段的 JSON（`JSON.stringify(segments)`）→ 值。先于自动修复写入。
 */
export function deriveSchemaFix(schema: EraSchemaLike, plain: any, manual: Record<string, any> = {}): SchemaFixPlan {
  let target = clone(plain ?? {});
  const steps: FixStep[] = [];

  for (const [key, value] of Object.entries(manual)) {
    let segments: (string | number)[];
    try {
      segments = toSegments(JSON.parse(key));
    } catch {
      continue;
    }
    if (segments.length === 0 || value === undefined) continue;
    const before = getAtPath(target, segments);
    if (setAtPath(target, segments, clone(value))) {
      steps.push({
        action: 'manual',
        path: formatIssuePath(segments),
        segments,
        ...(before === undefined ? {} : { before: clone(before) }),
        after: clone(value),
        reason: '手动填写',
      });
    }
  }

  let parsed = rawParse(schema, target);
  for (let round = 0; round < MAX_ROUNDS && !parsed.ok && !parsed.thrown; round++) {
    const issues = parsed.issues;
    let accepted = false;
    for (const raw of issues) {
      for (const candidate of candidatesFor(target, raw)) {
        const trial = clone(target);
        if (!candidate.apply(trial)) continue;
        const result = rawParse(schema, trial);
        if (result.ok === false && (result.thrown || result.issues.length >= issues.length)) continue;
        target = trial;
        steps.push({ ...candidate.step, reason: String(raw?.message ?? '不符合变量结构') });
        parsed = result;
        accepted = true;
        break;
      }
      if (accepted) break;
    }
    if (!accepted) break;
  }

  if (parsed.ok) return { target, steps, remaining: [], valid: true };
  if (parsed.thrown) return { target, steps, remaining: [], valid: false, error: parsed.message };
  return { target, steps, remaining: parsed.issues.map(raw => toIssue(raw, target)), valid: false };
}
