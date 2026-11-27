/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；修复第三批改动在审查中发现的问题；修复复审中发现的问题；发送前等待只拦玩家的发送，脚本用 Era.extra.wait()；修复 [1] 形式的键在 Patch 中的回滚；分步更新的重试、退避、备用接口、角色卡推荐、超时等待、“继续”、status() 与 run() 的测试；条目过滤器、EJS 渲染、warnings、实测的 generateRaw 错误形状、写入已到正文但同步未完成
 *       2026-11-27 预设、头部提示词、附带角色信息、流式请求、存为本卡推荐与 status().history 的测试
 *       2026-11-27 主生成标记卡住、规划摘要的配对注入、切换聊天后丢弃旧聊天的结果、跟随角色卡时保留卡里的变量更新方式
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 等待式写入、试算、变量结构说明与额外模型解析。
const test = require('node:test');
const assert = require('node:assert/strict');
const z = require('zod');
const { create_chat, plain } = require('./chat.cjs');

const T = (tag, value) => `<Variable${tag}>${JSON.stringify(value)}</Variable${tag}>`;

const entry = (name, content, extra = {}) => ({
  name,
  content,
  enabled: true,
  strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] } },
  position: { order: 100 },
  ...extra,
});

/** 带有世界书、宏等酒馆接口的假聊天。 */
function create_env({ entries = [entry('[era_update]规则', '规则内容')], ...options } = {}) {
  let chat_id = 'chat';
  const worldbooks = { 主书: entries };
  const env = create_chat({
    ...options,
    globals: {
      SillyTavern: {
        name1: 'User',
        name2: 'Char',
        characterId: 'c',
        characters: {},
        getCurrentChatId: () => chat_id,
      },
      getCharWorldbookNames: () => ({ primary: '主书', additional: [] }),
      getGlobalWorldbookNames: () => ['不存在'],
      getChatWorldbookName: () => null,
      getWorldbook: async name => {
        if (!worldbooks[name]) throw new Error('not found');
        return worldbooks[name];
      },
      substitudeMacros: text => text.replace(/{{user}}/g, 'User'),
      formatAsTavernRegexedString: text => text,
      setTimeout,
      clearTimeout,
      $: () => {},
      ...options.globals,
    },
  });
  const load = env.host.load_src;
  const tickets = load('events/handlers/api/tickets');
  const commit_raw = load('events/handlers/api/handler').commit;
  const { handleWriteExtra } = load('events/handlers/api/extra_write');
  const readMk = i => env.host.mk.readMessageKey({ message_id: i, ...env.chat[i] });
  /** 与同步事件一致：同步后结算凭据。 */
  const sync = async (...args) => {
    await env.sync(...args);
    tickets.settleTickets();
  };
  return {
    ...env,
    load,
    tickets,
    sync,
    mk: readMk,
    switch_chat: id => (chat_id = id),
    commit: async (operations, detail = {}, { settle = true } = {}) => {
      const { ticket, promise } = tickets.createTicket(300);
      promise.catch(() => {});
      await commit_raw({ operations, ...detail }, ticket);
      if (settle) await sync();
      return promise;
    },
    write_extra: async (mk, blocks) => {
      const { ticket, promise } = tickets.createTicket(300);
      promise.catch(() => {});
      await handleWriteExtra({ mk, blocks }, ticket);
      await sync();
      await promise;
    },
  };
}

// ============================ 等待式写入 ============================

test('commit：按顺序执行全部写入，完成时带有结果，不修改正文', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { 金币: 10, 背包: ['剑'] }));
  await env.sync();
  const before = env.chat[0].swipes[0];
  const result = await env.commit([
    { edit: { 金币: '-=3' } },
    { patch: [{ op: 'insert', path: '/背包/-', value: '面包' }] },
    { insert: { 新: 1 } },
    { delete: { 新: {} } },
  ]);
  assert.deepEqual(plain(result.statWithoutMeta), { 金币: 7, 背包: ['剑', '面包'] });
  assert.equal(result.mk, env.mk(0));
  assert.equal(env.chat[0].swipes[0], before);
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));
});

test('commit：可以写到较早的楼层，之后的楼层在其基础上重算', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { 金币: 10 }));
  env.send('assistant', T('Edit', { 金币: '*=2' }));
  await env.sync();
  await env.commit({ edit: { 金币: '+=5' } }, { message_id: 0 });
  assert.equal(env.stat().金币, 30);
  await env.commit({ edit: { 金币: '+=1' } }, { mk: env.mk(0) });
  assert.equal(env.stat().金币, 32);
  await assert.rejects(env.commit({ edit: { 金币: 1 } }, { mk: 'era_mk_none' }), /目标消息不存在/);
});

test('commit atomic：有一项不能生效就全部不写入', async () => {
  const schema = z.object({ 金币: z.coerce.number().min(0) });
  const env = create_env({ schema });
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  const meta = plain(env.meta());
  await assert.rejects(env.commit([{ edit: { 金币: '-=4' } }, { edit: { 金币: '-=20' } }], { atomic: true }), /放弃/);
  await assert.rejects(env.commit([{ edit: { 金币: 5 } }, { edit: { 不存在: 1 } }], { atomic: true }), /放弃/);
  assert.deepEqual(plain(env.meta()), meta);
  assert.equal(env.stat().金币, 10);
  await env.commit([{ edit: { 金币: '-=4' } }], { atomic: true });
  assert.equal(env.stat().金币, 6);
  // 不要求原子时，有效的部分照常生效
  await env.commit([{ edit: { 金币: '-=1' } }, { edit: { 金币: '-=20' } }]);
  assert.equal(env.stat().金币, 5);
});

test('commit atomic：之前尚未同步的写入也计算在内', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  const first = env.commit([{ insert: { b: 1 } }], {}, { settle: false });
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = env.commit([{ edit: { b: '+=1' } }], { atomic: true });
  await Promise.all([first, second]);
  assert.deepEqual(plain(env.stat()), { a: 1, b: 2 });
});

test('commit：格式错误、没有消息、切换聊天时失败', async () => {
  const env = create_env();
  await assert.rejects(env.commit([{ edit: { a: 1 } }]), /没有可以写入的消息/);
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  await assert.rejects(env.commit([{ set: { a: 1 } }]), /每项写入必须是/);
  await assert.rejects(env.commit([{ edit: { a: 1 }, insert: {} }]), /每项写入必须是/);
  const pending = env.commit([{ edit: { a: 2 } }], {}, { settle: false });
  await new Promise(resolve => setTimeout(resolve, 10));
  env.switch_chat('other');
  env.tickets.settleTickets();
  await assert.rejects(pending, /聊天已切换/);
});

test('commit atomic：刚到的消息、更早楼层未同步的写入都计算在内', async () => {
  const schema = z.object({ 金币: z.coerce.number().min(0) });
  const env = create_env({ schema });
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  env.send('assistant', T('Edit', { 金币: '-=8' }));
  await assert.rejects(env.commit([{ edit: { 金币: '-=5' } }], { atomic: true }), /放弃/);
  assert.equal(env.stat().金币, 2);
  const early = env.commit([{ edit: { 金币: '-=2' } }], { message_id: 0 }, { settle: false });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(env.commit([{ edit: { 金币: '-=1' } }], { atomic: true }), /放弃/);
  await early;
  assert.equal(env.stat().金币, 0);
});

test('commit atomic：按真正的执行顺序检查，钩子在写入之后执行', async () => {
  const schema = z.object({ 金币: z.coerce.number().min(0), 背包: z.array(z.string()) });
  const env = create_env({ schema, hooks: [['收入', ({ stat }) => void (stat.金币 += 5)]] });
  env.send('assistant', T('Insert', { 金币: 10, 背包: [] }));
  await env.sync();
  assert.equal(env.stat().金币, 15);
  const buy = cost => [{ edit: { 金币: `-=${cost}` } }, { patch: [{ op: 'append', path: '/背包', value: '剑' }] }];
  await assert.rejects(env.commit(buy(12), { atomic: true }), /放弃/);
  assert.deepEqual(plain(env.stat()), { 金币: 15, 背包: [] });
  await env.commit(buy(10), { atomic: true });
  assert.deepEqual(plain(env.stat()), { 金币: 5, 背包: ['剑'] });
});

test('commit atomic：折叠了的旧楼明确失败，不拿当前状态冒充', async () => {
  const env = create_env({ settings: { 日志保留楼层数: 2 } });
  env.send('assistant', T('Insert', { a: 1 }));
  for (let i = 0; i < 6; i++) env.send('assistant', '剧情');
  env.send('assistant', T('Insert', { later: 1 }));
  await env.sync();
  await env.sync();
  assert.ok(env.meta().FoldedThroughMk);
  await assert.rejects(env.commit({ edit: { later: 5 } }, { message_id: 1, atomic: true }), /折叠/);
  assert.equal(await env.load('core/simulate').getStatAfter(env.mk(1)), null);
  // 不要求原子时仍可写入，之后从头重放
  await env.commit({ edit: { a: 5 } }, { message_id: 1 });
  assert.equal(env.stat().a, 5);
});

test('commit atomic：试算期间切换聊天，不写入另一个聊天', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  const sync = env.load('core/simulate');
  const original = sync.createFloorSimulator;
  Object.defineProperty(sync, 'createFloorSimulator', {
    value: async (...args) => {
      const result = await original(...args);
      env.switch_chat('other');
      return result;
    },
  });
  await assert.rejects(env.commit([{ edit: { a: 2 } }], { atomic: true }, { settle: false }), /聊天已切换/);
  assert.equal(env.meta().ApiOps, undefined);
});

test('commit：指定的消息仍在流式生成，或 MK 重复时', async () => {
  let generating = false;
  const env = create_env({ globals: { builtin: { duringGenerating: () => generating } } });
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  env.chat.push(plain(env.chat[0]));
  await env.commit([{ insert: { b: 1 } }], { message_id: 1 });
  assert.notEqual(env.mk(0), env.mk(1));
  assert.deepEqual(Object.keys(env.meta().ApiOps), [env.mk(1)]);
  env.send('assistant', '正在生成');
  generating = true;
  await assert.rejects(env.commit([{ insert: { c: 1 } }], { message_id: 2 }, { settle: false }), /生成中/);
});

test('commit：没有内容时立即失败；超时的写入不会在之后才执行', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  await assert.rejects(env.commit([]), /没有要写入的内容/);
  const { ticket, promise } = env.tickets.createTicket(5);
  await assert.rejects(promise, /已放弃/);
  await env.load('events/handlers/api/handler').commit({ operations: { edit: { a: 9 } } }, ticket);
  assert.equal(env.meta().ApiOps, undefined);
});

test('commit atomic：钩子原有的问题消失，不能与写入自己的问题抵消', async () => {
  const schema = z.object({ 金币: z.coerce.number().min(0) });
  const env = create_env({ schema, hooks: [['支出', ({ stat }) => void (stat.金币 -= 5)]] });
  env.send('assistant', T('Insert', { 金币: 3 }));
  await env.sync();
  assert.equal(env.stat().金币, 3);
  await assert.rejects(env.commit([{ edit: { 金币: '+=4' } }, { edit: { 金币: '-=100' } }], { atomic: true }), /放弃/);
  assert.equal(env.stat().金币, 3);
});

test('commit：无效的 message_id 失败，不会写到开场白', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  env.send('assistant', '剧情');
  await env.sync();
  for (const message_id of [null, NaN, 'x', 1.5, 99]) {
    await assert.rejects(env.commit({ edit: { a: 2 } }, { message_id }), /目标消息不存在/);
  }
  await env.commit({ edit: { a: 2 } }, { message_id: -1 });
  assert.deepEqual(Object.keys(env.meta().ApiOps), [env.mk(1)]);
});

test('commit：同步没有完成时，超时失败', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  await assert.rejects(env.commit([{ edit: { a: 2 } }], {}, { settle: false }), /限定时间/);
});

