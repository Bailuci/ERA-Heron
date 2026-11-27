/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-25 至 2026-11-27
 * 目的：新增脚本设置“数组内保留对象”；新增可选的变量结构 schema 校验与全局接口 Era；新增脚本设置“清理失效日志”；新增脚本设置“日志保留楼层数”；显示 ERA-Heron 版本号；脚本设置逐字段容错并提供严格校验；调整项目介绍与作者说法；era:extraStatus 的负载增加 warnings；新增事件 era:schemaInvalid（变量结构诊断）
 *       2026-11-26 新增版本标识 ERA_FEATURES 与 ERAMetaData 的解析版本 / 写入版本标记、脚本设置“思考标签”“指令外层标签”、旁路写入的 origin 字段
 *       2026-11-27 ERA_FEATURES 补登记其他 1.7 分支的功能：keepMessageKey、entryFilter、ejs、checkSchema、schemaInvalid、issuesMacro、reentryGuard、slashCommands；更正 ERA_FEATURES 注释中检查所在的测试文件；版本号改为 2.0.0；ejs 注释更正为分步更新设置；错误负载类型补 source 字段；工具调用与自定义公式函数（tools、exprFns、era:toolResult）；登记 exprCall（表达式调用存成变量的公式）；版本号升级至 2.0.2
 *       2026-11-27 解析版本 3；ActionsTaken.apply 标为保留字段；版本号 2.0.3
 *       2026-11-28 ERA_FEATURES 登记 sync、extraAuto；版本号 2.0.4
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 核心常量模块
 * @description
 * 该文件集中定义了整个 ERA 框架所使用的关键常量。
 * 这些常量主要用作在酒馆 `chat` 变量中存储和检索 ERA 核心数据的路径（键名）。
 *
 * **核心数据结构**:
 * ERA 的数据被分为两部分，存储在 `chat` 变量下：
 * 1. **元数据 (ERAMetaData)**: 包含框架自身运行所需的核心数据，如 `EditLogs` 和 `SelectedMks`。
 * 2. **状态数据 (stat_data)**: 包含所有由用户和 AI 管理的游戏/故事变量，如 `player`、`world_state` 等。
 *
 * 其结构大致如下：
 * ```json
 * {
 *   "ERAMetaData": {
 *     "EditLogs": { ... },
 *     "SelectedMks": [ ... ]
 *   },
 *   "stat_data": {
 *     "player": { "hp": 100, "gold": 50 },
 *     "world_state": { ... }
 *   }
 * }
 * ```
 * 将这些路径定义为常量，有助于：
 * 1. **避免硬编码**：减少因拼写错误导致的 bug。
 * 2. **提高可维护性**：如果未来需要调整数据结构，只需修改此文件即可。
 * 3. **增强代码可读性**：常量的名称清晰地表达了其所指向的数据的含义。
 */

'use strict';

import { z } from 'zod';

/** ERA-Heron（基于 ERA 变量框架二次开发）的版本号。 */
export const ERA_VERSION = '2.0.4';

/**
 * 当前版本提供的功能，供角色卡用 `Era.features.includes(...)` 判断，参见 `Era.features`。
 * 只增不删；新功能合入时在这里登记。`Era` 上新增的函数成员必须有对应的项（`tests/era_cross.test.cjs` 检查）。
 */
