/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。日期：2026-11-27。
 * 目的：测试正文前规划（路线图 1.8-3）
 *       2026-11-27 主生成的条目过滤器只在主生成期间运行；带粘性或冷却的条目只能排除；输入框有文字时不回退读取旧的规划摘要
 *       2026-11-27 规划请求的头部提示词、预设、流式、附带角色信息与请求记录
 *       2026-11-27 主生成还要求酒馆正处于生成中
 */
// 运行方式: node --test tests/era_plan.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
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

function create_env({ entries = [entry('[era_plan]检定规则', '攻击时掷 d20，大于 10 命中')], ...options } = {}) {
  const worldbooks = { 主书: entries };
  const env = create_chat({
    ...options,
    globals: {
      SillyTavern: { name1: 'User', name2: 'Char', characterId: 'c', characters: {}, getCurrentChatId: () => 'chat' },
      getCharWorldbookNames: () => ({ primary: '主书', additional: [] }),
      getGlobalWorldbookNames: () => [],
      getChatWorldbookName: () => null,
      getWorldbook: async name => worldbooks[name] ?? [],
      substitudeMacros: text => text,
      formatAsTavernRegexedString: text => text,
      eventOn: () => ({ stop() {} }),
      eventEmit: () => {},
      toastr: { warning() {}, error() {}, info() {}, success() {} },
      initializeGlobal: () => {},
      setTimeout,
      clearTimeout,
      $: () => {},
      ...options.globals,
    },
  });
  return { ...env, load: env.host.load_src };
}

const CONFIG = { 聊天楼层数: 2, 重试次数: 1, 备用接口: [], 附加要求: '', EJS预处理: '关闭' };

