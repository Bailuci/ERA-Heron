/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-27
 * 目的：测试 1.7 各分支合并后的配合：分步更新的试算与写入同形、“已执行的更新”与额外输出的思考遮蔽、未闭合思考标签与 <era_extra>、
 *       {{ERA-issues}} 只报告主模型的指令、/era-issues 与宏共用报告、keepMessageKey 保留 <era_extra>、分步更新提示词去掉占位符、
 *       Era.features 登记、条目过滤器的重入保护、atomic 预检与写入的压缩一致、“ERA 表达式规则”是内置更新条目、seedMk 的含义；
 *       <era_extra> 区段只认闭合、不在闭合思考块里的块（思考里提到这个标签时草稿仍遮蔽、{{ERA-issues}} 不变）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 运行方式: node --test tests/era_cross.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
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

/** 带有世界书、宏、弹窗等酒馆接口的假聊天（与 era_extra.test.cjs 相同）。 */
function create_env({ entries = [entry('[era_update]规则', '规则内容')], ...options } = {}) {
  const worldbooks = { 主书: entries };
  const env = create_chat({
    ...options,
    globals: {
      SillyTavern: { name1: 'User', name2: 'Char', characterId: 'c', characters: {}, getCurrentChatId: () => 'chat' },
      getCharWorldbookNames: () => ({ primary: '主书', additional: [] }),
      getGlobalWorldbookNames: () => [],
      getChatWorldbookName: () => null,
      getWorldbook: async name => {
        if (!worldbooks[name]) throw new Error('not found');
        return worldbooks[name];
      },
      substitudeMacros: text => text.replace(/{{user}}/g, 'User'),
      formatAsTavernRegexedString: text => text,
      eventOn: () => ({ stop() {} }),
      eventEmit: () => {},
      toastr: { warning() {}, error() {} },
      initializeGlobal: () => {},
      setTimeout,
      clearTimeout,
      $: () => {},
      ...options.globals,
    },
  });
  const load = env.host.load_src;
  const tickets = load('events/handlers/api/tickets');
  const handler = load('events/handlers/api/handler');
  const { handleWriteExtra } = load('events/handlers/api/extra_write');
  const sync = async (...args) => {
    await env.sync(...args);
    tickets.settleTickets();
  };
  const submit = async detail => {
    const { ticket, promise } = tickets.createTicket(5000);
    promise.catch(() => {});
    await handler.commit(detail, ticket);
    await sync();
    return promise;
  };
  return {
    ...env,
    load,
    sync,
    mk: i => env.host.mk.readMessageKey({ message_id: i, ...env.chat[i] }),
    Era: () => load('api/global').Era,
    commit: (operations, detail = {}) => submit({ ...detail, operations }),
    apply_text: (text, detail = {}) => submit({ ...detail, text }),
    write_extra: async (mk, blocks) => {
      const { ticket, promise } = tickets.createTicket(5000);
      promise.catch(() => {});
      await handleWriteExtra({ mk, blocks }, ticket);
      await sync();
      await promise;
    },
  };
}

const CONFIG = { 聊天楼层数: 2, 重试次数: 1, 失败处理: '保留有效部分' };
async function run(env, outputs, config = {}, target = env.chat.length - 1) {
  const { runExtra } = env.load('extra/runner');
  const { ExtraConfigSchema } = env.load('extra/config');
  const calls = [];
  const result = await runExtra(
    env.mk(target),
    ExtraConfigSchema.parse({ ...CONFIG, ...config }),
    {
      generate: async prompts => {
        calls.push(plain(prompts));
        return typeof outputs === 'function' ? outputs(calls.length) : outputs.shift();
      },
      write: env.write_extra,
      sleep: async () => {},
    },
    { aborted: false },
  );
  return { result: plain(result), calls, text: calls.map(prompts => prompts.map(p => p.content).join('\n')) };
}

/** 开场有金币 10、地点“城”；最后一楼是 `last`。 */
async function story(options = {}, last = '你花了 3 金币。') {
  const env = create_env(options);
  const wrap = text => (options.outer ? `<${options.outer}>${text}</${options.outer}>` : text);
  env.send('assistant', `开场${wrap(T('Insert', { 金币: 10, 地点: '城' }))}`);
  env.send('user', '买面包');
  env.send('assistant', last);
  await env.sync();
  return env;
}
const OUTER = { outer: 'ERA_Update', settings: { 指令外层标签: 'ERA_Update' } };

// ============================ A. 试算与写入同形 ============================

