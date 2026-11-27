/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：长聊天诊断：统计聊天数据体积（stat_data、EditLogs、ApiOps、正文）与当前挂载的状态栏 iframe 数
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 面板 - 聊天数据体积诊断
 * @description
 * 1.9（日志压缩）和 2.0（可选外置）的取舍以真实长聊天的数据为准。这里只读取、统计，不改任何数据。
 * 体积按 JSON 序列化后的 UTF-8 字节数计算，与聊天文件里实际占用的大小相近。
 */
'use strict';

import { API_OPS_PATH, LOG_ARCHIVE_PATH, LOGS_PATH, META_DATA_PATH, STAT_DATA_PATH } from '../utils/constants';

export interface ChatSizeReport {
  /** 消息条数。 */
  messages: number;
  /** `stat_data` 的字节数。 */
  stat: number;
  /** 未折叠的逐楼日志 `EditLogs` 的字节数，以及有日志的楼层数。 */
  editLogs: number;
  logFloors: number;
  /** 旁路写入 `ApiOps` 的字节数，以及写入的条数。 */
  apiOps: number;
  apiOpCount: number;
  /** 其余元数据（`SelectedMks`、折叠边界、存档索引等）的字节数。 */
  otherMeta: number;
  /** 是否开启了折叠日志存档（旧楼日志存在聊天之外）。 */
  archived: boolean;
  /** 当前显示的正文的字节数。 */
  text: number;
  /** 包括未显示的 swipe 在内的全部正文的字节数。 */
  allSwipes: number;
  /** 当前挂载在聊天里的 iframe（状态栏、前端界面）数；无法统计时为 `null`。 */
  iframes: number | null;
}

/** UTF-8 字节数。 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4; // 代理对
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** 值序列化成 JSON 后的 UTF-8 字节数；`undefined` 为 0。 */
export function jsonBytes(value: any): number {
  if (value === undefined) return 0;
  try {
    return utf8Length(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

/** 显示用：`1.2 KB`、`3.4 MB`。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 统计聊天数据体积。
 * @param chatVariables 聊天变量（`getVariables({ type: 'chat' })`）。
 * @param messages `getChatMessages(..., { include_swipes: true })` 的结果。
 * @param iframes 当前挂载的 iframe 数。
 */
export function measureChatSize(chatVariables: any, messages: any[], iframes: number | null): ChatSizeReport {
  const meta = chatVariables?.[META_DATA_PATH] ?? {};
  const logs = meta[LOGS_PATH] ?? {};
  const apiOps = meta[API_OPS_PATH] ?? {};
  const text = (msg: any): string => {
    if (typeof msg?.message === 'string') return msg.message;
    if (typeof msg?.mes === 'string') return msg.mes;
    const swipes = Array.isArray(msg?.swipes) ? msg.swipes : [];
    return String(swipes[Number(msg?.swipe_id ?? 0)] ?? '');
  };
  let shown = 0;
  let all = 0;
  for (const msg of messages ?? []) {
    const current = utf8Length(text(msg));
    shown += current;
    const swipes: any[] = Array.isArray(msg?.swipes) ? msg.swipes : [];
    all += swipes.length > 0 ? swipes.reduce((sum, swipe) => sum + utf8Length(String(swipe ?? '')), 0) : current;
  }
  return {
    messages: messages?.length ?? 0,
    stat: jsonBytes(chatVariables?.[STAT_DATA_PATH] ?? {}),
    editLogs: jsonBytes(logs),
    logFloors: _.isPlainObject(logs) ? Object.keys(logs).length : 0,
    apiOps: jsonBytes(meta[API_OPS_PATH]),
    apiOpCount: _.isPlainObject(apiOps)
      ? _.sumBy(Object.values(apiOps) as any[], record =>
          _.sumBy(Array.isArray(record?.ops) ? record.ops : [], (op: any) => op?.n ?? 1),
        )
      : 0,
    otherMeta: jsonBytes(_.omit(meta, [LOGS_PATH, API_OPS_PATH])),
    archived: !_.isEmpty(meta[LOG_ARCHIVE_PATH]),
    text: shown,
    allSwipes: all,
    iframes,
  };
}

/** 当前聊天区域里挂载的 iframe 数（状态栏、前端界面都算）。 */
export function countChatIframes(doc: Document): number | null {
  try {
    const chat = doc.getElementById('chat');
    return chat ? chat.querySelectorAll('iframe').length : null;
  } catch {
    return null;
  }
}
