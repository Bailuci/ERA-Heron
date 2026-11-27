/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：新增表达式 $expr：默认关闭的可选世界书条目“ERA 表达式规则”。快速初始化不创建、更新旧卡的规则不下发，
 *       作者按 doc/02 自行建条目；分步更新把同名条目当作只发给更新模型的条目
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import type { PartialDeep } from 'type-fest';
import content from './era_expr_rule.txt?raw';

export const ERA_EXPR_RULE_ENTRY_NAME = 'ERA 表达式规则';

/**
 * 可选条目：需要公式或骰点的卡再启用。默认关闭，不改动默认的 `era_var_operation_rule.txt`。
 * order 10000：紧跟在“ERA 变量操作规则”（9999）之后。
 */
export const eraExprRuleEntry: PartialDeep<WorldbookEntry> = {
  name: ERA_EXPR_RULE_ENTRY_NAME,
  content,
  enabled: false,
  strategy: {
    type: 'constant',
    keys: [],
    keys_secondary: {
      logic: 'and_any',
      keys: [],
    },
    scan_depth: 'same_as_global',
  },
  position: {
    type: 'at_depth',
    role: 'system',
    depth: 0,
    order: 10000,
  },
  probability: 100,
  recursion: {
    prevent_incoming: false,
    prevent_outgoing: false,
    delay_until: null,
  },
  effect: {
    sticky: null,
    cooldown: null,
    delay: null,
  },
};
