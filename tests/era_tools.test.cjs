/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。日期：2026-11-27。
 * 目的：测试工具调用 <EraFCall> 与自定义公式函数（路线图 1.8-2）
 *       2026-11-27 未注册时算过的楼，换页面会话后注册也完全重算（元数据记 missing）
 *       2026-11-27 只对以前注册过的名字记 missing，AI 编造的名字不进元数据
 */
// 运行方式: node --test tests/era_tools.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const z = require('zod');
const { create_chat, plain } = require('./chat.cjs');

const T = (tag, value) => `<Variable${tag}>${JSON.stringify(value)}</Variable${tag}>`;
const CALL = (name, args) => `<EraFCall name="${name}">${args === undefined ? '' : JSON.stringify(args)}</EraFCall>`;

/** 读 b、写 c = a * 2：能看到同一楼前面指令的结果。 */
const DOUBLE = [
  'double',
  {
    description: '把 a 的两倍写进 c',
    handler: (_args, ctx) => [{ insert: { c: ctx.stat.a * 2 } }],
  },
];

test('工具调用按位置执行，读到执行到这里时的变量，重算结果不变', async () => {
  const env = create_chat({ tools: [DOUBLE] });
  env.send(
    'assistant',
    `${T('Insert', { a: 1 })} ${T('Edit', { a: '+=1' })} ${CALL('double')} ${T('Edit', { a: '+=10' })}`,
  );
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: 12, c: 4 });
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));
});

test('自闭合写法、args 属性、单双引号都能解析；参数原样交给工具', async () => {
  const seen = [];
  const env = create_chat({
    tools: [['记录', { handler: args => void seen.push(args) }]],
  });
  env.send(
    'assistant',
    `${T('Insert', { x: 1 })} <EraFCall name="记录" args='{"n":1,"s":"a.b"}'/> <EraFCall name='记录'/> <EraFCall name="记录">\n\`\`\`json\n{"n":3}\n\`\`\`\n</EraFCall>`,
  );
  await env.sync();
  assert.deepEqual(plain(seen), [{ n: 1, s: 'a.b' }, {}, { n: 3 }]);
});

test('解析失败、缺少 name、未知工具、工具出错都报告问题，后面的指令照常执行', async () => {
  const env = create_chat({
    tools: [
      [
        '坏',
        {
          handler: () => {
            throw new Error('目标不存在');
          },
        },
      ],
      ['异步', { handler: async () => [] }],
      ['坏操作', { handler: () => [{ set: { a: 1 } }] }],
    ],
  });
  const errors = [];
  env.host.load_src('core/latest_report');
  env.send(
    'assistant',
    [
      T('Insert', { a: 1 }),
      '<EraFCall name="坏">{oops</EraFCall>',
      '<EraFCall>{}</EraFCall>',
      CALL('没有这个'),
      CALL('坏'),
      CALL('异步'),
      CALL('坏操作'),
      T('Edit', { a: '+=1' }),
    ].join('\n'),
  );
  const patcher = env.host.load_src('core/crud/patcher');
  const msg = { message_id: 0, role: 'assistant', swipes: [env.chat[0].swipes[0]], swipe_id: 0 };
  const result = await patcher.ApplyVarChangeForMessage(msg, {}, {}, {}, 'mk-1');
  for (const issue of result.commandIssues) errors.push(`${issue.type}:${issue.path}:${issue.reason}`);
  assert.deepEqual(plain(result.finalStat), { a: 2 });
  assert.equal(errors.length, 6, errors.join('\n'));
  assert.match(errors[0], /^call:坏:.*不是合法的 JSON/);
  assert.match(errors[1], /缺少 name/);
  assert.match(errors[2], /未知工具 没有这个/);
  assert.match(errors[3], /目标不存在/);
  assert.match(errors[4], /同步函数/);
  assert.match(errors[5], /insert.*之一/);
  assert.equal(result.toolResults.length, 4);
  assert.deepEqual(plain(result.toolResults.map(r => r.ok)), [false, false, false, false]);
});

