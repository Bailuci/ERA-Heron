/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：重新设计面板：变量树（懒渲染、搜索、节点编辑）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import type { InjectionKey, Ref } from 'vue';
import type { ValueKind } from '../workbench';

/** 节点上的编辑器状态；同一时间只编辑一个节点。 */
export interface EditorState {
  /** `edit` 修改 `path` 的值；`add` 在容器 `path` 下新增。 */
  mode: 'edit' | 'add';
  path: string;
  /** 新增时，容器是否是数组（数组追加到末尾，不需要键名）。 */
  parentIsArray: boolean;
  key: string;
  kind: ValueKind;
  text: string;
  error: string;
  /** 保护提示。 */
  hints: string[];
}

export interface VarTreeContext {
  readonly: boolean;
  search: Ref<{ active: boolean; matches: Set<string>; ancestors: Set<string>; version: number }>;
  changed: Ref<Set<string>>;
  editor: Ref<EditorState | null>;
  startEdit(path: string, value: any): void;
  startAdd(path: string, isArray: boolean): void;
  remove(path: string): void;
  submit(): void;
  cancel(): void;
}

export const VAR_TREE_KEY: InjectionKey<VarTreeContext> = Symbol('era-var-tree');

/** 每个容器一次渲染的子节点数，超出部分点“显示更多”。 */
export const CHUNK = 100;