/** 依次返回给定的输出，记下每次收到的提示词。 */
const scripted = outputs => {
  const calls = [];
  return {
    calls,
    deps: {
      generate: async prompts => {
        calls.push(prompts);
        const next = outputs[Math.min(calls.length - 1, outputs.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async () => {},
    },
  };
};

async function setup(options) {
  const env = create_env(options);
  env.send('assistant', `开场${T('Insert', { 敌人: { 生命: 10 }, 主角: { 体力: 5 } })}`);
  await env.sync();
  return env;
}

test('规划：提示词含规划规则、当前变量、玩家行动和预掷的骰子；结果是摘要加指令块', async () => {
  const env = await setup();
  const { runPlan } = env.load('extra/plan');
  const output = `<VariableThink>掷 d20</VariableThink><PlanSummary>攻击命中，敌人受到 4 点伤害</PlanSummary>${T('Edit', { 敌人: { 生命: 6 } })}`;
  const { calls, deps } = scripted([output]);
  const result = await runPlan(
    '我挥剑砍向敌人',
    env.chat.map((m, i) => ({ message_id: i, ...m })),
    CONFIG,
    deps,
    { aborted: false },
  );
  assert.equal(result.status, 'done');
  assert.equal(result.summary, '攻击命中，敌人受到 4 点伤害');
  assert.equal(result.blocks, T('Edit', { 敌人: { 生命: 6 } }));
  const text = calls[0].map(p => p.content).join('\n');
  assert.match(text, /攻击时掷 d20/);
  assert.match(text, /"生命":10/);
  assert.match(text, /<玩家这一轮的行动>\n我挥剑砍向敌人/);
  assert.match(text, /<可用的骰子>d20=\d+，d100=\d+/);
});

test('规划：输出有问题时带着问题重试；$expr、工具调用、缺摘要、试算失败都算问题', async () => {
  const env = await setup();
  const { runPlan } = env.load('extra/plan');
  const bad = [
    `<PlanSummary>x</PlanSummary>${T('Edit', { 敌人: { 生命: { $expr: '敌人.生命 - 4' } } })}`,
    `<PlanSummary>x</PlanSummary><EraFCall name="攻击">{}</EraFCall>${T('Edit', { 敌人: { 生命: 1 } })}`,
    T('Edit', { 敌人: { 生命: 6 } }),
    `<PlanSummary>x</PlanSummary>${T('Edit', { 不存在: { a: 1 } })}`,
  ];
  for (const output of bad) {
    const { calls, deps } = scripted([output, `<PlanSummary>好</PlanSummary>${T('Edit', { 敌人: { 生命: 6 } })}`]);
    const result = await runPlan('攻击', [], CONFIG, deps, { aborted: false });
    assert.equal(result.status, 'done', output);
    assert.equal(calls.length, 2, output);
    assert.match(calls[1].at(-1).content, /问题/);
  }
});

test('规划：不需要结算时返回 no_change；没有 [era_plan] 条目时不请求；一直失败时返回 failed', async () => {
  const env = await setup();
  const { runPlan } = env.load('extra/plan');
  let { calls, deps } = scripted(['<VariableThink>无需规划</VariableThink>']);
  assert.equal((await runPlan('看看四周', [], CONFIG, deps, { aborted: false })).status, 'no_change');

  const none = await setup({ entries: [entry('[era_update]规则', '更新规则')] });
  ({ calls, deps } = scripted(['x']));
  assert.equal(
    (await none.load('extra/plan').runPlan('攻击', [], CONFIG, deps, { aborted: false })).status,
    'no_entries',
  );
  assert.equal(calls.length, 0);

  ({ calls, deps } = scripted([Object.assign(new Error('Unauthorized'), {})]));
  const failed = await runPlan('攻击', [], CONFIG, deps, { aborted: false });
  assert.equal(failed.status, 'failed');
  assert.equal(calls.length, 1, '鉴权错误不重试');
  assert.match(failed.problems[0], /Unauthorized/);
});

test('规划块：追加在玩家消息里，发送时执行（不执行钩子），重算不变；滑动 AI 回复时复用', async () => {
  // 纯函数钩子：每个 AI 楼加一；玩家楼（含规划块）不执行钩子
  const env = await setup({ hooks: [['计数', ctx => void (ctx.stat.计数 = (ctx.old_stat.计数 ?? 0) + 1)]] });
  const { appendPlanBlock, readPlanSummary, stripPlanBlock } = env.load('extra/plan');
  const text = appendPlanBlock('我挥剑砍向敌人', '命中，造成 4 点伤害', T('Edit', { 敌人: { 生命: 6 } }));
  assert.equal(
    text,
    `我挥剑砍向敌人\n<era_plan>\n<PlanSummary>命中，造成 4 点伤害</PlanSummary>\n${T('Edit', { 敌人: { 生命: 6 } })}\n</era_plan>`,
  );
  assert.equal(readPlanSummary(text), '命中，造成 4 点伤害');
  assert.equal(stripPlanBlock(text), '我挥剑砍向敌人');
  assert.equal(appendPlanBlock(text, '', ''), '我挥剑砍向敌人', '空结果只去掉原有的规划');
  env.send('user', text);
  env.send('assistant', '你一剑命中。');
  await env.sync();
  assert.equal(env.stat().敌人.生命, 6);
  assert.equal(env.stat().计数, 2);
  env.swipe_new(2, '敌人踉跄后退。');
  await env.sync(true);
  assert.equal(env.stat().敌人.生命, 6);
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));
});

test('规划块：新聊天设置了指令外层标签时，指令包在外层标签里', async () => {
  const env = create_env({ settings: { 指令外层标签: 'ERA_Update' } });
  env.send('assistant', `开场<ERA_Update>${T('Insert', { 敌人: { 生命: 10 } })}</ERA_Update>`);
  await env.sync();
  const { appendPlanBlock } = env.load('extra/plan');
  const text = appendPlanBlock('攻击', '命中', T('Edit', { 敌人: { 生命: 6 } }));
  assert.match(text, /<era_plan>\n<PlanSummary>命中<\/PlanSummary>\n<ERA_Update>\n<VariableEdit>/);
  env.send('user', text);
  await env.sync();
  assert.equal(env.stat().敌人.生命, 6);
});

test('规划块：数据隐藏正则整块隐藏；更新模型在聊天里只看到摘要，并被告知已经执行的规划指令', async () => {
  const env = await setup();
  const { HIDE_ERA_DATA_REGEX } = env.load('initer/manual/regex_objects/hide_era_data');
  const [, body, flags] = /^\/(.*)\/([a-z]*)$/s.exec(HIDE_ERA_DATA_REGEX.find_regex);
  const { appendPlanBlock } = env.load('extra/plan');
  const text = appendPlanBlock('攻击', '命中', T('Edit', { 敌人: { 生命: 6 } }));
  assert.equal(text.replace(new RegExp(body, flags), ''), '攻击\n');
  const { stripCommandBlocks } = env.load('utils/message');
  assert.equal(stripCommandBlocks(text).trim(), '攻击');
  const { buildExtraPrompts: build0, readSettledPlan } = env.load('extra/prompt');
  const build = messages =>
    build0({
      messages,
      entries: [{ name: '[era_update]规则', content: '规则', order: 0, group: '' }],
      group: '',
      stat: env.stat(),
      executed: '',
      config: { 聊天楼层数: 4, 附加要求: '' },
    });
  const last = prompts => prompts[prompts.length - 1].content;
  const prompts = build([
    { message_id: 0, role: 'user', mes: text },
    { message_id: 1, role: 'assistant', mes: '你一剑命中。' },
  ]);
  const all = prompts.map(p => p.content).join('\n');
  assert.match(all, /攻击\n（本轮已结算：命中）/);
  assert.doesNotMatch(all, /PlanSummary/);
  // 剧情是照着规划结果写的：必须把已执行的规划指令列出来并要求不要重复，否则同一个结果会被算两次
  const tail = last(prompts);
  assert.ok(tail.includes(`<本轮已结算>\n结算结果：命中\n${T('Edit', { 敌人: { 生命: 6 } })}\n</本轮已结算>`));
  assert.match(tail, /已经计入当前变量[^\n]*不要把这些变化再输出一遍/);
  assert.ok(tail.indexOf('<最新剧情>') < tail.indexOf('<本轮已结算>'));

  // 没有规划、规划属于更早的一轮时不出现
  assert.ok(!last(build([{ message_id: 0, role: 'assistant', mes: '开场' }])).includes('<本轮已结算>'));
  const later = build([
    { message_id: 0, role: 'user', mes: text },
    { message_id: 1, role: 'assistant', mes: '你一剑命中。' },
    { message_id: 2, role: 'user', mes: '继续前进' },
    { message_id: 3, role: 'assistant', mes: '你走进了森林。' },
  ]);
  assert.ok(!last(later).includes('<本轮已结算>'));
  assert.equal(
    readSettledPlan([
      { role: 'user', mes: '只有正文' },
      { role: 'assistant', mes: 'x' },
    ]),
    '',
  );
});

test('[era_plan] 条目不发给剧情模型和更新模型；[era_both] 两边都发', async () => {
  const env = create_env({
    entries: [
      entry('[era_plan]检定', '规划规则'),
      entry('[era_both]设定', '共享设定'),
      entry('[era_update]更新', '更新规则'),
      entry('普通条目', '剧情'),
    ],
  });
  const { collectExtraEntries } = env.load('extra/prompt');
  const names = async purpose => (await collectExtraEntries('', { purpose })).map(e => e.name);
  assert.deepEqual(plain(await names('plan')), ['[era_plan]检定', '[era_both]设定']);
  assert.deepEqual(plain(await names('extra')), ['[era_both]设定', '[era_update]更新']);
});

/** 假页面：输入框、发送按钮与捕获阶段的监听器。返回模拟点击发送的函数。 */
function fake_page() {
  const listeners = {};
  const state = { text: '', sent: [] };
  const page = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: () => {},
    document: { querySelector: () => ({ click: () => click(true) }) },
  };
  const $ = selector => ({
    val: value => {
      if (value === undefined) return selector === '#send_textarea' ? state.text : '';
      state.text = value;
      return { trigger() {} };
    },
  });
  // 发送按钮被点击：拦截器放行（passing）时记为一次真正的发送
  function click(programmatic = false) {
    let blocked = false;
    listeners.click({
      target: { closest: selector => selector === '#send_but' },
      preventDefault: () => (blocked = true),
      stopImmediatePropagation() {},
    });
    if (!blocked) state.sent.push({ text: state.text, programmatic });
  }
  return { page, $, state, click };
}

