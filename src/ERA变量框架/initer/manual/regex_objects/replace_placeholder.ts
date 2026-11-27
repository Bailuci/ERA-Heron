/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26
 * 目的：显式写出 source.reasoning: false 与 trim_strings: []（与缺省行为相同）；删去未使用的函数
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
import statusBarHtml from './status_bar.html?raw';

/**
 * @constant {Omit<TavernRegex, 'id' | 'scope'>} REPLACE_PLACEHOLDER_REGEX
 * @description
 * 用于将消息中的状态栏占位符替换为实际的状态栏 HTML。
 */
export const REPLACE_PLACEHOLDER_REGEX: Omit<TavernRegex, 'id' | 'scope'> = {
  script_name: 'ERA 状态栏模板',
  enabled: true,
  run_on_edit: true,
  find_regex: `/<StatusPlaceHolderImpl\\/>/gsi`,
  replace_string: `\`\`\`html\n${statusBarHtml}\n\`\`\``,
  trim_strings: [],
  source: {
    user_input: false,
    ai_output: true,
    slash_command: false,
    world_info: false,
    reasoning: false,
  },
  destination: {
    display: true,
    prompt: false,
  },
  min_depth: null,
  max_depth: null,
};
