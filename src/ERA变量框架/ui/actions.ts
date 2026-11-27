/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：重新设计面板：耗时操作显示进行中与完成反馈，快照查询显示失败原因
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 面板 - 面板操作与组合式工具
 */
'use strict';

import { onBeforeUnmount, reactive, ref } from 'vue';
import { Era } from '../api/global';
import type { QueryResultItem, QueryResultPayload, WriteDonePayload } from '../utils/constants';

/** 等待下一次 `era:writeDone`；超时返回 `null`。 */
export function waitForWriteDone(timeout: number): Promise<WriteDonePayload | null> {
  return new Promise(resolve => {
    const listener = (payload: WriteDonePayload) => {
      clearTimeout(timer);
      eventRemoveListener('era:writeDone', listener);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      eventRemoveListener('era:writeDone', listener);
      resolve(null);
    }, timeout);
    eventOn('era:writeDone', listener);
  });
}

export type ForceSyncDetail = { mode: 'full' | 'latest' } | { mode: 'rollbackTo'; message_id: number };

/** 请求同步并等待其完成。`null` 表示在时限内没有收到完成通知（可能仍在后台进行）。 */
export async function forceSync(detail: ForceSyncDetail, timeout: number): Promise<WriteDonePayload | null> {
  const done = waitForWriteDone(timeout);
  eventEmit('era:forceSync', detail);
  return done;
}

export type SnapshotQuery = { message_id: number } | { mk: string };

/** 查询某一楼处理完之后的变量。失败时抛出带原因的异常。 */
export async function querySnapshot(query: SnapshotQuery): Promise<QueryResultItem> {
  const getVarsAt = (Era as any).getVarsAt;
  if (typeof getVarsAt === 'function') {
    const result = await getVarsAt.call(Era, query);
    return {
      mk: result.mk,
      message_id: result.message_id,
      is_user: !!result.is_user,
      stat: result.stat,
      statWithoutMeta: result.statWithoutMeta,
    };
  }
  // 旧接口：通过事件查询
  return new Promise((resolve, reject) => {
    const isMk = 'mk' in query;
    const timer = setTimeout(() => {
      eventRemoveListener('era:queryResult', listener);
      reject(new Error('查询超时：ERA 没有回应'));
    }, 15000);
    const listener = (detail: QueryResultPayload) => {
      const matched = isMk
        ? detail.queryType === 'getSnapshotAtMk' && detail.request?.mk === (query as any).mk
        : detail.queryType === 'getSnapshotAtMId' && detail.request?.message_id === (query as any).message_id;
      if (!matched) return;
      clearTimeout(timer);
      eventRemoveListener('era:queryResult', listener);
      const result = detail.result as any;
      if (!result || result.error || result.stat === null || result.stat === undefined) {
        reject(
          new Error(
            result?.error ??
              '没有找到这一楼的快照：楼层不存在、还没有计算到，或日志已被折叠（可开启“折叠日志存档”或执行完全重算）',
          ),
        );
      } else {
        resolve(result as QueryResultItem);
      }
    };
    eventOn('era:queryResult', listener);
    if (isMk) eventEmit('era:getSnapshotAtMk', { mk: (query as any).mk });
    else eventEmit('era:getSnapshotAtMId', { message_id: (query as any).message_id });
  });
}

/** 读取模块中可能不存在的导出（新旧版本兼容）。用函数包一层，避免打包工具静态检查导出名。 */
export function optionalExport(module: object, name: string): any {
  return (module as Record<string, any>)[name];
}

export const errorText = (error: any): string => String(error?.message ?? error ?? '未知错误');

/** 一个异步操作的状态：进行中 / 完成 / 失败，用于在按钮旁显示反馈。 */
export function useTask() {
  const state = reactive({
    busy: false,
    kind: null as null | 'ok' | 'error' | 'warn',
    text: '',
  });
  async function run(task: () => Promise<string | { warn: string } | void>, busyText = '正在处理…'): Promise<boolean> {
    if (state.busy) return false;
    state.busy = true;
    state.kind = null;
    state.text = busyText;
    try {
      const result = await task();
      if (result && typeof result === 'object') {
        state.kind = 'warn';
        state.text = result.warn;
      } else {
        state.kind = 'ok';
        state.text = result || '完成';
      }
      return true;
    } catch (error) {
      state.kind = 'error';
      state.text = errorText(error);
      return false;
    } finally {
      state.busy = false;
    }
  }
  function reset() {
    state.kind = null;
    state.text = '';
  }
  return { state, run, reset };
}

/** 两步确认：第一次点击进入待确认状态，数秒内再点一次才执行。 */
export function useConfirm(timeout = 4000) {
  const armed = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function confirm(id: string): boolean {
    clearTimeout(timer);
    if (armed.value === id) {
      armed.value = null;
      return true;
    }
    armed.value = id;
    timer = setTimeout(() => (armed.value = null), timeout);
    return false;
  }
  onBeforeUnmount(() => clearTimeout(timer));
  return { armed, confirm };
}

/** 复制文本到剪贴板。 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // iframe 中可能没有剪贴板权限，退回旧方法
  }
  const doc = document;
  const area = doc.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  area.select();
  doc.execCommand('copy');
  area.remove();
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export const shortMk = (mk: string | null | undefined): string => (mk ? `…${mk.slice(-6)}` : '—');
