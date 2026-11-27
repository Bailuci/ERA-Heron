/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；导出按字面键名查找的函数，供 /era-get 命令使用；新增 {{ERA-issues}}（2026-11-26）
 *       2026-11-27 分步更新的提示词里 {{ERA-issues}} 展开为空（它是主模型上一条回复的问题，与更新模型无关）；新增 {{ERA-tools}}、{{ERA-exprFns}}、{{ERA-toolResults}}
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 宏解析
 * @description 把文本中的 ERA 宏替换为变量值。不注册任何监听，可以被其他模块直接使用。
 */
'use strict';

import { describeLatestIssues, describeLatestToolResults } from '../core/latest_report';
import { describeActiveSchema, describeExprFns, describeTools } from '../extra/describe';
import { unescapeEraData } from '../utils/data';
import { getEraData, removeMetaFields } from '../utils/era_data';
import { Logger } from '../utils/log';

const logger = new Logger('MacroParser');

/** 按字面上的键名查找，用于键名本身含有 `.`、`[`、`]` 的情况：每一级优先匹配最长的键。 */
export function getByRawKeys(data: any, path: string): any {
  if (!_.isPlainObject(data)) return undefined;
  if (Object.prototype.hasOwnProperty.call(data, path)) return data[path];
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '.') continue;
    const key = path.slice(0, i);
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const found = getByRawKeys(data[key], path.slice(i + 1));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 解析字符串中的 ERA 宏, 并将其替换为对应的变量值。
 * 这是提供给其他模块调用的公共接口。
 * @param text - 包含宏的输入字符串。
 * @param stat_data - 可选的，用于宏替换的特定变量快照。如果未提供，则使用最新的全局状态。
 * @param options.issues `{{ERA-issues}}` 是否展开为最新 AI 楼的问题，默认 `true`；为 `false` 时展开为空
 *   （分步更新的提示词：这些问题是主模型上一条回复的，不是更新模型的，目标楼也不一定是最新楼）。
 * @returns - 替换宏后的字符串。
 */
export function parseEraMacros(
  text: string,
  statWithMeta?: object | null,
  statWithoutMeta?: object | null,
  options: { issues?: boolean } = {},
): string {
  if (!/{{\s*ERA/i.test(text)) {
    return text;
  }
  text = text.replace(/{{\s*ERA-schema\s*}}/gi, () => describeActiveSchema());
  // 最新 AI 楼中主模型写错的指令和原因；没有问题时为空
  text = text.replace(/{{\s*ERA-issues\s*}}/gi, () => (options.issues === false ? '' : describeLatestIssues()));
  text = text.replace(/{{\s*ERA-tools\s*}}/gi, () => describeTools());
  text = text.replace(/{{\s*ERA-exprFns\s*}}/gi, () => describeExprFns());
  // 与 {{ERA-issues}} 一样是主模型上一条回复的结果，分步更新的提示词里为空
  text = text.replace(/{{\s*ERA-toolResults\s*}}/gi, () =>
    options.issues === false ? '' : describeLatestToolResults(),
  );
  const macroRegex = /{{\s*ERA(-withmeta)?\s*:\s*([^}]+?)\s*}}/gi;

  // 如果没有提供特定的 stat，则从全局获取
  const finalStatWithMeta = statWithMeta ?? unescapeEraData(getEraData().stat);
  const finalStatWithoutMeta = statWithoutMeta ?? unescapeEraData(removeMetaFields(getEraData().stat));

  return text.replace(macroRegex, (substring, withMeta, path) => {
    const funcName = 'parseEraMacros';
    const trimmedPath = path.trim();
    const includeMeta = !!withMeta;

    // 根据用户要求，选择正确的数据源
    const statToUse = includeMeta ? finalStatWithMeta : finalStatWithoutMeta;

    if (!statToUse) {
      logger.warn(funcName, `无法获取到宏替换所需的数据 (includeMeta: ${includeMeta})`);
      return substring; // 返回原始宏以避免破坏内容
    }

    let data;
    if (trimmedPath === '$ALLDATA') {
      data = statToUse;
    } else {
      data = _.get(statToUse, trimmedPath) ?? getByRawKeys(statToUse, trimmedPath);
    }

    if (data === undefined) {
      logger.warn(funcName, `在数据源中未找到路径 "${trimmedPath}", 宏将替换为空字符串.`);
      return ''; // 路径未找到, 返回空字符串
    }

    // 数据直接从 stat 中获取，无需反转义
    const finalData = data;

    logger.debug(funcName, `宏替换数据: ${trimmedPath}`, {
      data: finalData,
    });

    if (typeof finalData === 'object' && finalData !== null) {
      return JSON.stringify(finalData);
    }

    return String(finalData);
  });
}