export const ERA_FEATURES: readonly string[] = [
  'registerSchema',
  'hooks',
  'commit',
  'simulate',
  'getVarsAt',
  'extra',
  'version',
  'parseCommands',
  'applyText',
  'maskThinking',
  'outerTag',
  'expr',
  'math',
  /** `Era.keepMessageKey`：前端改写正文时保留 `<era_data>` 与 `<era_extra>`。 */
  'keepMessageKey',
  /** `Era.registerEntryFilter` / `Era.hasEntryFilter`：分步更新的条目过滤器。 */
  'entryFilter',
  /** 分步更新按目标楼的状态渲染条目中的 EJS 与 `@@if`（分步更新设置“EJS预处理”）。 */
  'ejs',
  /** `Era.checkSchema`：变量结构诊断。 */
  'checkSchema',
  /** 事件 `era:schemaInvalid`：最新状态不符合变量结构时广播。 */
  'schemaInvalid',
  /** 宏 `{{ERA-issues}}`：主模型上一条回复中没有生效的指令。 */
  'issuesMacro',
  /** 钩子、条目过滤器执行期间拒绝写入接口（重入保护）。 */
  'reentryGuard',
  /** 斜杠命令 `/era-get`、`/era-issues`。 */
  'slashCommands',
  /** 工具调用 `<EraFCall>`：`Era.registerTool`、`{{ERA-tools}}`、`{{ERA-toolResults}}`、`era:toolResult`（1.8 起）。 */
  'tools',
  /** 自定义公式函数：`Era.registerExprFn`、`{{ERA-exprFns}}`（1.8 起）。 */
  'exprFns',
  /** 正文前规划：分步更新设置“正文前规划”、`[era_plan]` 条目、`Era.extra.plan` / `replan`（1.8 起）。 */
  'plan',
  /** `Era.commit` / `Era.applyText` 的幂等键 `options.key`（1.8 起）。 */
  'commitKey',
  /** `Era.setMessageText`：改写一楼的正文并重新计算。 */
  'setMessageText',
  /** `Era.sync`（可等待的同步）与 `Era.extra.autoRun` / `settings` / `planInjection`（自己建楼、自己调用生成的前端用）。 */
  'sync',
  'extraAuto',
  /** 表达式里的 `call(公式路径, 参数…)`：调用存成字符串变量的公式。 */
  'exprCall',
];

/** ERA-Heron 仓库。 */
export const ERA_REPOSITORY = 'https://github.com/Bailuci/ERA-Heron';

/** 各项脚本设置及其默认值。 */
const SETTING_FIELDS = {
  在ai消息尾部生成特殊符号: z.boolean().default(true),
  特殊符号值: z.string().default('<StatusPlaceHolderImpl/>'),
  开启悬浮球: z.boolean().default(true),
  开启黑夜模式: z.boolean().default(false),
  强制重载功能: z.boolean().default(false),
  /** 使用时向下取整。 */
  强制重载消息数: z.number().min(1).default(2),
  繁体转简体: z.boolean().default(false),
  /** 开启后，数组内的对象/数组不再被转成 JSON 字符串。默认关闭以兼容旧卡。 */
  数组内保留对象: z.boolean().default(false),
  /** 开启后，同步时删除已不在聊天记录中的消息（被删除或被 swipe 掉）遗留的 EditLogs。 */
  清理失效日志: z.boolean().default(false),
  /** 只保留最近 N 楼的逐楼 EditLogs，更早的折叠成一份等效日志。0 表示不折叠。使用时向下取整。 */
  日志保留楼层数: z.number().min(0).default(0),
  /** 把被折叠掉的逐楼日志存到酒馆服务器上的单独文件，仅在 `日志保留楼层数` 大于 0 时有效。参见 `core/log_archive.ts`。 */
  折叠日志存档: z.boolean().default(false),
  /** 开启后，AI 的指令不能修改或删除以 `_` 开头的字段（仍可插入新的）；旁路 API 写入和钩子不受限制。 */
  下划线只读: z.boolean().default(false),
  /** 指令块的 JSON 不合法时，尝试修复后再解析。 */
  宽松解析: z.boolean().default(true),
  /** 最新一条消息中有指令没有生效时弹窗提示。 */
  指令失败提示: z.boolean().default(false),
  /**
   * 思考标签，逗号或空格分隔。这些标签里的指令不执行（只对 1.7 起新建的聊天生效，参见 `core/version.ts`）。
   * 留空表示不遮蔽。
   */
  思考标签: z.string().default('think, thinking'),
  /**
   * 指令外层标签，例如 `ERA_Update`。填写后只执行该标签内部的指令（只对 1.7 起新建的聊天生效）。留空表示不启用。
   */
  指令外层标签: z.string().default(''),
  /** 开启后，era:insert* / update* / delete* 不再把指令块追加到消息正文。参见 `core/api_ops.ts`。 */
  API写入不修改消息: z.boolean().default(false),
  调试模式: z.boolean().default(false),
};

