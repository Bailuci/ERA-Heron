/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复复审中发现的问题
 *       2026-11-27 问题带上指令的来源标记 source（额外模型输出、旁路写入），只用于报告
 *       2026-11-27 新增 findProtectedInside（整体覆盖对象前检查其中受保护的内容）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 指令问题收集
 * @description
 * 指令没有生效的原因（路径不存在、已存在、受保护、JSON 无法解析等）以前只写在控制台里。
 * 这里把它们收集起来，供 `era:commandError` 事件、弹窗提示和额外模型的自动重试使用。
 */
'use strict';

import { unescapeEraData } from '../../utils/data';

export interface CommandIssue {
  /** 出问题的指令类型；`parse` 表示指令块的内容无法解析。 */
  type: 'insert' | 'edit' | 'delete' | 'patch' | 'parse' | 'call';
  /** 涉及的路径（已反转义）；`parse` 时是内容的开头。 */
  path: string;
  /** 没有生效的原因。 */
  reason: string;
  /** 来自哪种指令；无法解析的指令块没有。 */
  origin?: 'text' | 'api' | 'hook' | 'tool';
  /** 指令的来源标记，参见 `EraCommand.source`；主模型写在正文里的指令没有。 */
  source?: 'extra' | 'apiOps';
}

export function reportIssue(
  issues: CommandIssue[] | undefined,
  type: CommandIssue['type'],
  path: string,
  reason: string,
): void {
  issues?.push({ type, path: unescapeEraData(path), reason });
}

/** 以 `_` 开头的键是只读字段（仅在脚本设置 `下划线只读` 开启时生效）。键可以是转义过的。 */
/**
 * 整体覆盖或删除 `node` 会不会破坏其中受保护的内容。返回原因；没有问题时返回 `null`。
 * - `$meta.updatable: false`：它自己和任何后代；
 * - `$meta.necessary`：自己是 `self` / `all` 的后代，以及 `children` / `all` 的直属子节点；
 * - `checkReadonly` 时，任何层级上以 `_` 开头的字段。
 */
export function findProtectedInside(node: any, checkReadonly: boolean): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const reason = findProtectedInside(item, checkReadonly);
      if (reason) return reason;
    }
    return null;
  }
  if (!_.isPlainObject(node)) return null;
  if (_.get(node, ['$meta', 'updatable']) === false) return '其中有受 $meta.updatable 保护的内容';
  const necessary = _.get(node, ['$meta', 'necessary']);
  for (const key of Object.keys(node)) {
    if (key === '$meta' || key === '$template') continue;
    if (checkReadonly && isReadonlyKey(key)) return '其中有以 _ 开头的只读字段';
    if (necessary === 'children' || necessary === 'all') return '其中有受 $meta.necessary 保护的内容';
    const own = _.get(node[key], ['$meta', 'necessary']);
    if (own === 'self' || own === 'all') return '其中有受 $meta.necessary 保护的内容';
    const reason = findProtectedInside(node[key], checkReadonly);
    if (reason) return reason;
  }
  return null;
}

export function isReadonlyKey(key: string): boolean {
  return unescapeEraData(key).startsWith('_');
}
