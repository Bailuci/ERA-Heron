/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增脚本设置“API写入不修改消息”；修复第三批改动在审查中发现的问题；可替换外部模块，统计聊天变量的写入次数；；可取得重放用的宿主（2026-11-26）
 *       2026-11-26 从头重放时沿用原聊天的解析版本；legacy 选项模拟 1.6 建立的旧聊天
 *       2026-11-27 tools、expr_fns 选项注册工具与公式函数（重放的宿主同样注册）；假的酒馆文件接口（折叠日志存档）移到这里
 *       2026-11-27 模拟的 getChatMessages 与酒馆助手一致，把越界的楼层号夹到首尾楼
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 一个只有内存状态的假聊天，用来驱动真实的同步流程。
const _ = require('lodash');
const { create_host } = require('./host.cjs');

const plain = value => JSON.parse(JSON.stringify(value));

/** 一个只有内存状态的聊天。每条消息: { role, swipes: string[], swipe_id }。 */
function create_chat(options = {}) {
  const chat = [];
  // legacy：模拟 1.6 及更早建立的聊天（元数据不为空、没有解析版本标记）
  const initial = () => (options.legacy ? { ERAMetaData: { EditLogs: {} } } : {});
  let variables = initial();
  const others = {}; // 全局变量、脚本变量等
  let fresh = null;
  let writes = 0;
  const host = create_host(
    {
      ...options.globals,
      getChatMessages: range => {
        const all = chat.map((m, message_id) => ({
          message_id,
          role: m.role,
          swipes: [...m.swipes],
          swipe_id: m.swipe_id,
        }));
        if (typeof range !== 'number') return all;
        // 与酒馆助手一致：越界的楼层号被夹到首楼或末楼，而不是返回空
        if (all.length === 0) return [];
        const index = range < 0 ? Math.max(0, all.length + range) : Math.min(range, all.length - 1);
        return [all[index]];
      },
      setChatMessages: async updates => {
        for (const update of updates) {
          const target = chat[update.message_id];
          if (update.swipes) target.swipes = [...update.swipes];
          else if (update.message !== undefined) target.swipes[target.swipe_id] = update.message;
        }
      },
      getVariables: option => plain(option?.type && option.type !== 'chat' ? (others[option.type] ??= {}) : variables),
      updateVariablesWith: async (updater, option) => {
        if (option?.type && option.type !== 'chat') {
          return (others[option.type] = plain(await updater(plain((others[option.type] ??= {})))));
        }
        variables = plain(await updater(plain(variables)));
        writes++;
        return variables;
      },
    },
    options.externals,
  );
  Object.assign(host.era_data.settings.value, options.settings ?? {});
  if (options.schema) host.registry.setActiveSchema(options.schema);
  for (const [id, fn, order] of options.hooks ?? []) host.hook_registry.addHook('after', id, fn, { order });
  for (const [id, fn] of options.before_hooks ?? []) host.hook_registry.addHook('before', id, fn);
  const tool_registry = host.load_src('api/tool_registry');
  for (const [name, definition] of options.tools ?? []) tool_registry.addTool(name, definition);
  for (const [name, fn, fn_options] of options.expr_fns ?? []) tool_registry.addExprFn(name, fn, fn_options);
  return {
    host,
    chat,
    send: (role, text) => chat.push({ role, swipes: [text], swipe_id: 0 }),
    swipe_new: (index, text) => {
      chat[index].swipes.push(text);
      chat[index].swipe_id = chat[index].swipes.length - 1;
    },
    /** 模拟 MESSAGE_SENT：只登记 MK，不计算变量。 */
    register_only: async () => {
      const { ensureMessageKey, updateLatestSelectedMk } = host.load_src('core/key/mk');
      const last = {
        message_id: chat.length - 1,
        role: chat.at(-1).role,
        swipes: [...chat.at(-1).swipes],
        swipe_id: chat.at(-1).swipe_id,
      };
      const { mk } = await ensureMessageKey(last);
      await updateLatestSelectedMk(mk);
    },
    sync: (...args) => host.sync.resyncStateOnHistoryChange(...args),
    variables: () => variables,
    /** 聊天变量被写入的次数。 */
    writes: () => writes,
    others,
    /** 直接把一条旁路写入挂到指定楼层；该楼层还没有 MK 时返回 null。 */
    push_op: async (index, { type, data }, compact = true) => {
      const { message_id, role, swipes, swipe_id } = { message_id: index, ...chat[index] };
      const msg = { message_id, role, swipes, swipe_id };
      const mk = host.mk.readMessageKey(msg);
      if (!mk) return null;
      const after = host.load_src('utils/message').countCommandBlocks(msg);
      const op = host.api_ops.createApiOp(type, data, after, false);
      await host.era_data.updateEraMetaData(meta => {
        meta.ApiOps = { ...meta.ApiOps, [mk]: host.api_ops.appendApiOp(meta.ApiOps?.[mk], op, compact) };
        return meta;
      });
      return { mk, op };
    },
    /** 像 `Era.applyText` 那样，把一段文本中的指令作为 `origin: 'text'` 的旁路写入挂到指定楼层；没有 MK 或指令时返回 null。 */
    push_text: async (index, text, compact = true) => {
      const { message_id, role, swipes, swipe_id } = { message_id: index, ...chat[index] };
      const msg = { message_id, role, swipes, swipe_id };
      const mk = host.mk.readMessageKey(msg);
      if (!mk) return null;
      const after = host.load_src('utils/message').countCommandBlocks(msg);
      const parse = host.load_src('core/version').getParseOptions(variables.ERAMetaData ?? {});
      const { ops } = host.api_ops.createTextApiOps(text, after, false, parse);
      if (ops.length === 0) return null;
      await host.era_data.updateEraMetaData(meta => {
        let record = meta.ApiOps?.[mk];
        for (const op of ops) record = host.api_ops.appendApiOp(record, op, compact);
        meta.ApiOps = { ...meta.ApiOps, [mk]: record };
        return meta;
      });
      return { mk, ops };
    },
    stat: () => variables.stat_data ?? {},
    /** 最近一次 `replay` 使用的宿主；还没有重放过时为 `null`。 */
    replay_host: () => fresh?.host ?? null,
    meta: () => variables.ERAMetaData ?? {},
    reset: () => {
      chat.length = 0;
      variables = initial();
    },
    /** 用一个没有任何历史的变量环境，按当前正文和旁路写入从头重放。可指定另一份旁路写入。 */
    replay: async api_ops => {
      // replay：重放用的选项（例如另一个文件服务器，避免覆盖原聊天的存档）
      fresh ??= create_chat(options.replay ? { ...options, ...options.replay, replay: undefined } : options);
      fresh.reset();
      const ops = (api_ops ?? variables.ERAMetaData?.ApiOps) && plain(api_ops ?? variables.ERAMetaData.ApiOps);
      // 沿用原聊天的解析版本：旧聊天（有元数据、没有标记）仍按旧方式解析
      const meta = fresh.variables().ERAMetaData ?? {};
      const parser = variables.ERAMetaData?.ParserVersion;
      if (parser !== undefined) meta.ParserVersion = parser;
      else if (!_.isEmpty(variables.ERAMetaData)) meta.EditLogs ??= {};
      if (ops) {
        for (const record of Object.values(ops)) record.applied = 0;
        meta.ApiOps = ops;
      }
      if (!_.isEmpty(meta)) fresh.variables().ERAMetaData = meta;
      for (const m of chat) fresh.send(m.role, m.swipes[m.swipe_id]);
      await fresh.sync(true);
      return fresh.stat();
    },
  };
}

/** 假的酒馆文件接口。 */
function create_files() {
  const files = new Map();
  const log = [];
  const server = { files, log, fail: false, character: 0, chat: 'chat' };
  server.globals = {
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    btoa,
    SillyTavern: {
      name1: 'User',
      name2: 'Char',
      get characterId() {
        return server.character;
      },
      characters: [{ avatar: 'a.png' }, { avatar: 'b.png' }],
      getCurrentChatId: () => server.chat,
      getRequestHeaders: () => ({}),
    },
    fetch: async (url, options = {}) => {
      log.push(`${options.method ?? 'GET'} ${url}`);
      if (server.fail) throw new Error('offline');
      const body = options.body && JSON.parse(options.body);
      if (url === '/api/files/upload') {
        await server.during?.();
        files.set(`/user/files/${body.name}`, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true };
      }
      if (url === '/api/files/delete') return { ok: files.delete(body.path) };
      if (url === '/api/files/verify')
        return { ok: true, json: async () => Object.fromEntries(body.urls.map(u => [u, files.has(u)])) };
      return { ok: files.has(url), status: files.has(url) ? 200 : 404, text: async () => files.get(url) ?? '' };
    },
  };
  return server;
}

module.exports = { create_chat, create_files, plain };