// ============================ 试算 ============================

test('simulate：返回结果与问题，不改变任何数据', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  const before = JSON.stringify(env.variables());
  const { simulateText } = env.load('core/simulate');
  const result = await simulateText(
    `${T('Edit', { a: 5, 无: 1 })}${T('Patch', [{ op: 'remove', path: '/没有' }])}`,
    env.stat(),
  );
  assert.equal(result.stat.a, 5);
  assert.equal(result.problems.length, 2);
  assert.equal(JSON.stringify(env.variables()), before);
});

test('额外模型的试算基准：不含额外模型的输出，但含自己的指令和旁路写入', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  env.send('assistant', `剧情${T('Edit', { a: '+=10' })}`);
  await env.sync();
  await env.write_extra(env.mk(1), T('Edit', { a: '+=100' }));
  await env.push_op(1, { type: 'edit', data: { a: '+=1000' } });
  await env.sync();
  assert.equal(env.stat().a, 1111);
  const { findMessageByMk, createExtraSimulator } = env.load('core/simulate');
  assert.equal((await createExtraSimulator(findMessageByMk(env.mk(1)))).stat.a, 1011);
});

// ============================ 写回楼层 ============================

test('writeExtra：写到指定楼层的正文，重复写入时整块替换，可以清除', async () => {
  const env = create_env();
  env.send('assistant', `你好${T('Insert', { a: 1 })}`);
  env.send('user', '嗯');
  env.send('assistant', '后面的剧情');
  await env.sync();
  env.chat[0].swipes[0] = '{{user}}' + env.chat[0].swipes[0];
  const raw = env.chat[0].swipes[0];
  await env.write_extra(env.mk(0), T('Edit', { a: 2 }));
  assert.equal(env.stat().a, 2);
  assert.ok(env.chat[0].swipes[0].includes('{{user}}'), '不应固定宏');
  await env.write_extra(env.mk(0), T('Edit', { a: 3 }));
  assert.equal(env.stat().a, 3);
  assert.equal(env.chat[0].swipes[0].match(/<era_extra>/g).length, 1);
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));
  await env.write_extra(env.mk(0), '');
  assert.equal(env.stat().a, 1);
  assert.equal(env.chat[0].swipes[0], raw.trimEnd());
});

test('writeExtra：目标暂时滑到别的 swipe 时写到原来那一条，滑回来后生效；已删除时失败', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  env.send('assistant', '剧情');
  await env.sync();
  const mk = env.mk(1);
  env.swipe_new(1, '另一个剧情');
  await env.sync();
  await env.write_extra(mk, T('Edit', { a: 2 }));
  assert.equal(env.stat().a, 1);
  assert.ok(!env.chat[1].swipes[1].includes('era_extra'));
  env.chat[1].swipe_id = 0;
  await env.sync();
  assert.equal(env.stat().a, 2);
  env.chat.pop();
  await env.sync();
  const before = plain(env.chat);
  await assert.rejects(env.write_extra(mk, T('Edit', { a: 3 })), /不存在/);
  assert.deepEqual(plain(env.chat), before);
});

test('writeExtra：值里含有 ERA 自己的标签时，正文仍能正确分段', async () => {
  const env = create_env();
  env.send('assistant', `剧情${T('Insert', { a: '' })}`);
  await env.sync();
  for (const n of [1, 2, 3]) {
    await env.write_extra(env.mk(0), T('Edit', { a: `x</era_extra><era_data>${n}` }));
    assert.equal(env.stat().a, `x</era_extra><era_data>${n}`);
    assert.equal(env.chat[0].swipes[0].match(/<\/era_extra>/g).length, 1);
  }
  await env.write_extra(env.mk(0), '');
  assert.ok(!env.chat[0].swipes[0].includes('Edit'));
});

test('继续生成后重新解析：旧的输出被移除，新的输出排在最后', async () => {
  const env = create_env();
  env.send('assistant', '剧情');
  await env.sync();
  await env.write_extra(env.mk(0), T('Insert', { a: 1 }));
  env.chat[0].swipes[0] += '\n继续的剧情';
  await env.sync();
  await env.write_extra(env.mk(0), T('Insert', { a: 2 }));
  assert.equal(env.stat().a, 2);
  assert.ok(env.chat[0].swipes[0].indexOf('继续的剧情') < env.chat[0].swipes[0].indexOf('<era_extra>'));
});

// ============================ 变量结构说明 ============================

test('describeSchema：枚举、范围、可空、记录、数组', () => {
  const env = create_env();
  env.host.registry.setActiveSchema(
    z.object({
      状态: z.enum(['健康', '受伤']).prefault('健康'),
      血量: z.coerce.number().min(0).max(100),
      计数: z.number(),
      名字: z.string().nullable(),
      背包: z.record(z.string().describe('物品名'), z.object({ 数量: z.number().int().describe('至少一个') })),
      标签: z.array(z.union([z.string(), z.number()])),
    }),
  );
  const { describeActiveSchema } = env.load('extra/describe');
  const text = describeActiveSchema();
  assert.match(text, /状态: '健康' \| '受伤';/);
  assert.match(text, /血量: .*0~100/);
  assert.match(text, /计数: number;/);
  assert.match(text, /名字: string \| null;/);
  assert.match(text, /\[物品名\]: \{\n      数量: number; \/\/ 至少一个/);
  assert.match(text, /标签: \(string \| number\)\[\];/);
  const { parseEraMacros } = env.load('macro/parse');
  assert.equal(parseEraMacros('<{{ERA-schema}}>', {}, {}), `<${text}>`);
  env.host.registry.clearActiveSchema();
  assert.equal(describeActiveSchema(), '');
});

test('describeSchema：不能转换的 schema 返回空字符串，不抛异常', () => {
  const env = create_env();
  env.host.registry.setActiveSchema({ safeParse: data => ({ success: true, data }) });
  assert.equal(env.load('extra/describe').describeActiveSchema(), '');
});

// ============================ 世界书条目与输出提取 ============================

test('parseEntryTag：标记、分组、内置条目', () => {
  const { parseEntryTag } = create_env().load('extra/prompt');
  const tag = (update, both, group, extra = {}) => ({ update, plan: false, builtin: false, both, group, ...extra });
  assert.deepEqual(plain(parseEntryTag('[era_update]规则')), tag(true, false, ''));
  assert.deepEqual(plain(parseEntryTag('[era_update:战斗] x')), tag(true, false, '战斗'));
  assert.deepEqual(plain(parseEntryTag('[ERA_BOTH]设定')), tag(false, true, ''));
  assert.deepEqual(plain(parseEntryTag('[era_plan]检定')), tag(false, false, '', { plan: true }));
  assert.equal(parseEntryTag('ERA 变量操作规则').builtin, true);
  assert.equal(parseEntryTag('ERA 变量操作规则').update, true);
  assert.equal(parseEntryTag('普通设定').update, false);
});

test('isEntryActive：绿灯按主要与次要关键字判断', () => {
  const { isEntryActive } = create_env().load('extra/prompt');
  const make = (keys, logic, secondary) =>
    entry('x', 'y', { strategy: { type: 'selective', keys, keys_secondary: { logic, keys: secondary } } });
  assert.equal(isEntryActive(make(['酒馆'], 'and_any', []), '走进酒馆'), true);
  assert.equal(isEntryActive(make(['酒馆'], 'and_any', []), '走进森林'), false);
  assert.equal(isEntryActive(make([/森.林/g], 'and_any', []), '森x林'), true);
  assert.equal(isEntryActive(make(['a'], 'and_all', ['b', 'c']), 'a b'), false);
  assert.equal(isEntryActive(make(['a'], 'and_any', ['b', 'c']), 'a b'), true);
  assert.equal(isEntryActive(make(['a'], 'not_any', ['b']), 'a b'), false);
  assert.equal(isEntryActive(make(['a'], 'not_all', ['b', 'c']), 'a b'), true);
  assert.equal(isEntryActive({ ...entry('x', 'y'), enabled: false }, ''), false);
});

test('extractCommandBlocks：丢弃正文与思考，识别截断', () => {
  const { extractCommandBlocks } = create_env().load('utils/message');
  const text = `<think>${T('Edit', { 假: 1 })}</think>正文<VariableThink>例: ${T('Edit', { 例: 1 })}</VariableThink>${T('Edit', { a: 1 })}尾巴`;
  assert.deepEqual(plain(extractCommandBlocks(text)), {
    text: T('Edit', { a: 1 }),
    hasCommands: true,
    hasThink: true,
    truncated: false,
  });
  assert.equal(extractCommandBlocks('<VariableThink>x</VariableThink><VariableEdit>{"a":').truncated, true);
  assert.equal(
    extractCommandBlocks(`先想${T('Edit', { 假: 1 })}</think>${T('Edit', { a: 1 })}`).text,
    T('Edit', { a: 1 }),
  );
});

// ============================ 额外模型解析 ============================

const CONFIG = { 聊天楼层数: 2, 重试次数: 1, 失败处理: '保留有效部分' };
async function run(env, outputs, config = {}, hooks = {}) {
  const { runExtra } = env.load('extra/runner');
  const { ExtraConfigSchema } = env.load('extra/config');
  const calls = [];
  const sleeps = [];
  const signal = { aborted: false };
  const result = await runExtra(
    env.mk(hooks.target ?? env.chat.length - 1),
    ExtraConfigSchema.parse({ ...CONFIG, ...config }),
    {
      generate: async (prompts, group, api) => {
        calls.push({ prompts: plain(prompts), group, api });
        const output = typeof outputs === 'function' ? outputs(group, calls.length) : outputs.shift();
        await hooks.during?.(signal);
        if (output instanceof Error) throw output;
        return output;
      },
      write: env.write_extra,
      sleep: async ms => void sleeps.push(ms),
    },
    signal,
  );
  return {
    result: plain(result),
    calls,
    sleeps,
    text: calls.map(call => call.prompts.map(p => p.content).join('\n')),
  };
}

async function story(options) {
  const env = create_env(options);
  env.send('assistant', `开场${T('Insert', { 金币: 10, 地点: '城' })}`);
  env.send('user', '买面包');
  env.send('assistant', '你花了 3 金币。');
  await env.sync();
  return env;
}

test('解析：提示词含规则、变量、剧情，不含旧指令；结果写回该楼', async () => {
  const env = await story();
  const { result, text } = await run(env, [`好的\n${T('Edit', { 金币: '-=3' })}`]);
  assert.equal(result.status, 'done');
  assert.equal(env.stat().金币, 7);
  assert.ok(text[0].includes('规则内容'));
  assert.ok(text[0].includes('"金币":10'));
  assert.ok(text[0].includes('你花了 3 金币'));
  assert.ok(text[0].includes('买面包'));
  assert.ok(!text[0].includes('开场'), '只取最近 2 楼');
  assert.ok(!text[0].includes('era_data'));
  // 重新解析：以没有额外输出的状态为准，不会重复扣除
  const again = await run(env, [T('Edit', { 金币: '-=4' })]);
  assert.ok(again.text[0].includes('"金币":10'));
  assert.equal(env.stat().金币, 6);
});

test('解析：有问题时带着问题重试，成功后采用新的输出', async () => {
  const env = await story();
  const { result, calls } = await run(env, [T('Edit', { 钱: 1 }), T('Edit', { 金币: 7 })]);
  assert.deepEqual(result, { status: 'done', problems: [], warnings: [] });
  assert.equal(calls.length, 2);
  const last = calls[1].prompts.slice(-2);
  assert.equal(last[0].role, 'assistant');
  assert.match(last[1].content, /钱/);
  assert.equal(env.stat().金币, 7);
});

test('解析：重试变差时保留较好的一次；整次放弃则不写入', async () => {
  let env = await story();
  const outputs = () => [T('Edit', { 金币: 7, 钱: 1 }), '没有指令'];
  let { result } = await run(env, outputs());
  assert.equal(result.status, 'done');
  assert.equal(result.problems.length, 1);
  assert.equal(env.stat().金币, 7);

  env = await story();
  ({ result } = await run(env, outputs(), { 失败处理: '整次放弃' }));
  assert.equal(result.status, 'failed');
  assert.equal(env.stat().金币, 10);
  assert.ok(!env.chat[2].swipes[0].includes('era_extra'));
});

test('解析：无变化、没有条目、请求失败、截断', async () => {
  let env = await story();
  assert.equal((await run(env, ['<VariableThink>无变化</VariableThink>'])).result.status, 'no_change');
  assert.ok(!env.chat[2].swipes[0].includes('era_extra'));

  env = await story({ entries: [entry('普通设定', 'x')] });
  const none = await run(env, []);
  assert.equal(none.result.status, 'no_entries');
  assert.equal(none.calls.length, 0);

  env = await story();
  const failed = await run(env, [new Error('503'), new Error('503')]);
  assert.equal(failed.result.status, 'failed');
  assert.match(failed.result.problems[0], /503/);

  env = await story();
  const cut = await run(env, ['<VariableThink>x</VariableThink><VariableEdit>{"金币":', T('Edit', { 金币: 1 })]);
  assert.equal(cut.result.status, 'done');
  assert.equal(env.stat().金币, 1);
});

test('解析：期间被取消或删除时不写入；滑到别的 swipe 时写到原来那一条', async () => {
  for (const during of [(_env, signal) => (signal.aborted = true), env => env.chat.pop()]) {
    const env = await story();
    const { result } = await run(env, [T('Edit', { 金币: 1 })], {}, { during: signal => during(env, signal) });
    assert.equal(result.status, 'aborted');
    assert.ok(env.chat.every(msg => msg.swipes.every(text => !text.includes('era_extra'))));
  }
  const env = await story();
  const { result } = await run(env, [T('Edit', { 金币: 1 })], {}, { during: () => env.swipe_new(2, '新的剧情') });
  assert.equal(result.status, 'done');
  assert.ok(env.chat[2].swipes[0].includes('era_extra') && !env.chat[2].swipes[1].includes('era_extra'));
});

test('解析：钩子不会被多执行一次，有效的输出不会被误判', async () => {
  const schema = z.object({ 金币: z.number(), 倒计时: z.number().min(0) });
  const env = create_env({ schema, hooks: [['倒计时', ({ stat }) => void (stat.倒计时 -= 1)]] });
  env.send('assistant', T('Insert', { 金币: 10, 倒计时: 2 }));
  env.send('assistant', '花了 3 金币');
  await env.sync();
  assert.equal(env.stat().倒计时, 0);
  const { result, calls } = await run(env, [T('Edit', { 金币: 7 })], { 失败处理: '整次放弃' });
  assert.deepEqual(result, { status: 'done', problems: [], warnings: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(env.stat()), { 金币: 7, 倒计时: 0 });
});

test('解析：消息已有自己的指令时告诉模型不要重复', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { 金币: 10 }));
  env.send('assistant', `花了 3 金币${T('Edit', { 金币: '-=3' })}`);
  await env.sync();
  const { text } = await run(env, ['<VariableThink></VariableThink>']);
  assert.ok(text[0].includes('<已执行的更新>') && text[0].includes('"金币":"-=3"') && text[0].includes('"金币":7'));
});

