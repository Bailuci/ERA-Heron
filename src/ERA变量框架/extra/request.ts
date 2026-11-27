/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。日期：2026-11-27。
 * 目的：分步更新与正文前规划的请求加上头部提示词、酒馆预设（提示词条目与采样参数）和流式请求
 *       2026-11-27 注释写明预设条目按“聊天记录”分在 ERA 提示词前后
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 发给更新模型、规划模型的请求
 * @description
 * ERA 用酒馆助手的 `generateRaw` 自己组织提示词（`ordered_prompts`），不经过酒馆的预设。
 * `generateRaw` 的类型声明里虽然有 `preset_name`（来自 `GenerateConfig`），但 `generateRaw` 本身说明“不使用酒馆当前启用的预设”，
 * 提示词完全由 `ordered_prompts` 决定，预设里的条目不会发出去。所以“使用预设”由 ERA 自己完成：
 * 用 `getPreset` 读出预设，把其中启用的、不是占位符的条目按预设里的顺序和角色放在 ERA 的提示词前后，
 * 采样参数（温度、top_p 等）经 `custom_api` 传给酒馆。
 *
 * 最终顺序：头部提示词 → 预设中“聊天记录”之前的条目 → ERA 自己的规则、变量、剧情（完整保留）→ 预设中“聊天记录”之后的条目。
 * 条目保留预设里设定的角色（system / user / assistant）。
 */
'use strict';

import { ExtraApi, ExtraConfig, getPresetName, toCustomApi } from './config';

export type RolePromptLike = { role: 'system' | 'assistant' | 'user'; content: string };

/** 预设里的占位符条目：世界书、角色描述、聊天记录等的插入位置，没有自己的内容。 */
const PLACEHOLDER_IDS = [
  'worldInfoBefore',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
];

/** 预设设置里可以经 `custom_api` 传递的采样参数：预设里的名字 → `custom_api` 的名字。 */
const SAMPLING_KEYS: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  max_completion_tokens: 'max_tokens',
};

export interface PresetPart {
  /** 预设里排在“聊天记录”占位符之前的条目（启用的、有内容的非占位条目，已替换酒馆宏，保留各自的角色）。 */
  prompts: RolePromptLike[];
  /** 排在“聊天记录”占位符之后的条目（常见的是放在末尾的破限、输出要求），发送时放在 ERA 的提示词之后。 */
  tail: RolePromptLike[];
  /** 预设的采样参数（`custom_api` 的字段名）。 */
  sampling: Record<string, number>;
}

const presetLabel = (name: string) => (name === 'in_use' ? '当前预设' : `预设“${name}”`);

const expandMacros = (text: string): string => {
  try {
    return substitudeMacros(text);
  } catch {
    return text;
  }
};

/**
 * 读取预设中要用的部分。`name` 为 `null` 时不使用预设；读不到（不存在、读取出错、没填名字）时返回 `null` 并记入 `warnings`。
 */
export function readPresetPart(name: string | null, warnings: string[]): PresetPart | null {
  if (name === null) return null;
  if (name === '') {
    warnings.push('选了“使用指定预设”但没有填写预设名，这次没有使用预设');
    return null;
  }
  let preset: any;
  try {
    if (name !== 'in_use' && typeof getPresetNames === 'function' && !getPresetNames().includes(name)) {
      throw new Error('没有这个预设');
    }
    preset = getPreset(name);
    if (!preset || typeof preset !== 'object') throw new Error('预设内容为空');
  } catch (error: any) {
    warnings.push(`无法读取${presetLabel(name)}，这次没有使用预设：${error?.message ?? error}`);
    return null;
  }
  const prompts: RolePromptLike[] = [];
  const tail: RolePromptLike[] = [];
  let afterHistory = false;
  for (const prompt of Array.isArray(preset.prompts) ? preset.prompts : []) {
    // 预设里“聊天记录”的位置对应 ERA 自己的规则、变量与剧情：它之后的条目放在 ERA 的提示词后面
    if (String(prompt?.id) === 'chatHistory') afterHistory = true;
    if (!prompt?.enabled || PLACEHOLDER_IDS.includes(String(prompt.id))) continue;
    if (typeof prompt.content !== 'string' || !prompt.content.trim()) continue;
    const content = expandMacros(prompt.content);
    if (!content.trim()) continue;
    const role = ['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system';
    (afterHistory ? tail : prompts).push({ role, content });
  }
  const sampling: Record<string, number> = {};
  for (const [from, to] of Object.entries(SAMPLING_KEYS)) {
    const value = preset.settings?.[from];
    if (typeof value === 'number' && Number.isFinite(value)) sampling[to] = value;
  }
  return { prompts, tail, sampling };
}

export interface PreparedRequest {
  /** 实际发送的提示词。 */
  prompts: RolePromptLike[];
  custom_api?: Record<string, any>;
  should_stream: boolean;
}

/**
 * 在 ERA 的提示词前面加上头部提示词和预设中“聊天记录”之前的条目、后面加上“聊天记录”之后的条目，合并采样参数。
 * ERA 设置里明确填写的“温度”“最大回复”优先于预设。
 * @param stage `update` 是更新模型（`group` 是分组名），`plan` 是规划模型。
 */
export function prepareRequest(
  prompts: RolePromptLike[],
  config: ExtraConfig,
  api: ExtraApi,
  stage: 'update' | 'plan',
  group: string,
  warnings: string[],
): PreparedRequest {
  const head: RolePromptLike[] = [];
  const header = String(config.头部提示词 ?? '').trim();
  if (header) head.push({ role: 'system', content: expandMacros(header) });
  const preset = readPresetPart(getPresetName(config, stage, group), warnings);
  if (preset) head.push(...preset.prompts);
  const own = toCustomApi(api, config);
  const merged = { ...(preset?.sampling ?? {}), ...(own ?? {}) };
  return {
    prompts: [...head, ...prompts.map(({ role, content }) => ({ role, content })), ...(preset?.tail ?? [])],
    custom_api: _.isEmpty(merged) ? undefined : merged,
    should_stream: config.请求方式 === '流式',
  };
}
