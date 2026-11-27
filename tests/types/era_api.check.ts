/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：类型层面校验 开发工具/exported.era.d.ts 中声明的 Era 与 api/global.ts 的实现一致（由 pnpm typecheck 检查，不会运行）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import type { EraGlobal } from '../../src/ERA变量框架/api/global';

/** 声明的每个成员都必须有实现，且实现的签名能满足声明 */
export const implementsDeclaration: typeof Era = null as unknown as EraGlobal;

/** 实现的每个成员都必须写进声明，且声明不会比实现承诺得更多 */
export const declarationCoversImplementation: EraGlobal = null as unknown as typeof Era;