test('解析：规则没有提到 VariablePatch 时不要求使用它', async () => {
  let env = await story();
  assert.ok(!(await run(env, ['<VariableThink></VariableThink>'])).text[0].includes('VariablePatch'));
  env = await story({ entries: [entry('[era_update]', '可用 <VariablePatch>')] });
  assert.ok((await run(env, ['<VariableThink></VariableThink>'])).text[0].includes('、<VariablePatch> 指令块'));
});

test('解析：群聊读取全部成员的世界书；人设世界书也会读取', () => {
  const env = create_env({
    globals: {
      SillyTavern: {
        name1: 'User',
        name2: 'Char',
        groupId: 'g',
        groups: [{ id: 'g', members: ['a.png', 'b.png', 'c.png'] }],
        powerUserSettings: { persona_description_lorebook: '人设书' },
        getCurrentChatId: () => 'chat',
      },
      getCharWorldbookNames: name => {
        if (name === 'c.png') throw new Error('没有这张卡');
        return { primary: `${name}书`, additional: [] };
      },
      getChatWorldbookName: () => '聊天书',
    },
  });
  assert.deepEqual(plain(env.load('extra/prompt').getExtraWorldbookNames()), [
    '不存在',
    'a.png书',
    'b.png书',
    '聊天书',
    '人设书',
  ]);
});

test('解析：分组同时请求，各自只看到自己的规则；按组名顺序写入', async () => {
  const env = await story({
    entries: [
      entry('[era_update]公共', '公共规则'),
      entry('[era_update:b]', '规则B'),
      entry('[era_update:a]', '规则A'),
      entry('[era_both]设定', '世界设定'),
      entry('剧情条目', '剧情要求'),
    ],
  });
  const { result, calls, text } = await run(env, group =>
    T('Edit', group === 'a' ? { 金币: 1 } : { 金币: 2, 地点: '村' }),
  );
  assert.equal(result.status, 'done');
  assert.deepEqual(calls.map(call => call.group).sort(), ['a', 'b']);
  const a = text[calls.findIndex(call => call.group === 'a')];
  assert.ok(a.includes('公共规则') && a.includes('规则A') && a.includes('世界设定'));
  assert.ok(!a.includes('规则B') && !a.includes('剧情要求'));
  assert.equal(env.stat().金币, 2);
});

test('解析：条目中的 ERA 宏使用目标楼层的状态；有 $ALLDATA 时不再附带变量', async () => {
  const env = await story({ entries: [entry('[era_update]', '现在: {{ERA:$ALLDATA}} {{user}}')] });
  const { text } = await run(env, ['<VariableThink></VariableThink>']);
  assert.ok(text[0].includes('"金币"') && text[0].includes('User'));
  assert.ok(!text[0].includes('<当前变量>'));
});

test('解析：schema 拒绝的修改会反馈给模型；提示词附带变量结构', async () => {
  const schema = z.object({ 金币: z.coerce.number().min(0), 地点: z.enum(['城', '村']) });
  const env = await story({ schema });
  const { result, calls, text } = await run(env, [T('Edit', { 地点: '海' }), T('Edit', { 地点: '村' })]);
  assert.ok(text[0].includes("地点: '城' | '村'"));
  assert.match(calls[1].prompts.at(-1).content, /地点/);
  assert.equal(result.status, 'done');
  assert.equal(env.stat().地点, '村');
});

test('设置：缺失或错误的值使用默认值；接口转换', () => {
  const { ExtraConfigSchema, toCustomApi, createExtraApi } = create_env().load('extra/config');
  const config = ExtraConfigSchema.parse({ 重试次数: 'x', 变量更新方式: '乱写', 默认接口: 3 });
  // 新的默认值“跟随角色卡”在卡片没有推荐时等同于“随AI输出”
  assert.equal(config.变量更新方式, '跟随角色卡');
  assert.deepEqual(plain(config.备用接口), []);
  assert.equal(config.重试次数, 1);
  assert.equal(config.默认接口.来源, '跟随酒馆');
  assert.equal(toCustomApi(createExtraApi(), config), undefined);
  assert.deepEqual(
    plain(
      toCustomApi({ ...createExtraApi(), 来源: '自定义', 接口地址: 'u', 密钥: 'k', 模型: 'm' }, { ...config, 温度: 0 }),
    ),
    { apiurl: 'u', key: 'k', model: 'm', source: 'openai', temperature: 0 },
  );
});

// ============================ 触发、等待与中止 ============================

/** 加载真正的 controller 和事件队列；模型的输出由 `answer` 控制。 */
async function create_live(config = {}, options = {}) {
  const handlers = {};
  const requests = [];
  const stopped = [];
  let textarea = '';
  const eventOn = (name, fn) => void (handlers[name] ??= []).push(fn);
  /** 假页面：`send()` 模拟点击发送，没有被拦下的点击记入 `sent`。 */
  const page = {
    generating: false,
    listeners: {},
    sent: 0,
    addEventListener: (name, fn) => (page.listeners[name] = fn),
    removeEventListener() {},
    document: { querySelector: () => ({ click: () => page.send() }), body: { dataset: {} } },
    send: () => {
      let stopped = false;
      const target = { closest: selector => (selector === '#send_but' ? target : null) };
      page.listeners.click({ target, preventDefault() {}, stopImmediatePropagation: () => (stopped = true) });
      if (!stopped) page.sent++;
    },
  };
  const env = create_env({
    ...options,
    globals: {
      window: page,
      builtin: { duringGenerating: () => page.generating },
      $: arg =>
        typeof arg === 'function'
          ? void arg()
          : {
              on() {},
              trigger() {},
              val(text) {
                if (text === undefined) return textarea;
                textarea = text;
                return this;
              },
            },
      eventOn,
      eventEmit: async (name, ...args) => {
        for (const fn of handlers[name] ?? []) await fn(...args);
      },
      toastr: { info: () => ({}), warning() {}, error() {}, success() {}, clear() {} },
      generateRaw: request => new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })),
      stopGenerationById: id => {
        stopped.push(id);
        requests.find(request => request.generation_id === id)?.reject(new Error('stopped'));
        return true;
      },
      iframe_events: {},
      ...options.globals,
    },
  });
  (env.others.global ??= {}).ERA额外模型 = { 变量更新方式: '额外模型解析', 重试次数: 0, ...config };
  env.load('extra/controller');
  const { EVENT_GROUPS } = env.load('events/merger');
  const { pushToQueue } = env.load('events/queue');
  for (const name of Object.values(EVENT_GROUPS).flat()) eventOn(name, detail => pushToQueue(name, detail));
  const emit = async (name, ...args) => {
    for (const fn of handlers[name] ?? []) await fn(...args);
  };
  const until = async check => {
    for (let i = 0; i < 200 && !check(); i++) await sleep(20);
    assert.ok(check(), '等待超时');
  };
  const receive = async text => {
    env.send('assistant', text);
    await emit('MESSAGE_RECEIVED', env.chat.length - 1, 'normal');
  };
  return {
    ...env,
    emit,
    until,
    page,
    textarea: () => textarea,
    receive,
    requests,
    stopped,
    type: text => (textarea = text),
  };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('触发：回复同步后请求一次，发送会等它写完；自己有指令、非剧情消息不触发', async () => {
  const env = await create_live();
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.emit('MESSAGE_RECEIVED', 0, 'first_message');
  await env.receive(`有指令${T('Edit', { 金币: 9 })}`);
  await env.until(() => env.stat().金币 === 9);
  await env.receive('花了 3 金币');
  await env.until(() => env.requests.length === 1);
  env.page.send();
  await sleep(200);
  assert.equal(env.page.sent, 0);
  env.requests[0].resolve(T('Edit', { 金币: '-=3' }));
  await env.until(() => env.page.sent === 1);
  assert.equal(env.stat().金币, 6);
  assert.equal(env.requests.length, 1);
});

test('等待：刚收到回复就发送也会等；期间又来了别的楼层也不会漏掉', async () => {
  const env = await create_live();
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('花了 3 金币');
  env.page.send();
  await env.until(() => env.requests.length === 1);
  assert.equal(env.page.sent, 0);
  env.requests[0].resolve(T('Edit', { 金币: '-=3' }));
  await env.until(() => env.page.sent === 1);
  assert.equal(env.stat().金币, 7);
  await env.receive('又花了 3 金币');
  env.send('user', '脚本快速发送');
  await env.until(() => env.requests.length === 2);
});

