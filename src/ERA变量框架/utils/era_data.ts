/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26
 * 目的：脚本设置逐字段容错、保存前校验；新增 stat 与元数据一次写入的 updateEraData；
 *       新聊天第一次写入元数据时记下解析版本与写入版本；保存脚本设置时保留不认识的设置项（新版本增加的）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - ERA 核心变量读写模块
 */

'use strict';

import _ from 'lodash';
import {
  CHAT_SCOPE,
  ERA_VERSION,
  META_DATA_PATH,
  PARSER_VERSION,
  PARSER_VERSION_PATH,
  STAT_DATA_PATH,
  SettingsSchema,
  StrictSettingsSchema,
  EraConfig,
  WRITTEN_WITH_PATH,
} from './constants';
import { ref, readonly, DeepReadonly, Ref } from 'vue';

declare function getScriptId(): string;

// --- 响应式配置中心 ---

/**
 * @description 存储全局脚本设置的响应式引用。
 * @internal
 */
const scriptSettingsRef: Ref<EraConfig> = ref(SettingsSchema.parse({}));

/**
 * @description 供外部模块使用的只读的脚本设置。
 * @example
 * import { settings } from './utils/era_data';
 * if (settings.value.调试模式) { ... }
 */
export const settings: DeepReadonly<Ref<EraConfig>> = readonly(scriptSettingsRef);

/** 值不合法的设置项。缺失的项会使用默认值，不算不合法。 */
export function findInvalidSettings(raw: unknown): (keyof EraConfig)[] {
  const source: Record<string, unknown> = _.isPlainObject(raw) ? (raw as Record<string, unknown>) : {};
  const shape = StrictSettingsSchema.shape;
  return (Object.keys(shape) as (keyof EraConfig)[]).filter(key => !shape[key].safeParse(source[key]).success);
}

/**
 * 解析脚本设置。逐字段容错：某一项不合法时只有它回到默认值，其余设置不受影响。
 * @returns 解析后的设置，以及被回退为默认值的设置项。
 */
export function parseScriptSettings(raw: unknown): { settings: EraConfig; invalid: (keyof EraConfig)[] } {
  const source = _.isPlainObject(raw) ? raw : {};
  return { settings: SettingsSchema.parse(source), invalid: findInvalidSettings(source) };
}

/** `updateScriptSettings` 拒绝保存不合法的设置时抛出的错误，`fields` 是不合法的设置项。 */
export class InvalidSettingsError extends Error {
  constructor(public readonly fields: (keyof EraConfig)[]) {
    super(`脚本设置的值不合法：${fields.join('、')}`);
    this.name = 'InvalidSettingsError';
  }
}

/**
 * @description 初始化脚本设置，从酒馆变量中读取并填充到响应式引用中。
 * 应在脚本启动时调用一次。某一项不合法时只有它使用默认值，并提示用户。
 */
export function initEraSettings() {
  const rawSettings = getVariables({ type: 'script', script_id: getScriptId() });
  const { settings, invalid } = parseScriptSettings(rawSettings);
  scriptSettingsRef.value = settings;
  if (invalid.length > 0) {
    console.warn('[ERA] 以下脚本设置的值不合法，已使用默认值：', invalid);
    toastr.warning(`以下脚本设置的值不合法，已使用默认值：${invalid.join('、')}`, '[ERA]');
  }
}

/**
 * 递归地从对象中移除所有以 `$` 开头的字段（如 `$meta`, `$template`）。
 * 返回新的对象和数组，不修改原始对象。只复制一遍（不再先深拷贝整份数据再删除）。
 * @param {any} obj - 待处理的对象或值。
 * @returns {any} 一个不包含 `$` 前缀字段的新对象或原始值。
 */
export function removeMetaFields(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(item => removeMetaFields(item));
  }
  if (_.isPlainObject(obj)) {
    const newObj: Record<string, any> = {};
    for (const key in obj) {
      if (!key.startsWith('$')) newObj[key] = removeMetaFields(obj[key]);
    }
    return newObj;
  }
  // 其他对象（聊天变量来自 JSON，实际不会出现）保持原来的深拷贝行为
  return _.isObject(obj) ? _.cloneDeep(obj) : obj;
}

/**
 * 获取并确保 ERA 的元数据和状态数据对象的存在。
 * @returns {{meta: object, stat: object}} 包含元数据和状态数据的对象。
 */
export function getEraData(): { meta: any; stat: any } {
  const chatVars = getVariables(CHAT_SCOPE) || {};
  const meta = _.get(chatVars, META_DATA_PATH, {});
  const stat = _.get(chatVars, STAT_DATA_PATH, {});
  return { meta, stat };
}

