/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；角色卡可以在角色卡变量中推荐分步更新的设置，新增备用接口；；新增“EJS预处理”；导出和诊断用的设置副本去掉密钥
 *       2026-11-26 设置保留不认识的字段，旧版本保存一次不会丢掉新版本增加的设置
 *       2026-11-27 分阶段选预设、头部提示词、附带角色描述与用户人设、流式请求；把当前设置存为本卡推荐、清除本卡推荐
 *       2026-11-27 存为本卡推荐时，玩家是“跟随角色卡”则保留卡里原有的变量更新方式推荐
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 额外模型的设置
 * @description
 * 玩家的设置保存在酒馆的**全局变量**中，而不是脚本变量：脚本变量会随角色卡一起导出，API 密钥不能放在那里。
 * 注意全局变量对所有酒馆助手脚本和前端界面开放，其他角色卡的脚本也能读到其中的密钥；
 * 浏览器里没有更隔离的位置（这些脚本与酒馆同源），因此只在文档和面板中提示风险，推荐使用酒馆的代理预设或跟随酒馆：
 * 那样 ERA 不保存任何密钥。localStorage 也不是安全措施：同源的脚本照样能读，它只能让密钥不进服务器设置和备份。
 * 导出、复制、诊断设置时用 `redactExtraConfig` 去掉密钥。
 *
 * 角色卡可以在**角色卡变量** `ERA分步更新` 中推荐不含接口与密钥的设置（随卡导出）。
 * 玩家把“变量更新方式”设为“跟随角色卡”（默认）时采用；选了其他方式时完全按玩家的设置。
 */
'use strict';

import { readonly, ref } from 'vue';
import { z } from 'zod';

const GLOBAL_KEY = 'ERA额外模型';
/** 角色卡变量中推荐设置的键名。 */
export const CARD_KEY = 'ERA分步更新';

// 设置用 looseObject：保留不认识的字段（更新的 ERA 增加的设置），降级后保存一次不会把它们丢掉
const ApiSchema = z.looseObject({
  来源: z.enum(['跟随酒馆', '代理预设', '自定义']).catch('跟随酒馆'),
  代理预设: z.string().catch(''),
  接口地址: z.string().catch(''),
  密钥: z.string().catch(''),
  模型: z.string().catch(''),
  接口类型: z.string().catch('openai'),
});
export type ExtraApi = z.infer<typeof ApiSchema>;

/** 更新模型、规划模型使用预设的方式。 */
export const PRESET_MODES = ['不使用预设', '使用当前预设', '使用指定预设'] as const;
export type PresetMode = (typeof PRESET_MODES)[number];

/** 可以由角色卡推荐的设置：不含接口与密钥。 */
const CardFields = {
  等待方式: z.enum(['发送前等待', '后台更新']).catch('发送前等待'),
  失败处理: z.enum(['保留有效部分', '整次放弃']).catch('保留有效部分'),
  聊天楼层数: z.number().min(1).catch(2),
  重试次数: z.number().min(0).max(10).catch(1),
  超时秒数: z.number().min(5).catch(120),
  /** 0 表示不限制。 */
  最大回复: z.number().min(0).catch(0),
  /** -1 表示不设置。 */
  温度: z.number().min(-1).catch(-1),
  附加要求: z.string().catch(''),
  /**
   * 发给更新模型的条目是否先渲染 EJS（需要提示词模板插件）：按目标楼的状态求值 `@@if` 和 `<% %>`，写函数不执行。
   * “关闭”时与 1.6 一样发原文。
   */
  EJS预处理: z.enum(['自动', '关闭']).catch('自动'),
  /**
   * 正文前规划（1.8 起）：玩家点击发送时，先请求规划模型按 `[era_plan]` 条目结算检定、骰点等结果，
   * 写成指令块追加在玩家消息里，再发送。卡里没有 `[era_plan]` 条目时不规划。
   */
  正文前规划: z.enum(['关闭', '开启']).catch('关闭'),
  /**
   * 更新模型用不用酒馆的预设：把预设里启用的提示词条目按“聊天记录”的位置放在 ERA 的提示词前后，并采用预设的采样参数。
   * “使用指定预设”时按 `更新模型预设名`；角色卡只能推荐前两种（预设是玩家本机的）。
   */
  更新模型预设: z.enum(PRESET_MODES).catch('不使用预设'),
  /** 规划模型（正文前规划）用不用酒馆的预设，含义同 `更新模型预设`。 */
  规划模型预设: z.enum(PRESET_MODES).catch('不使用预设'),
  /** 是否在提示词里附上角色描述与用户人设（酒馆的 `{{description}}`、`{{persona}}`）。 */
  附带角色信息: z.enum(['关闭', '开启']).catch('关闭'),
};