test('A：开启指令外层标签时，额外模型的错误输出仍会被识别并重试', async () => {
  for (const options of [{}, OUTER]) {
    const env = await story(options);
    assert.equal(env.meta().ParserVersion, 2);
    const { result, calls } = await run(env, [T('Edit', { 钱: 1 }), T('Edit', { 金币: 7 })]);
    assert.deepEqual(result, { status: 'done', problems: [], warnings: [] });
    assert.equal(calls.length, 2, `第一次的错误输出应当触发重试（${options.outer ?? '无外层标签'}）`);
    assert.match(calls[1].at(-1).content, /钱/);
    assert.equal(env.stat().金币, 7);
  }
});

test('A：试算与写入共用 appendExtraBlock；退回最新状态的试算同样包在 <era_extra> 里', async () => {
  const env = await story(OUTER);
  const { appendExtraBlock } = env.load('utils/message');
  const raw = env.chat[2].swipes[0];
  const blocks = T('Edit', { 金币: 7 });
  await env.write_extra(env.mk(2), blocks);
  assert.equal(env.chat[2].swipes[0], appendExtraBlock(raw, blocks));
  assert.equal(appendExtraBlock(env.chat[2].swipes[0], ''), raw.trimEnd(), '空输出只去掉原有的块');
  assert.equal(
    appendExtraBlock('正文', '{"a":"</era_extra>"}'),
    '正文\n<era_extra>\n{"a":"\\u003c/era_extra>"}\n</era_extra>',
  );

  // 退回路径：日志折叠后取不到较早楼层之前的状态
  const folded = create_env({ settings: { 日志保留楼层数: 2, 指令外层标签: 'ERA_Update' } });
  folded.send('assistant', `<ERA_Update>${T('Insert', { a: 1 })}</ERA_Update>`);
  for (let i = 0; i < 6; i++) folded.send('assistant', '剧情');
  await folded.sync();
  await folded.sync();
  const { createExtraSimulator } = folded.load('core/simulate');
  const simulator = await createExtraSimulator({ message_id: 1, ...folded.chat[1] });
  assert.equal(simulator.fallback, true);
  assert.deepEqual(
    plain((await simulator.check(T('Edit', { 不存在: 1 }))).map(problem => problem.path)),
    ['不存在'],
    '退回路径的试算也能看到额外模型的指令',
  );
});

// ============================ B. 已执行的更新 ============================

test('B：“已执行的更新”只列出真正执行了的指令（外层标签、自定义思考标签、旧聊天）', async () => {
  const cases = [
    [OUTER, `你花了 3 金币。${T('Edit', { 金币: '-=3' })}<ERA_Update>${T('Edit', { 地点: '店' })}</ERA_Update>`],
    [
      { settings: { 思考标签: 'reasoning' } },
      `<reasoning>${T('Edit', { 金币: '-=3' })}</reasoning>${T('Edit', { 地点: '店' })}`,
    ],
    [{ legacy: true }, `<think>${T('Edit', { 金币: '-=3' })}</think>${T('Edit', { 地点: '店' })}`],
  ];
  for (const [options, last] of cases) {
    const env = await story(options, last);
    const legacy = !!options.legacy;
    assert.equal(env.stat().金币, legacy ? 7 : 10);
    const { text } = await run(env, ['<VariableThink>无变化</VariableThink>']);
    const executed = text[0].match(/<已执行的更新>\n([\s\S]*?)\n<\/已执行的更新>/)[1];
    assert.equal(executed.includes('"金币":"-=3"'), legacy, `${JSON.stringify(options)}: ${executed}`);
    assert.ok(executed.includes('"地点":"店"'));
  }
  // 没有执行任何指令时不出现这一段
  const env = await story(OUTER, `你花了 3 金币。${T('Edit', { 金币: '-=3' })}`);
  assert.ok(!(await run(env, ['<VariableThink></VariableThink>'])).text[0].includes('<已执行的更新>'));
});

// ============================ C. 额外模型输出的思考遮蔽 ============================