test('发送拦截：开启规划时先规划，把结果写进输入框再发送；规划返回 null 时不发送；规划期间改了文字不发送', async () => {
  for (const scenario of ['done', 'cancel', 'edited']) {
    const { page, $, state, click } = fake_page();
    const env = create_env({ globals: { window: { parent: page }, $, builtin: { duringGenerating: () => false } } });
    env.host.context.SillyTavern.chat = [];
    const { installSendGuard } = env.load('extra/send_guard');
    installSendGuard({
      shouldHold: () => false,
      wait: async () => true,
      shouldPlan: text => text !== '',
      plan: async text => {
        if (scenario === 'edited') state.text = '改了';
        return scenario === 'cancel' ? null : `${text}<era_plan>x</era_plan>`;
      },
    });
    state.text = '攻击';
    click();
    assert.equal(state.sent.length, 0, '先拦下');
    await new Promise(resolve => setTimeout(resolve, 120));
    if (scenario === 'done') {
      assert.deepEqual(state.sent, [{ text: '攻击<era_plan>x</era_plan>', programmatic: true }]);
    } else {
      assert.deepEqual(state.sent, [], scenario);
    }
  }
});

test('发送拦截：斜杠命令、不需要规划也不需要等待时直接放行', async () => {
  const { page, $, state, click } = fake_page();
  const env = create_env({ globals: { window: { parent: page }, $, builtin: { duringGenerating: () => false } } });
  const { installSendGuard } = env.load('extra/send_guard');
  let planned = 0;
  installSendGuard({
    shouldHold: () => false,
    wait: async () => true,
    shouldPlan: () => true,
    plan: async () => void planned++,
  });
  state.text = '/echo hi';
  click();
  assert.equal(state.sent.length, 1);
  assert.equal(planned, 0);
});

