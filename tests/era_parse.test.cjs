/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：测试 1.7 的版本标识（Era.version、Era.features、解析版本与写入版本标记、ERA最低版本）、
 *       新聊天不执行思考块里的指令与指令外层标签、Era.parseCommands / Era.applyText / Era.keepMessageKey
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 运行方式: node --test tests/era_parse.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create_chat, plain } = require('./chat.cjs');

const T = (tag, value) => `<Variable${tag}>${JSON.stringify(value)}</Variable${tag}>`;
const THINK = ['think', 'thinking'];

/** 带有事件监听、定时器、全局接口的假聊天（与 era_api.test.cjs 相同）。 */
function create_env(options = {}) {
  const toasts = [];
  const env = create_chat({
    ...options,
    globals: {
      eventOn: () => ({ stop() {} }),
      toastr: {
        warning: (...args) => toasts.push(['warning', ...args]),
        error: (...args) => toasts.push(['error', ...args]),
      },
      setTimeout,
      clearTimeout,
      $: () => {},
      initializeGlobal: () => {},
      ...options.globals,
    },
  });
  const load = env.host.load_src;
  const handler = load('events/handlers/api/handler');
  const tickets = load('events/handlers/api/tickets');
  return {
    ...env,
    load,
    handler,
    tickets,
    toasts,
    message: () => load('utils/message'),
    version: () => load('core/version'),
    Era: () => load('api/global').Era,
    mk: i => env.host.mk.readMessageKey({ message_id: i, ...env.chat[i] }),
    msg: i => ({ message_id: i, ...env.chat[i] }),
    /** 与 Era.applyText 相同：经 commit 处理器提交文本，同步后结算。 */
    apply_text: async (text, detail = {}) => {
      const { ticket, promise } = tickets.createTicket(5000);
      promise.catch(() => {});
      await handler.commit({ ...detail, text }, ticket);
      await env.sync();
      tickets.settleTickets();
      return promise;
    },
    commit: async (operations, detail = {}) => {
      const { ticket, promise } = tickets.createTicket(5000);
      promise.catch(() => {});
      await handler.commit({ ...detail, operations }, ticket);
      await env.sync();
      tickets.settleTickets();
      return promise;
    },
  };
}

// ============================ 遮蔽 ============================

test('maskCommandText：等长遮蔽思考块，保留换行；嵌套、大小写、属性、未闭合、丢了开头标签', () => {
  const { maskCommandText } = create_env().message();
  const mask = (text, thinkTags = THINK, outerTag) => maskCommandText(text, { thinkTags, outerTag });
  const blank = text => text.replace(/[^\n\r]/g, ' ');

  assert.equal(maskCommandText('<think>x</think>'), '<think>x</think>', '没有解析方式时原样返回');
  assert.equal(mask('<think>x</think>', []), '<think>x</think>');
  const text = 'a<think>x\ny</think>b';
  assert.equal(mask(text), `a${blank('<think>x\ny</think>')}b`);
  assert.equal(mask(text).length, text.length);
  const nested = '前<THINK>外<thinking>内</thinking>仍是思考</THINK>后';
  assert.equal(mask(nested), `前${blank(nested.slice(1, -1))}后`);
  assert.equal(mask('<think type="x">想</think>正文'), `${blank('<think type="x">想</think>')}正文`);
  assert.equal(mask('<thinker>不是思考</thinker>'), '<thinker>不是思考</thinker>', '只匹配完整的标签名');
  assert.equal(mask('正文<think>没写完'), `正文${blank('<think>没写完')}`, '没有闭合时遮蔽到结尾');
  assert.equal(mask('想法</think>正文'), `${blank('想法</think>')}正文`, '丢了开头标签');
  assert.equal(
    mask('a<think>x</thinking>y</think>b'),
    `a${blank('<think>x</thinking>y</think>')}b`,
    '不匹配的闭合标签忽略',
  );
  assert.equal(mask('<r.e>想</r.e>正文', ['r.e']), `${blank('<r.e>想</r.e>')}正文`, '标签名中的特殊字符按字面匹配');
});