test('参数先用 zod schema 校验，不合法时调用失败；校验后的值交给工具', async () => {
  const env = create_chat({
    tools: [
      [
        '加',
        {
          parameters: z.object({ n: z.coerce.number().int() }),
          handler: ({ n }, ctx) => [{ edit: { a: ctx.stat.a + n } }],
        },
      ],
    ],
  });
  env.send('assistant', `${T('Insert', { a: 1 })}${CALL('加', { n: '2' })}${CALL('加', { n: 'x' })}`);
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: 3 });
});

test('ctx.random 按 MK、工具名、块序号取种子：重算不变，同一楼两次调用不同', async () => {
  const roll = ['掷', { handler: (_a, ctx) => [{ insert: { [`r${Object.keys(ctx.stat).length}`]: ctx.random() } }] }];
  const env = create_chat({ tools: [roll] });
  env.send('assistant', `${CALL('掷')}${CALL('掷')}`);
  await env.sync();
  const first = plain(env.stat());
  assert.notEqual(first.r0, first.r1);
  assert.deepEqual(plain(await env.replay()), first);
  await env.sync(true);
  assert.deepEqual(plain(env.stat()), first);
});

test('工具产出的操作走 schema；下划线只读不限制工具；用户消息里的调用不执行', async () => {
  const env = create_chat({
    settings: { 下划线只读: true },
    schema: z.object({ hp: z.number().max(10).optional(), _内部: z.number().optional() }).passthrough(),
    tools: [['设', { handler: args => [{ insert: args }] }]],
  });
  env.send('user', CALL('设', { hp: 1 }));
  env.send('assistant', `${CALL('设', { hp: 99 })}${CALL('设', { _内部: 5 })}`);
  await env.sync();
  assert.deepEqual(plain(env.stat()), { _内部: 5 });
});

test('钩子能看到、修改和删除工具调用', async () => {
  const seen = [];
  const env = create_chat({
    tools: [DOUBLE],
    before_hooks: [
      [
        '看',
        ctx => {
          seen.push(...ctx.commands.map(c => c.type));
          ctx.commands = ctx.commands.filter(c => !(c.type === 'call' && c.data[0].args?.skip));
        },
      ],
    ],
  });
  env.send('assistant', `${T('Insert', { a: 2 })}${CALL('double', { skip: true })}`);
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: 2 });
  assert.deepEqual(seen, ['insert', 'call']);
});

test('新聊天里思考块中的工具调用不执行', async () => {
  const env = create_chat({ tools: [DOUBLE] });
  env.send('assistant', `<think>${CALL('double')}</think>${T('Insert', { a: 3 })}${CALL('double')}`);
  await env.sync();
  assert.equal(env.meta().ParserVersion, 2);
  assert.deepEqual(plain(env.stat()), { a: 3, c: 6 });
});

test('旁路写入可以是工具调用，按位置插入；随机数种子取旁路写入的稳定身份', async () => {
  const env = create_chat({ tools: [DOUBLE] });
  env.send('assistant', `${T('Insert', { a: 1 })}`);
  await env.sync();
  await env.push_op(0, { type: 'call', data: { name: 'double', args: {} } });
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: 1, c: 2 });
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));
});

test('工具调用计入指令块序号，提取与剥离都认得它', () => {
  const env = create_chat();
  const message = env.host.load_src('utils/message');
  const text = `${T('Insert', { a: 1 })}${CALL('x', { a: 1 })}<EraFCall name="y"/>${T('Edit', { a: 2 })}`;
  assert.equal(message.countCommandBlocks({ message_id: 0, role: 'assistant', swipes: [text], swipe_id: 0 }), 4);
  assert.equal(message.stripCommandBlocks(`前${text}后`), '前后');
  const extracted = message.extractCommandBlocks(`<think>${CALL('z')}</think>正文${CALL('x', { a: 1 })}`);
  assert.equal(extracted.text, CALL('x', { a: 1 }));
  const parsed = message.parseCommandText(text);
  assert.deepEqual(plain(parsed.map(c => [c.type, c.block])), [
    ['insert', 0],
    ['call', 1],
    ['call', 2],
    ['edit', 3],
  ]);
});

