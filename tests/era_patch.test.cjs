/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复第三批改动在审查中发现的问题；修复复审中发现的问题；发送前等待只拦玩家的发送，脚本用 Era.extra.wait()；修复 [1] 形式的键在 Patch 中的回滚
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// <VariablePatch>、宽松解析、只读字段、问题收集的测试。运行方式: node --test tests/era_patch.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');
const z = require('zod');
const { create_host } = require('./host.cjs');
const { create_chat, plain } = require('./chat.cjs');

const P = (...ops) => `<VariablePatch>${JSON.stringify(ops)}</VariablePatch>`;

async function run(start, mes, setup = () => {}) {
  const host = create_host();
  host.era_data.settings.value.数组内保留对象 = true;
  setup(host);
  const r = await host.patcher.ApplyVarChangeForMessage({ message_id: 1, role: 'assistant', mes }, start, {});
  const log = plain(r.finalEditLog);
  assert.deepEqual(
    plain(host.timetravel.rollbackStatToMK(undefined, 'm', r.finalStat, ['m'], { m: log })),
    start,
    `回滚: ${mes}`,
  );
  // 日志正向重放也必须得到同样的结果
  assert.deepEqual(plain(host.timetravel.applyForward(_.cloneDeep(start), log)), plain(r.finalStat), `重放: ${mes}`);
  return {
    stat: plain(host.data.unescapeEraData(r.finalStat)),
    issues: plain(r.commandIssues),
    rejections: r.schemaRejections,
  };
}

const ok = (name, start, ops, expected) =>
  test(`patch: ${name}`, async () => {
    const { stat, issues } = await run(start, P(...ops));
    assert.deepEqual(stat, expected);
    assert.deepEqual(issues, []);
  });

const fails = (name, start, ops, reason) =>
  test(`patch: ${name}（不生效并报告原因）`, async () => {
    const { stat, issues } = await run(start, P(...ops));
    assert.deepEqual(stat, start);
    assert.equal(issues.length, 1);
    assert.match(issues[0].reason, reason);
  });

ok('replace 改值', { a: 1 }, [{ op: 'replace', path: '/a', value: 2 }], { a: 2 });
ok('replace 不存在则插入，自动补父级', { a: {} }, [{ op: 'replace', path: '/a/b/1', value: 2 }], {
  a: { b: { 1: 2 } },
});
ok('replace 整体替换对象', { a: { x: 1, y: 2 } }, [{ op: 'replace', path: '/a', value: { x: 9 } }], { a: { x: 9 } });
ok(
  'replace 对象换标量再换回',
  { a: { x: 1 } },
  [
    { op: 'set', path: 'a', value: 5 },
    { op: 'set', path: 'a', value: { z: 1 } },
  ],
  { a: { z: 1 } },
);
ok(
  'replace 保留 $meta',
  { a: { $meta: { necessary: 'self' }, x: 1 } },
  [{ op: 'replace', path: '/a', value: { y: 1 } }],
  { a: { $meta: { necessary: 'self' }, y: 1 } },
);
ok('insert 新键', { a: {} }, [{ op: 'insert', path: '/a/b', value: [1] }], { a: { b: [1] } });
ok('insert 应用模板', { g: { $template: { rank: 'R', n: 0 } } }, [{ op: 'insert', path: '/g/Alex', value: { n: 1 } }], {
  g: { $template: { rank: 'R', n: 0 }, Alex: { rank: 'R', n: 1 } },
});
ok(
  '数组追加',
  { l: [1] },
  [
    { op: 'insert', path: '/l/-', value: 2 },
    { op: 'append', path: '/l', value: { k: 3 } },
  ],
  { l: [1, 2, { k: 3 }] },
);
ok('数组按位置插入', { l: [1, 3] }, [{ op: 'add', path: '/l/1', value: 2 }], { l: [1, 2, 3] });
ok('数组按位置删除不留空位', { l: [1, 2, 3] }, [{ op: 'remove', path: '/l/1' }], { l: [1, 3] });
ok(
  '数组元素内的字段',
  { l: [{ n: 1 }] },
  [
    { op: 'delta', path: '/l/0/n', value: 4 },
    { op: 'replace', path: '/l/0/m', value: 1 },
  ],
  { l: [{ n: 5, m: 1 }] },
);
ok(
  '嵌套数组',
  { l: [[1], [2]] },
  [
    { op: 'insert', path: '/l/0/-', value: 9 },
    { op: 'remove', path: '/l/1/0' },
  ],
  { l: [[1, 9], []] },
);
ok(
  'delta 数字、负数、文本、运算符',
  { a: 1, b: 10, c: '5' },
  [
    { op: 'delta', path: '/a', value: -2 },
    { op: 'delta', path: '/b', value: '*=3' },
    { op: 'increment', path: '/c', value: '2.5' },
  ],
  { a: -1, b: 30, c: 7.5 },
);
ok('toggle', { a: true }, [{ op: 'toggle', path: '/a' }], { a: false });
ok('append 文本', { s: '甲' }, [{ op: 'append', path: '/s', value: '乙.' }], { s: '甲乙.' });
ok('remove', { a: { b: 1, c: 2 } }, [{ op: 'remove', path: '/a/b' }], { a: { c: 2 } });
ok('move 重命名', { 旧: { x: 1 } }, [{ op: 'move', from: '/旧', to: '/新' }], { 新: { x: 1 } });
ok('move 跨级与数组之间', { a: [1, 2], b: [] }, [{ op: 'move', from: '/a/0', path: '/b/-' }], { a: [2], b: [1] });
ok('copy', { a: { x: 1 } }, [{ op: 'copy', from: '/a', to: '/b' }], { a: { x: 1 }, b: { x: 1 } });
ok(
  '键含点、方括号、斜杠、波浪线',
  { m: {} },
  [
    { op: 'insert', path: '/m/v1.5', value: 1 },
    { op: 'insert', path: '/m/剑[+1]', value: 2 },
    { op: 'insert', path: '/m/a~1b~0c', value: 3 },
    { op: 'delta', path: '/m/剑[+1]', value: 1 },
  ],
  { m: { 'v1.5': 1, '剑[+1]': 3, 'a/b~c': 3 } },
);
ok('路径带 stat_data 前缀', { a: 1 }, [{ op: 'replace', path: '/stat_data/a', value: 2 }], { a: 2 });