test('maskCommandText：指令外层标签只保留标签内部和 <era_extra>，思考块里的外层标签不算', () => {
  const { maskCommandText } = create_env().message();
  const mask = text => maskCommandText(text, { thinkTags: THINK, outerTag: 'ERA_Update' });
  const kept = text => mask(text).replace(/ +/g, ' ').trim();
  assert.equal(kept('外面<ERA_Update>里面</ERA_Update>外面'), '<ERA_Update>里面</ERA_Update>');
  assert.equal(kept('外<era_extra>额外</era_extra>外'), '<era_extra>额外</era_extra>');
  assert.equal(kept('外<ERA_Update>被截断'), '<ERA_Update>被截断', '没有闭合时到结尾');
  assert.equal(kept('<think><ERA_Update>示例</ERA_Update></think>正文'), '', '思考块里的外层标签不算');
  assert.equal(kept('<era_update a="1">x</ERA_UPDATE>'), '<era_update a="1">x</ERA_UPDATE>', '不区分大小写');
});

test('parseCommandText：遮蔽后的块序号仍按原文计数；不转义时得到原样数据', () => {
  const { parseCommandText } = create_env().message();
  const text = `${T('Edit', { a: 1 })}<think>${T('Edit', { a: 99 })}</think>${T('Edit', { 'b.c': 2 })}`;
  const legacy = plain(parseCommandText(text));
  assert.deepEqual(
    legacy.map(c => c.block),
    [0, 1, 2],
  );
  const masked = plain(parseCommandText(text, false, [], { thinkTags: THINK }));
  assert.deepEqual(
    masked.map(c => c.block),
    [0, 2],
  );
  assert.deepEqual(masked[0].data, [{ a: 1 }]);
  const raw = plain(parseCommandText(text, false, [], { thinkTags: THINK }, false));
  assert.deepEqual(raw[1].data, [{ 'b.c': 2 }], '不转义');
  assert.notDeepEqual(masked[1].data, raw[1].data, '默认转义键中的点');
});

// ============================ 解析版本 ============================

test('解析版本：空元数据是新聊天；有元数据没有标记是旧聊天；标记比当前新时按当前最新的方式', () => {
  const { getParserVersion, getParseOptions, splitTagList, normalizeTagName } = create_env().version();
  assert.equal(getParserVersion({}), 2);
  assert.equal(getParserVersion(undefined), 2);
  assert.equal(getParserVersion({ EditLogs: {} }), 1);
  assert.equal(getParserVersion({ SelectedMks: [], ParserVersion: 'x' }), 1);
  assert.equal(getParserVersion({ ParserVersion: 2 }), 2);
  assert.equal(getParserVersion({ ParserVersion: 9 }), 2);
  assert.equal(getParseOptions({ EditLogs: {} }), undefined);
  assert.deepEqual(plain(getParseOptions({ ParserVersion: 2 })), { thinkTags: THINK });
  assert.deepEqual(plain(splitTagList(' <think>, thinking，reasoning;  ')), ['think', 'thinking', 'reasoning']);
  assert.equal(normalizeTagName('</ERA_Update>'), 'ERA_Update');
  assert.equal(normalizeTagName('a b'), '');
  assert.equal(normalizeTagName(''), '');
});

test('新聊天：第一次写入时记下解析版本与写入版本；思考块里的指令不执行，完全重算结果不变', async () => {
  const env = create_env();
  const { ERA_VERSION } = env.load('utils/constants');
  env.send('assistant', `<think>${T('Insert', { 思考: 1 })}</think>${T('Insert', { a: 1 })}`);
  await env.sync();
  assert.equal(env.meta().ParserVersion, 2);
  assert.equal(env.meta().WrittenWith, ERA_VERSION);
  assert.deepEqual(plain(env.stat()), { a: 1 });
  env.send(
    'assistant',
    `<thinking>${T('Edit', { a: 50 })}</thinking>正文${T('Edit', { a: 2 })}<think>没写完${T('Edit', { a: 60 })}`,
  );
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: 2 });
  await env.sync(true);
  assert.deepEqual(plain(env.stat()), { a: 2 });
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
});

