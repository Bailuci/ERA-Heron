/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-27
 * 目的：存档段的单楼日志压缩（合并同一路径的更新链，抵消插入后删除），写入前逐楼自检
 *       2026-11-27 插入后删除不再整体抵消，改为保留一条不带旧值的 delete
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 存档段的日志压缩
 * @description
 * 只在写存档段时使用，只做**单楼内**合并：同一路径的一串操作，中间没有该路径的前缀或后代路径上的操作时，
 * 合并成一条等效操作（插入后又删除则合并成一条不带旧值的删除，见 `combine`）。
 *
 * 压缩后的日志会被 `expandArchive` 原样还原进 `EditLogs`，供回滚和查询使用。因此写入前逐楼自检：
 * 压缩后的日志与原日志的正向结果、回滚结果都必须 `_.isEqual`，任何一楼不通过就保留该楼的原日志。
 */
'use strict';

import { parseEditLog } from '../utils/data';
import { applyForward, applyRollback } from './timetravel';

const KNOWN_OPS = ['insert', 'update', 'delete'];

interface Item {
  entry: any;
  /** `_.toPath` 拆出的路径；`null` 表示无法分析的条目，与一切操作相关。 */
  path: string[] | null;
}

/** 一条路径是另一条的前缀（含相等）。 */
function related(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b) return true;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

const opOf = (entry: any): string => String(entry?.op || '').toLowerCase();

/**
 * 把同一路径上的两条操作合成一条：合并前路径的状态取前一条，合并后的状态取后一条。
 *
 * 合并前后路径都不存在（插入后又删除）时不整体抵消，而是保留一条不带旧值的 `delete`：
 * 正向对不存在的路径删除等于不做（`_.unset` 不建立父对象）；回滚时它仍会删除该路径，
 * 清掉后面楼层回滚留下的空对象（例如后一楼在该路径下插入过子路径），与原日志回滚的结果一致。
 */
function combine(first: any, second: any): any {
  const firstOp = opOf(first);
  const secondOp = opOf(second);
  // 回滚时 insert 和缺少旧值的 update / delete 都是删除路径
  const before = firstOp === 'insert' || first.value_old === undefined ? undefined : { value: first.value_old };
  const after = secondOp === 'delete' ? undefined : { value: second.value_new };
  const path = second.path;
  if (!before && !after) return { op: 'delete', path };
  if (!before) return { op: 'insert', path, value_new: after!.value };
  if (!after) return { op: 'delete', path, value_old: before.value };
  return { op: 'update', path, value_old: before.value, value_new: after.value };
}

/**
 * 压缩一楼的日志（不做自检）。合并后的条目放在后一条的位置：回滚时它与原来的后一条一样最先执行，
 * 父路径的创建时机不变。
 */
export function compressFloorLog(log: any[]): any[] {
  const out: Item[] = [];
  for (const entry of log) {
    const valid = entry && typeof entry.path === 'string' && entry.path !== '' && KNOWN_OPS.includes(opOf(entry));
    const item: Item = { entry, path: valid ? _.toPath(entry.path) : null };
    let j = out.length - 1;
    while (j >= 0 && !related(out[j].path, item.path)) j--;
    if (j >= 0 && item.path && out[j].path && _.isEqual(out[j].path, item.path)) {
      const merged = combine(out[j].entry, entry);
      out.splice(j, 1);
      out.push({ entry: merged, path: item.path });
      continue;
    }
    out.push(item);
  }
  return out.map(item => item.entry);
}

/** JSON 往返：与存档文件写出、读回后的内容一致。 */
const roundTrip = (value: any): any => JSON.parse(JSON.stringify(value ?? []));

export interface CompressResult {
  logs: Record<string, any>;
  /** 压缩后通过自检的楼层数。 */
  compressed: number;
  /** 压缩后没有通过自检、保留原日志的楼层数。 */
  rejected: number;
}

/**
 * 压缩一段存档的逐楼日志，逐楼自检。
 * @param base 这一段开始处的等效日志。
 * @param logs 逐楼日志（按 `order` 的顺序应用）。
 * @param order 楼层的 MK，按顺序。
 */
export function compressSegmentLogs(base: any[], logs: Record<string, any>, order: string[]): CompressResult {
  const originals = order.map(mk => roundTrip(parseEditLog(logs[mk])));
  const candidates: (any[] | null)[] = originals.map(log => {
    const compressed = roundTrip(compressFloorLog(log));
    return compressed.length < log.length ? compressed : null;
  });
  const result: CompressResult = { logs: { ...logs }, compressed: 0, rejected: 0 };
  if (candidates.every(item => item === null)) return result;

  const ok = candidates.map(item => item !== null);
  const check = (i: number, actual: () => object, expected: () => object) => {
    if (ok[i]) {
      try {
        ok[i] = _.isEqual(actual(), expected());
      } catch {
        ok[i] = false;
      }
    }
  };

  // 正向：从这一段开始处逐楼推进；同时检查从每楼结束时的状态回滚
  let state: object = applyForward({}, roundTrip(base));
  for (let i = 0; i < order.length; i++) {
    const next = applyForward(_.cloneDeep(state), originals[i]);
    check(
      i,
      () => applyForward(_.cloneDeep(state), candidates[i]!),
      () => next,
    );
    check(
      i,
      () => applyRollback(_.cloneDeep(next), candidates[i]!),
      () => applyRollback(_.cloneDeep(next), originals[i]),
    );
    state = next;
  }
  // 回滚：从这一段末尾沿原日志逐楼回滚（回滚留下的空父对象会累积，实际回滚面对的正是这种状态）
  for (let i = order.length - 1; i >= 0; i--) {
    const previous = applyRollback(_.cloneDeep(state), originals[i]);
    check(
      i,
      () => applyRollback(_.cloneDeep(state), candidates[i]!),
      () => previous,
    );
    state = previous;
  }

  order.forEach((mk, i) => {
    if (candidates[i] === null) return;
    if (ok[i]) {
      result.logs[mk] = candidates[i];
      result.compressed++;
    } else {
      result.rejected++;
    }
  });
  return result;
}