fails('delta 路径不存在', { a: 1 }, [{ op: 'delta', path: '/b', value: 1 }], /不存在/);
fails('delta 非数字', { a: '文' }, [{ op: 'delta', path: '/a', value: 1 }], /不是数字/);
fails('remove 不存在', { a: 1 }, [{ op: 'remove', path: '/b' }], /不存在/);
fails('数组下标越界', { l: [1] }, [{ op: 'insert', path: '/l/5', value: 1 }], /超出范围/);
fails('父级不是对象', { a: 1 }, [{ op: 'insert', path: '/a/b', value: 1 }], /不是对象/);
fails('未知操作', { a: 1 }, [{ op: '乱写', path: '/a' }], /未知/);
fails('缺少 value', { a: 1 }, [{ op: 'replace', path: '/a' }], /缺少 value/);
fails('移动到自身内部', { a: { b: 1 } }, [{ op: 'move', from: '/a', to: '/a/c' }], /自身/);
fails('move 目标无效时源不丢失', { a: 1, b: 2 }, [{ op: 'move', from: '/a', to: '/b/c' }], /不是对象/);
fails('原型污染', { a: 1 }, [{ op: 'insert', path: '/__proto__/x', value: 1 }], /无效/);
fails(
  '$meta.updatable',
  { a: { $meta: { updatable: false }, x: 1 } },
  [{ op: 'replace', path: '/a/x', value: 2 }],
  /updatable/,
);
fails(
  '$meta.necessary',
  { a: { $meta: { necessary: 'all' }, x: { y: 1 } } },
  [{ op: 'remove', path: '/a/x' }],
  /necessary/,
);
fails(
  '$meta.unInsertAble',
  { a: { $meta: { unInsertAble: 'self' } } },
  [{ op: 'insert', path: '/a/x', value: 1 }],
  /unInsertAble/,
);
fails(
  '受保护对象内的数组',
  { a: { $meta: { updatable: false }, l: [1] } },
  [{ op: 'append', path: '/a/l', value: 2 }],
  /updatable/,
);

