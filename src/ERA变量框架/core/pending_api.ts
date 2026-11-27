/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：修复第二批改动在审查中发现的问题；新增额外模型分步更新、等待式提交、试算与变量结构说明
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 待同步的正文 API 写入
 * @description
 * 默认模式下，API 写入把指令块追加到最后一条 AI 消息，再由防抖后的 `era:apiWrite` 触发同步。
 * 如果在此之前新回复到达或有消息被删除，那次同步的起点会落在被写入的消息之后，这次写入就永远不会被计算。
 * 这里记下被写入的消息，同步时保证起点不晚于它。只存在于内存中：脚本重载后会按正文重算最后一条消息。
 */
'use strict';

const pending = new Set<string>();

export const markPendingApiWrite = (mk: string): void => {
  if (mk) pending.add(mk);
};

export const isPendingApiWrite = (mk: string): boolean => pending.has(mk);

/** 第一条含有待同步写入的消息索引；没有时返回 -1。 */
export const findFirstPendingIndex = (mks: (string | null)[]): number =>
  pending.size === 0 ? -1 : mks.findIndex(mk => !!mk && pending.has(mk));

/** 这些消息已经重新计算过。 */
export const clearPendingApiWrites = (mks: (string | null)[]): void => {
  for (const mk of mks) {
    if (mk) pending.delete(mk);
  }
};