test('C：额外模型输出按“思考标签”设置遮蔽，总是包括 think、thinking', async () => {
  const env = await story({ settings: { 思考标签: 'think, thinking, thought' } });
  const { extractCommandBlocks } = env.load('utils/message');
  const out = `<thought>举例：${T('Edit', { 地点: '示例' })}</thought>${T('Edit', { 金币: 7 })}`;
  assert.equal(extractCommandBlocks(out).text, T('Edit', { 金币: 7 }));
  assert.equal(
    extractCommandBlocks(`<think>${T('Edit', { a: 1 })}</think>${T('Edit', { b: 1 })}`, []).text.length > 0,
    true,
  );
  // 设置清空时仍遮蔽 think、thinking；丢了开头标签、嵌套、未闭合与正文的规则相同
  env.host.era_data.settings.value.思考标签 = '';
  assert.equal(
    extractCommandBlocks(`<thinking>${T('Edit', { a: 1 })}</thinking>${T('Edit', { b: 1 })}`).text,
    T('Edit', { b: 1 }),
  );
  assert.equal(
    extractCommandBlocks(`想${T('Edit', { a: 1 })}</think>${T('Edit', { b: 1 })}`).text,
    T('Edit', { b: 1 }),
  );
  assert.equal(
    extractCommandBlocks(`${T('Edit', { b: 1 })}<think>没写完${T('Edit', { a: 1 })}`).text,
    T('Edit', { b: 1 }),
  );
  env.host.era_data.settings.value.思考标签 = 'think, thinking, thought';

  const { result } = await run(env, [out]);
  assert.equal(result.status, 'done');
  assert.deepEqual(plain(env.stat()), { 金币: 7, 地点: '城' }, '与同一段文本放进正文的结果相同');
});

// ============================ D. 未闭合的思考标签与 <era_extra> ============================

test('D：正文的思考标签没有闭合时，<era_extra> 仍然生效；旧聊天不变', async () => {
  for (const legacy of [false, true]) {
    const env = await story(
      { legacy },
      `你花了 3 金币。${T('Edit', { 地点: '店' })}<thinking>（被截断的思考${T('Edit', { 地点: '想' })}`,
    );
    assert.equal(env.stat().地点, legacy ? '想' : '店');
    const { result, calls } = await run(env, [T('Edit', { 金币: 7 })]);
    assert.deepEqual(result, { status: 'done', problems: [], warnings: [] });
    assert.equal(calls.length, 1);
    assert.equal(env.stat().金币, 7, legacy ? '旧聊天' : '新聊天');
    assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  }
});

test('D：<era_extra> 里的思考标签字样不影响正文，正文的思考块照样遮蔽', async () => {
  const env = create_env();
  const { maskCommandText, parseCommandText } = env.load('utils/message');
  const options = { thinkTags: ['think', 'thinking'] };
  const body = `正文${T('Edit', { a: 1 })}<think>${T('Edit', { a: 9 })}</think>`;
  const extra = `\n<era_extra>\n${T('Edit', { b: '</think>' })}\n${T('Edit', { c: '<think>' })}\n</era_extra>`;
  const commands = parseCommandText(body + extra, false, [], options, false);
  assert.deepEqual(plain(commands.map(command => command.data[0])), [{ a: 1 }, { b: '</think>' }, { c: '<think>' }]);
  assert.equal(maskCommandText(body + extra, options).length, (body + extra).length);
  // 没有 <era_extra> 时与以前相同；外层标签照样保留 <era_extra>
  assert.equal(maskCommandText(`${T('Edit', { a: 1 })}<think>x`, options), `${T('Edit', { a: 1 })}        `);
  const outer = parseCommandText(
    `<think>没写完${T('Edit', { a: 2 })}${extra}`,
    false,
    [],
    { ...options, outerTag: 'U' },
    false,
  );
  assert.deepEqual(plain(outer.map(command => command.data[0])), [{ b: '</think>' }, { c: '<think>' }]);
});