test('patch: 失败的操作不影响其他操作；与其他指令按顺序混用；schema 照常纠正和拦截', async () => {
  const mes =
    P(
      { op: 'delta', path: '/hp', value: 999 },
      { op: 'remove', path: '/没有' },
      { op: 'replace', path: '/name', value: 5 },
    ) + '<VariableEdit>{"mp":"+=1"}</VariableEdit>';
  const { stat, issues, rejections } = await run({ hp: 1, name: 'a', mp: 1 }, mes, host =>
    host.registry.setActiveSchema(
      z.object({ hp: z.number().transform(v => Math.min(v, 100)), name: z.string(), mp: z.number() }),
    ),
  );
  assert.deepEqual(stat, { hp: 100, name: 'a', mp: 2 });
  assert.equal(issues.length, 1);
  assert.equal(rejections.length, 1);
});

test('patch: 随机操作后回滚与重放都一致', async () => {
  let seed = 7;
  const rnd = n => (seed = (seed * 48271) % 2147483647) % n;
  const pick = list => list[rnd(list.length)];
  for (let round = 0; round < 400; round++) {
    const path = () =>
      '/' + Array.from({ length: 1 + rnd(3) }, () => pick(['a', 'b', 'l', '0', '1', '-', 'k.1', 'x[0]'])).join('/');
    const ops = Array.from({ length: 1 + rnd(6) }, () => ({
      op: pick(['replace', 'insert', 'remove', 'move', 'copy', 'delta', 'append', 'toggle']),
      path: path(),
      from: path(),
      value: pick([1, 'x', { c: 1 }, [1, { d: 2 }], null, true, '+=2']),
    }));
    await run({ a: { b: 1, l: [1, { k__DOT__1: 2 }] }, l: [1, [2], 's'], b: true }, P(...ops));
  }
});

test('方括号键：三种旧指令也能正确存取和回滚', async () => {
  const { stat, issues } = await run(
    { m: {} },
    '<VariableInsert>{"m":{"剑[+1]":1,"x]":2}}</VariableInsert><VariableEdit>{"m":{"剑[+1]":"+=1"}}</VariableEdit><VariableDelete>{"m":{"x]":{}}}</VariableDelete>',
  );
  assert.deepEqual(stat, { m: { '剑[+1]': 2 } });
  assert.deepEqual(issues, []);
});

// ---------------------------------------------------------------------------
// 宽松解析
// ---------------------------------------------------------------------------

test('宽松解析：还原常见的 AI 写法', () => {
  const { parseTolerant } = create_host().load_src('utils/tolerant_json');
  const same = (text, expected) => assert.deepEqual(plain(parseTolerant(text)), expected, text);
  same('{"a":1,}', [{ a: 1 }]);
  same("{'a':'b'}", [{ a: 'b' }]);
  same('{a: 1, 好感度: -2.5}', [{ a: 1, 好感度: -2.5 }]);
  same('｛'.length ? '{“a”：“b”，“c”：1}' : '', [{ a: 'b', c: 1 }]);
  same('{"a":"他说"你好"然后走了","b":1}', [{ a: '他说"你好"然后走了', b: 1 }]);
  same('{"a":"第一行\n第二行"}', [{ a: '第一行\n第二行' }]);
  same('{"a":{"b":[1,2', [{ a: { b: [1, 2] } }]);
  same('{"a":1 // 注释\n,"b":2 /* x */}', [{ a: 1, b: 2 }]);
  same('{"a":"1"\n"b":2}', [{ a: '1', b: 2 }]);
  same('{"a":+5,"b":True,"c":None}', [{ a: 5, b: true, c: null }]);
  same('{"a":"http://x.y/z#1"}', [{ a: 'http://x.y/z#1' }]);
  same('{"a":1}\n{"b":2}', [{ a: 1 }, { b: 2 }]);
  same('[{"op":"replace","path":"/a","value":1,},]', [[{ op: 'replace', path: '/a', value: 1 }]]);
  same('{"a":"\\u4f60\\n\\"x\\""}', [{ a: '你\n"x"' }]);
});

test('宽松解析：无法还原时返回 null，不猜测', () => {
  const { parseTolerant } = create_host().load_src('utils/tolerant_json');
  for (const text of ['', '你好', '{"a"}', '{"a":}', '{"a":,"b":1}', '{"a":"没有结束', '{"a" 1}', '123']) {
    assert.equal(parseTolerant(text), null, text);
  }
  const polluted = parseTolerant('{"__proto__":{"x":1}}');
  assert.equal({}.x, undefined);
  assert.equal(polluted.length, 1);
});