/** 给每个字段加上 `.catch(默认值)`。 */
function catchEach<T extends Record<string, z.ZodDefault<z.ZodType>>>(fields: T): { [K in keyof T]: z.ZodCatch<T[K]> } {
  const result: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(fields)) result[key] = field.catch(field.parse(undefined));
  return result as { [K in keyof T]: z.ZodCatch<T[K]> };
}

/**
 * 逐字段严格校验脚本设置，不回退到默认值。用于保存前检查，参见 `updateScriptSettings`。
 */
export const StrictSettingsSchema = z.object(SETTING_FIELDS);

/**
 * @constant {z.ZodObject} SettingsSchema
 * @description
 * 定义了脚本设置的 Zod schema，包括类型和默认值。
 * 每个字段都带 `.catch(默认值)`：某个字段的值不合法（例如设置面板清空数字框后存成的空字符串）时，
 * 只有它回到默认值，其余设置保持用户的选择，解析本身不会失败。
 */
export const SettingsSchema = z.object(catchEach(SETTING_FIELDS));

/**
 * @type {EraConfig}
 * @description ERA 框架的配置类型。
 */
export type EraConfig = z.infer<typeof SettingsSchema>;

/**
 * @constant {object} CHAT_SCOPE
 * @description
 * 用于酒馆助手 `getVariables` 和 `replaceVariables` 系列函数的 `scope` 参数。
 * 它指定了操作的目标是当前**聊天（Chat）**级别的变量。
 * ERA 框架的所有核心数据和用户变量都存储在此作用域下。
 */
export const CHAT_SCOPE = { type: 'chat' as const };

/**
 * @constant {string} META_DATA_PATH
 * @description 在 `chat` 变量中，存储 ERA 框架**元数据**的根对象的键名。
 */
export const META_DATA_PATH = 'ERAMetaData';

/**
 * @constant {string} STAT_DATA_PATH
 * @description 在 `chat` 变量中，存储用户**状态数据**的根对象的键名。
 */
export const STAT_DATA_PATH = 'stat_data';

/**
 * @constant {string} LOGS_PATH
 * @description
 * 在 `ERAMetaData` 对象中，存储**编辑日志（Edit Logs）**的对象的键名，即 `"EditLogs"`。
 * `EditLogs` 是一个以**消息密钥（MK）**为键，以该消息引发的变量变更记录数组为值的对象。
 * 这是实现“逆序回滚”功能的基础数据。
 *
 * @example
 * // chat.ERAMetaData.EditLogs 的一个条目
 * "era_mk_1759246942209_jipmrj": [
 *   { "op": "insert", "path": "testData.inventory", "value_new": { "gold": 100, "slots": ["sword", "shield"] } },
 *   { "op": "update", "path": "player.hp", "value_old": 90, "value_new": 100 }
 * ]
 */
export const LOGS_PATH = 'EditLogs';

/**
 * @constant {string} SEL_PATH
 * @description
 * 在 `ERAMetaData` 对象中，存储**已选择消息密钥链（Selected Message Keys）**的数组的键名，即 `"SelectedMks"`。
 * `SelectedMks` 是一个稀疏数组，其**索引约等于消息 ID**，值是该楼层消息的 MK。
 * 这个数组是 ERA 框架的“脊梁”，是连接抽象变量状态与具体聊天历史的桥梁。
 * 框架通过比对 `SelectedMks` 与实际消息流中的 MK，来判断数据是否需要同步。
 *
 * @example
 * // chat.ERAMetaData.SelectedMks
 * [ , "era_mk_greeting", "era_mk_abc123", , "era_mk_xyz789"]
 */