test('旧聊天（1.6 建立，没有解析版本标记）：思考块和外层标签外的指令照旧执行，不会被升级', async () => {
  const env = create_env({ legacy: true, settings: { 指令外层标签: 'ERA_Update' } });
  env.send('assistant', `<think>${T('Insert', { 思考: 1 })}</think>${T('Insert', { 外: 1 })}`);
  await env.sync();
  await env.sync(true);
  assert.deepEqual(plain(env.stat()), { 思考: 1, 外: 1 });
  assert.equal(env.meta().ParserVersion, undefined);
  assert.equal(typeof env.meta().WrittenWith, 'string');
});

test('先登记 MK（MESSAGE_SENT）再同步的新聊天同样记下解析版本', async () => {
  const env = create_env();
  env.send('user', '你好');
  await env.register_only();
  assert.equal(env.meta().ParserVersion, 2);
  env.send('assistant', `<think>${T('Insert', { 思考: 1 })}</think>${T('Insert', { a: 1 })}`);
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: 1 });
});

test('新聊天的指令外层标签：只认标签内和 <era_extra> 中的指令；API 写入追加到正文时包在外层标签里', async () => {
  const env = create_env({ settings: { 指令外层标签: '<ERA_Update>' } });
  env.send(
    'assistant',
    `${T('Insert', { 外: 1 })}<ERA_Update>${T('Insert', { a: { x: 1 } })}</ERA_Update><era_extra>${T('Insert', { e: 1 })}</era_extra>`,
  );
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: { x: 1 }, e: 1 });
  await env.handler.updateByPath('a.x', 5);
  assert.match(env.chat[0].swipes[0], /<ERA_Update>\n<VariableEdit>[\s\S]*<\/VariableEdit>\n<\/ERA_Update>$/);
  await env.sync();
  assert.equal(env.stat().a.x, 5);
});

test('hasOwnCommands：新聊天中只有思考块里有指令时不算有指令', async () => {
  const env = create_env();
  const { hasOwnCommands } = env.message();
  const msg = { message_id: 0, role: 'assistant', mes: `<think>${T('Edit', { a: 1 })}</think>正文` };
  assert.equal(hasOwnCommands(msg), false, '元数据为空：按新聊天');
  assert.equal(hasOwnCommands(msg, {}), true, '不遮蔽');
  assert.equal(hasOwnCommands({ ...msg, mes: `${msg.mes}${T('Edit', { a: 1 })}` }), true);
});

// ============================ 旁路写入的块定位 ============================

test('旁路写入的块定位：按原文计数，遮蔽与否、改了思考标签设置都不错位', async () => {
  const env = create_env();
  const { interleaveApiOps } = env.host.api_ops;
  const { extractAndParseCommands } = env.message();
  const text = `${T('Edit', { t: 0 })}<think>${T('Edit', { t: 1 })}</think>${T('Edit', { t: 2 })}`;
  const msg = { message_id: 0, role: 'assistant', mes: text };
  const record = { rev: 1, applied: 0, ops: [{ type: 'edit', data: { o: 1 }, after: 2, by: 'block' }] };
  const order = options =>
    plain(interleaveApiOps(extractAndParseCommands(msg, false, [], options), record)).map(c =>
      Object.entries(c.data[0])[0].join(''),
    );
  assert.deepEqual(order(undefined), ['t0', 't1', 'o1', 't2']);
  assert.deepEqual(order({ thinkTags: THINK }), ['t0', 'o1', 't2']);
  assert.deepEqual(order({ thinkTags: [] }), ['t0', 't1', 'o1', 't2']);
});