test('宽松解析：任意合法 JSON 的结果与 JSON.parse 一致', () => {
  const { parseTolerant } = create_host().load_src('utils/tolerant_json');
  let seed = 11;
  const rnd = n => (seed = (seed * 48271) % 2147483647) % n;
  const strings = [
    '',
    '普通',
    '带"引号',
    "单'引",
    '换\n行',
    '逗,号:冒{括}[方]',
    '//不是注释',
    '#井',
    '“全角”',
    '反\\斜',
    '<!--x-->',
    ' 空 ',
  ];
  const value = depth => {
    const k = rnd(depth > 2 ? 4 : 6);
    if (k === 0) return rnd(1000) - 500;
    if (k === 1) return strings[rnd(strings.length)];
    if (k === 2) return [true, false, null][rnd(3)];
    if (k === 3) return (rnd(1000) - 500) / 8;
    if (k === 4) return Array.from({ length: rnd(4) }, () => value(depth + 1));
    return Object.fromEntries(
      Array.from({ length: rnd(4) }, (_v, i) => [strings[rnd(strings.length)] + i, value(depth + 1)]),
    );
  };
  for (let i = 0; i < 1500; i++) {
    const data = { v: value(0) };
    for (const space of [0, 2]) assert.deepEqual(plain(parseTolerant(JSON.stringify(data, null, space))), [data]);
  }
});

test('指令块写坏时自动修复；关闭设置后报告原因', async () => {
  const mes = `<VariableEdit>{'a': 2,}</VariableEdit><VariablePatch>[{op:'delta', path:'/a', value:+3},]</VariablePatch>`;
  assert.deepEqual((await run({ a: 1 }, mes)).stat, { a: 5 });
  const off = await run({ a: 1 }, mes, host => (host.era_data.settings.value.宽松解析 = false));
  assert.deepEqual(off.stat, { a: 1 });
  assert.deepEqual(
    off.issues.map(i => i.type),
    ['parse', 'parse'],
  );
});

test('多个 JSON 连写时，其中一个写坏不会丢掉它', async () => {
  const { stat } = await run({ a: 1, b: 1 }, `<VariableEdit>{"a":2}\n{'b':3,}</VariableEdit>`);
  assert.deepEqual(stat, { a: 2, b: 3 });
});

// ---------------------------------------------------------------------------
// 只读字段与问题收集
// ---------------------------------------------------------------------------

test('下划线只读：默认不限制；开启后 AI 不能改或删，但可以插入；旁路写入不受限', async () => {
  const start = { _id: 1, o: { _x: 1, y: 1 }, __DOT__k: 1 };
  const mes =
    '<VariableEdit>{"_id":2,"o":{"_x":2,"y":2},".k":2}</VariableEdit><VariableDelete>{"o":{"_x":{}}}</VariableDelete>' +
    P(
      { op: 'replace', path: '/_id', value: 3 },
      { op: 'move', from: '/o/_x', to: '/z' },
      { op: 'insert', path: '/_new', value: 1 },
    );
  const off = await run(start, mes);
  assert.equal(off.stat._id, 3);
  const on = await run(start, mes, host => (host.era_data.settings.value.下划线只读 = true));
  assert.deepEqual(on.stat, { _id: 1, o: { _x: 1, y: 2 }, '.k': 2, _new: 1 });
  assert.equal(on.issues.length, 5);

  const c = create_chat({ settings: { 下划线只读: true } });
  c.send('assistant', '<VariableInsert>{"_id":1}</VariableInsert>');
  await c.sync();
  await c.push_op(0, { type: 'edit', data: { _id: 2 } });
  await c.push_op(0, { type: 'patch', data: [{ op: 'delta', path: '/_id', value: 5 }] });
  await c.sync();
  assert.equal(c.stat()._id, 7);
});

