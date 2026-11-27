/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；新增折叠日志存档：旧楼日志存到单独文件，可回滚与查询，缺失时自动从头重放；修复第三批改动在审查中发现的问题；修复复审中发现的问题；从头重放、还原存档后复用不再引用的编号，存档文件数不再随重算增长；进程内缓存设上限
 * 2026-11-27：写存档段时压缩单楼日志（逐楼自检，不通过保留原日志）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 折叠日志的存档
 * @description
 * `日志保留楼层数` 会把旧楼的逐楼日志折叠成一份等效日志。开启 `折叠日志存档` 后，被折叠掉的逐楼日志
 * 存到酒馆服务器上的单独文件（`user/files/`）里，聊天文件保持小巧，同时仍能回滚和查询旧楼。
 *
 * - 存档按段保存，每段是**不再改动**的一个文件，含一次折叠掉的若干楼；聊天中只记录各段的路径、范围和校验值。
 * - 先确认文件已经保存，才会折叠；保存失败时日志留在聊天里。
 * - 存档只是**缓存**：文件缺失、内容与校验值不符、与聊天中的等效日志不一致时一律忽略，
 *   退回到“从头按正文重放”，不会影响变量的正确性。
 * - 从头重放、或还原存档后重新折叠时，不再被索引引用的段的编号会被复用（覆盖旧文件），
 *   因此文件数不会随重算增长，删除聊天时按编号也能找全。旧文件被覆盖后，仍引用它的分支聊天会因校验值不符而从头重放。
 */
'use strict';

import { FOLDED_MK_PATH, LOG_ARCHIVE_PATH, LOGS_PATH, SEL_PATH } from '../utils/constants';
import { parseEditLog } from '../utils/data';
import { Logger } from '../utils/log';
import { compressSegmentLogs } from './log_compress';
import { applyForward } from './timetravel';

const logger = new Logger();

/** 攒够这么多楼才折叠一次，避免每次回复都产生一个文件。 */
export const ARCHIVE_BATCH = 10;

/** 聊天中记录的一段存档。 */
export interface LogSegment {
  path: string;
  hash: string;
  /** 上一次的折叠边界；`null` 表示从第 0 楼开始。 */
  after: string | null;
  /** 这一段的折叠边界（含）。 */
  to: string;
}

/** 文件的内容。 */
interface SegmentFile {
  version: 1;
  /** `after` 处的等效日志。 */
  base: any[];
  /** `after` 之后到 `to`（含）的逐楼日志。 */
  logs: Record<string, any>;
}

interface ArchiveIndex {
  /** 写入这些段的聊天；分支、改名之后换成新的。 */
  owner: string;
  /** 下一段的序号，只增不减。 */
  next: number;
  segments: LogSegment[];
}

/** 只读写自己的文件：路径来自聊天数据，可能随别人的聊天一起导入。 */
const PATH_REGEX = /^\/user\/files\/era_logs_[0-9a-z]+_[0-9a-z]+_\d+\.json$/;

/** 已读取的文件；`null` 表示不存在或不可用。按读取顺序淘汰，切换到别的聊天的存档时清空。 */
const cache = new Map<string, SegmentFile | null>();
/** 缓存最多保留的段数。 */
const CACHE_LIMIT = 30;
/** 缓存中的段属于哪个聊天（索引的 owner）。 */
let cacheOwner: string | null = null;

function cacheGet(key: string): SegmentFile | null | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    // 最近用过的放到最后，最后淘汰
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: SegmentFile | null) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** 段文件的编号；不是 `owner` 写的文件时返回 `null`。 */
function segmentNumber(path: string, owner: string): number | null {
  const prefix = `/user/files/era_logs_${owner}_`;
  if (!owner || !path.startsWith(prefix)) return null;
  const number = Number(path.slice(prefix.length, -'.json'.length));
  return Number.isSafeInteger(number) ? number : null;
}

function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = (Math.imul(b ^ code, 0x5bd1e995) + i) | 0;
  }
  return `${(a >>> 0).toString(36)}_${(b >>> 0).toString(36)}`;
}

/** 聊天的标识。不同角色卡可能有同名的聊天，因此带上角色卡。 */
function getChatIdentity(chatId: string): string | null {
  const owner = SillyTavern.groupId || SillyTavern.characters?.[Number(SillyTavern.characterId)]?.avatar;
  return owner ? `${owner}\n${chatId}` : null;
}