/** 角色卡可以推荐的预设方式：具体的预设只存在玩家本机。 */
const CARD_PRESET_MODES: readonly string[] = ['不使用预设', '使用当前预设'];

const PresetChoiceSchema = z.looseObject({
  预设: z.enum(PRESET_MODES).catch('不使用预设'),
  预设名: z.string().catch(''),
});
export type PresetChoice = z.infer<typeof PresetChoiceSchema>;

export const ExtraConfigSchema = z.looseObject({
  /** “跟随角色卡”：按角色卡的推荐，卡片没有推荐时等同于“随AI输出”。 */
  变量更新方式: z.enum(['随AI输出', '额外模型解析', '跟随角色卡']).catch('跟随角色卡'),
  ...CardFields,
  默认接口: ApiSchema.catch(ApiSchema.parse({})),
  /** 按分组名指定接口；没有指定的分组使用默认接口。 */
  分组接口: z.record(z.string(), ApiSchema).catch({}),
  /** 主接口（分组接口或默认接口）请求失败时依次换用；用完后在最后一个上按重试次数重试。 */
  备用接口: z.array(ApiSchema).catch([]),
  /** `更新模型预设` 为“使用指定预设”时用的预设名。 */
  更新模型预设名: z.string().catch(''),
  /** `规划模型预设` 为“使用指定预设”时用的预设名。 */
  规划模型预设名: z.string().catch(''),
  /** 按分组名指定预设；没有指定的分组按 `更新模型预设`。 */
  分组预设: z.record(z.string(), PresetChoiceSchema).catch({}),
  /** 玩家自己的头部提示词（破限等），作为第一条系统提示词；空时不加。只在玩家设置里，角色卡不能推荐。 */
  头部提示词: z.string().catch(''),
  /** 请求方式，对应 `generateRaw` 的 `should_stream`。 */
  请求方式: z.enum(['非流式', '流式']).catch('非流式'),
});
export type ExtraConfig = z.infer<typeof ExtraConfigSchema>;

/** 角色卡推荐的设置；只包含卡片写了的项。 */
export type CardExtraPreference = Partial<Pick<ExtraConfig, keyof typeof CardFields>> & {
  变量更新方式?: '随AI输出' | '额外模型解析';
};

const configRef = ref<ExtraConfig>(ExtraConfigSchema.parse({}));
/** 玩家的全局设置（不含角色卡推荐）。 */
export const extraConfig = readonly(configRef);

export const createExtraApi = (): ExtraApi => ApiSchema.parse({});

/** 密钥在导出、诊断信息里的替代文字。 */
export const REDACTED_KEY = '（已隐藏）';

/** 设置的副本，去掉所有接口的密钥（填了的换成“（已隐藏）”），用于导出、复制和诊断信息。 */
export function redactExtraConfig(config: ExtraConfig): ExtraConfig {
  const copy = _.cloneDeep(config);
  const redact = (api: ExtraApi | undefined) => {
    if (api && typeof api === 'object' && api.密钥) api.密钥 = REDACTED_KEY;
  };
  redact(copy.默认接口);
  Object.values(copy.分组接口 ?? {}).forEach(redact);
  (copy.备用接口 ?? []).forEach(redact);
  return copy;
}