test('没有生效的指令通过 era:commandError 报告，弹窗默认关闭', async () => {
  for (const toast of [false, true]) {
    const c = create_chat({ settings: { 指令失败提示: toast } });
    c.send('assistant', '<VariableInsert>{"a":1}</VariableInsert>');
    c.send(
      'assistant',
      '<VariableInsert>{"a":2}</VariableInsert><VariableEdit>{"b":1}</VariableEdit><VariableDelete>{"c":{}}</VariableDelete><VariableEdit>乱写</VariableEdit>',
    );
    await c.sync();
    const event = c.host.emitted.find(e => e.name === 'era:commandError');
    assert.deepEqual(
      plain(event.payload.errors).map(e => [e.message_id, e.type, e.path]),
      [
        [1, 'parse', '乱写'],
        [1, 'insert', 'a'],
        [1, 'edit', 'b'],
        [1, 'delete', 'c'],
      ],
    );
    assert.equal(c.host.toasts.length, toast ? 1 : 0);
    await c.sync();
    assert.equal(c.host.toasts.length, toast ? 1 : 0);
  }
});

test('宏：含点和方括号的键可以查询，未提供快照时也会反转义', () => {
  const stat = { m: { v1__DOT__5: 1, '剑__LBRACKET__+1__RBRACKET__': { n: 2 } }, s: '引__DQUOTE__号' };
  const host = create_host({ getVariables: () => ({ stat_data: stat }), $: () => ({ on() {} }) });
  const { parseEraMacros } = host.load_src('macro/parser');
  assert.equal(parseEraMacros('{{ERA:m.v1.5}}|{{ERA:m.剑[+1].n}}|{{ERA:s}}|{{ERA:没有}}'), '1|2|引"号|');
});

// ============================ 审查发现的问题 ============================

const with_schema = schema => host => host.registry.setActiveSchema(schema);

test('patch + schema：移动被拒绝时不会丢掉来源', async () => {
  const schema = z.object({
    bag: z.record(z.string(), z.any()),
    equip: z.record(z.string(), z.object({ atk: z.number() })),
  });
  const { stat, rejections } = await run(
    { bag: { 剑: { w: 1 } }, equip: {} },
    P({ op: 'move', from: '/bag/剑', to: '/equip/剑' }),
    with_schema(schema),
  );
  assert.deepEqual(stat, { bag: { 剑: { w: 1 } }, equip: {} });
  assert.equal(rejections.length, 1);
});

test('patch + schema：一次不合法的追加不影响之后的；跨字段约束会重试', async () => {
  const list = await run(
    { l: ['a'] },
    P(
      { op: 'append', path: '/l', value: 'b' },
      { op: 'append', path: '/l', value: 5 },
      { op: 'append', path: '/l', value: 'c' },
    ),
    with_schema(z.object({ l: z.array(z.string()) })),
  );
  assert.deepEqual(list.stat, { l: ['a', 'b', 'c'] });
  assert.equal(list.rejections.length, 1);
  const hp = await run(
    { hp: 5, max: 10, name: 'x' },
    P(
      { op: 'replace', path: '/name', value: 1 },
      { op: 'replace', path: '/hp', value: 50 },
      { op: 'replace', path: '/max', value: 100 },
    ),
    with_schema(z.object({ hp: z.number(), max: z.number(), name: z.string() }).refine(s => s.hp <= s.max)),
  );
  assert.deepEqual(hp.stat, { hp: 50, max: 100, name: 'x' });
});

test('指令块带代码围栏、注释、逐行操作、空数组', async () => {
  const fence = '```';
  const cases = [
    `<VariablePatch>\n${fence}json\n[{"op":"delta","path":"/a","value":1}]\n${fence}\n</VariablePatch>`,
    '<VariablePatch>[{"op":"delta","path":"/a","value":1} // 加一\n]</VariablePatch>',
    '<VariablePatch>{"op":"delta","path":"/a","value":1}\n{"op":"delta","path":"/a","value":0}</VariablePatch>',
    `<VariableEdit>\n${fence}json\n{"a":2,}\n${fence}\n</VariableEdit>`,
  ];
  for (const text of cases) {
    const { stat, issues } = await run({ a: 1 }, text);
    assert.deepEqual([stat, issues], [{ a: 2 }, []], text);
  }
  for (const text of cases.slice(0, 3)) {
    const { stat } = await run({ a: 1 }, text, host => (host.era_data.settings.value.宽松解析 = false));
    assert.deepEqual(stat, { a: 2 }, text);
  }
  assert.deepEqual((await run({ a: 1 }, '<VariablePatch>[]</VariablePatch>')).issues, []);
});