test('数据隐藏正则隐藏工具调用的两种写法', () => {
  const env = create_chat();
  const { hideEraDataRegex } = env.host.load_src('initer/manual/regex_objects/hide_era_data');
  const source = (hideEraDataRegex ?? Object.values(env.host.load_src('initer/manual/regex_objects/hide_era_data'))[0])
    .find_regex;
  const [, body, flags] = /^\/(.*)\/([a-z]*)$/s.exec(source);
  const regex = new RegExp(body, flags);
  const text = `前${CALL('x', { a: 1 })}中<EraFCall name="y" args='{}'/>后`;
  assert.equal(text.replace(regex, ''), '前中后');
});

test('{{ERA-tools}} 列出工具与参数，{{ERA-toolResults}} 给出最新楼的调用结果', async () => {
  const env = create_chat({
    tools: [
      [
        '攻击',
        {
          description: '普通攻击',
          parameters: z.object({ 目标: z.string() }),
          handler: ({ 目标 }) => ({ operations: [{ insert: { 记录: 目标 } }], result: { 伤害: 7 } }),
        },
      ],
    ],
  });
  env.send('assistant', CALL('攻击', { 目标: '哥布林' }));
  await env.sync();
  const { parseEraMacros } = env.host.load_src('macro/parse');
  const tools = parseEraMacros('{{ERA-tools}}');
  assert.match(tools, /<EraFCall name="工具名">/);
  assert.match(tools, /- 攻击：普通攻击\n  参数：\{\n {4}目标: string;/);
  assert.equal(
    parseEraMacros('{{ERA-toolResults}}'),
    '上一条回复中的工具调用结果：\n1. 攻击 {"目标":"哥布林"}：成功，结果 {"伤害":7}',
  );
  assert.equal(parseEraMacros('{{ERA-toolResults}}', null, null, { issues: false }), '');
});

// ============================ 自定义公式函数 ============================

test('自定义公式函数可以在 $expr 里调用，与内置函数、随机数组合；重算不变', async () => {
  const env = create_chat({
    expr_fns: [['伤害', (atk, def) => Math.max(1, atk - def), { params: 2 }]],
  });
  env.send(
    'assistant',
    `${T('Insert', { hp: 20, atk: 5, def: 2 })}${T('Edit', { hp: { $expr: 'hp - 伤害(atk + roll(1, 6), def)' } })}`,
  );
  await env.sync();
  const hp = env.stat().hp;
  assert.ok(hp >= 20 - 9 && hp <= 20 - 4, String(hp));
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));
});

test('公式函数：不能与内置函数同名；参数个数、返回值、异步都会检查', async () => {
  const env = create_chat({
    expr_fns: [
      ['坏', () => 'x'],
      ['慢', async () => 1],
      ['二', (a, b) => a + b, { params: 2 }],
    ],
  });
  const registry = env.host.load_src('api/tool_registry');
  assert.match(
    registry.addExprFn('roll', () => 1),
    /内置函数/,
  );
  assert.match(
    registry.addExprFn('1x', () => 1),
    /函数名/,
  );
  assert.match(
    registry.addExprFn('ok', () => 1, { params: [3, 1] }),
    /params/,
  );
  env.send(
    'assistant',
    `${T('Insert', { a: 0, b: 0, c: 0, d: 0 })}${T('Edit', { a: { $expr: '坏()' }, b: { $expr: '慢()' }, c: { $expr: '二(1)' }, d: { $expr: '二(1, 2)' } })}`,
  );
  const patcher = env.host.load_src('core/crud/patcher');
  const msg = { message_id: 0, role: 'assistant', swipes: [env.chat[0].swipes[0]], swipe_id: 0 };
  const result = await patcher.ApplyVarChangeForMessage(msg, {}, {}, {}, 'mk-1');
  assert.deepEqual(plain(result.finalStat), { a: 0, b: 0, c: 0, d: 3 });
  const reasons = result.commandIssues.map(i => i.reason).join('\n');
  assert.match(reasons, /坏\(\) 的结果不是有限数字/);
  assert.match(reasons, /同步函数/);
  assert.match(reasons, /函数 二 需要 2 个参数/);
});