export const getSegmentPath = (identity: string, index: number): string =>
  `/user/files/era_logs_${hash(identity)}_${index}.json`;

const getIndex = (meta: any): ArchiveIndex => {
  const raw = _.get(meta, LOG_ARCHIVE_PATH);
  return {
    owner: String(raw?.owner ?? ''),
    next: Number.isSafeInteger(raw?.next) ? raw.next : 0,
    segments: Array.isArray(raw?.segments) ? raw.segments : [],
  };
};

/** 从当前的折叠边界往前，首尾相接的各段（由新到旧）。 */
function getChain(meta: any): LogSegment[] {
  const { segments } = getIndex(meta);
  const chain: LogSegment[] = [];
  let marker: string | null = _.get(meta, FOLDED_MK_PATH) ?? null;
  for (let i = segments.length - 1; i >= 0 && marker !== null; i--) {
    const segment = segments[i];
    if (segment?.to !== marker || typeof segment.path !== 'string' || !PATH_REGEX.test(segment.path)) break;
    chain.push(segment);
    marker = segment.after;
  }
  return chain;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const post = (url: string, body: object): Promise<Response> =>
  fetchWithTimeout(url, { method: 'POST', headers: SillyTavern.getRequestHeaders(), body: JSON.stringify(body) });

/** 预先读取当前聊天的存档，之后可以同步地使用。 */
export async function loadArchive(meta: any): Promise<void> {
  const { owner } = getIndex(meta);
  if (owner !== cacheOwner) {
    cache.clear();
    cacheOwner = owner;
  }
  await Promise.all(
    getChain(meta)
      .filter(segment => !cache.has(segment.path + segment.hash))
      .map(async segment => {
        try {
          const response = await fetchWithTimeout(segment.path, { cache: 'no-store' });
          if (!response.ok && response.status !== 404) return; // 服务器暂时不可用，下次再试
          const text = response.ok ? await response.text() : '';
          const valid = text !== '' && hash(text) === segment.hash;
          cacheSet(segment.path + segment.hash, valid ? JSON.parse(text) : null);
        } catch (error) {
          logger.debug('loadArchive', '读取存档失败', error);
        }
      }),
  );
}

/**
 * 用已读取的存档还原被折叠的逐楼日志，返回新的 `meta`；没有可用的存档时返回 `null`。
 * 中间有一段不可用时，只还原它之后的部分。
 */
export function expandArchive(meta: any): any | null {
  const marker = _.get(meta, FOLDED_MK_PATH);
  if (!marker) return null;
  const mks: (string | null)[] = _.get(meta, SEL_PATH, []);
  const allLogs = _.get(meta, LOGS_PATH, {});

  const used: { segment: LogSegment; file: SegmentFile }[] = [];
  for (const segment of getChain(meta)) {
    const file = cacheGet(segment.path + segment.hash);
    const start = segment.after === null ? -1 : mks.indexOf(segment.after);
    const end = mks.indexOf(segment.to);
    const range = mks.slice(start + 1, end + 1);
    if (
      !file ||
      end === -1 ||
      (segment.after !== null && start === -1) ||
      range.length === 0 ||
      range.some(mk => !mk || !_.has(file.logs, [mk]))
    ) {
      break;
    }
    used.unshift({ segment, file });
  }
  if (used.length === 0) return null;

  const { after } = used[0].segment;
  const restored: Record<string, any> = {};
  if (after !== null) restored[after] = used[0].file.base;
  for (const { file } of used) Object.assign(restored, file.logs);
  const copy = _.cloneDeep(restored);

  // 与聊天中的等效日志核对
  let actual = {};
  for (const mk of Object.keys(copy)) actual = applyForward(actual, parseEditLog(copy[mk]));
  if (!_.isEqual(actual, applyForward({}, parseEditLog(allLogs[marker])))) {
    logger.debug('expandArchive', '存档与聊天中的日志不一致，忽略存档');
    return null;
  }

  const index = getIndex(meta);
  // 被还原的段之后会重新折叠、写成新的段，它们的编号可以复用
  const freed = used.map(({ segment }) => segmentNumber(segment.path, index.owner));
  const next = freed.every(number => number !== null) ? Math.min(index.next, ...(freed as number[])) : index.next;
  const expanded = {
    ...meta,
    [LOGS_PATH]: { ...allLogs, ..._.cloneDeep(restored) },
    [LOG_ARCHIVE_PATH]: { ...index, next, segments: index.segments.slice(0, index.segments.length - used.length) },
  };
  if (after === null) _.unset(expanded, FOLDED_MK_PATH);
  else _.set(expanded, FOLDED_MK_PATH, after);
  return expanded;
}

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** 保存失败后，过一段时间再尝试。 */
let retryAfter = 0;
export const canArchive = (): boolean => Date.now() >= retryAfter;

/**
 * 折叠之后、写回聊天之前调用：保存刚被折叠掉的逐楼日志，并在 `folded` 中登记。
 * @param before 折叠之前的 `meta`（其 `EditLogs` 必须是折叠前的副本）。
 * @param folded 折叠之后的 `meta`，会被直接修改。
 * @returns 是否已经保存；没有保存时应放弃这次折叠。
 */
export async function archiveFoldedLogs(before: any, folded: any, chatId: string): Promise<boolean> {
  const to: string = _.get(folded, FOLDED_MK_PATH);
  const after: string | null = _.get(before, FOLDED_MK_PATH) ?? null;
  if (!to || to === after) return true;
  const identity = getChatIdentity(chatId);
  if (!identity) return false;

  const mks: (string | null)[] = _.get(before, SEL_PATH, []);
  const logs = _.get(before, LOGS_PATH, {});
  const file: SegmentFile = { version: 1, base: after === null ? [] : parseEditLog(logs[after]), logs: {} };
  const range = mks.slice(after === null ? 0 : mks.indexOf(after) + 1, mks.indexOf(to) + 1);
  for (const mk of range) file.logs[mk!] = logs[mk!] ?? [];
  // 单楼内压缩；自检不通过的楼保留原日志，出错时整段不压缩
  try {
    const result = compressSegmentLogs(
      file.base,
      file.logs,
      range.filter((mk): mk is string => !!mk),
    );
    file.logs = result.logs;
    if (result.rejected > 0)
      logger.debug('archiveFoldedLogs', `${result.rejected} 楼的日志压缩没有通过自检，保留原日志`);
  } catch (error) {
    logger.debug('archiveFoldedLogs', '日志压缩出错，保留原日志', error);
  }

  const index = getIndex(before);
  const { segments } = index;
  const owner = hash(identity);
  // 每个聊天从 0 开始编号，删除聊天时才能找全；但不能覆盖仍在使用的文件
  let next = index.owner === owner ? index.next : 0;
  while (segments.some(segment => segment.path === getSegmentPath(identity, next))) next++;
  const text = JSON.stringify(file);
  const segment: LogSegment = { path: getSegmentPath(identity, next), hash: hash(text), after, to };
  try {
    const response = await post('/api/files/upload', { name: segment.path.split('/').pop(), data: toBase64(text) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    retryAfter = Date.now() + 5 * 60 * 1000;
    logger.warn('archiveFoldedLogs', '日志存档没有保存成功，暂不折叠', error);
    return false;
  }
  // 刚写出的段也放进缓存：同一会话中查询旧楼时不必再读取
  if (owner !== cacheOwner) {
    cache.clear();
    cacheOwner = owner;
  }
  cacheSet(segment.path + segment.hash, JSON.parse(text));
  folded[LOG_ARCHIVE_PATH] = { owner, next: next + 1, segments: [...segments, segment] };
  return true;
}

/** 从头重放后，已有的各段不再有效，编号从 0 开始复用。 */
export function resetArchive(meta: any): void {
  if (_.has(meta, LOG_ARCHIVE_PATH)) meta[LOG_ARCHIVE_PATH] = { ...getIndex(meta), next: 0, segments: [] };
}

/** 聊天被删除时删除它的存档。无法确定是哪张角色卡的聊天时不处理。 */
export async function deleteArchive(chatId: string): Promise<void> {
  const identity = getChatIdentity(chatId);
  if (!identity) return;
  try {
    for (let start = 0; ; start += 20) {
      const paths = _.range(start, start + 20).map(index => getSegmentPath(identity, index));
      const response = await post('/api/files/verify', { urls: paths });
      if (!response.ok) return;
      const exists = await response.json();
      const found = paths.filter(path => exists[path] === true);
      for (const path of found) await post('/api/files/delete', { path });
      if (!found.includes(paths[paths.length - 1])) return;
    }
  } catch (error) {
    logger.debug('deleteArchive', '删除存档失败', error);
  }
}