test('宽松解析：不改动已经合法的部分，不把说明文字和网址当成数据', async () => {
  assert.deepEqual((await run({}, '<VariableInsert>{"hp":5}\n{注：其余为变化}</VariableInsert>')).stat, { hp: 5 });
  assert.deepEqual((await run({}, '<VariableInsert>{"a":1}\n{"b":2,}\n{"c":3}</VariableInsert>')).stat, {
    a: 1,
    b: 2,
    c: 3,
  });
  assert.deepEqual((await run({}, "<VariableInsert>{'url': https://a.b/c, 'n': 5//注释\n}</VariableInsert>")).stat, {
    url: 'https://a.b/c',
    n: 5,
  });
  const bad = await run({}, '<VariableInsert>{"a":1}\n{"b" 2}</VariableInsert>');
  assert.deepEqual(bad.stat, { a: 1 });
});

test('旁路写入的位置不受解析方式影响；早期的记录按当时的方式解释', async () => {
  const text = '<VariableEdit>{"a":2,}</VariableEdit><VariableEdit>{"hp":5}</VariableEdit>';
  for (const by of ['block', undefined]) {
    const c = create_chat({ settings: { 宽松解析: false } });
    c.send('assistant', '<VariableInsert>{"a":1,"hp":1}</VariableInsert>');
    c.send('assistant', text);
    await c.sync();
    await c.push_op(1, { type: 'edit', data: { hp: 9 } });
    const [record] = Object.values(c.meta().ApiOps);
    assert.equal(record.ops[0].after, 2);
    if (!by) Object.assign(record.ops[0], { after: 1, by: undefined });
    await c.sync();
    assert.deepEqual(c.stat(), { a: 1, hp: 9 });
    c.host.era_data.settings.value.宽松解析 = true;
    await c.sync(true);
    assert.deepEqual(c.stat(), { a: 2, hp: 9 }, String(by));
  }
});

test('下划线只读：钩子改动指令后，API 写入和钩子自己的指令仍不受限制，正文指令仍受限制', async () => {
  for (const rebuild of [false, true]) {
    const c = create_chat({
      settings: { 下划线只读: true },
      before_hooks: [
        [
          'h',
          ctx => {
            if (!ctx.old_stat._id) return;
            if (rebuild) ctx.commands = ctx.commands.map(command => ({ ...command }));
            ctx.commands.push({ type: 'edit', data: { _hook: 7 } });
          },
        ],
      ],
    });
    c.send('assistant', '<VariableInsert>{"_id":1,"_hook":1,"_text":1}</VariableInsert>');
    c.send('assistant', '<VariableEdit>{"_text":2}</VariableEdit>');
    await c.sync();
    await c.push_op(1, { type: 'edit', data: { _id: 2 } });
    await c.sync();
    assert.deepEqual(c.stat(), { _id: 2, _hook: 7, _text: 1 });
  }
});

test('下划线只读：不能通过数组末尾、替换或复制父级绕过', async () => {
  const readonly = host => (host.era_data.settings.value.下划线只读 = true);
  for (const path of ['/_l/-', '/_l/1', '/_l']) {
    const { stat, issues } = await run(
      { _l: [1] },
      P({ op: path === '/_l' ? 'append' : 'insert', path, value: 2 }),
      readonly,
    );
    assert.deepEqual(stat, { _l: [1] });
    assert.equal(issues.length, 1);
  }
  const start = { p: { _id: 1, hp: 2, q: { _x: 1, y: 1 } }, o: { _id: 5 } };
  let r = await run(start, P({ op: 'replace', path: '/p', value: { hp: 9, q: { y: 2 } } }), readonly);
  assert.deepEqual([r.stat.p, r.issues], [{ _id: 1, hp: 9, q: { _x: 1, y: 2 } }, []]);
  r = await run(start, P({ op: 'replace', path: '/p', value: { _id: 99, hp: 9, q: { y: 2 } } }), readonly);
  assert.equal(r.stat.p._id, 1);
  assert.equal(r.issues.length, 1);
  r = await run(start, P({ op: 'copy', from: '/o', to: '/p' }), readonly);
  assert.equal(r.stat.p._id, 1);
  r = await run(start, P({ op: 'replace', path: '/p', value: 5 }), readonly);
  assert.deepEqual(r.stat, start);
  r = await run(start, P({ op: 'insert', path: '/p/_new', value: 5 }), readonly);
  assert.equal(r.stat.p._new, 5);
});