test('未知函数失败后再注册，注册时报告需要完全重算；有扩展时旁路写入不压缩', async () => {
  const env = create_chat();
  const registry = env.host.load_src('api/tool_registry');
  env.send('assistant', `${T('Insert', { a: 1 })}${T('Edit', { a: { $expr: '加一(a)' } })}`);
  await env.sync();
  assert.equal(env.stat().a, 1);
  assert.equal(registry.hasActiveExtensions(), false);
  registry.addExprFn('加一', x => x + 1, { params: 1 });
  assert.equal(registry.takeUnknownExtension('expr', '加一'), true);
  assert.equal(registry.takeUnknownExtension('expr', '加一'), false);
  assert.equal(registry.hasActiveExtensions(), true);
  assert.deepEqual(plain(registry.getExtensionKeys()), ['expr:加一@0']);
  await env.sync(true);
  assert.equal(env.stat().a, 2);
});

test('{{ERA-exprFns}} 列出公式函数；工具与公式函数随角色卡切换注销', () => {
  const env = create_chat({ expr_fns: [['伤害', (a, b) => a - b, { params: 2, description: '攻击减防御' }]] });
  const { parseEraMacros } = env.host.load_src('macro/parse');
  assert.match(parseEraMacros('{{ERA-exprFns}}'), /- 伤害（2 个参数）：攻击减防御/);
  const registry = env.host.load_src('api/tool_registry');
  registry.addTool('t', { handler: () => [] });
  env.host.context.SillyTavern.characterId = 'another-card';
  assert.equal(registry.hasExprFn('伤害'), false);
  assert.equal(registry.hasTool('t'), false);
  assert.equal(parseEraMacros('{{ERA-exprFns}}'), '');
});

// ============================ 1.8-1 幂等键 ============================

test('幂等键：同一楼已有同 key 的提交时跳过，结果带 skipped；带 key 的写入不被压缩掉', async () => {
  const env = create_chat();
  const load = env.host.load_src;
  const tickets = load('events/handlers/api/tickets');
  const { commit } = load('events/handlers/api/handler');
  const run = async detail => {
    const { ticket, promise } = tickets.createTicket(500);
    promise.catch(() => {});
    await commit(detail, ticket);
    await env.sync();
    tickets.settleTickets();
    return promise;
  };
  env.send('assistant', T('Insert', { 金币: 0 }));
  await env.sync();
  const first = await run({ operations: [{ edit: { 金币: '+=10' } }], key: '奖励:1' });
  assert.equal(first.skipped, undefined);
  const again = await run({ operations: [{ edit: { 金币: '+=10' } }], key: '奖励:1' });
  assert.equal(again.skipped, true);
  // 同一路径的直接赋值会取代更早的简单编辑，但带 key 的那条要留着
  await run({ operations: [{ edit: { 金币: 99 } }] });
  const third = await run({ operations: [{ edit: { 金币: '+=10' } }], key: '奖励:1' });
  assert.equal(third.skipped, true);
  assert.equal(env.stat().金币, 99);
  const ops = env.meta().ApiOps[env.host.mk.readMessageKey({ message_id: 0, ...env.chat[0] })].ops;
  assert.equal(ops.filter(op => op.key === '奖励:1').length, 1);
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));
});

// ============================ 审查发现的问题（回归） ============================

