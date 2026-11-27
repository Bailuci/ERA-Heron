/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：新增表达式 $expr：把钩子的确定性随机数（FNV-1a + mulberry32）抽出共用，并提供按序号随机访问的 randomAt
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 确定性随机数
 * @description
 * 重算历史消息时会再次执行钩子和表达式，随机数必须只由种子决定。
 * 这里只用整数运算（`Math.imul`、位运算），各引擎结果一致。
 */
'use strict';

/** 字符串的 FNV-1a 32 位哈希（无符号）。 */
export function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 的一步：返回新状态和 [0, 1) 的取值。 */
function mulberry32(state: number): { state: number; value: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** 以字符串为种子的确定性随机数序列 [0, 1)：FNV-1a 哈希作为种子的 mulberry32。 */
export function createSeededRandom(seed: string): () => number {
  let state = fnv1a(seed);
  return () => {
    const step = mulberry32(state);
    state = step.state;
    return step.value;
  };
}

/**
 * 随机访问：同一个 `(seed, draw)` 总是得到同一个 [0, 1) 的值，与调用顺序无关。
 * 数字按 `String()` 转成文本（规范规定了唯一的最短表示），因此各引擎一致。
 */
export function randomAt(seed: string | number, draw: string | number): number {
  return createSeededRandom(`${String(seed)}|${String(draw)}`)();
}