test('D：只有闭合、并且不在闭合思考块里的 <era_extra> 才是分步更新的区段', () => {
  const env = create_env();
  const { parseCommandText, stripExtraBlock } = env.load('utils/message');
  const options = { thinkTags: ['think', 'thinking'] };
  const parse = (text, parseOptions = options) =>
    plain(parseCommandText(text, false, [], parseOptions, false)).map(({ data, source }) => ({ d: data[0], source }));
  const parseLegacy = text => parse(text, null);
  const real = `\n<era_extra>\n${T('Edit', { b: '</think>' })}\n</era_extra>`;

  // 思考里提到这个标签（没有闭合、闭合），之后的草稿仍然遮蔽；正文的指令不标成额外输出
  assert.deepEqual(parse(`<think>提到 <era_extra> ${T('Edit', { 草稿: 1 })}</think>正文${T('Edit', { a: 1 })}`), [
    { d: { a: 1 }, source: undefined },
  ]);
  assert.deepEqual(
    parse(`<think>例子 <era_extra>${T('Edit', { 草稿: 2 })}</era_extra></think>正文${T('Edit', { a: 1 })}`),
    [{ d: { a: 1 }, source: undefined }],
  );
  // 外层标签同样不因思考里的字样放行
  assert.deepEqual(
    parse(`<think>提到 <era_extra> ${T('Edit', { 草稿: 1 })}</think><U>${T('Edit', { a: 1 })}</U>`, {
      ...options,
      outerTag: 'U',
    }),
    [{ d: { a: 1 }, source: undefined }],
  );
  assert.deepEqual(
    parse(
      `<think>例子 <era_extra>${T('Edit', { 草稿: 2 })}</era_extra></think>${T('Edit', { 外: 1 })}<U>${T('Edit', { a: 1 })}</U>${real}`,
      {
        ...options,
        outerTag: 'U',
      },
    ),
    [
      { d: { a: 1 }, source: undefined },
      { d: { b: '</think>' }, source: 'extra' },
    ],
  );
  // 思考里提到之后再追加真正的块：只认后者，前面没有闭合的字样不与它连成一段
  assert.deepEqual(
    parse(`<think>提到 <era_extra> ${T('Edit', { 草稿: 1 })}</think>正文${T('Edit', { a: 1 })}${real}`),
    [
      { d: { a: 1 }, source: undefined },
      { d: { b: '</think>' }, source: 'extra' },
    ],
  );
  // 正文里没有闭合的字样：之后的指令仍是主模型写的；外层标签之外的指令不因它放行
  assert.deepEqual(parse(`正文 <era_extra> ${T('Edit', { a: 1 })}`), [{ d: { a: 1 }, source: undefined }]);
  assert.deepEqual(parse(`<U>${T('Edit', { a: 1 })}</U> <era_extra> ${T('Edit', { 外: 1 })}`, { outerTag: 'U' }), [
    { d: { a: 1 }, source: undefined },
  ]);
  // 接口丢掉了开头的 <think>：没有开始标签的 </think> 之前都是思考
  assert.deepEqual(
    parse(`例子 <era_extra>${T('Edit', { 草稿: 3 })}</era_extra>想完了</think>正文${T('Edit', { a: 1 })}`),
    [{ d: { a: 1 }, source: undefined }],
  );
  // 主回复被截断（思考没有闭合）时，末尾追加的块照样生效
  assert.deepEqual(parse(`<think>没写完${T('Edit', { 草稿: 4 })}${real}`), [{ d: { b: '</think>' }, source: 'extra' }]);
  // 旧聊天全文匹配，执行结果不变，只有来源标记按同样的规则判断
  assert.deepEqual(parseLegacy(`<think>提到 <era_extra> ${T('Edit', { 草稿: 1 })}</think>正文${T('Edit', { a: 1 })}`), [
    { d: { 草稿: 1 }, source: undefined },
    { d: { a: 1 }, source: undefined },
  ]);
  assert.deepEqual(parseLegacy(`<think>例子 <era_extra>${T('Edit', { 草稿: 2 })}</era_extra></think>${real}`), [
    { d: { 草稿: 2 }, source: undefined },
    { d: { b: '</think>' }, source: 'extra' },
  ]);

  // 去掉 <era_extra> 块时不跨过另一个 <era_extra>；Era.keepMessageKey 同样只补真正的块
  const body = `<think>提到 <era_extra> 标签</think>正文`;
  assert.equal(stripExtraBlock(body + real), body);
  assert.equal(env.Era().keepMessageKey('新正文', body + real), `新正文${real}`);
});

test('D：思考里提到 <era_extra> 时，新聊天仍遮蔽草稿，{{ERA-issues}} 与旧聊天的结果不变', async () => {
  const mentions = [
    `<think>格式里有个 <era_extra> 标签，我别用。草稿${T('Edit', { 金币: 999 })}</think>`,
    `<think>例子 <era_extra>${T('Edit', { 金币: 999 })}</era_extra></think>`,
  ];
  for (const mention of mentions) {
    for (const legacy of [false, true]) {
      const env = create_env({ legacy });
      env.send('assistant', T('Insert', { 金币: 10 }));
      env.send('user', 'x');
      env.send('assistant', `${mention}正文${T('Edit', { 不存在: 1 })}`);
      await env.sync();
      const label = `${legacy ? '旧' : '新'}聊天：${mention}`;
      assert.equal(env.stat().金币, legacy ? 999 : 10, label);
      const issues = env.load('macro/parse').parseEraMacros('{{ERA-issues}}');
      assert.match(issues, /^上一条回复中有 1 处/, label);
      assert.match(issues, /不存在/, label);
      assert.deepEqual(plain(env.stat()), plain(await env.replay()), label);
    }
  }
});

// ============================ E. {{ERA-issues}} 的范围 ============================