export const SEL_PATH = 'SelectedMks';

/**
 * @constant {string} API_OPS_PATH
 * @description 在 `ERAMetaData` 对象中，存储旁路 API 写入的键名。只有发生过旁路写入的聊天才有这个键。
 */
export const API_OPS_PATH = 'ApiOps';

/**
 * 在 `ERAMetaData` 中记录计算时用过的工具与公式函数版本的键名（1.8 起）：`{ 'tool:名字': '版本' }`。
 * 是缓存：当前注册的某个扩展与记录的版本不同（含没有记录）时完全重算一次，使历史按新逻辑结算。
 */
export const EXTENSIONS_PATH = 'Extensions';

/**
 * 在 `ERAMetaData` 中记录解析版本的键名。缺省（1.6 及更早建立的聊天）表示 1，即原来的解析方式。
 * 新聊天第一次写入元数据时记为 `PARSER_VERSION`，之后不再改变。参见 `core/version.ts`。
 */
export const PARSER_VERSION_PATH = 'ParserVersion';

/**
 * 当前的解析版本：
 * - 1：全文匹配指令块（1.6 及更早）；
 * - 2：先遮蔽思考标签的内容，设置了指令外层标签时只认标签内部的指令（1.7 起新建的聊天）；
 * - 3：保护规则补全（2.0.3 起新建的聊天）：整体覆盖或删除一个对象时也检查其中受 `$meta`、`_` 保护的内容，
 *   `<VariablePatch>` 不能改动 `$meta`。更早的聊天保持原来的结果。参见 `core/version.ts` 的 `isStrictProtection`。
 */
export const PARSER_VERSION = 3;

/** 在 `ERAMetaData` 中记录最近一次写入这个聊天的 ERA 版本的键名，仅用于提示，不影响计算。 */
export const WRITTEN_WITH_PATH = 'WrittenWith';

/** 一条旁路 API 写入。 */
export interface ApiOp {
  /** `call` 是工具调用（1.8 起），`data` 为 `{ name, args }`。 */
  type: 'insert' | 'edit' | 'delete' | 'patch' | 'call';
  /** 纯 JSON 数据；宏与繁转简已在写入时处理，未转义。 */
  data: any;
  /** 写入时该消息正文的指令数；重放时排在前 `after` 条正文指令之后。 */
  after: number;
  /** `block` 表示 `after` 按指令块计数（含无法解析的），因此不受解析方式影响；缺省是早期版本的计数方式。 */
  by?: 'block';
  /** 连续重复次数，缺省为 1。 */
  n?: number;
  /**
   * 来源，缺省为 `api`。`text` 表示由 `Era.applyText` 从文本解析而来，`下划线只读` 等规则按正文指令处理。
   * 合并（`n`）与压缩只发生在来源相同的写入之间。
   */
  origin?: 'text';
  /** 幂等键（1.8 起）：同一楼已有同 key 的写入时，新的提交被跳过。带 key 的写入不参与合并与压缩。 */
  key?: string;
}

/** 一条消息的旁路写入记录。`rev > applied` 表示有尚未执行的写入。 */
export interface ApiOpsRecord {
  rev: number;
  applied: number;
  ops: ApiOp[];
}

/**
 * @constant {string} FOLDED_MK_PATH
 * @description 在 `ERAMetaData` 对象中，存储日志折叠边界楼 MK 的键名。缺省表示未折叠。参见 `core/compaction.ts`。
 */
export const FOLDED_MK_PATH = 'FoldedThroughMk';

/** @constant {string} LOG_ARCHIVE_PATH - 折叠日志存档文件的路径。 */
export const LOG_ARCHIVE_PATH = 'LogArchive';