test('回归：beforeApply 钩子改写指令后，正文工具调用的随机数种子不变', async () => {
  const roll = ['掷', { handler: (_a, ctx) => [{ insert: { r: ctx.random() } }] }];
  const clamp = [
    '钳制',
    ctx => {
      for (const c of ctx.commands) if (c.type === 'edit' && c.data[0]?.hp < 0) c.data[0].hp = 0;
    },
  ];
  const env = create_chat({ tools: [roll], before_hooks: [clamp] });
  env.send('assistant', `${T('Insert', { hp: 5 })}${CALL('掷')}`);
  await env.sync();
  const first = env.stat().r;
  await env.push_op(0, { type: 'edit', data: { hp: -3 } });
  await env.sync();
  assert.equal(env.stat().hp, 0, '钩子确实改写了指令');
  assert.equal(env.stat().r, first);
});

test('回归：工具或公式函数提高版本、或新注册时完全重算，版本记在元数据里（跨页面会话也有效）', async () => {
  const make = version => ['t', { version, handler: () => [{ edit: { v: version } }] }];
  const env = create_chat({ tools: [make(1)] });
  env.send('assistant', `${T('Insert', { v: 0 })}${CALL('t')}`);
  env.send('user', '继续');
  env.send('assistant', '好的');
  await env.sync();
  assert.equal(env.stat().v, 1);
  assert.deepEqual(plain(env.meta().Extensions), { 'tool:t': '1' });
  // 模拟页面重新加载后注册了新版本：新的宿主实例没有本次会话的重放记录
  const registry = env.host.load_src('api/tool_registry');
  registry.clearExtensions();
  registry.addTool(...make(2));
  await env.sync();
  assert.equal(env.stat().v, 2);
  assert.deepEqual(plain(env.meta().Extensions), { 'tool:t': '2' });
});

test('回归：隐藏正则的 <EraFCall> 不跨过另一个调用；参数引号里的 > 不影响解析与隐藏', () => {
  const env = create_chat();
  const { HIDE_ERA_DATA_REGEX } = env.host.load_src('initer/manual/regex_objects/hide_era_data');
  const [, body, flags] = /^\/(.*)\/([a-z]*)$/s.exec(HIDE_ERA_DATA_REGEX.find_regex);
  const regex = new RegExp(body, flags);
  const text = `<think>用 <EraFCall name="攻击"> 这个工具</think>\n你拔出长剑。\n${CALL('攻击', { 目标: 'a' })}\n结尾`;
  assert.equal(text.replace(regex, ''), '<think>用 <EraFCall name="攻击"> 这个工具</think>\n你拔出长剑。\n\n结尾');
  const self = `前<EraFCall name="比较" args='{"c":"x>1"}'/>后`;
  assert.equal(self.replace(regex, ''), '前后');
  const parsed = env.host.load_src('utils/message').parseCommandText(self);
  assert.deepEqual(plain(parsed.map(c => c.data[0])), [{ name: '比较', args: { c: 'x>1' } }]);
});

test('回归：工具的 result 无法序列化时调用失败并报告，不会悄悄丢掉操作', async () => {
  const env = create_chat({
    tools: [['坏结果', { handler: () => ({ operations: [{ insert: { gold: 5 } }], result: { big: 10n } }) }]],
  });
  env.send('assistant', CALL('坏结果'));
  const patcher = env.host.load_src('core/crud/patcher');
  const msg = { message_id: 0, role: 'assistant', swipes: [env.chat[0].swipes[0]], swipe_id: 0 };
  const result = await patcher.ApplyVarChangeForMessage(msg, {}, {}, {}, 'mk-1');
  assert.equal(result.toolResults[0].ok, false);
  assert.equal(result.commandIssues.length, 1);
  assert.equal(result.finalStat.gold, undefined);
});