test('等待：拦下点击，更新完后替玩家点一次；重复点击只发送一次；斜杠命令不拦', async () => {
  const env = await create_live();
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  env.page.send();
  assert.equal(env.page.sent, 1);
  await env.receive('剧情');
  await env.until(() => env.requests.length === 1);
  env.type('你好');
  env.page.send();
  env.page.send();
  await sleep(200);
  env.page.send();
  assert.equal(env.page.sent, 1);
  env.requests[0].resolve('<VariableThink>无变化</VariableThink>');
  await env.until(() => env.page.sent === 2);
  await sleep(300);
  assert.equal(env.page.sent, 2);

  await env.receive('剧情2');
  await env.until(() => env.requests.length === 2);
  env.type('/help');
  env.page.send();
  assert.equal(env.page.sent, 3);
});

test('等待：期间切换聊天、改了文字、开始了别的生成，都不再自动发送', async () => {
  for (const change of [
    async env => {
      env.switch_chat('other');
      await env.emit('CHAT_CHANGED');
    },
    env => env.type('改过的文字'),
    env => (env.page.generating = true),
  ]) {
    const env = await create_live();
    env.send('assistant', T('Insert', { 金币: 10 }));
    await env.sync();
    await env.receive('剧情');
    await env.until(() => env.requests.length === 1);
    env.type('你好');
    env.page.send();
    await change(env);
    env.requests[0].resolve('<VariableThink>无变化</VariableThink>');
    await sleep(700);
    assert.equal(env.page.sent, 0);
  }
});

test('等待：脚本触发的生成不会被暂停；脚本可以自己等待；一直没同步的楼层不会拖住之后的发送', async () => {
  const env = await create_live();
  const { waitForJobs } = env.load('extra/controller');
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await waitForJobs();
  await env.receive('剧情');
  await env.until(() => env.requests.length === 1);
  await env.emit('GENERATION_STARTED', 'normal', {}, false);
  let done = false;
  const waiting = waitForJobs().then(() => (done = true));
  await sleep(200);
  assert.equal(done, false);
  env.requests[0].resolve(T('Edit', { 金币: 1 }));
  await waiting;
  assert.equal(env.stat().金币, 1);
});

test('中止：重新生成只取消最后一楼的解析；滑动查看不取消；删除后取消', async () => {
  const env = await create_live({ 等待方式: '后台更新' });
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('第一段');
  await env.until(() => env.requests.length === 1);
  env.send('user', 'u');
  await env.receive('第二段');
  await env.until(() => env.requests.length === 2);
  await env.emit('GENERATION_STARTED', 'regenerate', {}, false);
  assert.equal(env.stopped.length, 1);
  assert.equal(env.stopped[0], env.requests[1].generation_id);

  await env.receive('第三段');
  await env.until(() => env.requests.length === 3);
  await env.emit('MESSAGE_SWIPED', env.chat.length - 1);
  assert.equal(env.stopped.length, 1);
  env.chat.pop();
  await env.emit('MESSAGE_DELETED', env.chat.length);
  assert.equal(env.stopped.length, 2);
  env.requests[0].resolve(T('Edit', { 金币: 1 }));
  await env.until(() => env.stat().金币 === 1);
});

test('世界书：只移除更新模型读得到的条目；关闭时不移除', async () => {
  const env = await create_live();
  const lores = () => ({
    globalLore: [
      { comment: '[era_update]a', world: '主书' },
      { comment: '设定', world: '主书' },
      { comment: '[era_both]b', world: '主书' },
    ],
    personaLore: [{ comment: '[era_update]c', world: '读不到' }],
  });
  const data = lores();
  await env.emit('WORLDINFO_ENTRIES_LOADED', data);
  assert.deepEqual(
    data.globalLore.map(e => e.comment),
    ['设定', '[era_both]b'],
  );
  assert.equal(data.personaLore.length, 1);
  const off = await create_live({ 变量更新方式: '随AI输出' });
  const kept = lores();
  await off.emit('WORLDINFO_ENTRIES_LOADED', kept);
  assert.equal(kept.globalLore.length, 3);
  off.send('assistant', '剧情');
  await off.receive('剧情');
  await sleep(400);
  assert.equal(off.requests.length, 0);
});

// ============================ 重试、备用接口与角色卡推荐 ============================

test('重试：请求失败后退避再试；鉴权、参数错误不重试', async () => {
  let env = await story();
  const retried = await run(env, [new Error('503 Service Unavailable'), new Error('429'), T('Edit', { 金币: 7 })], {
    重试次数: 3,
  });
  assert.equal(retried.result.status, 'done');
  assert.equal(retried.calls.length, 3);
  assert.deepEqual(retried.sleeps, [2000, 4000]);
  assert.equal(env.stat().金币, 7);

  env = await story();
  const denied = await run(env, [new Error('401 Unauthorized'), T('Edit', { 金币: 7 })], { 重试次数: 3 });
  assert.equal(denied.result.status, 'failed');
  assert.equal(denied.calls.length, 1);
  assert.match(denied.result.problems[0], /401/);

  // 输出有问题时立即重试，不退避
  env = await story();
  const fixed = await run(env, [T('Edit', { 钱: 1 }), T('Edit', { 金币: 7 })]);
  assert.equal(fixed.calls.length, 2);
  assert.deepEqual(fixed.sleeps, []);
});

test('重试：错误分类', () => {
  const { isRetryableError, retryDelay } = create_env().load('extra/runner');
  for (const error of [
    Object.assign(new Error('超过 400 秒没有完成'), { retryable: true }),
    new Error('Failed to fetch'),
    new Error('Error 502 Bad Gateway'),
    new Error('max_tokens 4096 exceeded'),
    { status: 429 },
    { response: { status: 500 } },
  ]) {
    assert.equal(isRetryableError(error), true, String(error?.message ?? error?.status));
  }
  for (const error of [new Error('401 Unauthorized'), { status: 403 }, new Error('HTTP 400: bad request')]) {
    assert.equal(isRetryableError(error), false);
  }
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelay), [2000, 4000, 8000, 16000, 30000, 30000]);
});

test('备用接口：主接口失败时依次换用，不占重试次数；用完后在最后一个上重试', async () => {
  const backup = { 来源: '自定义', 接口地址: 'b' };
  let env = await story();
  const switched = await run(env, [new Error('401'), new Error('500'), T('Edit', { 金币: 7 })], {
    重试次数: 0,
    备用接口: [backup, backup],
  });
  assert.equal(switched.result.status, 'done');
  assert.deepEqual(
    switched.calls.map(call => call.api),
    [0, 1, 2],
  );
  assert.deepEqual(switched.sleeps, []);

  env = await story();
  const exhausted = await run(env, [new Error('500'), new Error('500'), new Error('500')], {
    重试次数: 1,
    备用接口: [backup],
  });
  assert.equal(exhausted.result.status, 'failed');
  assert.deepEqual(
    exhausted.calls.map(call => call.api),
    [0, 1, 1],
  );

  const { getApiChain, ExtraConfigSchema } = env.load('extra/config');
  const config = ExtraConfigSchema.parse({
    备用接口: [backup],
    分组接口: { 战斗: { 来源: '代理预设', 代理预设: 'p' } },
  });
  assert.deepEqual(plain(getApiChain(config, '战斗').map(api => api.来源)), ['代理预设', '自定义']);
  assert.deepEqual(plain(getApiChain(config, '').map(api => api.来源)), ['跟随酒馆', '自定义']);
});

test('角色卡推荐：跟随角色卡时采用卡片的设置，玩家选了别的方式时不采用；无效的值被忽略', () => {
  const env = create_env();
  const { resolveExtraConfig, getCardExtraPreference, ExtraConfigSchema, isExtraEnabled, loadExtraConfig } =
    env.load('extra/config');
  assert.equal(getCardExtraPreference(), null);
  assert.equal(resolveExtraConfig(ExtraConfigSchema.parse({})).变量更新方式, '随AI输出');

  env.others.character = {
    ERA分步更新: {
      变量更新方式: '额外模型解析',
      重试次数: 3,
      聊天楼层数: '很多',
      附加要求: '卡片要求',
      默认接口: { 密钥: 'x' },
    },
  };
  assert.deepEqual(plain(getCardExtraPreference()), {
    变量更新方式: '额外模型解析',
    重试次数: 3,
    附加要求: '卡片要求',
  });
  const followed = resolveExtraConfig(ExtraConfigSchema.parse({ 聊天楼层数: 4, 重试次数: 1 }));
  assert.equal(followed.变量更新方式, '额外模型解析');
  assert.equal(followed.重试次数, 3);
  assert.equal(followed.聊天楼层数, 4);
  assert.equal(followed.附加要求, '卡片要求');
  assert.equal(followed.默认接口.密钥, '');

  for (const mode of ['随AI输出', '额外模型解析']) {
    const own = resolveExtraConfig(ExtraConfigSchema.parse({ 变量更新方式: mode, 重试次数: 1 }));
    assert.equal(own.变量更新方式, mode);
    assert.equal(own.重试次数, 1);
  }

  // 旧版保存的设置原样生效
  env.others.global = { ERA额外模型: { 变量更新方式: '随AI输出', 重试次数: 2 } };
  loadExtraConfig();
  assert.equal(isExtraEnabled(), false);
  env.others.global = { ERA额外模型: { 重试次数: 2 } };
  loadExtraConfig();
  assert.equal(isExtraEnabled(), true);
});

// ============================ 超时、继续、status() 与 run() ============================

/** 计时器加快 100 倍：30 秒的超时只需 300 毫秒。 */
const FAST_TIMERS = { setTimeout: (fn, ms, ...args) => setTimeout(fn, (ms ?? 0) / 100, ...args), clearTimeout };

test('等待：重试=1 且第一次超时，重试完成前不发送', async () => {
  const env = await create_live({ 重试次数: 1, 超时秒数: 30 }, { globals: FAST_TIMERS });
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('花了 3 金币');
  await env.until(() => env.requests.length === 1);
  env.type('你好');
  env.page.send();
  // 第一次请求没有回应：超时后退避，再重试
  await env.until(() => env.requests.length === 2);
  assert.ok(env.stopped.includes(env.requests[0].generation_id));
  assert.equal(env.page.sent, 0);
  env.requests[1].resolve(T('Edit', { 金币: '-=3' }));
  await env.until(() => env.page.sent === 1);
  assert.equal(env.stat().金币, 7);
});

test('等待：点击提示框放弃等待时提示“已先发送”；wait() 返回是否完成', async () => {
  const infos = [];
  const warnings = [];
  const toastr = {
    info: (...args) => (infos.push(args), {}),
    warning: (...args) => warnings.push(args),
    error() {},
    success() {},
    clear() {},
  };
  const env = await create_live({}, { globals: { toastr } });
  const { waitForJobs } = env.load('extra/controller');
  assert.equal(await waitForJobs(), true);
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('剧情');
  await env.until(() => env.requests.length === 1);
  env.type('你好');
  env.page.send();
  await env.until(() => infos.some(args => args[2]?.onclick));
  infos.find(args => args[2]?.onclick)[2].onclick();
  await env.until(() => env.page.sent === 1);
  assert.ok(warnings.some(args => /已先发送/.test(args[0])));
  env.requests[0].resolve('<VariableThink>无变化</VariableThink>');
});

test('继续：取消该楼正在进行的解析，继续完成后重新解析；更早的楼层不受影响', async () => {
  const env = await create_live({ 等待方式: '后台更新' });
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('第一段');
  await env.until(() => env.requests.length === 1);
  env.send('user', 'u');
  await env.receive('第二段');
  await env.until(() => env.requests.length === 2);
  await env.emit('GENERATION_STARTED', 'continue', {}, true); // 试运行不取消
  assert.equal(env.stopped.length, 0);
  await env.emit('GENERATION_STARTED', 'continue', {}, false);
  assert.deepEqual(env.stopped, [env.requests[1].generation_id]);
  // 继续写完：正文变长，重新解析
  const last = env.chat.at(-1);
  last.swipes[last.swipe_id] += '，继续写的部分';
  await env.emit('MESSAGE_RECEIVED', env.chat.length - 1, 'continue');
  await env.until(() => env.requests.length === 3);
  env.requests[2].resolve(T('Edit', { 金币: 5 }));
  await env.until(() => env.stat().金币 === 5);
  assert.ok(last.swipes[last.swipe_id].trimEnd().endsWith('</era_extra>'));
  env.requests[0].resolve('<VariableThink>无变化</VariableThink>');
});

