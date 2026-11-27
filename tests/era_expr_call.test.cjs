/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-27
 * 目的：测试表达式中的 call(公式路径, 参数…)：调用存成字符串变量的公式
 *       2026-11-27 call 参数过多时的报错
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 存成变量的公式 call（core/crud/expr.ts）的测试。运行方式: node --test tests/era_expr_call.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');

const { create_host } = require('./host.cjs');
const { create_chat } = require('./chat.cjs');

const plain = value => JSON.parse(JSON.stringify(value));

function make() {
  const host = create_host();
  const expr = host.load_src('core/crud/expr');
  const data = host.load_src('utils/data');
  /** 求值，成功返回数值，失败返回 { error }。stat 按 ERA 的存法转义 */
  const ev = (source, stat = {}, { old = stat, seed = 'seed', resolveFn } = {}) => {
    const result = expr.evaluateExpr(source, {
      stat: data.escapeEraData(_.cloneDeep(stat)),
      oldStat: data.escapeEraData(_.cloneDeep(old)),
      seed,
      resolveFn,
    });
    return result.ok ? result.value : { error: result.reason };
  };
  return { host, expr, data, ev };
}

function fails(value, includes, label) {
  assert.ok(value && typeof value === 'object' && 'error' in value, `${label ?? includes}: 期望失败，实际 ${value}`);
  assert.ok(value.error.includes(includes), `${label ?? includes}: ${value.error}`);
}

const E = data => `<VariableEdit>${JSON.stringify(data)}</VariableEdit>`;
const I = data => `<VariableInsert>${JSON.stringify(data)}</VariableInsert>`;
const X = source => ({ $expr: source });

// ---------------------------------------------------------------------------
// 求值器
// ---------------------------------------------------------------------------

test('call：按位置传参，公式里能读变量、用内置函数与自定义函数', () => {
  const { ev, expr } = make();
  const stat = {
    公式: {
      伤害: 'max(1, a * 2 - b)',
      加成: 'a + 主角.等级',
      双倍: 'double(a)',
      常数: '10',
      平方和: 'a^2 + b^2 + c^2',
    },
    主角: { 攻击: 5, 等级: 3 },
    敌人: { 防御: 3 },
  };
  assert.equal(ev('call(公式.伤害, 主角.攻击, 敌人.防御)', stat), 7);
  assert.equal(ev('call(公式.伤害, 1, 10)', stat), 1);
  assert.equal(ev('100 - call(公式.伤害, 主角.攻击 + 1, 敌人.防御 * 2)', stat), 94);
  assert.equal(ev('call(公式.加成, 2)', stat), 5);
  assert.equal(ev('call(公式.常数) * 2', stat), 20);
  assert.equal(ev('call(公式.平方和, 1, 2, 3)', stat), 14);
  // 全角符号、反引号段
  assert.equal(ev('call（公式.`伤害`，４，１）', stat), 7);
  const resolve = name =>
    name === 'double' ? { minArgs: 1, maxArgs: 1, call: ([x]) => x * 2 } : expr.resolveBuiltinExprFn(name);
  assert.equal(ev('call(公式.双倍, 21)', stat, { resolveFn: resolve }), 42);
  fails(ev('call(公式.双倍, 21)', stat), '未知函数 double');
  // @ 读本楼开始前存的公式
  assert.equal(ev('call(@公式.伤害, 5, 0)', stat, { old: { 公式: { 伤害: 'a - b' } } }), 5);
});

test('call：单个小写字母在公式里是参数，在外层仍是变量；公式里读同名变量用反引号', () => {
  const { ev } = make();
  const stat = { a: 100, b: 200, x: 1, 公式: { f: 'a * 2', g: '`a` + a', h: 'call(公式.f, a + 1)', 只读x: 'x + a' } };
  assert.equal(ev('call(公式.f, 4)', stat), 8);
  // 外层的 a 是变量
  assert.equal(ev('call(公式.f, a)', stat), 200);
  assert.equal(ev('call(公式.g, 1)', stat), 101);
  // 嵌套调用时参数在调用处求值：h 里的 a 是 h 自己的参数
  assert.equal(ev('call(公式.h, 5)', stat), 12);
  // 公式里所有单独的小写字母都是参数名
  fails(ev('call(公式.只读x, 1)', stat), '用到了第 24 个参数');
});