test('回归：era:commit 的 key 必须是非空字符串', async () => {
  const env = create_chat();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  const tickets = env.host.load_src('events/handlers/api/tickets');
  const { commit } = env.host.load_src('events/handlers/api/handler');
  for (const key of ['', 0]) {
    const { ticket, promise } = tickets.createTicket(500);
    await commit({ operations: [{ edit: { a: 2 } }], key }, ticket);
    await assert.rejects(promise, /key 必须是非空字符串/);
  }
});

test('回归：工具或公式函数没注册时算过的楼，换页面会话后注册时也完全重算一次；一直没注册时不反复重算', async () => {
  let calls = 0;
  const counter = ['计数', { handler: () => void calls++ }];
  const tool = ['t', { version: 3, handler: () => [{ edit: { v: '+=1' } }] }];
  const fn = ['加一', x => x + 1, { params: 1 }];
  const env = create_chat({ tools: [counter, tool], expr_fns: [fn] });
  const registry = env.host.load_src('api/tool_registry');
  /** 模拟页面重新加载：内存里的注册与失败记录都没了，只剩元数据。 */
  const reload = (...register) => {
    registry.clearExtensions();
    registry.addTool(...counter);
    for (const add of register) add();
  };
  env.send('assistant', `${T('Insert', { v: 0, a: 0 })}${CALL('计数')}${CALL('t')}`);
  await env.sync();
  assert.deepEqual(plain(env.stat()), { v: 1, a: 0 });
  const stored = { 'tool:计数': '0', 'tool:t': '3', 'expr:加一': '0' };
  assert.deepEqual(plain(env.meta().Extensions), stored);

  // 这一次页面会话里工具和公式函数都没有注册（例如脚本加载失败），新的一楼调用它们失败
  reload();
  env.send('user', '继续');
  env.send('assistant', `${CALL('t')}${T('Edit', { a: { $expr: '加一(a)' } })}`);
  await env.sync();
  assert.equal(env.stat().a, 0);
  // 以前注册过（元数据里有真实版本）的才记 missing
  assert.deepEqual(plain(env.meta().Extensions), { ...stored, 'tool:t': 'missing', 'expr:加一': 'missing' });
  const before = calls;
  await env.sync();
  assert.equal(calls, before, '一直没注册：missing 不触发重算');

  // 下一次页面会话照常注册（版本没变）：第二楼是缺少它们时算的，要完全重算
  reload(
    () => registry.addTool(...tool),
    () => registry.addExprFn(...fn),
  );
  await env.sync();
  assert.equal(calls, before + 1, '完全重算');
  assert.deepEqual(plain(env.stat()), { v: 2, a: 1 });
  assert.deepEqual(plain(env.meta().Extensions), stored);
  await env.sync();
  assert.equal(calls, before + 1, '重算后记下正常版本，不再重算');
});

test('回归：从未注册过的名字（AI 编造的工具名、函数名）失败时不进元数据；以后第一次注册时照常完全重算', async () => {
  let calls = 0;
  const counter = ['计数', { handler: () => void calls++ }];
  const env = create_chat({ tools: [counter] });
  const registry = env.host.load_src('api/tool_registry');
  env.send(
    'assistant',
    `${T('Insert', { v: 0 })}${CALL('计数')}${CALL('幻觉工具')}${T('Edit', { v: { $expr: '幻觉函数(1)' } })}`,
  );
  await env.sync();
  assert.equal(env.stat().v, 0);
  const stored = { 'tool:计数': '0' };
  assert.deepEqual(plain(env.meta().Extensions), stored);
  // 完全重算后仍然没有
  env.send('user', '继续');
  await env.sync(true);
  assert.deepEqual(plain(env.meta().Extensions), stored);

  // 卡后来真的注册了同名工具：元数据里没有它的记录，完全重算一次
  const before = calls;
  registry.addTool('幻觉工具', { handler: () => [{ edit: { v: 5 } }] });
  await env.sync();
  assert.equal(calls, before + 1, '完全重算');
  assert.equal(env.stat().v, 5);
  assert.deepEqual(plain(env.meta().Extensions), { ...stored, 'tool:幻觉工具': '0' });
});