/** 读取玩家的全局设置（编辑用）。 */
export function loadExtraConfig(): ExtraConfig {
  const raw = _.get(getVariables({ type: 'global' }), GLOBAL_KEY, {});
  configRef.value = ExtraConfigSchema.parse(_.isPlainObject(raw) ? raw : {});
  return _.cloneDeep(configRef.value);
}

export async function saveExtraConfig(config: ExtraConfig): Promise<void> {
  const next = ExtraConfigSchema.parse(config);
  configRef.value = next;
  await updateVariablesWith(variables => _.set(variables, [GLOBAL_KEY], _.cloneDeep(next)), { type: 'global' });
}

/** 当前角色卡在角色卡变量中推荐的设置；没有打开角色卡或没有推荐时为 `null`。无效的值被忽略。 */
export function getCardExtraPreference(): CardExtraPreference | null {
  let raw: unknown;
  try {
    raw = _.get(getVariables({ type: 'character' }), CARD_KEY);
  } catch {
    return null; // 没有打开角色卡（例如群聊）
  }
  if (!_.isPlainObject(raw)) return null;
  const source = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (source.变量更新方式 === '随AI输出' || source.变量更新方式 === '额外模型解析') {
    result.变量更新方式 = source.变量更新方式;
  }
  for (const [key, field] of Object.entries(CardFields)) {
    if (!(key in source)) continue;
    const parsed = (field as z.ZodType).safeParse(source[key]);
    // 字段带有 catch，无效的值会变成默认值；只有原样通过的值才采用
    if (!parsed.success || !_.isEqual(parsed.data, source[key])) continue;
    // 角色卡不能指定具体的预设
    if (PRESET_KEYS.includes(key) && !CARD_PRESET_MODES.includes(parsed.data as string)) continue;
    result[key] = parsed.data;
  }
  return _.isEmpty(result) ? null : (result as CardExtraPreference);
}

const PRESET_KEYS: readonly string[] = ['更新模型预设', '规划模型预设'];

/**
 * 从设置中取出角色卡可以推荐的部分：`CardFields` 与变量更新方式（“跟随角色卡”不写）。
 * 不含接口、密钥、头部提示词、请求方式、分组预设和具体的预设名；“使用指定预设”不写。
 */
export function pickCardPreference(config: ExtraConfig): CardExtraPreference {
  const parsed = ExtraConfigSchema.parse(_.cloneDeep(config));
  const result: Record<string, unknown> = {};
  if (parsed.变量更新方式 !== '跟随角色卡') result.变量更新方式 = parsed.变量更新方式;
  for (const key of Object.keys(CardFields)) {
    const value = (parsed as Record<string, unknown>)[key];
    if (PRESET_KEYS.includes(key) && !CARD_PRESET_MODES.includes(value as string)) continue;
    result[key] = _.cloneDeep(value);
  }
  return result as CardExtraPreference;
}

/** 卡里原有推荐中有效的变量更新方式。 */
const readCardMode = (raw: unknown): CardExtraPreference['变量更新方式'] | undefined => {
  const mode = _.isPlainObject(raw) ? (raw as Record<string, unknown>).变量更新方式 : undefined;
  return mode === '随AI输出' || mode === '额外模型解析' ? mode : undefined;
};

/**
 * 要写进角色卡的推荐：`pickCardPreference` 的结果；玩家选“跟随角色卡”（没有自己的变量更新方式）时，
 * 保留卡里原有的变量更新方式推荐，否则保存一次就会让这张卡对跟随角色卡的玩家退回“随AI输出”。
 * @param current 卡里原有的推荐（角色卡变量 `ERA分步更新` 的原始值）。
 */
function mergeCardPreference(config: ExtraConfig, current: unknown): CardExtraPreference {
  const picked = pickCardPreference(config);
  if (picked.变量更新方式 !== undefined) return picked;
  const kept = readCardMode(current);
  return kept === undefined ? picked : ({ 变量更新方式: kept, ...picked } as CardExtraPreference);
}