/**
 * @constant {string} ERA_DATA_TAG
 * @description
 * 用于在消息内容中包裹 ERA 元数据（如消息密钥 MK）的 XML 风格标签名。
 * e.g., `<era_data>{...}</era_data>`
 */
export const ERA_DATA_TAG = 'era_data';

/**
 * @constant {RegExp} ERA_DATA_REGEX
 * @description
 * 用于从消息内容字符串中匹配和提取 `<era_data>` 块的正则表达式。
 * 这个常量被定义在这里，以避免 `message_key.ts` 和 `message_utils.ts` 之间的循环依赖。
 */
export const ERA_DATA_REGEX = new RegExp(`<${ERA_DATA_TAG}>({.*?})<\\/${ERA_DATA_TAG}>`);

/**
 * @constant {object} ERA_API_EVENTS
 * @description
 * 定义了所有供外部脚本通过 `eventEmit` 调用的自定义 API 事件名称。
 * 使用这些常量可以避免在代码中使用硬编码的字符串。
 */
export const ERA_API_EVENTS = {
  INSERT_BY_OBJECT: 'era:insertByObject',
  UPDATE_BY_OBJECT: 'era:updateByObject',
  INSERT_BY_PATH: 'era:insertByPath',
  UPDATE_BY_PATH: 'era:updateByPath',
  DELETE_BY_OBJECT: 'era:deleteByObject',
  DELETE_BY_PATH: 'era:deleteByPath',
  /** 获取当前最新的变量状态 */
  GET_CURRENT_VARS: 'era:getCurrentVars',
  /** 获取指定 MK 的历史变量快照 */
  GET_SNAPSHOT_AT_MK: 'era:getSnapshotAtMk',
  /** 获取两个 MK 之间的所有历史变量快照 */
  GET_SNAPSHOTS_BETWEEN_MKS: 'era:getSnapshotsBetweenMks',
  /** 获取指定 message_id 的历史变量快照 */
  GET_SNAPSHOT_AT_MID: 'era:getSnapshotAtMId',
  /** 获取两个 message_id 之间的所有历史变量快照 */
  GET_SNAPSHOTS_BETWEEN_MIDS: 'era:getSnapshotsBetweenMIds',
  /** 请求 ERA 重新广播最新的 `writeDone` 事件 */
  REQUEST_WRITE_DONE: 'era:requestWriteDone',
  /** 强制触发一次同步，可指定范围 */
  FORCE_SYNC: 'era:forceSync',
  /** 执行 `<VariablePatch>` 中的操作 */
  PATCH: 'era:patch',
  /** 按顺序提交一组写入，可以指定楼层 */
  COMMIT: 'era:commit',
  /** （内部使用）写入额外模型的输出 */
  WRITE_EXTRA: 'era:writeExtra',
} as const;

/**
 * @constant {object} ERA_EVENT_EMITTER
 * @description 定义了所有由 ERA 框架**向外发出**的事件。
 */
export const ERA_EVENT_EMITTER = {
  /** 当变量写入完成时触发 */
  WRITE_DONE: 'era:writeDone',
  /** 当API执行写入时触发 */
  API_WRITE: 'era:apiWrite',
  /** 当变量查询准备好时触发，用于响应 GET_... 系列 API 事件 */
  VARS_QUERY_RESULT: 'era:queryResult',
  /** 当已注册的变量结构 schema 拦截了某些修改时触发 */
  SCHEMA_ERROR: 'era:schemaError',
  /** 当有指令没有生效时触发 */
  COMMAND_ERROR: 'era:commandError',
  /** 同步后最新的变量不符合已注册的变量结构时触发（同一聊天、同一组问题只触发一次） */
  SCHEMA_INVALID: 'era:schemaInvalid',
  /** 额外模型解析的进度 */
  EXTRA_STATUS: 'era:extraStatus',
  /** 本轮同步中执行了工具调用 `<EraFCall>`（1.8 起） */
  TOOL_RESULT: 'era:toolResult',
} as const;