test('旁路写入的块定位：新旧聊天中“写入后又追加指令”都排在写入时已有的指令之后', async () => {
  for (const legacy of [false, true]) {
    const env = create_env({ legacy });
    env.send('assistant', `${T('Insert', { a: 0 })}<think>${T('Edit', { a: 9 })}</think>`);
    await env.sync();
    await env.push_op(0, { type: 'edit', data: { a: 1 } });
    await env.sync();
    env.chat[0].swipes[0] += T('Edit', { a: 2 }); // “继续”追加的指令
    await env.sync(false, 0);
    assert.equal(env.stat().a, 2, legacy ? '旧聊天' : '新聊天');
    assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  }
});

// ============================ Era.parseCommands / Era.applyText ============================

test('Era.version / Era.features：与常量一致，features 只读', () => {
  const env = create_env();
  const Era = env.Era();
  const { ERA_VERSION } = env.load('utils/constants');
  assert.equal(Era.version, ERA_VERSION);
  for (const name of ['applyText', 'parseCommands', 'maskThinking', 'outerTag', 'version']) {
    assert.ok(Era.features.includes(name), name);
  }
  assert.throws(() => Era.features.push('x'));
});

test('Era.parseCommands：展开宏、数据不转义；新聊天中思考块里的不算；报告无法解析的块', () => {
  const env = create_env();
  const Era = env.Era();
  const text = `<think>${T('Edit', { 思考: 1 })}</think>${T('Edit', { '带.点': '{{user}}' })}<VariablePatch>[{"op":"insert","path":"/l/-","value":1}]</VariablePatch><VariableInsert>{坏了</VariableInsert>`;
  const result = plain(Era.parseCommands(text));
  assert.deepEqual(result.commands, [
    { type: 'edit', data: [{ '带.点': 'User' }] },
    { type: 'patch', data: [{ op: 'insert', path: '/l/-', value: 1 }] },
  ]);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].reason, /VariableInsert/);
  env.variables().ERAMetaData = { EditLogs: {} }; // 旧聊天
  assert.equal(Era.parseCommands(text).commands.length, 3);
});

test('Era.applyText：作为 origin: text 的旁路写入执行，不改正文，按正文规则受下划线只读限制', async () => {
  const env = create_env({ settings: { 下划线只读: true } });
  env.send('assistant', T('Insert', { _x: 1, a: 1, list: [] }));
  await env.sync();
  const text = env.chat[0].swipes[0];

  const result = await env.apply_text(`<think>${T('Edit', { a: 99 })}</think>好的${T('Edit', { a: 2, _x: 5 })}`);
  assert.equal(env.chat[0].swipes[0], text, '正文不变');
  assert.deepEqual(plain(result.statWithoutMeta), { _x: 1, a: 2, list: [] }, '下划线只读拒绝了 _x，思考块里的不执行');
  const ops = env.meta().ApiOps[env.mk(0)].ops;
  assert.deepEqual(plain(ops), [{ type: 'edit', data: [{ a: 2, _x: 5 }], after: 1, by: 'block', origin: 'text' }]);

  await env.commit({ edit: { _x: 7 } });
  assert.equal(env.stat()._x, 7, 'Era.commit 是旁路写入，不受限制');
  await env.sync(true);
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  assert.equal(env.stat()._x, 7);
  assert.equal(env.stat().a, 2);
});