test('E：{{ERA-issues}} 不报告额外模型输出与 Era.applyText 的问题，报告里带 source', async () => {
  const env = await story();
  const { parseEraMacros } = env.load('macro/parse');
  const { getLatestReport } = env.load('core/latest_report');
  const issues = () => parseEraMacros('[{{ERA-issues}}]');

  // 额外模型的输出有问题（保留有效部分时仍会写入）
  await run(env, [T('Edit', { 金币: 7, 钱: 1 }), T('Edit', { 金币: 7, 钱: 1 })]);
  assert.equal(env.stat().金币, 7);
  assert.equal(issues(), '[]', '额外模型的问题由它自己的重试处理');
  assert.deepEqual(plain(getLatestReport().issues.map(({ path, origin, source }) => ({ path, origin, source }))), [
    { path: '钱', origin: 'text', source: 'extra' },
  ]);

  // 旁路写入（含 applyText）的问题不是主模型写的
  await env.apply_text(T('Edit', { 前端缺: 1, 金币: 6 }));
  await env.commit([{ edit: { 接口缺: 1 } }]);
  assert.equal(env.stat().金币, 6);
  assert.equal(issues(), '[]');
  const sources = plain(getLatestReport().issues.map(({ path, origin, source }) => ({ path, origin, source })));
  assert.deepEqual(sources, [
    { path: '钱', origin: 'text', source: 'extra' },
    { path: '前端缺', origin: 'text', source: 'apiOps' },
    { path: '接口缺', origin: 'api', source: 'apiOps' },
  ]);

  // 主模型自己写错的仍然报告，包括无法解析的块；额外输出里无法解析的块不报告
  env.chat[2].swipes[0] = env.chat[2].swipes[0].replace(
    '你花了 3 金币。',
    `你花了 3 金币。${T('Edit', { 主模型缺: 1 })}<VariableEdit>{坏</VariableEdit>`,
  );
  env.chat[2].swipes[0] = env.chat[2].swipes[0].replace(
    '</era_extra>',
    '<VariableEdit>{也坏</VariableEdit>\n</era_extra>',
  );
  await env.sync(false, 2);
  const text = issues();
  assert.match(text, /^\[上一条回复中有 2 处/);
  assert.match(text, /指令块无法解析（开头：{坏）/);
  assert.match(text, /主模型缺/);
  assert.ok(!/也坏|钱|前端缺|接口缺/.test(text));
  // 报告是缓存：与从头重放的一致
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  const replayed = env.replay_host().load_src('core/latest_report').getLatestReport();
  assert.deepEqual(plain(replayed.issues), plain(getLatestReport().issues));
});

test('E：下划线只读等规则仍按 origin 判断，source 不改变执行结果', async () => {
  const env = await story({ settings: { 下划线只读: true } }, `你花了 3 金币。${T('Insert', { _只读: 1 })}`);
  await env.apply_text(T('Edit', { _只读: 2 }));
  assert.equal(env.stat()._只读, 1, 'applyText 的写入按正文规则受下划线只读限制');
  await env.write_extra(env.mk(2), T('Edit', { _只读: 3 }));
  assert.equal(env.stat()._只读, 1, '额外模型的输出同样受限制');
  await env.commit([{ edit: { _只读: 4 } }]);
  assert.equal(env.stat()._只读, 4, 'Era.commit 不受限制');
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
});

test('E：分步更新提示词里的 {{ERA-issues}} 展开为空', async () => {
  const env = await story({ entries: [entry('[era_update]规则', '规则内容\n问题：[{{ERA-issues}}]')] });
  env.send('user', '再来');
  env.send('assistant', `剧情${T('Edit', { 不存在: 1 })}`);
  await env.sync();
  const { parseEraMacros } = env.load('macro/parse');
  assert.match(parseEraMacros('{{ERA-issues}}'), /不存在/);
  assert.equal(parseEraMacros('[{{ERA-issues}}]', null, null, { issues: false }), '[]');
  const { text } = await run(env, ['<VariableThink>无变化</VariableThink>'], {}, 2);
  assert.ok(text[0].includes('问题：[]'), text[0]);
});

// ============================ F. /era-issues 与 {{ERA-issues}} 共用报告 ============================

test('F：/era-issues 先读同步时的报告，没有报告时重算；format=model 与宏相同', async () => {
  const env = await story();
  const commands = env.load('ui/commands');
  const latest = env.load('core/latest_report');
  const { parseEraMacros } = env.load('macro/parse');
  await run(env, [T('Edit', { 金币: 7, 钱: 1 }), T('Edit', { 金币: 7, 钱: 1 })]);
  env.chat[2].swipes[0] = env.chat[2].swipes[0].replace(
    '你花了 3 金币。',
    `你花了 3 金币。${T('Edit', { 主模型缺: 1 })}`,
  );
  await env.sync(false, 2);
  await env.apply_text(T('Edit', { 前端缺: 1 }));

  const json = JSON.parse(await commands.eraIssues({ format: 'json' }));
  assert.deepEqual(
    json.problems.map(({ path, source }) => [path, source]),
    [
      ['主模型缺', undefined],
      ['钱', 'extra'],
      ['前端缺', 'apiOps'],
    ],
  );
  assert.equal(json.mk, env.mk(2));
  const text = await commands.eraIssues({});
  assert.equal(text.split('\n').length, 3);
  const model = await commands.eraIssues({ format: 'model' });
  assert.equal(model, parseEraMacros('{{ERA-issues}}'));
  assert.match(model, /主模型缺/);
  assert.ok(!/钱|前端缺/.test(model));

  // 刷新页面后报告丢失：/era-issues 重算出相同的结果，宏按没有问题处理
  latest.clearFloorReports();
  assert.equal(parseEraMacros('[{{ERA-issues}}]'), '[]');
  assert.deepEqual(JSON.parse(await commands.eraIssues({ format: 'json' })), json);
  assert.equal(await commands.eraIssues({ format: 'model' }), model);
  assert.equal(env.stat().金币, 7, '读取问题不改变变量');
});

// ============================ G. keepMessageKey 保留 <era_extra> ============================

test('G：Era.keepMessageKey 同时保留 <era_extra>，不重复；完全重算后分步更新写入的变量仍在', async () => {
  const env = await story();
  await run(env, [T('Edit', { 金币: 7 })]);
  assert.equal(env.stat().金币, 7);
  const Era = env.Era();
  const raw = env.chat[2].swipes[0];
  const next = Era.keepMessageKey('你花了 3 金币。（前端改写后的正文）', raw);
  assert.match(next, /<era_data>/);
  assert.equal((next.match(/<era_extra>/g) ?? []).length, 1);
  assert.equal(Era.keepMessageKey(next, raw), next, '两种块都已经有时原样返回');
  assert.equal(
    Era.keepMessageKey('新正文', 2),
    next.replace('你花了 3 金币。（前端改写后的正文）', '新正文'),
    '按消息 ID 取原文',
  );
  const own = Era.keepMessageKey(`新正文\n<era_extra>\n${T('Edit', { 金币: 8 })}\n</era_extra>`, raw);
  assert.equal((own.match(/<era_extra>/g) ?? []).length, 1, '新文本已有 <era_extra> 时不再补');
  assert.match(own, /<era_data>/);
  env.chat[2].swipes[0] = next;
  await env.sync(true);
  assert.equal(env.stat().金币, 7);
  assert.equal(Era.keepMessageKey('x', '没有块的旧正文'), 'x');
});

// ============================ H. 分步更新提示词去掉占位符 ============================

test('H：分步更新的提示词去掉 AI 消息里的状态栏占位符，规则与主生成相同', async () => {
  const env = create_env();
  env.send('assistant', `开场${T('Insert', { 金币: 10 })}\n<StatusPlaceHolderImpl/>`);
  env.send('user', '用户自己写的 <StatusPlaceHolderImpl/>');
  env.send('assistant', '你花了 3 金币。\n<StatusPlaceHolderImpl/>');
  await env.sync();
  const { text } = await run(env, [T('Edit', { 金币: 7 })], { 聊天楼层数: 3 });
  assert.equal((text[0].match(/StatusPlaceHolderImpl/g) ?? []).length, 1, '只剩用户消息里的');
  assert.ok(text[0].includes('你花了 3 金币。\n</最新剧情>'));

  const { stripStatusPlaceholderText } = env.load('macro/placeholder');
  assert.equal(stripStatusPlaceholderText('a\n[状态]', '[状态]', true), 'a');
  assert.equal(stripStatusPlaceholderText('a\n[状态]', '[状态]', false), 'a\n[状态]', '功能关闭时自定义值不处理');
  assert.equal(stripStatusPlaceholderText('a <statusplaceholderimpl/>', '<StatusPlaceHolderImpl/>', false), 'a');
  assert.equal(stripStatusPlaceholderText('a \n b', ' '), 'a \n b');
});

// ============================ I. Era.features ============================

test('I：Era 上的每个函数成员都在 Era.features 中登记（或在豁免名单里）', () => {
  const env = create_env();
  const Era = env.Era();
  // 一个功能对应几个函数成员
  const ALIASES = {
    unregisterSchema: 'registerSchema',
    hasSchema: 'registerSchema',
    onBeforeApply: 'hooks',
    onAfterApply: 'hooks',
    hasHook: 'hooks',
    registerEntryFilter: 'entryFilter',
    hasEntryFilter: 'entryFilter',
    registerTool: 'tools',
    hasTool: 'tools',
    registerExprFn: 'exprFns',
    hasExprFn: 'exprFns',
  };
  // 1.6 及更早就有的成员，不需要能力检测
  const EXEMPT = ['describeSchema', 'getCurrentVars'];
  for (const [name, value] of Object.entries(Era)) {
    if (name === 'features' || EXEMPT.includes(name)) continue;
    if (typeof value !== 'function' && !(value && typeof value === 'object')) continue;
    assert.ok(Era.features.includes(ALIASES[name] ?? name), `Era.${name} 没有对应的 feature`);
  }
  for (const name of [
    'keepMessageKey',
    'entryFilter',
    'ejs',
    'checkSchema',
    'schemaInvalid',
    'issuesMacro',
    'reentryGuard',
    'slashCommands',
  ]) {
    assert.ok(Era.features.includes(name), name);
  }
  assert.equal(new Set(Era.features).size, Era.features.length);
});

// ============================ J. 条目过滤器的重入保护 ============================

test('J：条目过滤器里调用写入接口被拒绝，忽略它的结果并记入 warnings', async () => {
  const env = await story({
    entries: [entry('[era_update]规则', '规则内容'), entry('[era_update]关', '关闭的', { enabled: false })],
  });
  const Era = env.Era();
  const reentry = env.load('core/reentry');
  const seen = [];
  let calls = 0;
  Era.registerEntryFilter('坏过滤器', (item, ctx) => {
    seen.push(reentry.isGuarded());
    // 没有保护时 Era.extra.run 会无限重启；限制次数，回归时测试失败而不是卡住
    if (++calls > 10) return undefined;
    Era.commit({ edit: { 金币: '-=1' } }, { mk: ctx.mk }).catch(error => seen.push(error.name));
    Era.extra.run(ctx.mk).catch(error => seen.push(error.name));
    return true; // 被忽略：否则会纳入关闭的条目
  });
  const { result, text } = await run(env, [T('Edit', { 金币: 7 })]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(result.status, 'done');
  assert.equal(calls, 2, '每个条目调用一次，没有重启');
  assert.ok(seen.includes(true) && !seen.includes(false), '过滤器在保护下调用');
  assert.ok(seen.filter(item => item === 'ReentryError').length >= 2);
  assert.ok(result.warnings.some(line => line.includes('坏过滤器') && line.includes('Era.commit')));
  assert.ok(!text[0].includes('关闭的'), '违规的过滤器的结果被忽略');
  assert.equal(env.meta().ApiOps, undefined, '没有写入旁路写入');
  assert.equal(env.stat().金币, 7);
});

// ============================ K. atomic 预检与写入的压缩一致 ============================

test('K：atomic 提交含 $expr 时，预检与落盘的骰点一致，不会部分写入', async () => {
  let rejected = 0;
  for (let i = 0; i < 24; i++) {
    const env = create_env();
    env.send('assistant', T('Insert', { hp: 0, mp: 0 }));
    await env.sync();
    await env.apply_text(T('Edit', { hp: 5 }));
    const text = T('Edit', { hp: 7 }) + T('Edit', { mp: { $expr: 'log(roll(0, 1)) + 5' } });
    let ok = true;
    try {
      await env.apply_text(text, { atomic: true });
    } catch (error) {
      ok = false;
      rejected++;
      assert.match(error.message, /放弃/);
    }
    const stat = plain(env.stat());
    assert.deepEqual(stat, ok ? { hp: 7, mp: 5 } : { hp: 5, mp: 0 }, `第 ${i} 次：${ok ? '通过' : '放弃'}`);
  }
  assert.ok(rejected > 0 && rejected < 24, '两种情况都应当出现');

  // 整楼试算的 compact 参数与 appendApiOp 一致
  const env = create_env();
  env.send('assistant', T('Insert', { hp: 0, mp: 0 }));
  await env.sync();
  await env.push_text(0, T('Edit', { hp: 5 }));
  await env.sync();
  const text = T('Edit', { hp: 7 }) + T('Edit', { mp: { $expr: 'roll(1, 1000000)' } });
  const { createFloorSimulator } = env.load('core/simulate');
  const after = env.load('utils/message').countCommandBlocks({ message_id: 0, ...env.chat[0] });
  const parse = env.load('core/version').getParseOptions(env.meta());
  const { ops } = env.host.api_ops.createTextApiOps(text, after, false, parse);
  const simulator = await createFloorSimulator({ message_id: 0, ...env.chat[0] });
  const compacted = await simulator.run({ ops, compact: true });
  await env.push_text(0, text, true);
  await env.sync();
  assert.equal(compacted.stat.mp, env.stat().mp);
});

// ============================ L. 内置更新条目 ============================

test('L：“ERA 表达式规则”视为内置的更新条目，只发给更新模型', async () => {
  const env = await story({ entries: [entry('ERA 表达式规则', '表达式写法'), entry('普通设定', '剧情设定')] });
  const { parseEntryTag } = env.load('extra/prompt');
  const { ERA_EXPR_RULE_ENTRY_NAME } = env.load('initer/manual/worldbook_entries/era_expr_rule');
  assert.equal(parseEntryTag(ERA_EXPR_RULE_ENTRY_NAME).update, true);
  assert.equal(parseEntryTag(` ${ERA_EXPR_RULE_ENTRY_NAME} `).update, true);
  const { text } = await run(env, ['<VariableThink>无变化</VariableThink>']);
  assert.ok(text[0].includes('表达式写法') && !text[0].includes('剧情设定'));
});

// ============================ M. seedMk 的含义 ============================

test('M：seedMk 的骰点与文本出现在该楼正文里相同，与 applyText 的旁路写入不同；预览旁路写入用 atomic', async () => {
  const text = T('Edit', { mp: { $expr: 'roll(1, 1000000)' } });
  const env = create_env();
  env.send('assistant', T('Insert', { mp: 0 }));
  env.send('assistant', '剧情');
  await env.sync();
  const Era = env.Era();
  // 在第 0 楼之后的状态上，按第 1 楼的 MK 取种子
  const preview = await Era.simulate(text, env.mk(0), { seedMk: env.mk(1) });

  // 同一段文本放进第 1 楼的正文：骰点相同
  const original = env.chat[1].swipes[0];
  env.chat[1].swipes[0] = original.replace('剧情', `剧情${text}`);
  await env.sync(false, 1);
  assert.equal(env.stat().mp, preview.stat.mp);
  env.chat[1].swipes[0] = original;
  await env.sync(false, 1);
  assert.equal(env.stat().mp, 0);

  // applyText 的旁路写入按写入序号取种子，骰点与预览不同（相同的概率是百万分之一）
  await env.apply_text(text, { mk: env.mk(1), atomic: true });
  assert.notEqual(env.stat().mp, preview.stat.mp);
  const docs = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '开发工具', 'exported.era.d.ts'),
    'utf8',
  );
  assert.match(docs, /要预览旁路写入请用 `atomic: true` 提交/);
});

// ============================ Era.setMessageText ============================

test('setMessageText：改写正文后按新正文重算，保留 MK 与额外模型的输出，旁路写入不丢', async () => {
  const env = await story();
  const { handleWriteExtra } = env.load('events/handlers/api/extra_write');
  const tickets = env.load('events/handlers/api/tickets');
  const rewrite = async (mk, body) => {
    const { ticket, promise } = tickets.createTicket(5000);
    promise.catch(() => {});
    await handleWriteExtra({ mk, blocks: '', body }, ticket);
    await env.sync();
    return promise;
  };
  await env.write_extra(env.mk(2), T('Edit', { 金币: 7 }));
  await env.commit([{ edit: { 地点: '港口' } }], { mk: env.mk(2) });
  assert.equal(env.stat().金币, 7);
  const mk = env.mk(2);

  // 只换显示的文字：变量不变，MK 和 <era_extra> 都还在
  const result = await rewrite(mk, '新的正文');
  assert.equal(result.mk, mk);
  assert.equal(env.mk(2), mk);
  assert.match(env.chat[2].swipes[0], /^新的正文\n<era_data>[\s\S]*<era_extra>/);
  assert.deepEqual(plain(env.stat()), { 金币: 7, 地点: '港口' });

  // 新正文带了指令：按新正文重算（正文指令在前，额外模型的输出在后）
  await rewrite(mk, `再改一次${T('Insert', { 新键: 1 })}`);
  assert.deepEqual(plain(env.stat()), { 金币: 7, 地点: '港口', 新键: 1 });
  assert.deepEqual(plain(await env.replay()), plain(env.stat()));

  const { keepEraBlocks } = env.load('utils/message');
  assert.equal(keepEraBlocks('x', 'y'), 'x');
  assert.equal(keepEraBlocks('x<era_data>{}</era_data>', 'y<era_data>{"a"=1}</era_data>'), 'x<era_data>{}</era_data>');
});

test('setMessageText：钩子里调用被拒绝；楼层不存在或没有 MK 时失败', async () => {
  const env = await story();
  const Era = env.Era();
  await assert.rejects(Era.setMessageText(99, 'x'), /目标消息不存在/);
  await assert.rejects(Era.setMessageText({}, 'x'), /需要指定楼层/);
  await assert.rejects(Era.setMessageText(0, 123), /text 必须是字符串/);
  const reentry = env.load('core/reentry');
  assert.ok(reentry.GUARDED_ENTRIES.includes('Era.setMessageText'));
});