/**
 * 描述在一次事件处理循环中，执行了哪些核心操作。
 * 这对于外部脚本理解状态变更的原因至关重要。
 */
export interface ActionsTaken {
  /** 保留字段，始终为 false（旧版的单楼回滚 `rollbackByMk` 已删除，回滚都在同步中完成） */
  rollback: boolean;
  /** 保留字段，始终为 false（判断变量有没有变请看 `editLogs` 或比较 `stat`） */
  apply: boolean;
  /** 是否执行了 `resyncStateOnHistoryChange` 操作 */
  resync: boolean;
  /** 是否执行了 API 调用 */
  api: boolean;
  /** 是否是由API调用触发的后续逻辑 */
  apiWrite: boolean;
  /** 是否因编辑消息而触发了重新同步 */
  editedResync: boolean;
  /** 是否因滑动消息而触发了变量回退 */
  swipedRollback: boolean;
}

/**
 * `era:writeDone` 事件的负载对象结构。它提供了关于一次成功写入操作的完整上下文。
 */
export interface WriteDonePayload {
  /**
   * 本轮事件处理循环中，最后操作的消息的**消息密钥 (Message Key)**。
   * 通常由 `ensureMkForLatestMessage` 在循环开始时确定。
   */
  mk: string;
  /**
   * 本轮事件处理循环中，最后操作的消息的**消息 ID**。
   */
  message_id: number;
  /**
   * 最后操作的消息是否由用户发送。
   */
  is_user: boolean;
  /**
   * 描述在本轮事件处理中，执行了哪些核心操作。
   */
  actions: ActionsTaken;
  /**
   * 事件处理完成**之后**，整个聊天会话的**已选择消息密钥链 (Selected Message Keys)** 的最新状态。
   * 这是一个稀疏数组，其索引约等于消息 ID，值是对应楼层消息的 MK。
   * 它代表了当前聊天记录的“主干”，是 ERA 判断同步状态的核心数据结构。
   */
  selectedMks: (string | null)[];
  /**
   * 事件处理完成**之后**，`chat` 变量中存储的**完整的编辑日志对象 (EditLogs)**。
   * 这是一个以 MK 为键，以变更记录数组为值的对象。
   */
  editLogs: { [key: string]: any[] };
  /**
   * 事件处理完成**之后**，整个聊天会话的**状态数据 (`stat_data`)** 的最新状态。
   * 这个版本**包含**所有内部使用的 `$meta` 字段。
   */
  stat: any;
  /**
   * 事件处理完成**之后**，一个**不包含**任何 `$meta` 字段的 `stat_data` 的深拷贝版本。
   * 适用于需要纯净数据进行展示或进一步处理的场景。
   */
  statWithoutMeta: any;
  /**
   * 表示这是对当前 `mk` 的第几次连续处理。
   * 如果一个新的 `mk` 被处理，这个计数会重置为 1。
   * 这对于需要感知状态是否在同一消息上连续更新的外部脚本很有用。
   */
  consecutiveProcessingCount: number;
}

/**
 * `era:queryResult` 事件中，单个查询结果的结构。
 */
export interface QueryResultItem {
  mk: string;
  message_id: number;
  is_user: boolean;
  stat: any;
  statWithoutMeta: any;
}

/**
 * `era:queryResult` 事件的负载对象结构。
 */
export interface QueryResultPayload {
  /** 原始查询的类型 */
  queryType:
    'getCurrentVars' | 'getSnapshotAtMk' | 'getSnapshotsBetweenMks' | 'getSnapshotAtMId' | 'getSnapshotsBetweenMIds';
  /** 原始查询的 detail 对象 */
  request: any;
  /** 查询的结果。根据 queryType，可以是单个结果或结果数组。 */
  result: QueryResultItem | QueryResultItem[];
  /**
   * 查询执行时，整个聊天会话的**已选择消息密钥链 (Selected Message Keys)** 的最新状态。
   */
  selectedMks: (string | null)[];
  /**
   * 查询执行时，`chat` 变量中存储的**完整的编辑日志对象 (EditLogs)**。
   */
  editLogs: { [key: string]: any[] };
}

