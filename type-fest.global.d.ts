/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：@types/ 下的酒馆助手类型声明使用全局命名空间 TypeFest，这里把 type-fest 导出为全局命名空间，使 tsc 类型检查能通过
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import * as TF from 'type-fest';

declare global {
  export import TypeFest = TF;
}
