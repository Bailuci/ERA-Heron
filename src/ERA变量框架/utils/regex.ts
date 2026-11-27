/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25
 * 目的：面板：分步更新设置、重新解析、更新旧卡规则；补充文档与规则
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import { Logger } from './log';

const logger = new Logger();

/**
 * @file ERA 变量框架 - 正则表达式工具模块
 * @description 提供用于管理和同步酒馆正则表达式的实用函数。
 */

/** 新旧版本的酒馆助手分别使用 `type` 和 `scope`，两者都提供。 */
export const CHARACTER_REGEX = { type: 'character', scope: 'character' } as TavernRegexOption;

type RegexInjectionResult = {
  success: boolean;
  status: 'injected' | 'exists' | 'failed' | 'skipped';
  reason?: string;
};

/**
 * 确保指定的正则表达式存在于当前角色的局部正则列表中。
 * 如果不存在，则会创建一个新的并添加到列表的末尾。
 *
 * @param regexData 一个不包含 `id` 和 `scope` 的 `TavernRegex` 对象。
 * 函数将根据 `script_name` 来检查正则是否存在。
 * @returns 一个包含操作结果的对象
 */
export async function ensureCharacterRegex(
  regexData: Omit<TavernRegex, 'id' | 'scope'>,
): Promise<RegexInjectionResult> {
  if (!isCharacterTavernRegexesEnabled()) {
    const reason = '局部正则未启用，跳过注入。';
    logger.debug('ensureCharacterRegex', reason);
    return { success: false, status: 'skipped', reason };
  }

  const characterRegexes = getTavernRegexes(CHARACTER_REGEX);
  const isAlreadyExists = characterRegexes.some(regex => regex.script_name === regexData.script_name);

  if (isAlreadyExists) {
    logger.debug('ensureCharacterRegex', `名为 "${regexData.script_name}" 的正则已存在，无需注入。`);
    return { success: true, status: 'exists' };
  }

  try {
    logger.debug('ensureCharacterRegex', `未找到名为 "${regexData.script_name}" 的正则，正在注入...`);
    await updateTavernRegexesWith(regexes => {
      // 在末尾添加新的正则表达式
      regexes.push({
        ...regexData,
        id: '', // id 会由酒馆自动生成
        scope: 'character',
      });
      return regexes;
    }, CHARACTER_REGEX);
    logger.debug('ensureCharacterRegex', '正则注入成功。');
    return { success: true, status: 'injected' };
  } catch (error) {
    const reason = `注入名为 "${regexData.script_name}" 的正则时发生错误。`;
    logger.error('ensureCharacterRegex', reason, error);
    return { success: false, status: 'failed', reason };
  }
}