test('回归：重新规划可以指定依据的变量；只有 [era_both] 没有 [era_plan] 时不规划', async () => {
  const env = await setup();
  const { runPlan } = env.load('extra/plan');
  const { calls, deps } = scripted(['<VariableThink>无需规划</VariableThink>']);
  await runPlan('攻击', [], CONFIG, deps, { aborted: false }, { 敌人: { 生命: 99 } });
  assert.match(calls[0].map(p => p.content).join('\n'), /"生命":99/);

  const both = await setup({ entries: [entry('[era_both]设定', '共享设定')] });
  const second = scripted(['x']);
  assert.equal(
    (await both.load('extra/plan').runPlan('攻击', [], CONFIG, second.deps, { aborted: false })).status,
    'no_entries',
  );
  assert.equal(second.calls.length, 0);
});

test('主生成的条目过滤器：按最新变量在内存里排除、强制纳入（含文件里关闭的）、替换内容', async () => {
  const env = await setup();
  const { addEntryFilter } = env.load('extra/entry_filter');
  const seen = [];
  addEntryFilter('测试.按生命', (entry, ctx) => {
    seen.push(ctx.purpose);
    if (entry.name === '低血量') return ctx.stat.敌人.生命 < 5;
    if (entry.name === '战斗') return `敌人剩余 ${ctx.stat.敌人.生命} 点生命`;
    return undefined;
  });
  const lores = {
    globalLore: [],
    characterLore: [
      { uid: 1, comment: '低血量', content: 'x', disable: false, constant: false },
      { uid: 2, comment: '战斗', content: '旧内容', disable: true, constant: false },
      { uid: 3, comment: '其他', content: '照常', disable: false, constant: false },
    ],
    chatLore: [],
    personaLore: [],
  };
  const { applyMainEntryFilters } = env.load('extra/controller');
  await applyMainEntryFilters(lores);
  assert.deepEqual(plain(lores.characterLore), [
    { uid: 2, comment: '战斗', content: '敌人剩余 10 点生命', disable: false, constant: true, useProbability: false },
    { uid: 3, comment: '其他', content: '照常', disable: false, constant: false },
  ]);
  assert.ok(seen.every(p => p === 'main'));
});

const lore_of = items => ({ globalLore: [], characterLore: items, chatLore: [], personaLore: [] });

test('回归：主生成的条目过滤器只在主生成期间运行；[era_plan] 条目总是移除', async () => {
  // 酒馆页面：deactivateSendButtons 置上 body.dataset.generating
  const env = await setup({ globals: { window: { document: { body: { dataset: { generating: 'true' } } } } } });
  const { addEntryFilter } = env.load('extra/entry_filter');
  let calls = 0;
  addEntryFilter('测试.排除', () => {
    calls++;
    return false;
  });
  const controller = env.load('extra/controller');
  const load = async () => {
    const lores = lore_of([
      { uid: 1, comment: '[era_plan]检定', content: '规划', world: '主书' },
      { uid: 2, comment: '普通', content: '剧情', world: '主书' },
    ]);
    await controller.filterLores(lores);
    return lores.characterLore.map(item => item.uid);
  };
  // 不在主生成中：切换聊天的预加载、其他脚本或 ERA 自己的 generateRaw
  assert.deepEqual(plain(await load()), [2]);
  // quiet 生成、dry run 不算主生成
  controller.noteGenerationStarted('quiet', false);
  assert.deepEqual(plain(await load()), [2]);
  controller.noteGenerationStarted('normal', true);
  assert.deepEqual(plain(await load()), [2]);
  assert.equal(calls, 0);
  for (const type of ['normal', 'swipe', 'regenerate', 'continue']) {
    controller.noteGenerationStarted(type, false);
    assert.deepEqual(plain(await load()), [], type);
    // 酒馆助手停止某个 generateRaw（带生成 ID）不是主生成结束
    controller.noteGenerationEnded('era_extra_1');
    assert.deepEqual(plain(await load()), [], type);
    controller.noteGenerationEnded();
    assert.deepEqual(plain(await load()), [2], type);
  }
  assert.equal(calls, 8);
});

