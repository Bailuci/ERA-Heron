/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：新增斜杠命令 /era-get（按路径读取去转义、去 $meta 的变量 JSON）与 /era-issues（最新 AI 楼没有生效的指令与原因），供 STscript、快速回复与冒烟测试使用
 *       2026-11-27 /era-issues 与 {{ERA-issues}} 共用最新 AI 楼的报告；新增 format=model，输出与 {{ERA-issues}} 相同的给主模型的文字
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import { collectLatestIssues, describeLatestIssuesForModel, formatIssues, readEraValue } from '../core/issues';
import { waitForQueueIdle } from '../events/queue';
import { Logger } from '../utils/log';

const logger = new Logger();

/** 读取前最多等待进行中的同步这么久（毫秒），与提示词中的宏一致。 */
const SYNC_WAIT = 3000;

const isTrue = (value: unknown) =>
  ['true', '1', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

/** 等进行中的同步结束，避免读到同步到一半的状态；超时后照常读取。 */
async function settle() {
  if (!(await waitForQueueIdle(SYNC_WAIT))) logger.warn('settle', '等待同步超时，读取当前的变量。');
}

/**
 * `/era-get [meta=true] 路径`：返回变量的 JSON。路径规则与 `{{ERA:路径}}` 一致，空路径返回全部变量；
 * 找不到时返回空串。字符串也按 JSON 返回（带引号），便于断言类型。
 */
export async function eraGet(named: Record<string, unknown>, path: string): Promise<string> {
  await settle();
  const value = readEraValue(path, isTrue(named?.meta));
  return value === undefined ? '' : JSON.stringify(value);
}

/**
 * `/era-issues [format=json|model]`：最新 AI 楼没有生效的指令与原因，与 `{{ERA-issues}}` 读同一份报告（见 `core/issues.ts`）。
 * - 默认每条一行（`- 路径：原因`），列出全部来源的问题，没有问题时为空串；
 * - `format=json` 返回完整结果，形如 `{"message_id":3,"mk":"…","problems":[{"path":"…","reason":"…","origin":"text"}]}`，
 *   额外模型输出和旁路写入的问题带 `source`（`extra` / `api`），无法计算时带 `unavailable` 说明原因；
 * - `format=model` 返回 `{{ERA-issues}}` 给主模型的文字（只含主模型自己写在正文里的指令）。
 */
export async function eraIssues(named: Record<string, unknown>): Promise<string> {
  await settle();
  const format = String(named?.format ?? '')
    .trim()
    .toLowerCase();
  if (format === 'model') return describeLatestIssuesForModel();
  const issues = await collectLatestIssues();
  if (format === 'json') return JSON.stringify(issues);
  return formatIssues(issues);
}

/**
 * 注册 `/era-get` 与 `/era-issues`。酒馆不支持注销命令，脚本卸载后命令仍在，调用时直接返回空串。
 * @returns 卸载时调用的清理函数；当前酒馆不支持斜杠命令时返回 `null`。
 */
export function registerDataCommands(): (() => void) | null {
  const context: any = SillyTavern;
  const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument } = context ?? {};
  if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return null;
  let alive = true;
  const guard =
    (name: string, run: (named: Record<string, unknown>, value: string) => Promise<string>) =>
    async (named: Record<string, unknown>, value: unknown) => {
      if (!alive) {
        toastr.warning('ERA 脚本没有在运行。', 'ERA');
        return '';
      }
      try {
        return await run(named ?? {}, String(value ?? ''));
      } catch (error) {
        logger.error(name, '执行失败', error);
        return '';
      }
    };
  const named = (name: string, description: string, enumList: string[]) =>
    SlashCommandNamedArgument?.fromProps
      ? [SlashCommandNamedArgument.fromProps({ name, description, typeList: ['string'], enumList, isRequired: false })]
      : undefined;
  const unnamed = (description: string) =>
    SlashCommandArgument?.fromProps
      ? [SlashCommandArgument.fromProps({ description, typeList: ['string'], isRequired: false })]
      : undefined;

  const commands = [
    {
      name: 'era-get',
      callback: guard('era-get', eraGet),
      returns: '变量的 JSON；找不到时为空',
      namedArgumentList: named('meta', '为 true 时保留 $meta', ['true', 'false']),
      unnamedArgumentList: unnamed('变量路径，例如 角色.生命；留空返回全部变量'),
      helpString:
        '读取 ERA 变量，返回去掉转义和 <code>$meta</code> 的 JSON。路径规则与 <code>{{ERA:路径}}</code> 相同。' +
        '例：<code>/era-get 角色.生命 | /echo</code>；<code>/era-get meta=true 角色</code> 保留 $meta。',
    },
    {
      name: 'era-issues',
      callback: guard('era-issues', (args: Record<string, unknown>) => eraIssues(args)),
      returns: '没有生效的指令，每条一行；没有问题时为空',
      namedArgumentList: named('format', 'json 返回完整结果；model 返回 {{ERA-issues}} 的内容', [
        'text',
        'json',
        'model',
      ]),
      helpString:
        '列出最新 AI 楼没有生效的变量指令与原因，每条一行，没有问题时为空。' +
        '<code>/era-issues format=json</code> 返回 JSON；<code>/era-issues format=model</code> 返回与 ' +
        '<code>{{ERA-issues}}</code> 相同的、给主模型的文字。',
    },
  ];
  try {
    for (const props of commands) {
      SlashCommandParser.addCommandObject(SlashCommand.fromProps(_.omitBy(props, _.isUndefined)));
    }
  } catch (error) {
    logger.warn('registerDataCommands', '注册 /era-get、/era-issues 失败', error);
  }
  return () => (alive = false);
}