test('Era.applyText：没有指令时失败；atomic 时有无法解析的块或不能生效的指令都全部放弃', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  await assert.rejects(env.apply_text('没有指令'), /没有可以执行的指令/);
  await assert.rejects(env.apply_text(`<think>${T('Edit', { a: 2 })}</think>`), /没有可以执行的指令/);
  await assert.rejects(env.apply_text('<VariableEdit>{坏了</VariableEdit>'), /无法解析/);
  await assert.rejects(
    env.apply_text(`${T('Edit', { a: 2 })}<VariableEdit>{坏了</VariableEdit>`, { atomic: true }),
    /提交被放弃/,
  );
  await assert.rejects(env.apply_text(T('Edit', { 不存在: 2 }), { atomic: true }), /提交被放弃/);
  assert.equal(env.meta().ApiOps, undefined);
  assert.equal(env.stat().a, 1);
  await env.apply_text(`${T('Edit', { a: 2 })}<VariableEdit>{坏了</VariableEdit>`);
  assert.equal(env.stat().a, 2, '不要求原子时执行能解析的部分');
  await assert.rejects(env.Era().applyText(123), /text 必须是字符串/);
});

test('appendApiOp：不同来源的写入不合并、不压缩；从文本解析的写入涉及 _ 开头的键时不压缩', () => {
  const { appendApiOp } = create_chat().host.api_ops;
  const run = list => plain(list.reduce((record, op) => appendApiOp(record, op, true), undefined)).ops;
  const api = data => ({ type: 'edit', data, after: 0, by: 'block' });
  const text = data => ({ ...api([data]), origin: 'text' });
  assert.equal(run([api({ a: 1 }), text({ a: 1 })]).length, 2, '来源不同不合并重复');
  assert.equal(run([api({ a: 1 }), text({ a: 2 })]).length, 2, '来源不同不压缩');
  assert.equal(run([text({ a: 1 }), api({ b: 1 }), text({ a: 2 })]).length, 3, '不跨过另一种来源');
  assert.deepEqual(run([text({ a: 1 }), text({ a: 2 })]), [text({ a: 2 })], '同为文本时照常压缩');
  assert.equal(run([text({ a: '+=1' }), text({ a: '+=1' })])[0].n, 2, '同为文本时合并重复');
  assert.equal(run([text({ _a: 1 }), text({ _a: 2 })]).length, 2, '_ 开头的键不压缩');
  assert.equal(run([text({ a: { _b: 1 } }), text({ a: { _b: 2 } })]).length, 2);
});

// ============================ 第 0 楼的 MK ============================

test('回归：同层前端改写第 0 楼时丢了 MK，下次完全同步会把整局的旁路写入当作孤儿清除', async () => {
  const env = create_env();
  env.send('assistant', `开场${T('Insert', { 回合: 0 })}`);
  await env.sync();
  for (let i = 1; i <= 3; i++) await env.push_op(0, { type: 'edit', data: { 回合: i } });
  await env.sync();
  assert.equal(env.stat().回合, 3);

  env.chat[0].swipes[0] = `前端改写了正文${T('Insert', { 回合: 0 })}`; // 没有保留 <era_data>
  await env.sync(true);
  await env.host.api_ops.pruneApiOps();
  await env.sync(true);
  assert.equal(env.meta().ApiOps, undefined, '旁路写入全部丢失');
  assert.equal(env.stat().回合, 0);
});

test('Era.keepMessageKey：改写正文时保留 MK，旁路写入不再丢失', async () => {
  const env = create_env();
  const Era = env.Era();
  env.send('assistant', `开场${T('Insert', { 回合: 0 })}`);
  await env.sync();
  await env.push_op(0, { type: 'edit', data: { 回合: 3 } });
  await env.sync();
  const old_text = env.chat[0].swipes[0];
  const mk = env.mk(0);

  assert.equal(Era.keepMessageKey('新正文', '没有 MK 的旧正文'), '新正文');
  assert.equal(Era.keepMessageKey(old_text, '无关'), old_text, '已经有 MK 时原样返回');
  const by_id = Era.keepMessageKey(`新正文${T('Insert', { 回合: 0 })}`, 0);
  assert.equal(by_id, Era.keepMessageKey(`新正文${T('Insert', { 回合: 0 })}`, old_text));
  env.chat[0].swipes[0] = by_id;
  assert.equal(env.mk(0), mk);
  await env.sync(true);
  await env.host.api_ops.pruneApiOps();
  await env.sync(true);
  assert.equal(env.stat().回合, 3);
});