test('patch：替换父级时保留各级 $meta / $template，并遵守子节点的保护', async () => {
  const start = {
    p: {
      bag: { $template: { n: 1 }, $meta: { note: 1 }, x: { n: 1 } },
      uid: { $meta: { updatable: false }, v: 1 },
      keep: { $meta: { necessary: 'self' }, v: 1 },
    },
  };
  const value = { bag: { y: { n: 2 } }, uid: { v: 1 }, keep: { v: 2 } };
  const r = await run(start, P({ op: 'replace', path: '/p', value }));
  assert.deepEqual(r.stat.p.bag, { $template: { n: 1 }, $meta: { note: 1 }, y: { n: 2 } });
  assert.deepEqual(r.stat.p.uid, start.p.uid);
  for (const bad of [{ ...value, uid: { v: 2 } }, _.omit(value, 'uid'), _.omit(value, 'keep'), 5]) {
    const { stat, issues } = await run(start, P({ op: 'replace', path: '/p', value: bad }));
    if (bad === 5) continue;
    assert.deepEqual(stat, start);
    assert.equal(issues.length, 1);
  }
});

test('patch：数组中的对象按设置存放，移动和复制保持原样', async () => {
  const off = host => (host.era_data.settings.value.数组内保留对象 = false);
  const json = '{"n":1}';
  const expect = async (start, op, expected) => assert.deepEqual((await run(start, P(op), off)).stat, expected);
  await expect({ l: [] }, { op: 'replace', path: '/l', value: [{ n: 1 }] }, { l: [json] });
  await expect({}, { op: 'replace', path: '/l', value: [{ n: 1 }] }, { l: [json] });
  await expect({ l: [] }, { op: 'append', path: '/l', value: { n: 1 } }, { l: [json] });
  await expect({ l: [] }, { op: 'insert', path: '/l/-', value: { n: 1 } }, { l: [json] });
  await expect({ l: [{ n: 1 }] }, { op: 'move', from: '/l', to: '/m' }, { m: [{ n: 1 }] });
  await expect({ l: [{ n: 1 }] }, { op: 'copy', from: '/l', to: '/a/m' }, { l: [{ n: 1 }], a: { m: [{ n: 1 }] } });
});

test('名称[下标] 仍表示数组元素', async () => {
  assert.deepEqual((await run({ l: [1, 2] }, '<VariableEdit>{"l[0]":9}</VariableEdit>')).stat, { l: [9, 2] });
  assert.deepEqual((await run({ l: [{ hp: 1 }] }, P({ op: 'replace', path: 'l[0].hp', value: 2 }))).stat, {
    l: [{ hp: 2 }],
  });
  assert.deepEqual((await run({ l: [{ hp: 1 }] }, P({ op: 'replace', path: '/l[0]/hp', value: 2 }))).stat, {
    l: [{ hp: 2 }],
  });
  assert.deepEqual((await run({}, '<VariableInsert>{"a[b]":1}</VariableInsert>')).stat, { 'a[b]': 1 });
});

fails('数组的 length', { l: [1, 2, 3] }, [{ op: 'replace', path: '/l/length', value: 0 }], /数组的位置/);
fails('数组的非数字路径', { l: [{ a: 1 }] }, [{ op: 'replace', path: '/l/x/a', value: 0 }], /数组的位置/);

test('patch：移动之后再修改，回滚仍能还原', async () => {
  const start = { 背包: { 剑: { 耐久: 10 } }, 装备: { 武器: null }, 列表: [] };
  for (const to of ['/装备/武器', '/列表/-', '/装备/新']) {
    const inside = to === '/列表/-' ? '/列表/0/耐久' : `${to}/耐久`;
    const { stat } = await run(
      start,
      P({ op: 'move', from: '/背包/剑', to }, { op: 'delta', path: inside, value: -1 }),
    );
    assert.deepEqual(stat.背包, {});
  }
});

test('patch + schema：一个操作被拒绝，不会打乱其他操作的顺序', async () => {
  const schema = z.object({ hp: z.number() }).loose();
  const bad = { op: 'replace', path: '/hp', value: 'abc' };
  const go = (start, ...ops) => run(start, P(bad, ...ops), with_schema(schema));
  const replace = (path, value) => ({ op: 'replace', path, value });
  assert.deepEqual((await go({ hp: 1, pos: '家' }, replace('/pos', '家'), replace('/pos', '学校'))).stat, {
    hp: 1,
    pos: '学校',
  });
  let r = await go({ hp: 1 }, { op: 'remove', path: '/task' }, { op: 'insert', path: '/task', value: { a: 1 } });
  assert.deepEqual(r.stat, { hp: 1, task: { a: 1 } });
  assert.deepEqual([r.issues.length, r.rejections.length], [1, 1]);
  r = await go({ hp: 1 }, { op: 'delta', path: '/n', value: 5 }, { op: 'insert', path: '/n', value: 1 });
  assert.deepEqual(r.stat, { hp: 1, n: 1 });
});