test('call：参数个数、公式不是文本、路径与语法错误都给出能照着改的说明', () => {
  const { ev } = make();
  const stat = {
    公式: { 伤害: 'max(1, a * 2 - b)', 常数: '7', 数: 5, 坏: 'a +', 空: '  ', 引号: '"a"' },
    主角: { 攻击: 1 },
  };
  fails(ev('call(公式.伤害, 主角.攻击)', stat), '公式 公式.伤害 用到了第 2 个参数（a、b），但只给了 1 个');
  fails(ev('call(公式.伤害, 1, 2, 3)', stat), '公式 公式.伤害 只用到 2 个参数（a、b），但给了 3 个');
  fails(ev('call(公式.常数, 1)', stat), '不使用参数，但给了 1 个');
  fails(ev('call(公式.数, 1)', stat), '公式.数 不是文本（当前值：5）');
  fails(ev('call(公式, 1)', stat), '公式 不是文本');
  fails(ev('call(公式.不存在, 1)', stat), '公式 公式.不存在 不存在');
  fails(ev('call(@公式.伤害, 1, 2)', stat, { old: {} }), '本楼开始时公式 公式.伤害 不存在');
  fails(ev('call(1, 2)', stat), 'call 的第一个参数必须是存放公式的变量路径');
  fails(ev('call()', stat), 'call 的第一个参数必须是存放公式的变量路径');
  fails(ev('call(公式.坏, 1)', stat), '公式 公式.坏 写错了：表达式不完整');
  fails(ev('call(公式.空)', stat), '公式 公式.空 写错了：公式是空的');
  fails(ev('call(公式.引号, 1)', stat), '表达式里不能有引号');
  // 公式求值时的错误带上公式名
  fails(ev('call(公式.伤害, 1, 0) + ln(0)', stat), 'ln 的参数必须大于 0');
  fails(ev('call(公式.伤害, 1, 1/0)', stat), '除数不能为 0');
  const inner = ev('call(公式.f, 0)', { 公式: { f: 'ln(a)' } });
  fails(inner, '公式 公式.f 出错：ln 的参数必须大于 0');
});

test('call：嵌套最多 4 层，不能直接或间接调用自己，调用次数有上限', () => {
  const { ev, expr } = make();
  assert.equal(expr.EXPR_CALL_MAX_DEPTH, 4);
  const chain = {
    公式: { f1: 'call(公式.f2, a + 1)', f2: 'call(公式.f3, a + 1)', f3: 'call(公式.f4, a + 1)', f4: 'a * 10', f5: 'a' },
  };
  assert.equal(ev('call(公式.f1, 0)', chain), 30);
  chain.公式.f4 = 'call(公式.f5, a)';
  fails(ev('call(公式.f1, 0)', chain), 'call 最多嵌套 4 层，公式.f5 是第 5 层');
  // 从第 2 层开始算，4 层以内仍然可以
  assert.equal(ev('call(公式.f2, 0)', chain), 2);

  fails(
    ev('call(公式.自己, 1)', { 公式: { 自己: 'call(公式.自己, a)' } }),
    '不能直接或间接调用自己：公式.自己 → 公式.自己',
  );
  fails(
    ev('call(公式.甲, 1)', { 公式: { 甲: 'call(公式.乙, a)', 乙: 'call(公式.`甲`, a)' } }),
    '公式.甲 → 公式.乙 → 公式.`甲`',
  );
  // 同一个公式可以被多次调用（不是递归）
  assert.equal(ev('call(公式.f, 1) + call(公式.f, 2)', { 公式: { f: 'a' } }), 3);
  assert.equal(ev('call(公式.g, 3)', { 公式: { f: 'a * 2', g: 'call(公式.f, a) + call(公式.f, 1)' } }), 8);

  // 次数上限：每次 h 调用自身算 1 次，h 里调用 8 次 f
  const many = { 公式: { f: '1', h: Array(8).fill('call(公式.f)').join(' + ') } };
  assert.equal(ev(Array(7).fill('call(公式.h)').join(' + '), many), 56); // 63 次
  fails(ev(Array(8).fill('call(公式.h)').join(' + '), many), `最多执行 ${expr.EXPR_CALL_MAX_CALLS} 次 call`);
  // 公式的长度、记号数沿用 $expr 的上限
  fails(ev('call(公式.长)', { 公式: { 长: Array(151).fill('1').join('+') } }), '最多 300 个记号');
  fails(ev('call(公式.长)', { 公式: { 长: `1${' '.repeat(1000)}` } }), `最多 ${expr.EXPR_MAX_LENGTH} 个字符`);
});