test('status()：同一楼重新解析时不报告旧任务的取消；记录最近一次的提示词与回复，不含密钥', async () => {
  const env = await create_live({
    等待方式: '后台更新',
    默认接口: { 来源: '自定义', 接口地址: 'https://example.invalid', 密钥: 'sk-secret-key' },
  });
  const statuses = [];
  const { startExtra, getExtraStatus } = env.load('extra/controller');
  const { ERA_EVENT_EMITTER } = env.load('utils/constants');
  env.host.context.eventOn(ERA_EVENT_EMITTER.EXTRA_STATUS, payload => statuses.push(payload.status));
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('花了 3 金币');
  await env.until(() => env.requests.length === 1);
  assert.equal(env.requests[0].custom_api.key, 'sk-secret-key');
  const mk = env.mk(env.chat.length - 1);
  let status = getExtraStatus();
  assert.deepEqual(plain(status.running.map(job => [job.mk, job.attempt])), [[mk, 1]]);
  assert.equal(typeof status.running[0].startedAt, 'number');
  assert.equal(status.last, null);

  statuses.length = 0;
  const second = startExtra(mk, true);
  await env.until(() => env.requests.length === 2);
  await sleep(50); // 旧任务此时已经结束
  env.requests[1].resolve(`好的${T('Edit', { 金币: '-=3' })}`);
  const result = await second;
  assert.deepEqual(plain(result), { mk, ok: true, status: 'done', problems: [], warnings: [] });
  assert.deepEqual(statuses, ['started', 'done']);

  status = getExtraStatus();
  assert.deepEqual(plain(status.running), []);
  assert.equal(status.last.mk, mk);
  assert.equal(status.last.ok, true);
  assert.equal(status.last.status, 'done');
  assert.ok(status.last.rawReply.includes('VariableEdit'));
  assert.equal(status.last.prompt.length, 1);
  assert.ok(status.last.prompt[0].messages.some(message => message.content.includes('花了 3 金币')));
  assert.ok(!JSON.stringify(status).includes('sk-secret-key'));
  // 返回的是副本
  status.last.mk = 'x';
  assert.equal(getExtraStatus().last.mk, mk);
});

test('Era.extra：run 返回结果，MK 不存在时失败；wait 与 status 可用', async () => {
  const env = await create_live({ 等待方式: '后台更新' }, { globals: { initializeGlobal() {} } });
  const { Era } = env.load('api/global');
  await assert.rejects(Era.extra.run(), /没有可以解析的 AI 消息/);
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await assert.rejects(Era.extra.run('era_mk_none'), /找不到 MK/);
  assert.equal(await Era.extra.wait(), true);

  const running = Era.extra.run();
  await env.until(() => env.requests.length === 1);
  assert.equal(Era.extra.status().running.length, 1);
  env.requests[0].reject(new Error('401 Unauthorized'));
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.problems[0], /401/);
  assert.equal(env.requests.length, 1, '鉴权错误不重试');
  assert.match(Era.extra.status().last.error, /401/);

  const aborted = Era.extra.run();
  await env.until(() => env.requests.length === 2);
  Era.extra.abort();
  assert.equal((await aborted).status, 'aborted');
  assert.equal(Era.extra.status().last.status, 'aborted');
});

// ============================ 实测的 generateRaw 错误 ============================

test('重试：按实测的 generateRaw 错误形状识别鉴权和参数错误，网络错误仍重试', async () => {
  const { isRetryableError, getErrorStatus } = create_env().load('extra/runner');
  // 真实酒馆 1.19.1 + 酒馆助手：自定义接口返回 4xx、5xx 时只抛出 new Error(response.statusText)
  for (const [message, status] of [
    ['Unauthorized', 401],
    ['Forbidden', 403],
    ['Bad Request', 400],
    ['Not Found', 404],
    ['Error: Payment Required', 402],
  ]) {
    assert.equal(getErrorStatus(new Error(message)), status, message);
    assert.equal(isRetryableError(new Error(message)), false, message);
  }
  for (const message of [
    'Too Many Requests',
    'Internal Server Error',
    'Service Unavailable',
    // 连不上接口时酒馆返回 502，消息里带着状态码
    'HTTP 502: {"error":{"message":"Connection refused","code":"ECONNREFUSED"}}',
    'Failed to fetch',
    'Unauthorized access token expired soon', // 不是完整的状态文字，不猜
  ]) {
    assert.equal(isRetryableError(new Error(message)), true, message);
  }
  let env = await story();
  const denied = await run(env, [new Error('Unauthorized'), T('Edit', { 金币: 7 })], { 重试次数: 3 });
  assert.equal(denied.result.status, 'failed');
  assert.equal(denied.calls.length, 1, '填错密钥只请求一次');
  assert.deepEqual(denied.sleeps, []);
  env = await story();
  const flaky = await run(env, [new Error('Internal Server Error'), T('Edit', { 金币: 7 })], { 重试次数: 3 });
  assert.equal(flaky.result.status, 'done');
  assert.deepEqual(flaky.sleeps, [2000]);
});

// ============================ 写入已到正文但同步未完成 ============================

test('等待：额外模型的写入已到正文、同步还在排队时，发送前等待会等同步算完', async () => {
  const env = await create_live({ 等待方式: '发送前等待' });
  const controller = env.load('extra/controller');
  const { ERA_API_EVENTS } = env.load('utils/constants');
  controller.extraTimings.writeMs = 150;
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('花了 3 金币');
  await env.until(() => env.requests.length === 1);
  // 写入可以执行（改正文），但之后的同步被卡住
  const release = env.host.hold_queue(job => job.type !== ERA_API_EVENTS.WRITE_EXTRA);
  env.requests[0].resolve(T('Edit', { 金币: '-=3' }));
  const mk = env.mk(1);
  await env.until(() => controller.getExtraStatus().pendingSync.includes(mk));
  assert.ok(env.chat[1].swipes[0].includes('era_extra'), '已经写进正文');
  assert.equal(env.stat().金币, 10, '还没有算');
  assert.equal(controller.getExtraStatus().last.status, 'done');
  env.page.send();
  await sleep(300);
  assert.equal(env.page.sent, 0, '同步没算完时不发送');
  release();
  await env.until(() => env.page.sent === 1);
  assert.equal(env.stat().金币, 7);
  assert.deepEqual(plain(controller.getExtraStatus().pendingSync), []);
});

// ============================ 条目过滤器 ============================

/** 金币在第 0 楼是 10，目标第 2 楼花了 3，之后第 4 楼改成 99：最新状态与目标楼的状态不同。 */
async function history(options) {
  const env = create_env(options);
  env.send('assistant', `开场${T('Insert', { 金币: 10, 归一: false })}`);
  env.send('user', '买面包');
  env.send('assistant', `你花了 3 金币。${T('Edit', { 金币: '-=3' })}`);
  env.send('user', '归一');
  env.send('assistant', `你归一了。${T('Edit', { 金币: 99, 归一: true })}`);
  await env.sync();
  return env;
}
const ruleEntries = () => [
  entry('[era_update]规则', '通用规则'),
  entry('[era_update][归一前]', '归一前的规则', { enabled: false }),
  entry('[era_update][归一后]', '归一后的规则', { enabled: true }),
  entry('普通设定', '不发给更新模型'),
];
const NO_CHANGE = () => ['<VariableThink>无变化</VariableThink>'];

test('条目过滤器：按目标楼的状态选择条目，可以纳入文件里关闭的条目；重新解析旧楼也正确', async () => {
  const env = await history({ entries: ruleEntries() });
  const { addEntryFilter } = env.load('extra/entry_filter');
  const seen = [];
  addEntryFilter('规则二选一', (entry, ctx) => {
    seen.push({
      name: entry.name,
      world: entry.world,
      stat: ctx.stat,
      text: ctx.text,
      mk: ctx.mk,
      purpose: ctx.purpose,
    });
    if (entry.name.includes('[归一前]')) return !ctx.stat.归一;
    if (entry.name.includes('[归一后]')) return ctx.stat.归一 === true;
  });
  // 解析旧楼（第 2 楼）：那时还没有归一
  const old = await run(env, NO_CHANGE(), {}, { target: 2 });
  assert.equal(old.result.status, 'no_change');
  assert.ok(old.text[0].includes('归一前的规则') && !old.text[0].includes('归一后的规则'));
  assert.ok(old.text[0].includes('通用规则') && !old.text[0].includes('不发给更新模型'));
  assert.ok(old.text[0].includes('"金币":7'), '附带的变量也是目标楼的');
  const ctx = seen.find(item => item.name === '[era_update][归一前]');
  assert.deepEqual(plain(ctx.stat), { 金币: 7, 归一: false });
  assert.equal(ctx.world, '主书');
  assert.equal(ctx.mk, env.mk(2));
  assert.equal(ctx.purpose, 'extra');
  assert.ok(ctx.text.includes('买面包') && ctx.text.includes('你花了 3 金币') && !ctx.text.includes('你归一了'));
  assert.ok(!seen.some(item => item.name === '普通设定'), '只对发给更新模型的条目调用');

  // 解析最新楼：已经归一
  const latest = await run(env, NO_CHANGE());
  assert.ok(latest.text[0].includes('归一后的规则') && !latest.text[0].includes('归一前的规则'));
});

test('条目过滤器：返回字符串替换内容；出错或返回 Promise 时忽略并记入 warnings；不表态时按文件', async () => {
  const env = await history({
    entries: [
      entry('[era_update]A', 'A 原文'),
      entry('[era_update]B', 'B 原文', { enabled: false }),
      entry('[era_update]C', 'C 原文'),
      entry('[era_update]D', 'D 原文'),
    ],
  });
  const { addEntryFilter, dropEntryFilter } = env.load('extra/entry_filter');
  addEntryFilter('1改写', entry => (entry.name.endsWith('A') ? `A 改写，以前是 ${entry.content}` : undefined));
  const thrower = addEntryFilter('2出错', entry => {
    if (entry.name.endsWith('C')) throw new Error('坏了');
  });
  addEntryFilter('3异步', async () => false);
  const { result, text } = await run(env, NO_CHANGE());
  assert.ok(text[0].includes('A 改写，以前是 A 原文'));
  assert.ok(!text[0].includes('B 原文'), '不表态时按文件的开关');
  assert.ok(text[0].includes('C 原文') && text[0].includes('D 原文'), '出错、返回 Promise 的过滤器被忽略');
  assert.equal(result.problems.length, 0, '告警不进 problems');
  assert.ok(result.warnings.some(line => line.includes('2出错') && line.includes('坏了')));
  assert.ok(result.warnings.some(line => line.includes('3异步') && line.includes('Promise')));
  assert.ok(dropEntryFilter(thrower));
  assert.ok(!dropEntryFilter(thrower));
});