/**
 * `era:schemaError` 事件中，单条消息的拦截记录。
 */
export interface SchemaErrorItem {
  /** 发生拦截的消息的 MK。 */
  mk: string | null;
  /** 发生拦截的消息的 ID。 */
  message_id: number;
  /** 被拦截的操作类型。 */
  op: 'insert' | 'update' | 'delete';
  /** 被拦截的变量路径。 */
  path: string;
  /** 指令试图写入的值；`delete` 操作没有该字段。 */
  value?: any;
  /** schema 给出的错误说明。 */
  message: string;
  /** 来自哪种指令：正文、旁路写入，或 beforeApply 钩子追加的指令；由 afterApply 钩子的修改引起时没有。 */
  origin?: 'text' | 'api' | 'hook' | 'tool';
  /** 只用于报告：`'extra'` 额外模型的输出，`'apiOps'` 旁路写入；主模型写在正文里的指令没有。 */
  source?: 'extra' | 'apiOps';
}

/**
 * `era:schemaError` 事件的负载对象结构。
 * 仅在注册了变量结构 schema、且本轮同步中有修改被拦截时触发。
 */
export interface SchemaErrorPayload {
  /** 本轮同步中被拦截的全部修改，按消息顺序排列。 */
  errors: SchemaErrorItem[];
}

/**
 * `era:schemaInvalid` 事件的负载对象结构。
 * 同步写入后，最新的变量（非空时）不符合已注册的变量结构时触发；同一聊天、同一组问题只触发一次。
 * 这时 ERA 照常放行之后的修改（无法判断是哪条修改造成的），可以用面板的“诊断”页一键修复。
 */
export interface SchemaInvalidPayload {
  /** 最后一条消息的 MK。 */
  mk: string | null;
  /** 最后一条消息的 ID。 */
  message_id: number;
  /** 不符合的地方。`missing`：缺必填字段（多半是 schema 升级新增了字段）；`invalid`：类型或取值不符。 */
  issues: { kind: 'missing' | 'invalid'; path: string; message: string }[];
  /** schema 的 safeParse 抛出异常时的说明，此时 `issues` 为空。 */
  error?: string;
}

/**
 * `era:commandError` 事件的负载对象结构。
 */
export interface CommandErrorPayload {
  /** 本轮同步中没有生效的指令，按消息顺序排列。 */
  errors: {
    mk: string | null;
    message_id: number;
    /** 指令类型；`parse` 表示指令块的内容无法解析。 */
    type: 'insert' | 'edit' | 'delete' | 'patch' | 'parse' | 'call';
    path: string;
    reason: string;
    /** 来自哪种指令：正文、旁路写入，或 beforeApply 钩子追加的指令；无法解析的块没有。 */
    origin?: 'text' | 'api' | 'hook' | 'tool';
    /** 只用于报告：`'extra'` 额外模型的输出，`'apiOps'` 旁路写入；主模型写在正文里的指令没有。 */
    source?: 'extra' | 'apiOps';
  }[];
}

/**
 * `era:extraStatus` 事件的负载对象结构。
 */
export interface ExtraStatusPayload {
  mk: string;
  message_id: number;
  /** `started`、`retry` 是过程；其余是结果。 */
  status: 'started' | 'retry' | 'done' | 'no_entries' | 'no_change' | 'aborted' | 'failed';
  /** 重试的原因，或最终没有解决的问题。 */
  problems?: string[];
  /** 结束时才有：不影响结果判定的告警（条目过滤器、EJS 渲染等）。 */
  warnings?: string[];
}