test('call：随机数与外层共用一个序列，同种子同结果', () => {
  const { ev } = make();
  const stat = { 公式: { 骰: 'roll(1, 1000000) + a', 两骰: 'roll(1, 1000000) + call(公式.骰, 0)' } };
  for (const seed of ['s1', 's2', 'mk|expr|hp|0']) {
    assert.equal(ev('call(公式.骰, 3)', stat, { seed }), ev('roll(1, 1000000) + 3', {}, { seed }));
    assert.equal(
      ev('roll(1, 1000000) * 10 + call(公式.两骰)', stat, { seed }),
      ev('roll(1, 1000000) * 10 + roll(1, 1000000) + roll(1, 1000000)', {}, { seed }),
    );
    // 参数先于公式求值
    assert.equal(
      ev('call(公式.骰, roll(1, 1000000) * 1000000)', stat, { seed }),
      ev('roll(1, 1000000) * 1000000 + roll(1, 1000000)', {}, { seed }),
    );
  }
  // 抽取次数与外层合计
  const draws = { 公式: { r: Array(40).fill('random()').join('+') } };
  assert.equal(typeof ev('call(公式.r) + ' + Array(24).fill('random()').join('+'), draws), 'number');
  fails(ev('call(公式.r) + call(公式.r)', draws), '最多抽取 64 次');
});

test('call 是保留名：Era.registerExprFn 不能注册，内置函数表里没有它', () => {
  const { host, expr } = make();
  const registry = host.load_src('api/tool_registry');
  const result = registry.addExprFn('call', () => 1);
  assert.equal(typeof result, 'string');
  assert.ok(result.includes('call'), result);
  assert.equal(registry.hasExprFn('call'), false);
  assert.ok(expr.RESERVED_EXPR_NAMES.includes('call'));
  assert.ok(!expr.BUILTIN_EXPR_FUNCTION_NAMES.includes('call'));
  // 注册了的自定义函数可以在公式里用
  assert.equal(typeof registry.addExprFn('翻倍', x => x * 2, { params: 1 }), 'object');
  const r = expr.evaluateExpr('call(公式.f, 4)', {
    stat: { 公式: { f: '翻倍(a) + 1' } },
    oldStat: {},
    seed: 's',
    resolveFn: registry.createExprFnResolver(),
  });
  assert.deepEqual(plain(r), { ok: true, value: 9 });
});

// ---------------------------------------------------------------------------
// 写入：公式是普通变量
// ---------------------------------------------------------------------------

async function apply(host, stat, mes, { mk = 'mk1' } = {}) {
  const result = await host.patcher.ApplyVarChangeForMessage(
    { message_id: 1, role: 'assistant', mes },
    stat,
    {},
    {},
    mk,
  );
  const log = plain(result.finalEditLog);
  assert.deepEqual(
    plain(host.timetravel.rollbackStatToMK(undefined, 'm', result.finalStat, ['m'], { m: log })),
    plain(stat),
  );
  return { stat: plain(result.finalStat), log, issues: plain(result.commandIssues) };
}