test('回归：主生成强制纳入时关闭概率；带粘性或冷却的条目不改写，只能排除', async () => {
  const env = await setup();
  const { addEntryFilter } = env.load('extra/entry_filter');
  addEntryFilter('测试.粘性', entry => (entry.name.startsWith('排除') ? false : `新内容${entry.uid}`));
  const lores = lore_of([
    { uid: 1, comment: '普通', content: '旧', disable: true, constant: false, useProbability: true, probability: 10 },
    { uid: 2, comment: '粘性', content: '旧', disable: true, constant: false, sticky: 3 },
    { uid: 3, comment: '冷却', content: '旧', disable: false, constant: false, cooldown: 2 },
    { uid: 4, comment: '排除粘性', content: '旧', sticky: 3 },
    { uid: 5, comment: '无计时', content: '旧', disable: false, constant: false, sticky: 0, cooldown: null },
  ]);
  await env.load('extra/controller').applyMainEntryFilters(lores);
  assert.deepEqual(plain(lores.characterLore), [
    {
      uid: 1,
      comment: '普通',
      content: '新内容1',
      disable: false,
      constant: true,
      useProbability: false,
      probability: 10,
    },
    { uid: 2, comment: '粘性', content: '旧', disable: true, constant: false, sticky: 3 },
    { uid: 3, comment: '冷却', content: '旧', disable: false, constant: false, cooldown: 2 },
    {
      uid: 5,
      comment: '无计时',
      content: '新内容5',
      disable: false,
      constant: true,
      sticky: 0,
      cooldown: null,
      useProbability: false,
    },
  ]);
});

test('回归：普通发送时输入框有文字但没有规划块，不注入上一条玩家楼的旧摘要；输入框为空时才回退', async () => {
  const state = { text: '' };
  const injected = [];
  const env = create_env({
    globals: {
      $: selector => (typeof selector === 'function' ? undefined : { val: () => state.text }),
      injectPrompts: prompts => injected.push(...prompts.map(p => p.content)),
      uninjectPrompts: () => {},
    },
  });
  const { appendPlanBlock } = env.load('extra/plan');
  env.send('assistant', '开场');
  // 上一次发送后生成失败：最新一条是带规划块的玩家楼
  env.send('user', appendPlanBlock('攻击', '旧摘要', ''));
  const { injectPlanSummary } = env.load('extra/controller');
  const run = (type, text) => {
    state.text = text;
    injected.length = 0;
    injectPlanSummary(type, false);
    return injected.join('\n');
  };
  assert.equal(run('normal', '换个行动'), '');
  assert.match(run('normal', appendPlanBlock('换个行动', '新摘要', '')), /新摘要/);
  assert.match(run('normal', ''), /旧摘要/);
  assert.match(run('normal', '  '), /旧摘要/);
  // 滑动等不看输入框
  env.send('assistant', '回复');
  assert.match(run('swipe', '输入框里的草稿'), /旧摘要/);
});

test('规划提示词：开启“附带角色信息”时附上角色描述与用户人设，默认不加', async () => {
  const macros = { '{{description}}': '一位剑士', '{{persona}}': '旅行者' };
  const env = await setup({ globals: { substitudeMacros: text => macros[text] ?? text } });
  const { runPlan } = env.load('extra/plan');
  const off = scripted(['<VariableThink>无需规划</VariableThink>']);
  await runPlan('攻击', [], CONFIG, off.deps, { aborted: false });
  assert.doesNotMatch(off.calls[0].map(p => p.content).join('\n'), /角色描述|用户人设/);
  const on = scripted(['<VariableThink>无需规划</VariableThink>']);
  await runPlan('攻击', [], { ...CONFIG, 附带角色信息: '开启' }, on.deps, { aborted: false });
  const info = on.calls[0].find(p => p.content.includes('<角色描述>'));
  assert.equal(info.content, '<角色描述>\n一位剑士\n</角色描述>\n<用户人设>\n旅行者\n</用户人设>');
  assert.ok(on.calls[0].indexOf(info) > 1, '在规划规则之后');
});

