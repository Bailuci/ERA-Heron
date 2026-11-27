/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26
 * 目的：快速初始化增加“ERA 状态栏占位符隐藏正则”
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import { ensureCharacterRegex } from '../../utils/regex';
import { HIDE_ERA_DATA_REGEX } from './regex_objects/hide_era_data';
import { HIDE_ERA_METADATA_REGEX } from './regex_objects/hide_era_metadata';
import { HIDE_ERA_THINKING_REGEX } from './regex_objects/hide_era_thinking';
import { HIDE_STATUS_PLACEHOLDER_REGEX } from './regex_objects/hide_status_placeholder';
import { REPLACE_PLACEHOLDER_REGEX } from './regex_objects/replace_placeholder';
import { Logger } from '../../utils/log';

const logger = new Logger();

/**
 * @file 手动初始化模块 - 正则表达式
 * @description 该模块负责在需要时手动触发 ERA 框架相关的正则表达式的初始化。
 */

type InitRegexResult = {
  success: boolean;
  reason?: string;
  details: {
    regexName: string;
    status: 'injected' | 'exists' | 'failed' | 'skipped';
    reason?: string;
  }[];
};

/**
 * 初始化 ERA 框架所需的所有角色卡级别的正则表达式。
 * @returns {Promise<InitRegexResult>} 返回一个包含详细操作结果的对象。
 */
export async function initEraCharacterRegexes(): Promise<InitRegexResult> {
  if (!isCharacterTavernRegexesEnabled()) {
    const reason = '当前角色卡未开启局部正则，请先在角色卡设置中启用。';
    logger.warn('initEraCharacterRegexes', reason);
    return { success: false, reason, details: [] };
  }

  const regexesToInject = [
    HIDE_ERA_DATA_REGEX,
    REPLACE_PLACEHOLDER_REGEX,
    HIDE_ERA_METADATA_REGEX,
    HIDE_ERA_THINKING_REGEX,
    HIDE_STATUS_PLACEHOLDER_REGEX,
  ];
  const results = [];
  let allSuccess = true;

  for (const regex of regexesToInject) {
    const result = await ensureCharacterRegex(regex);
    results.push({
      regexName: regex.script_name,
      status: result.status,
      reason: result.reason,
    });
    if (!result.success) {
      allSuccess = false;
    }
  }

  return { success: allSuccess, details: results };
}