test('条目过滤器：Era.registerEntryFilter 注册与注销；参数无效时提示；绑定在注册时的角色卡上', async () => {
  const errors = [];
  const env = await history({
    entries: ruleEntries(),
    globals: { initializeGlobal() {}, toastr: { error: (...args) => errors.push(args), warning() {} } },
  });
  const { Era } = env.load('api/global');
  const unregister = Era.registerEntryFilter(
    '只要通用',
    entry => entry.name.includes('规则]') || entry.name.endsWith('规则'),
  );
  assert.equal(Era.hasEntryFilter('只要通用'), true);
  let { text } = await run(env, NO_CHANGE());
  assert.ok(text[0].includes('通用规则') && !text[0].includes('归一后的规则'));
  unregister();
  assert.equal(Era.hasEntryFilter('只要通用'), false);
  ({ text } = await run(env, NO_CHANGE()));
  assert.ok(text[0].includes('归一后的规则'));
  Era.registerEntryFilter('', null);
  assert.equal(errors.length, 1);
  // 换了角色卡：遗留的过滤器不再生效
  Era.registerEntryFilter('全部排除', () => false);
  env.host.context.SillyTavern.characterId = 'other';
  ({ text } = await run(env, NO_CHANGE()));
  assert.ok(text[0].includes('通用规则'));
  assert.equal(Era.hasEntryFilter('全部排除'), false);
});

test('分步更新：取不到目标楼之前的状态、退回最新状态时记 warning', async () => {
  const env = create_env({ settings: { 日志保留楼层数: 2 } });
  env.send('assistant', T('Insert', { a: 1 }));
  for (let i = 0; i < 6; i++) env.send('assistant', '剧情');
  env.send('assistant', T('Insert', { later: 1 }));
  await env.sync();
  await env.sync();
  const { result } = await run(env, NO_CHANGE(), {}, { target: 1 });
  assert.equal(result.status, 'no_change');
  assert.ok(result.warnings.some(line => line.includes('最新状态')));
});

// ============================ EJS ============================

const AsyncFunction = (async () => {}).constructor;
/** 极简的 EJS：支持 <% %>、<%= %>、<%- %>、<%_ _%>，按 with(ctx) 求值。 */
function compile_ejs(code) {
  let js = 'let __o = "";\n';
  const re = /<%([=\-_]?)([\s\S]*?)[-_]?%>/g;
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    js += `__o += ${JSON.stringify(code.slice(last, m.index))};\n`;
    js += m[1] === '=' || m[1] === '-' ? `__o += String(${m[2]});\n` : `${m[2]}\n`;
    last = re.lastIndex;
  }
  js += `__o += ${JSON.stringify(code.slice(last))};\nreturn __o;`;
  return new AsyncFunction('ctx', `with (ctx) { ${js} }`);
}

/**
 * 假的提示词模板插件。它自己的 getvar / variables 读的是“最新状态”（`latest`），
 * 写函数会真的记下来：ERA 必须把它们全部换掉。
 */
function stub_ejs({ latest, features = { enabled: true, generate_enabled: true } } = {}) {
  const calls = { prepare: 0, eval: 0, writes: [] };
  const engine = {
    getFeatures: () => features,
    prepareContext: async env => {
      calls.prepare++;
      const vars = () => ({ stat_data: latest(), 别的: '插件的变量' });
      const ctx = {
        ...env,
        get variables() {
          return vars();
        },
        getvar: (key, options) => {
          const value = key.split('.').reduce((obj, part) => obj?.[part], vars());
          return value ?? options?.defaults;
        },
        getwi: async name => `[${name}]`,
        define: (name, value) => calls.writes.push(['define', name, value]),
      };
      for (const name of ['getLocalVar', 'getGlobalVar', 'getMessageVar']) ctx[name] = ctx.getvar;
      for (const name of [
        'setvar',
        'setLocalVar',
        'incvar',
        'decvar',
        'delvar',
        'insvar',
        'activewi',
        'injectPrompt',
        'execute',
      ]) {
        ctx[name] = (...args) => calls.writes.push([name, ...args]);
      }
      return ctx;
    },
    evalTemplate: async (code, ctx) => {
      calls.eval++;
      return compile_ejs(code)(ctx);
    },
  };
  return { engine, calls };
}

async function ejs_env(entries, stub_options = {}) {
  const holder = {};
  const stub = stub_ejs({ latest: () => holder.env.stat(), ...stub_options });
  holder.env = await history({ entries, globals: { EjsTemplate: stub.engine } });
  return { env: holder.env, ...stub };
}

test('EJS：按目标楼的状态渲染；getvar 的默认 scope、scope:local、别名和 variables 都读目标楼', async () => {
  const { env, calls } = await ejs_env([
    entry(
      '[era_update]规则',
      [
        "金币=<%= getvar('stat_data.金币') %>",
        "local=<%= getvar('stat_data.金币', { scope: 'local' }) %>",
        "alias=<%= getLocalVar('stat_data.归一') %>",
        'vars=<%- variables.stat_data.金币 %>',
        "other=<%= getvar('别的') %>",
        "missing=<%= getvar('stat_data.没有', { defaults: '默认' }) %>",
        'purpose=<%= era.purpose %>',
        'user={{user}}',
      ].join('\n'),
    ),
  ]);
  const { result, text } = await run(env, NO_CHANGE(), {}, { target: 2 });
  assert.equal(result.status, 'no_change');
  for (const expected of [
    '金币=7',
    'local=7',
    'alias=false',
    'vars=7',
    'other=插件的变量',
    'missing=默认',
    'purpose=extra',
    'user=User',
  ]) {
    assert.ok(text[0].includes(expected), expected);
  }
  assert.equal(env.stat().金币, 99, '最新状态不受影响');
  assert.equal(calls.prepare, 1);
  assert.deepEqual(result.warnings, []);
});

test('EJS：重新解析时读的是不含上一次额外输出的状态', async () => {
  const { env } = await ejs_env([entry('[era_update]规则', "金币=<%= getvar('stat_data.金币') %>")]);
  const first = await run(env, [T('Edit', { 金币: 1 })]);
  assert.ok(first.text[0].includes('金币=99'));
  assert.equal(env.stat().金币, 1);
  const again = await run(env, [T('Edit', { 金币: 2 })]);
  assert.ok(again.text[0].includes('金币=99') && !again.text[0].includes('金币=1'));
  assert.equal(env.stat().金币, 2);
});

test('EJS：[era_both] 条目里的写函数在额外流程中不执行，记入 warnings', async () => {
  const { env, calls } = await ejs_env([
    entry(
      '[era_both]状态栏',
      "<% setvar('stat_data.金币', 0); incvar('次数'); await execute('/echo hi'); activewi('x'); define('常量', 1) %>常量=<%= 常量 %>",
    ),
    entry('[era_update]后面的规则', '后面也能用：<%= 常量 + 1 %>', { position: { order: 200 } }),
  ]);
  const { result, text } = await run(env, NO_CHANGE());
  assert.deepEqual(calls.writes, [], '插件的写函数一个都没有被调用');
  assert.ok(text[0].includes('常量=1') && text[0].includes('后面也能用：2'), 'define 在同一次解析里按 order 生效');
  for (const name of ['setvar', 'incvar', 'execute', 'activewi']) {
    assert.ok(
      result.warnings.some(line => line.includes(name) && line.includes('[era_both]状态栏')),
      name,
    );
  }
  assert.equal(env.stat().金币, 99);
});

test('EJS：@@if 按目标楼的状态求值，出错按不满足；渲染为空或出错时跳过该条目', async () => {
  const { env } = await ejs_env([
    entry('[era_update][归一前]', "@@if !getvar('stat_data.归一')\n归一前的规则"),
    entry('[era_update][归一后]', "@@if getvar('stat_data.归一')\n归一后的规则"),
    entry('[era_update]坏条件', '@@if 不存在的变量.x\n不该出现A'),
    entry('[era_update]空', "<% if (getvar('stat_data.归一')) { %>只在归一后<% } %>"),
    entry('[era_update]出错', "<% throw new Error('模板坏了') %>不该出现B"),
    entry('[era_update]普通', '普通规则'),
  ]);
  const old = await run(env, NO_CHANGE(), {}, { target: 2 });
  assert.ok(old.text[0].includes('归一前的规则') && !old.text[0].includes('归一后的规则'));
  assert.ok(!old.text[0].includes('@@if'), '装饰器不发给模型');
  assert.ok(!old.text[0].includes('只在归一后') && !old.text[0].includes('<%'));
  assert.ok(!old.text[0].includes('不该出现A') && !old.text[0].includes('不该出现B'));
  assert.ok(old.text[0].includes('普通规则'));
  assert.ok(old.result.warnings.some(line => line.includes('坏条件') && line.includes('@@if')));
  assert.ok(old.result.warnings.some(line => line.includes('出错') && line.includes('模板坏了')));
  const latest = await run(env, NO_CHANGE());
  assert.ok(latest.text[0].includes('归一后的规则') && latest.text[0].includes('只在归一后'));
});

test('EJS：多分组加重试只渲染一次；$ALLDATA 的检测基于渲染后的内容', async () => {
  const { env, calls } = await ejs_env([
    entry('[era_update:甲]', "甲：<%= getvar('stat_data.金币') %>"),
    entry('[era_update:乙]', '乙<% if (false) { %>{{ERA:$ALLDATA}}<% } %>'),
  ]);
  const {
    result,
    calls: requests,
    text,
  } = await run(env, (_group, n) => (n <= 2 ? T('Edit', { 钱: 1 }) : T('Edit', { 金币: 1 })));
  assert.equal(result.status, 'done');
  assert.equal(requests.length, 4, '两组各重试一次');
  assert.equal(calls.eval, 2, '每个条目只渲染一次');
  const second = text.find(item => item.includes('乙'));
  assert.ok(second.includes('<当前变量>'), '模板没有输出 $ALLDATA，仍要附带变量');

  const echo = await ejs_env([entry('[era_update]', "<%- '{{ERA:$ALLDATA}}' %>")]);
  const shown = await run(echo.env, NO_CHANGE());
  assert.ok(!shown.text[0].includes('<当前变量>') && shown.text[0].includes('"金币":99'), '模板输出的 ERA 宏照常替换');
});

test('EJS：关闭预处理、插件关闭或没有安装时与以前一样发原文；插件的特殊条目在渲染时跳过', async () => {
  const content = "<%= getvar('stat_data.金币') %>";
  const special = [
    entry('[era_update]规则', content),
    entry('[era_update][GENERATE:BEFORE]', '特殊一'),
    entry('[era_update]x', '@@render_before\n特殊二'),
  ];
  let { env } = await ejs_env(special);
  let { text } = await run(env, NO_CHANGE(), { EJS预处理: '关闭' });
  assert.ok(text[0].includes(content) && text[0].includes('特殊一') && text[0].includes('特殊二'));
  ({ text } = await run(env, NO_CHANGE()));
  assert.ok(text[0].includes('99') && !text[0].includes('特殊一') && !text[0].includes('特殊二'));

  ({ env } = await ejs_env(special, { features: { enabled: false } }));
  ({ text } = await run(env, NO_CHANGE()));
  assert.ok(text[0].includes(content), '插件关闭时主生成也不渲染');

  env = await history({ entries: special });
  ({ text } = await run(env, NO_CHANGE()));
  assert.ok(text[0].includes(content));
});

test('装饰器：@@activate 无视关键字，@@dont_activate 不激活；@@@ 是转义', async () => {
  const green = {
    strategy: { type: 'selective', keys: ['不会出现的词'], keys_secondary: { logic: 'and_any', keys: [] } },
  };
  const env = await history({
    entries: [
      entry('[era_update]强制', '@@activate\n强制激活的规则', green),
      entry('[era_update]不激活', '@@dont_activate\n不该出现'),
      entry('[era_update]转义', '@@@开头是两个@的正文'),
    ],
  });
  const { text } = await run(env, NO_CHANGE());
  assert.ok(text[0].includes('强制激活的规则') && !text[0].includes('@@activate'));
  assert.ok(!text[0].includes('不该出现'));
  assert.ok(text[0].includes('@@开头是两个@的正文'));
  const { parseDecorators } = env.load('extra/ejs');
  assert.deepEqual(plain(parseDecorators('@@if a > 1\n@@private\n正文')), {
    decorators: [
      { name: '@@if', arg: 'a > 1' },
      { name: '@@private', arg: '' },
    ],
    content: '正文',
  });
});