test('规划请求：带上头部提示词、规划模型的预设与流式；记入 status().history（类型 plan）；没有 [era_plan] 条目时不记录', async () => {
  const requests = [];
  const env = await setup({
    globals: {
      generateRaw: async request => {
        requests.push(request);
        return `<PlanSummary>命中</PlanSummary>${T('Edit', { 敌人: { 生命: 6 } })}`;
      },
      stopGenerationById: () => true,
      getPresetNames: () => [],
      getPreset: name => {
        if (name !== 'in_use') throw new Error('预设不存在');
        return {
          settings: { temperature: 0.5 },
          prompts: [{ id: 'main', enabled: true, content: '当前预设的主提示' }],
        };
      },
    },
  });
  env.others.global = {
    ERA额外模型: {
      ...CONFIG,
      重试次数: 0,
      头部提示词: '破限',
      请求方式: '流式',
      规划模型预设: '使用当前预设',
      更新模型预设: '使用指定预设',
      更新模型预设名: '不存在',
    },
  };
  env.load('extra/config').loadExtraConfig();
  const controller = env.load('extra/controller');
  const result = await controller.planText('我挥剑砍向敌人');
  assert.equal(result.status, 'done');
  assert.deepEqual(plain(result.warnings), [], '规划不受更新模型预设的影响');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].should_stream, true);
  assert.deepEqual(plain(requests[0].ordered_prompts.slice(0, 2).map(p => p.content)), ['破限', '当前预设的主提示']);
  assert.match(requests[0].ordered_prompts[2].content, /你负责在写剧情之前/);
  assert.deepEqual(plain(requests[0].custom_api), { temperature: 0.5 });

  const { history, last } = controller.getExtraStatus();
  assert.equal(last, null, 'last 只记分步更新');
  assert.equal(history.length, 1);
  assert.equal(history[0].type, 'plan');
  assert.equal(history[0].mk, '');
  assert.equal(history[0].status, 'done');
  assert.equal(history[0].ok, true);
  assert.equal(history[0].prompt[0].group, '规划');
  assert.equal(history[0].prompt[0].messages[0].content, '破限');
  assert.match(history[0].rawReply, /PlanSummary/);

  // 读不到预设时记入告警
  env.others.global.ERA额外模型.规划模型预设 = '使用指定预设';
  env.others.global.ERA额外模型.规划模型预设名 = '已删除';
  env.load('extra/config').loadExtraConfig();
  const missing = await controller.planText('再砍一剑');
  assert.match(missing.warnings.join('\n'), /无法读取预设“已删除”/);
  assert.equal(controller.getExtraStatus().history.length, 2);
  assert.match(controller.getExtraStatus().history[0].warnings.join('\n'), /已删除/);

  // 重新规划时传入的是玩家楼的原文：消息密钥和原来的规划块都不发给规划模型
  await controller.planText(
    '再砍一剑<era_data>{"era-message-key"="era_mk_1_x"}</era_data>\n<era_plan>\n<PlanSummary>旧</PlanSummary>\n</era_plan>',
  );
  const sent = requests[requests.length - 1].ordered_prompts.map(p => p.content).join('\n');
  assert.ok(sent.includes('<玩家这一轮的行动>\n再砍一剑\n</玩家这一轮的行动>'));
  assert.doesNotMatch(sent, /era_data|era-message-key|PlanSummary>旧/);

  const none = await setup({ entries: [entry('[era_update]规则', '更新规则')] });
  const noneController = none.load('extra/controller');
  assert.equal((await noneController.planText('攻击')).status, 'no_entries');
  assert.deepEqual(plain(noneController.getExtraStatus().history), []);
});

test('回归：摘要只在思考块之外取（思考里提到标签名、接口丢掉开头的 <think> 都不影响）', async () => {
  const env = await setup();
  const { runPlan } = env.load('extra/plan');
  const output =
    '先想一想：只需输出 `<PlanSummary>` 说明结果。\n</think>\n<PlanSummary>未命中，木桩不变。</PlanSummary>';
  const { deps } = scripted([output]);
  const result = await runPlan('攻击', [], CONFIG, deps, { aborted: false });
  assert.equal(result.status, 'done');
  assert.equal(result.summary, '未命中，木桩不变。');
  const second = scripted(['<think>草稿 <PlanSummary>错的</PlanSummary></think><PlanSummary>对的</PlanSummary>']);
  assert.equal((await runPlan('攻击', [], CONFIG, second.deps, { aborted: false })).summary, '对的');
});
