/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：状态栏占位符只用于显示，从发给 AI 的提示词中去掉，避免每条历史 AI 消息都带着它、AI 模仿输出
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @constant {Omit<TavernRegex, 'id' | 'scope'>} HIDE_STATUS_PLACEHOLDER_REGEX
 * @description
 * ERA 在每条 AI 消息末尾写入状态栏占位符 `<StatusPlaceHolderImpl/>`，由“ERA 状态栏模板”在显示时换成状态栏。
 * 占位符对 AI 没有用处，这条正则只作用于提示词（仅格式提示词），把它连同前面的空白一起去掉；显示不受影响。
 */
export const HIDE_STATUS_PLACEHOLDER_REGEX: Omit<TavernRegex, 'id' | 'scope'> = {
  script_name: 'ERA 状态栏占位符隐藏正则',
  enabled: true,
  run_on_edit: true,
  find_regex: String.raw`/\s*<StatusPlaceHolderImpl\/>/gi`,
  replace_string: '',
  trim_strings: [],
  source: {
    user_input: false,
    ai_output: true,
    slash_command: false,
    world_info: false,
    reasoning: false,
  },
  destination: {
    display: false,
    prompt: true,
  },
  min_depth: null,
  max_depth: null,
};