// ============================ 试算 ============================

test('Era.simulate：按当前聊天的解析版本试算', async () => {
  for (const legacy of [false, true]) {
    const env = create_env({ legacy });
    env.send('assistant', T('Insert', { a: 1 }));
    await env.sync();
    const { stat } = await env.Era().simulate(`<think>${T('Edit', { a: 9 })}</think>`);
    assert.equal(stat.a, legacy ? 9 : 1, legacy ? '旧聊天' : '新聊天');
  }
});

// ============================ 版本 ============================

test('compareVersions / isVersionAtLeast', () => {
  const { compareVersions, isVersionAtLeast } = create_env().version();
  assert.equal(compareVersions('1.7', '1.7.0'), 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('v1.6.0-beta.1', '1.7') < 0);
  assert.ok(Number.isNaN(compareVersions('最新', '1.7')));
  assert.equal(isVersionAtLeast('1.7', '1.7.0'), true);
  assert.equal(isVersionAtLeast('1.8', '1.7.9'), false);
  assert.equal(isVersionAtLeast('乱写', '1.7.0'), false);
});

test('ERA最低版本：高于当前版本时提示一次；没有声明、无法识别或没有打开角色卡时不提示', () => {
  const env = create_env();
  const { checkCardRequirement } = env.version();
  assert.equal(checkCardRequirement(), null);
  env.others.character = { ERA最低版本: '1.0' };
  assert.equal(checkCardRequirement(), '1.0');
  env.others.character = { ERA最低版本: '乱写' };
  assert.equal(checkCardRequirement(), null);
  assert.equal(env.toasts.length, 0);
  env.others.character = { ERA最低版本: '99.0' };
  assert.equal(checkCardRequirement(), '99.0');
  checkCardRequirement();
  assert.equal(env.toasts.length, 1);
  assert.match(env.toasts[0][1], /99\.0/);

  const broken = create_env({
    globals: {
      getVariables: () => {
        throw new Error('没有角色卡');
      },
    },
  });
  assert.equal(broken.version().checkCardRequirement(), null);
});

test('由更新的 ERA 写入过的聊天：同步时提示一次，不阻止同步', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  env.variables().ERAMetaData = { WrittenWith: '99.0.0', ParserVersion: 2 };
  await env.sync();
  await env.sync();
  assert.equal(env.toasts.filter(([, message]) => /更新的 ERA/.test(message)).length, 1);
  assert.equal(env.stat().a, 1);
});

// ============================ 设置 ============================

test('设置：新增“思考标签”“指令外层标签”的默认值；保存时保留不认识的设置项', async () => {
  const env = create_env();
  const { era_data } = env.host;
  assert.equal(era_data.settings.value.思考标签, 'think, thinking');
  assert.equal(era_data.settings.value.指令外层标签, '');
  env.others.script = { 未来的设置: { x: 1 }, 宽松解析: false };
  era_data.initEraSettings();
  await era_data.updateScriptSettings(current => ({ ...current, 繁体转简体: true }));
  assert.deepEqual(env.others.script.未来的设置, { x: 1 });
  assert.equal(env.others.script.繁体转简体, true);
  assert.equal(env.others.script.宽松解析, false);
});

test('额外模型设置：保留不认识的字段（含接口里的）', () => {
  const { ExtraConfigSchema } = create_env().load('extra/config');
  const parsed = plain(ExtraConfigSchema.parse({ 未来的设置: 1, 默认接口: { 来源: '代理预设', 未来: 2 } }));
  assert.equal(parsed.未来的设置, 1);
  assert.equal(parsed.默认接口.未来, 2);
  assert.equal(parsed.默认接口.来源, '代理预设');
  assert.equal(parsed.变量更新方式, '跟随角色卡');
});