/**
 * 原子性地更新 ERA 的状态数据 (stat_data)。
 * @param {(currentStatData: any) => (any | Promise<any>)} updater - 一个接收当前 stat_data 并返回修改后 stat_data 的函数 (可以是 async)。
 */
export async function updateEraStatData(updater: (currentStatData: any) => any | Promise<any>) {
  await updateVariablesWith(async v => {
    const currentStat = _.get(v, STAT_DATA_PATH, {});
    const newStat = await updater(currentStat);
    _.set(v, STAT_DATA_PATH, newStat);
    return v;
  }, CHAT_SCOPE);
}

/**
 * 新聊天（ERA 从未写入过元数据）第一次写入元数据时，记下解析版本与写入版本，参见 `core/version.ts`。
 * 只在 `before` 为空、`after` 不为空时修改 `after`。
 */
export function stampNewChatMeta(before: any, after: any): void {
  if (!_.isEmpty(before) || !_.isPlainObject(after) || _.isEmpty(after)) return;
  if (!_.has(after, PARSER_VERSION_PATH)) _.set(after, PARSER_VERSION_PATH, PARSER_VERSION);
  _.set(after, WRITTEN_WITH_PATH, ERA_VERSION);
}

/**
 * 原子性地更新 ERA 的元数据 (ERAMetaData)。
 * @param {(currentMetaData: any) => (any | Promise<any>)} updater - 一个接收当前 ERAMetaData 并返回修改后 ERAMetaData 的函数 (可以是 async)。
 */
export async function updateEraMetaData(updater: (currentMetaData: any) => any | Promise<any>) {
  await updateVariablesWith(async v => {
    const currentMeta = _.get(v, META_DATA_PATH, {});
    const wasEmpty = _.isEmpty(currentMeta);
    const newMeta = await updater(currentMeta);
    if (wasEmpty) stampNewChatMeta({}, newMeta);
    _.set(v, META_DATA_PATH, newMeta);
    return v;
  }, CHAT_SCOPE);
}

/**
 * 原子性地同时更新 ERA 的状态数据和元数据，只写入一次聊天变量。
 * @param updater 接收当前的 `{ stat, meta }`，返回新的 `{ stat, meta }`；返回传入的对象本身表示不修改。
 */
export async function updateEraData(
  updater: (current: { stat: any; meta: any }) => { stat: any; meta: any } | Promise<{ stat: any; meta: any }>,
) {
  await updateVariablesWith(async v => {
    const current = { stat: _.get(v, STAT_DATA_PATH, {}), meta: _.get(v, META_DATA_PATH, {}) };
    const wasEmpty = _.isEmpty(current.meta);
    const next = await updater(current);
    if (next === current) return v;
    if (wasEmpty) stampNewChatMeta({}, next.meta);
    _.set(v, STAT_DATA_PATH, next.stat);
    _.set(v, META_DATA_PATH, next.meta);
    return v;
  }, CHAT_SCOPE);
}

/**
 * 原子性地更新脚本设置。
 *
 * - 传给 `updater` 的当前设置已逐字段容错（不合法的项为默认值）。
 * - `updater` 返回的设置会先逐字段校验：有不合法的项时**不保存**，抛出 `InvalidSettingsError`（`fields` 为这些项）；
 *   缺失的项使用默认值。
 * @returns 实际保存的设置。
 */
export async function updateScriptSettings(
  updater: (currentSettings: EraConfig) => EraConfig | Promise<EraConfig>,
): Promise<EraConfig> {
  let saved: EraConfig = scriptSettingsRef.value;
  await updateVariablesWith(
    async rawSettings => {
      const { settings: currentSettings } = parseScriptSettings(rawSettings);
      const newSettings = await updater(currentSettings);
      const invalid = findInvalidSettings(newSettings);
      if (invalid.length > 0) throw new InvalidSettingsError(invalid);
      saved = SettingsSchema.parse(newSettings);
      // 更新内存中的响应式引用
      scriptSettingsRef.value = saved;
      // 保留不认识的设置项：它们可能是更新的 ERA 增加的，降级后保存一次不应把它们丢掉
      const unknown = _.isPlainObject(rawSettings) ? _.omit(rawSettings, Object.keys(StrictSettingsSchema.shape)) : {};
      return { ...unknown, ...saved };
    },
    { type: 'script', script_id: getScriptId() },
  );
  return saved;
}