test('设置：EJS预处理默认自动；导出用的副本去掉密钥', () => {
  const { ExtraConfigSchema, redactExtraConfig } = create_env().load('extra/config');
  const config = ExtraConfigSchema.parse({
    EJS预处理: '乱写',
    默认接口: { 来源: '自定义', 密钥: 'sk-1' },
    分组接口: { 甲: { 来源: '自定义', 密钥: 'sk-2' } },
    备用接口: [
      { 来源: '自定义', 密钥: 'sk-3' },
      { 来源: '代理预设', 代理预设: 'p' },
    ],
  });
  assert.equal(config.EJS预处理, '自动');
  const redacted = redactExtraConfig(config);
  assert.ok(!JSON.stringify(redacted).includes('sk-'));
  assert.equal(redacted.默认接口.密钥, '（已隐藏）');
  assert.equal(redacted.备用接口[1].密钥, '');
  assert.equal(config.默认接口.密钥, 'sk-1', '不改原对象');
});

// ============================ 预设、头部提示词、角色信息、流式请求 ============================

/** 假的酒馆预设：一个占位符、一个关闭的条目、一个空条目、两个启用的条目。 */
const PRESETS = {
  in_use: {
    settings: { temperature: 0.7, top_p: 0.9, top_k: 40, max_completion_tokens: 2048, should_stream: true },
    prompts: [
      { id: 'main', name: '主提示', enabled: true, role: 'system', content: '预设主提示 {{user}}' },
      { id: 'chatHistory', name: '聊天记录', enabled: true, role: 'system', position: { type: 'relative' } },
      { id: 'off', name: '关闭的', enabled: false, role: 'system', content: '不该出现' },
      { id: 'jb', name: '破限', enabled: true, role: 'user', content: '预设破限' },
      { id: 'empty', name: '空的', enabled: true, role: 'system', content: '  ' },
    ],
  },
  我的预设: {
    settings: { temperature: 1.2 },
    prompts: [{ id: 'a', enabled: true, role: 'system', content: '我的预设条目' }],
  },
};
const PRESET_GLOBALS = {
  getPresetNames: () => ['我的预设'],
  getPreset: name => {
    if (!PRESETS[name]) throw new Error('预设不存在');
    return JSON.parse(JSON.stringify(PRESETS[name]));
  },
};

test('设置：新增项的默认值保持原来的行为', () => {
  const { ExtraConfigSchema, getPresetName } = create_env().load('extra/config');
  const config = ExtraConfigSchema.parse({});
  assert.equal(config.更新模型预设, '不使用预设');
  assert.equal(config.规划模型预设, '不使用预设');
  assert.equal(config.附带角色信息, '关闭');
  assert.equal(config.请求方式, '非流式');
  assert.equal(config.头部提示词, '');
  assert.deepEqual(plain(config.分组预设), {});
  assert.equal(getPresetName(config, 'update'), null);
  assert.equal(getPresetName(config, 'plan'), null);
  const chosen = ExtraConfigSchema.parse({
    更新模型预设: '使用指定预设',
    更新模型预设名: ' 我的预设 ',
    规划模型预设: '使用当前预设',
    分组预设: { 战斗: { 预设: '不使用预设' }, 社交: { 预设: '使用指定预设' } },
  });
  assert.equal(getPresetName(chosen, 'update'), '我的预设');
  assert.equal(getPresetName(chosen, 'update', '其他'), '我的预设', '没有单独指定的分组按更新模型');
  assert.equal(getPresetName(chosen, 'update', '战斗'), null);
  assert.equal(getPresetName(chosen, 'update', '社交'), '', '没填名字');
  assert.equal(getPresetName(chosen, 'plan'), 'in_use');
});

test('请求：默认与原来一样；头部提示词在最前，预设条目按“聊天记录”的位置分在 ERA 提示词前后', () => {
  const env = create_env({ globals: PRESET_GLOBALS });
  const { ExtraConfigSchema, createExtraApi, toCustomApi } = env.load('extra/config');
  const { prepareRequest } = env.load('extra/request');
  const era = [
    { role: 'system', content: 'ERA 规则' },
    { role: 'user', content: '最新剧情' },
  ];
  const api = { ...createExtraApi(), 来源: '自定义', 接口地址: 'u', 密钥: 'k' };
  const warnings = [];
  const base = ExtraConfigSchema.parse({});
  const plainRequest = prepareRequest(era, base, api, 'update', '', warnings);
  assert.deepEqual(plain(plainRequest.prompts), era);
  assert.deepEqual(plain(plainRequest.custom_api), plain(toCustomApi(api, base)));
  assert.equal(plainRequest.should_stream, false);
  assert.equal(prepareRequest(era, base, createExtraApi(), 'update', '', warnings).custom_api, undefined);
  assert.deepEqual(warnings, []);

  const config = ExtraConfigSchema.parse({
    头部提示词: '  破限 {{user}}  ',
    更新模型预设: '使用当前预设',
    请求方式: '流式',
    温度: 0.2,
  });
  const request = prepareRequest(era, config, api, 'update', '', warnings);
  assert.deepEqual(plain(request.prompts), [
    { role: 'system', content: '破限 User' },
    { role: 'system', content: '预设主提示 User' },
    ...era,
    // “聊天记录”占位符之后的条目放在 ERA 的提示词后面，角色保留
    { role: 'user', content: '预设破限' },
  ]);
  assert.equal(request.should_stream, true);
  // 设置里明确填写的温度优先；其余采样参数按预设
  assert.deepEqual(plain(request.custom_api), {
    temperature: 0.2,
    top_p: 0.9,
    top_k: 40,
    max_tokens: 2048,
    apiurl: 'u',
    key: 'k',
    source: 'openai',
  });
  assert.deepEqual(warnings, []);

  // 规划模型按自己的设置（这里不使用预设），头部提示词照样加
  assert.deepEqual(plain(prepareRequest(era, config, api, 'plan', '', warnings).prompts.slice(1)), era);
});

test('请求：预设不存在、读取出错、没填名字时不使用预设，记入告警', () => {
  const env = create_env({ globals: PRESET_GLOBALS });
  const { ExtraConfigSchema, createExtraApi } = env.load('extra/config');
  const { prepareRequest } = env.load('extra/request');
  const era = [{ role: 'system', content: 'ERA 规则' }];
  for (const [settings, pattern] of [
    [{ 更新模型预设: '使用指定预设', 更新模型预设名: '已删除' }, /无法读取预设“已删除”/],
    [{ 更新模型预设: '使用指定预设' }, /没有填写预设名/],
  ]) {
    const warnings = [];
    const request = prepareRequest(era, ExtraConfigSchema.parse(settings), createExtraApi(), 'update', '', warnings);
    assert.deepEqual(plain(request.prompts), era);
    assert.equal(request.custom_api, undefined);
    assert.match(warnings.join('\n'), pattern);
  }
  const named = prepareRequest(
    era,
    ExtraConfigSchema.parse({ 更新模型预设: '使用指定预设', 更新模型预设名: '我的预设' }),
    createExtraApi(),
    'update',
    '',
    [],
  );
  assert.deepEqual(plain(named.prompts), [{ role: 'system', content: '我的预设条目' }, ...era]);
  assert.deepEqual(plain(named.custom_api), { temperature: 1.2 });

  // 酒馆助手没有预设接口（读取抛错）时同样退回
  const bare = create_env();
  const warnings = [];
  const request = bare
    .load('extra/request')
    .prepareRequest(
      era,
      bare.load('extra/config').ExtraConfigSchema.parse({ 更新模型预设: '使用当前预设' }),
      createExtraApi(),
      'update',
      '',
      warnings,
    );
  assert.deepEqual(plain(request.prompts), era);
  assert.match(warnings[0], /无法读取当前预设/);
});

test('角色信息：开启时附上角色描述与用户人设；宏没有展开或为空时不加；默认不加', () => {
  const macros = { '{{description}}': '一位剑士', '{{persona}}': '' };
  const env = create_env({ globals: { substitudeMacros: text => macros[text] ?? text } });
  const { buildExtraPrompts, describeCharacterInfo } = env.load('extra/prompt');
  const input = config => ({
    messages: [{ message_id: 0, role: 'assistant', mes: '剧情' }],
    entries: [{ name: '[era_update]规则', content: '规则', order: 0, group: '' }],
    group: '',
    stat: {},
    executed: '',
    config: { 聊天楼层数: 2, 附加要求: '', ...config },
  });
  assert.equal(describeCharacterInfo(), '<角色描述>\n一位剑士\n</角色描述>');
  const on = buildExtraPrompts(input({ 附带角色信息: '开启' }));
  assert.equal(on[2].content, '<角色描述>\n一位剑士\n</角色描述>', '紧跟在条目后面');
  assert.ok(!buildExtraPrompts(input({})).some(p => p.content.includes('角色描述')));
  macros['{{persona}}'] = '旅行者';
  assert.match(describeCharacterInfo(), /<用户人设>\n旅行者\n<\/用户人设>/);
  // 宏原样返回（不认识）时不加
  delete macros['{{description}}'];
  delete macros['{{persona}}'];
  assert.equal(describeCharacterInfo(), '');
  assert.ok(!buildExtraPrompts(input({ 附带角色信息: '开启' })).some(p => /角色描述|用户人设/.test(p.content)));
});

test('角色卡推荐：只推荐不使用或使用当前预设；存为本卡推荐只写可推荐的项，可以清除', async () => {
  const env = create_env();
  const {
    getCardExtraPreference,
    pickCardPreference,
    saveCardExtraPreference,
    clearCardExtraPreference,
    resolveExtraConfig,
    ExtraConfigSchema,
  } = env.load('extra/config');
  env.others.character = {
    ERA分步更新: { 更新模型预设: '使用指定预设', 规划模型预设: '使用当前预设', 附带角色信息: '开启', 头部提示词: 'x' },
  };
  assert.deepEqual(plain(getCardExtraPreference()), { 规划模型预设: '使用当前预设', 附带角色信息: '开启' });
  const followed = resolveExtraConfig(ExtraConfigSchema.parse({ 头部提示词: '玩家的', 请求方式: '流式' }));
  assert.equal(followed.头部提示词, '玩家的');
  assert.equal(followed.请求方式, '流式');
  assert.equal(followed.规划模型预设, '使用当前预设');

  const config = ExtraConfigSchema.parse({
    变量更新方式: '额外模型解析',
    重试次数: 3,
    更新模型预设: '使用指定预设',
    更新模型预设名: '我的预设',
    规划模型预设: '使用当前预设',
    附带角色信息: '开启',
    头部提示词: '破限',
    请求方式: '流式',
    默认接口: { 来源: '自定义', 密钥: 'sk-secret' },
    分组预设: { 战斗: { 预设: '使用当前预设' } },
  });
  const picked = plain(pickCardPreference(config));
  assert.equal(picked.变量更新方式, '额外模型解析');
  assert.equal(picked.重试次数, 3);
  assert.equal(picked.规划模型预设, '使用当前预设');
  assert.equal(picked.附带角色信息, '开启');
  for (const key of [
    '更新模型预设',
    '更新模型预设名',
    '头部提示词',
    '请求方式',
    '默认接口',
    '分组预设',
    '分组接口',
    '备用接口',
  ]) {
    assert.ok(!(key in picked), key);
  }
  assert.ok(!JSON.stringify(picked).includes('sk-secret'));
  assert.ok(!('变量更新方式' in plain(pickCardPreference(ExtraConfigSchema.parse({})))), '跟随角色卡不写');

  env.others.character = { 其他变量: 1, ERA分步更新: { 重试次数: 9 } };
  await saveCardExtraPreference(config);
  assert.equal(env.others.character.其他变量, 1);
  assert.deepEqual(env.others.character.ERA分步更新, picked, '覆盖原有的推荐');
  // 写进去的推荐原样被读出
  assert.deepEqual(plain(getCardExtraPreference()), picked);
  await clearCardExtraPreference();
  assert.deepEqual(env.others.character, { 其他变量: 1 });
  assert.equal(getCardExtraPreference(), null);
});