test('存成变量的公式：含 . 与引号的公式经过转义后仍能求值；受 $meta.updatable 保护', async () => {
  const { host } = make();
  // 公式文本含小数点、反引号里的 . 与双引号
  const formula = 'a * 1.5 + `x.y`.`c"d` + 角色.`生命(当前)`';
  let r = await apply(
    host,
    {},
    I({ 公式: { 伤害: formula }, 'x.y': { 'c"d': 0.25 }, 角色: { '生命(当前)': 2 }, hp: 0 }),
  );
  assert.deepEqual(r.issues, []);
  assert.equal(r.stat.公式.伤害, 'a * 1__DOT__5 + `x__DOT__y`__DOT__`c__DQUOTE__d` + 角色__DOT__`生命(当前)`');
  const base = r.stat;
  r = await apply(host, base, E({ hp: X('call(公式.伤害, 2)') }));
  assert.deepEqual(r.issues, []);
  assert.equal(r.stat.hp, 5.25);

  // 受保护的公式不能被 AI 改写
  const locked = { 公式: { $meta: { updatable: false }, 伤害: 'a' }, hp: 0 };
  r = await apply(host, locked, `${E({ 公式: { 伤害: 'a * 100' } })}${E({ hp: X('call(公式.伤害, 3)') })}`);
  assert.equal(r.stat.公式.伤害, 'a');
  assert.equal(r.stat.hp, 3);
  assert.ok(r.issues.some(issue => issue.reason.includes('updatable')));

  // 失败时字段不变，问题里写着原因
  r = await apply(host, { 公式: { 伤害: 5 }, hp: 1 }, E({ hp: X('call(公式.伤害, 3)') }));
  assert.equal(r.stat.hp, 1);
  assert.ok(r.issues[0].reason.includes('公式.伤害 不是文本'), r.issues[0].reason);
});

test('同步：AI 修改公式后，删楼、滑动、完全重算的结果都与从头重放一致，骰点不变', async () => {
  const c = create_chat();
  c.send(
    'assistant',
    I({ 公式: { 伤害: 'max(1, a + roll(1, 6) - b)' }, 主角: { 攻击: 10 }, 敌人: { 防御: 2, 生命: 100 } }),
  );
  await c.sync();
  const hit = E({ 敌人: { 生命: X('敌人.生命 - call(公式.伤害, 主角.攻击, 敌人.防御)') } });
  c.send('assistant', hit);
  await c.sync();
  const afterFirst = c.stat().敌人.生命;
  assert.ok(afterFirst >= 100 - 14 && afterFirst <= 100 - 9, String(afterFirst));

  // AI 改写公式，下一楼按新公式计算
  c.send('assistant', E({ 公式: { 伤害: 'a * 2 - b + roll(1, 6) * 0' } }));
  await c.sync();
  c.send('assistant', hit);
  await c.sync();
  assert.equal(c.stat().敌人.生命, afterFirst - 18);
  assert.deepEqual(c.stat(), await c.replay());

  // 完全重算：骰点不变
  const before = plain(c.stat());
  await c.sync(true);
  assert.deepEqual(c.stat(), before);

  // 滑动改写公式的那一楼：后面的楼按旧公式重算
  c.swipe_new(2, '没有改公式');
  await c.sync();
  const second = c.stat().敌人.生命;
  assert.ok(afterFirst - second >= 9 && afterFirst - second <= 14, String(second));
  assert.deepEqual(c.stat(), await c.replay());
  // 滑回：与原来相同
  c.chat[2].swipe_id = 0;
  await c.sync();
  assert.deepEqual(c.stat(), before);
  // 删除改写公式的那一楼
  c.chat.splice(2, 1);
  await c.sync();
  assert.deepEqual(c.stat(), await c.replay());
  assert.equal(c.stat().公式.伤害, 'max(1, a + roll(1, 6) - b)');
});

test('call：最多 15 个参数（不含公式路径），超过时报错说明这一点', () => {
  const { ev } = make();
  const args = n => Array.from({ length: n }, (_v, i) => i + 1).join(', ');
  const stat = { 公式: { 和: 'a + o' } };
  assert.equal(ev(`call(公式.和, ${args(15)})`, stat), 16);
  fails(ev(`call(公式.和, ${args(16)})`, stat), 'call 最多 15 个参数（不含公式路径）');
  // 其他函数仍按 16 个说
  fails(ev(`max(${args(17)})`), '函数 max 的参数太多：最多 16 个');
});