/** 按当前角色卡预览 `saveCardExtraPreference` 会写入的内容，不写入。没有打开角色卡时按没有原有推荐处理。 */
export function previewCardPreference(config: ExtraConfig): CardExtraPreference {
  let current: unknown;
  try {
    current = _.get(getVariables({ type: 'character' }), CARD_KEY);
  } catch {
    current = undefined;
  }
  return mergeCardPreference(config, current);
}

/**
 * 把设置中角色卡可以推荐的部分写进当前角色卡的角色卡变量 `ERA分步更新`（覆盖原有的推荐；
 * 玩家是“跟随角色卡”时保留原有的变量更新方式推荐）。没有打开角色卡时抛出异常。
 */
export async function saveCardExtraPreference(config: ExtraConfig): Promise<CardExtraPreference> {
  let preference = pickCardPreference(config);
  await updateVariablesWith(
    variables => {
      preference = mergeCardPreference(config, _.get(variables, [CARD_KEY]));
      return _.set(variables, [CARD_KEY], _.cloneDeep(preference));
    },
    { type: 'character' },
  );
  return preference;
}

/** 删除当前角色卡的推荐设置。没有打开角色卡时抛出异常。 */
export async function clearCardExtraPreference(): Promise<void> {
  await updateVariablesWith(
    variables => {
      _.unset(variables, [CARD_KEY]);
      return variables;
    },
    { type: 'character' },
  );
}

/**
 * 某个阶段使用的预设：`update` 是更新模型（可以按分组单独指定），`plan` 是规划模型。
 * 返回 `null` 表示不使用预设；`in_use` 表示酒馆当前的预设（含未保存的修改）；选了“使用指定预设”却没填名字时为空字符串。
 */
export function getPresetName(config: ExtraConfig, stage: 'update' | 'plan', group = ''): string | null {
  let mode: string | undefined;
  let name = '';
  const own = stage === 'update' && group ? config.分组预设?.[group] : undefined;
  if (own) {
    mode = own.预设;
    name = own.预设名;
  } else if (stage === 'update') {
    mode = config.更新模型预设;
    name = config.更新模型预设名;
  } else {
    mode = config.规划模型预设;
    name = config.规划模型预设名;
  }
  if (mode === '使用当前预设') return 'in_use';
  if (mode === '使用指定预设') return String(name ?? '').trim();
  return null;
}

/** 实际生效的设置：玩家选“跟随角色卡”时合并角色卡的推荐。结果的变量更新方式不会是“跟随角色卡”。 */
export function resolveExtraConfig(base: ExtraConfig = configRef.value): ExtraConfig {
  const config = _.cloneDeep(base) as ExtraConfig;
  if (config.变量更新方式 !== '跟随角色卡') return config;
  const card = getCardExtraPreference();
  return { ...config, ...card, 变量更新方式: card?.变量更新方式 ?? '随AI输出' };
}

export const isExtraEnabled = (): boolean => resolveExtraConfig().变量更新方式 === '额外模型解析';

/** 某个分组依次尝试的接口：主接口（分组接口或默认接口），然后是备用接口。 */
export function getApiChain(config: ExtraConfig, group: string): ExtraApi[] {
  return [config.分组接口[group] ?? config.默认接口, ...config.备用接口];
}

/** 把接口设置转换成酒馆助手的 `custom_api`；完全跟随酒馆时返回 `undefined`。 */
export function toCustomApi(api: ExtraApi, config: ExtraConfig): Record<string, any> | undefined {
  const result: Record<string, any> = {};
  if (api.来源 === '代理预设' && api.代理预设) result.proxy_preset = api.代理预设;
  if (api.来源 === '自定义') {
    if (api.接口地址) result.apiurl = api.接口地址;
    if (api.密钥) result.key = api.密钥;
  }
  if (api.来源 !== '跟随酒馆' && api.接口类型) result.source = api.接口类型;
  if (api.模型) result.model = api.模型;
  if (config.最大回复 > 0) result.max_tokens = config.最大回复;
  if (config.温度 >= 0) result.temperature = config.温度;
  return _.isEmpty(result) ? undefined : result;
}
