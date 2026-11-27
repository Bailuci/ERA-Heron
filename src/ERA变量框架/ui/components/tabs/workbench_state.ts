/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：重新设计面板：变量编辑工作台的暂存状态（切换标签页、关闭面板时保留）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import { reactive } from 'vue';
import type { WorkbenchOp } from '../../workbench';

/** 暂存的修改只保存在内存中；刷新页面后丢失。暂存时记下聊天，切换聊天后不会写到别的聊天里。 */
export const workbench = reactive({
  ops: [] as WorkbenchOp[],
  chatId: undefined as string | undefined,
  view: 'pure' as 'pure' | 'full' | 'bulk',
  bulkText: '',
});