test('早期的旁路写入：按当时的计数方式，合法但没有对象的指令块也计入', async () => {
  for (const block of ['null', '"无变化"', '[1]']) {
    const c = create_chat();
    c.send('assistant', '<VariableInsert>{"hp":1}</VariableInsert>');
    c.send('assistant', `<VariableEdit>${block}</VariableEdit><VariableEdit>{"hp":10}</VariableEdit>`);
    await c.sync();
    await c.push_op(1, { type: 'edit', data: { hp: 50 } });
    Object.assign(Object.values(c.meta().ApiOps)[0].ops[0], { after: 2, by: undefined });
    c.chat[1].swipes[0] += '<VariableEdit>{"hp":20}</VariableEdit>';
    await c.sync(true);
    assert.deepEqual(c.stat(), { hp: 20 }, block);
  }
});

test('早期版本拆开存放的方括号键仍可修改和删除；嵌套数组中的对象照常执行', async () => {
  const edit = async (start, tag, data) =>
    (await run(start, `<Variable${tag}>${JSON.stringify(data)}</Variable${tag}>`)).stat;
  assert.deepEqual(await edit({ 列表: ['a', 'b'] }, 'Edit', { 列表: { '[0]': 'x' } }), { 列表: ['x', 'b'] });
  assert.deepEqual(await edit({ 列表: [{ 名: 'a' }] }, 'Edit', { 列表: { '[0]': { 名: 'x' } } }), {
    列表: [{ 名: 'x' }],
  });
  assert.deepEqual(await edit({ 列表: [{ 名: 'a' }] }, 'Edit', { '列表[0][名]': 'x' }), { 列表: [{ 名: 'x' }] });
  assert.deepEqual(await edit({ 关系: { 好感: { 小明: 1 } } }, 'Edit', { 关系: { '好感[小明]': '+=5' } }), {
    关系: { 好感: { 小明: 6 } },
  });
  assert.deepEqual(await edit({ 关系: { 好感: { 小明: 1 } } }, 'Delete', { 关系: { '好感[小明]': {} } }), {
    关系: { 好感: {} },
  });
  assert.deepEqual(await edit({ hp: 1 }, 'Edit', [[{ hp: 5 }]]), { hp: 5 });
});

test('宽松解析：删除指令绝不自动补全；只修复一部分时不猜测', async () => {
  const start = { tmp: 1, 背包: { 剑: 1, 盾: 2 } };
  for (const tail of ['{"背包": { // 移除剑 "剑": {} }}', '{"背包":{', '{"背包":{"剑":{']) {
    const { stat, issues } = await run(start, `<VariableDelete>{"tmp":{}}\n${tail}</VariableDelete>`);
    assert.deepEqual(stat, { 背包: start.背包 }, tail);
    assert.equal(issues.length, 1);
    assert.deepEqual((await run(start, `<VariableDelete>${tail}</VariableDelete>`)).stat, start, tail);
  }
  assert.deepEqual((await run({ hp: 1, mp: 100 }, '<VariableEdit>{"hp":10}\n{"mp": +5,"hp":2}</VariableEdit>')).stat, {
    hp: 10,
    mp: 100,
  });
});

test('patch：形如 [1] 的键可以精确修改和回滚', async () => {
  const start = { 日记: { __LBRACKET__1__RBRACKET__: '晴' } };
  for (const op of [
    { op: 'replace', path: '/日记/[1]', value: '雨' },
    { op: 'remove', path: '/日记/[1]' },
    { op: 'insert', path: '/日记/[2]', value: '雪' },
  ]) {
    const { stat, issues } = await run(start, P(op));
    assert.deepEqual(issues, []);
    assert.ok(
      Object.keys(stat.日记).every(key => /^\[\d\]$/.test(key)),
      JSON.stringify(stat),
    );
  }
});