test('回归：玩家是“跟随角色卡”时存为本卡推荐，保留卡里原有的变量更新方式', async () => {
  const env = create_env();
  const { saveCardExtraPreference, previewCardPreference, resolveExtraConfig, ExtraConfigSchema } =
    env.load('extra/config');
  env.others.character = { ERA分步更新: { 变量更新方式: '额外模型解析', 重试次数: 2 } };
  const config = ExtraConfigSchema.parse({ 聊天楼层数: 5 });
  assert.equal(config.变量更新方式, '跟随角色卡');
  assert.equal(previewCardPreference(config).变量更新方式, '额外模型解析', '预览与写入一致');
  const written = await saveCardExtraPreference(config);
  assert.equal(written.变量更新方式, '额外模型解析');
  assert.equal(env.others.character.ERA分步更新.变量更新方式, '额外模型解析');
  assert.equal(env.others.character.ERA分步更新.聊天楼层数, 5);
  assert.equal(resolveExtraConfig(config).变量更新方式, '额外模型解析');

  // 玩家自己选了更新方式时照常写入玩家的选择；卡里原来没有时也不凭空写
  await saveCardExtraPreference(ExtraConfigSchema.parse({ 变量更新方式: '随AI输出' }));
  assert.equal(env.others.character.ERA分步更新.变量更新方式, '随AI输出');
  env.others.character = { ERA分步更新: { 重试次数: 2 } };
  await saveCardExtraPreference(config);
  assert.ok(!('变量更新方式' in env.others.character.ERA分步更新));
  // 卡里原有的值无效时不保留
  env.others.character = { ERA分步更新: { 变量更新方式: '跟随角色卡' } };
  await saveCardExtraPreference(config);
  assert.ok(!('变量更新方式' in env.others.character.ERA分步更新));
});

test('请求：分步更新带上头部提示词与流式；读不到预设记入 warnings；默认请求不带 should_stream', async () => {
  const env = await create_live(
    {
      等待方式: '后台更新',
      头部提示词: '破限',
      请求方式: '流式',
      更新模型预设: '使用指定预设',
      更新模型预设名: '不存在',
    },
    { globals: PRESET_GLOBALS },
  );
  const controller = env.load('extra/controller');
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  await env.receive('花了 3 金币');
  await env.until(() => env.requests.length === 1);
  const request = env.requests[0];
  assert.equal(request.should_stream, true);
  assert.equal(request.should_silence, true);
  assert.deepEqual(plain(request.ordered_prompts[0]), { role: 'system', content: '破限' });
  assert.match(request.ordered_prompts[1].content, /你负责根据最新一段剧情更新变量/);
  request.resolve(T('Edit', { 金币: '-=3' }));
  await env.until(() => controller.getExtraStatus().last?.status === 'done');
  const status = controller.getExtraStatus();
  assert.match(status.last.warnings.join('\n'), /无法读取预设“不存在”/);
  assert.equal(status.last.prompt[0].messages[0].content, '破限', '记录的是实际发送的提示词');

  const plainEnv = await create_live({ 等待方式: '后台更新' });
  plainEnv.send('assistant', T('Insert', { 金币: 10 }));
  await plainEnv.sync();
  await plainEnv.receive('花了 3 金币');
  await plainEnv.until(() => plainEnv.requests.length === 1);
  assert.ok(!('should_stream' in plainEnv.requests[0]));
  assert.equal(plainEnv.requests[0].custom_api, undefined);
  assert.match(plainEnv.requests[0].ordered_prompts[0].content, /你负责根据最新一段剧情更新变量/);
  plainEnv.requests[0].resolve('<VariableThink>无变化</VariableThink>');
});

test('status().history：保留最近 10 次，最新的在前，含提示词与回复、不含密钥；切换聊天时清空；last 不变', async () => {
  const env = await create_live({
    等待方式: '后台更新',
    默认接口: { 来源: '自定义', 接口地址: 'https://example.invalid', 密钥: 'sk-secret-key' },
  });
  const { startExtra, getExtraStatus, EXTRA_HISTORY_LIMIT } = env.load('extra/controller');
  assert.equal(EXTRA_HISTORY_LIMIT, 10);
  env.send('assistant', T('Insert', { 金币: 100 }));
  await env.sync();
  const mk = env.mk(0);
  assert.deepEqual(plain(getExtraStatus().history), []);
  for (let i = 0; i < 12; i++) {
    const running = startExtra(mk);
    await env.until(() => env.requests.length === i + 1);
    env.requests[i].resolve(T('Edit', { 金币: i }));
    await running;
  }
  const status = getExtraStatus();
  assert.equal(status.history.length, 10);
  assert.ok(status.history.every(item => item.type === 'update' && item.mk === mk && item.ok));
  assert.match(status.history[0].rawReply, /"金币":11/);
  assert.match(status.history[9].rawReply, /"金币":2/);
  assert.ok(status.history[0].prompt[0].messages.length > 0);
  assert.equal(typeof status.history[0].finishedAt, 'number');
  const { type, ...latest } = status.history[0];
  assert.equal(type, 'update');
  assert.deepEqual(plain(status.last), plain(latest), 'last 仍是最近一次分步更新');
  assert.ok(!JSON.stringify(status).includes('sk-secret-key'));
  status.history.length = 0;
  assert.equal(getExtraStatus().history.length, 10, '返回的是副本');

  env.switch_chat('other');
  await env.emit('CHAT_CHANGED');
  assert.deepEqual(plain(getExtraStatus().history), []);
  assert.equal(getExtraStatus().last, null);
});

/** 带注入记录与 [era_plan] 条目的 create_live。 */
async function create_plan_live(config = {}) {
  const injected = [];
  const env = await create_live(
    { 等待方式: '后台更新', ...config },
    {
      entries: [entry('[era_update]规则', '规则内容'), entry('[era_plan]检定', '攻击时掷骰')],
      globals: {
        injectPrompts: prompts => injected.push(...prompts.map(item => item.content)),
        uninjectPrompts: () => {},
      },
    },
  );
  env.send('assistant', T('Insert', { 金币: 10 }));
  await env.sync();
  return { env, injected };
}

test('回归：GENERATION_STARTED 之后没有 ENDED 时，之后的世界书加载不运行过滤器、之后的 AFTER_COMMANDS 不注入', async () => {
  const { env, injected } = await create_plan_live();
  let calls = 0;
  env.load('extra/entry_filter').addEntryFilter('测试.计数', () => void calls++);
  const { appendPlanBlock } = env.load('extra/plan');
  const { filterLores } = env.load('extra/controller');
  const load = () => filterLores({ characterLore: [{ uid: 1, comment: '普通', content: 'x', world: '主书' }] });
  const body = env.page.document.body;

  // 正常的主生成：STARTED → AFTER_COMMANDS 注入一次 → 酒馆锁定界面后加载世界书
  env.type(appendPlanBlock('攻击', '命中', ''));
  await env.emit('GENERATION_STARTED', 'normal', {}, false);
  await env.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
  assert.equal(injected.length, 1);
  await load();
  assert.equal(calls, 0, '酒馆还没有进入生成');
  body.dataset.generating = 'true';
  await load();
  assert.equal(calls, 1);
  // 同一次生成期间酒馆助手 generateRaw 发出的 AFTER_COMMANDS 不再注入
  await env.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
  assert.equal(injected.length, 1);
  await env.emit('GENERATION_ENDED', 1);
  delete body.dataset.generating;

  // STARTED 后提前返回（没有连接后端等），不发 ENDED：之后的加载和 generateRaw 都不算主生成
  await env.emit('GENERATION_STARTED', 'normal', {}, false);
  await load();
  assert.equal(calls, 1);
  body.dataset.generating = 'true'; // 例如之后的 quiet 生成锁定了界面
  await env.emit('GENERATION_STARTED', 'quiet', {}, false);
  await load();
  assert.equal(calls, 1);
  delete body.dataset.generating;

  // STARTED 之后很久才来的 AFTER_COMMANDS 不配对
  await env.emit('GENERATION_STARTED', 'normal', {}, false);
  const ContextDate = env.host.context.Date ?? require('node:vm').runInContext('Date', env.host.context);
  const now = ContextDate.now;
  ContextDate.now = () => now() + 16_000;
  try {
    await env.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
  } finally {
    ContextDate.now = now;
  }
  assert.equal(injected.length, 1);
  await env.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
  assert.equal(injected.length, 1, '配对一次即失效');
});

test('回归：输入框是斜杠命令时 GENERATION_STARTED 不置主生成标记，也不注入', async () => {
  const { env, injected } = await create_plan_live();
  let calls = 0;
  env.load('extra/entry_filter').addEntryFilter('测试.计数', () => void calls++);
  const { filterLores } = env.load('extra/controller');
  const body = env.page.document.body;
  env.type('  /echo hi');
  await env.emit('GENERATION_STARTED', 'normal', {}, false);
  // 斜杠命令里的 /gen、其他脚本的 generateRaw：有 AFTER_COMMANDS，酒馆也可能在生成中
  body.dataset.generating = 'true';
  await env.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
  await filterLores({ characterLore: [{ uid: 1, comment: '普通', content: 'x', world: '主书' }] });
  assert.equal(calls, 0);
  assert.equal(injected.length, 0);
  // 同样的文字用于滑动时不看输入框
  await env.emit('GENERATION_STARTED', 'swipe', {}, false);
  await filterLores({ characterLore: [{ uid: 1, comment: '普通', content: 'x', world: '主书' }] });
  assert.equal(calls, 1);
});

test('回归：带生成 ID 的 GENERATION_STOPPED 不撤掉规划摘要注入', async () => {
  let removed = 0;
  const env = await create_live({}, { globals: { injectPrompts: () => {}, uninjectPrompts: () => void removed++ } });
  await env.emit('GENERATION_STOPPED', 'era_extra_1');
  assert.equal(removed, 0);
  await env.emit('GENERATION_STOPPED');
  assert.equal(removed, 1);
  await env.emit('GENERATION_ENDED', 3);
  assert.equal(removed, 2);
});

test('回归：切换聊天后，旧聊天被取消的分步更新和规划不写进新聊天的 last、history、lastPlan，也不发状态事件', async () => {
  const { env } = await create_plan_live();
  const controller = env.load('extra/controller');
  const { ERA_EVENT_EMITTER } = env.load('utils/constants');
  const statuses = [];
  env.host.context.eventOn(ERA_EVENT_EMITTER.EXTRA_STATUS, payload => statuses.push(payload.status));

  const running = controller.startExtra(env.mk(0));
  await env.until(() => env.requests.length === 1);
  const planning = controller.planText('攻击');
  await env.until(() => env.requests.length === 2);
  assert.match(env.requests[1].generation_id, /^era_plan_/);

  env.switch_chat('other');
  await env.emit('CHAT_CHANGED');
  const update = await running;
  assert.equal(update.status, 'aborted');
  env.requests[1].resolve('<PlanSummary>命中</PlanSummary>');
  await planning;

  const status = controller.getExtraStatus();
  assert.equal(status.last, null);
  assert.deepEqual(plain(status.history), []);
  assert.equal(controller.getLastPlan(), null);
  assert.deepEqual(statuses, ['started'], '只有切换前的 started');

  // 新聊天里的解析照常记录
  env.send('assistant', T('Insert', { 金币: 1 }));
  await env.sync();
  const next = controller.startExtra(env.mk(env.chat.length - 1));
  await env.until(() => env.requests.length === 3);
  env.requests[2].resolve('<VariableThink>无变化</VariableThink>');
  await next;
  assert.equal(controller.getExtraStatus().history.length, 1);
  assert.equal(statuses.at(-1), 'no_change');
});
