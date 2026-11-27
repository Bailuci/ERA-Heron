/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：新增表达式 $expr 的测试：求值器、写入与回滚、随机数种子规则、旁路写入的稳定身份、钩子与试算
 *       2026-11-27 “ERA 表达式规则”条目新增 call 的示例
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 表达式 $expr（core/crud/expr.ts 及其接入）的测试。运行方式: node --test tests/era_expr.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');

const { create_host } = require('./host.cjs');

const plain = value => JSON.parse(JSON.stringify(value));

function make() {
  const host = create_host();
  const expr = host.load_src('core/crud/expr');
  const random = host.load_src('utils/seeded_random');
  /** 求值，成功返回数值，失败返回 { error } */
  const ev = (source, stat = {}, oldStat = stat, seed = 'seed', resolveFn) => {
    const result = expr.evaluateExpr(source, { stat, oldStat, seed, resolveFn });
    return result.ok ? result.value : { error: result.reason };
  };
  return { host, expr, random, ev };
}

/** 断言失败，且说明里含有 `includes` */
function fails(value, includes, label) {
  assert.ok(value && typeof value === 'object' && 'error' in value, `${label ?? includes}: 期望失败，实际 ${value}`);
  assert.ok(value.error.includes(includes), `${label ?? includes}: ${value.error}`);
}

// ---------------------------------------------------------------------------
// 求值器
// ---------------------------------------------------------------------------

test('$expr 求值：优先级、右结合乘方、一元负号、数字写法', () => {
  const { ev } = make();
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('(-2)^2'), 4);
  assert.equal(ev('2^3^2'), 512);
  assert.equal(ev('2^-1'), 0.5);
  assert.equal(ev('- -3'), 3);
  assert.equal(ev('+3 - -3'), 6);
  assert.equal(ev('10 / 4'), 2.5);
  assert.equal(ev('0.1 + 0.2'), 0.3);
  assert.equal(ev('1e3 + 2E-1'), 1000.2);
  assert.equal(ev('.5 * 2'), 1);
  assert.equal(ev('0 * -1'), 0);
  assert.ok(Object.is(ev('0 * -1'), 0), '-0 归一为 0');
  assert.equal(ev('1 / 3'), 0.333333333333333);
  assert.equal(ev('9007199254740993'), 9007199254740992); // 整数原样，不按 15 位舍入
  assert.equal(ev('123456789012345678'), 123456789012345680);
});

test('$expr 求值：不支持的写法给出能照着改的说明', () => {
  const { ev } = make();
  fails(ev('5 % 3'), 'mod(x, y)');
  fails(ev('5 % 3'), '*0.5');
  fails(ev('2x'), '2*x');
  fails(ev('2 x'), '缺少运算符');
  fails(ev('2(3)'), '缺少运算符');
  fails(ev('1 > 0'), '比较');
  fails(ev('1 == 1'), '比较');
  fails(ev('a ? 1 : 2', { a: 1 }), '条件');
  fails(ev('"a"'), '反引号');
  fails(ev('(1 + 2'), '括号没有闭合');
  fails(ev('max(1, 2'), '括号没有闭合');
  fails(ev('1 +'), '表达式不完整');
  fails(ev('1 + * 2'), '不能出现在这里');
  fails(ev(')'), '不能出现在这里');
  fails(ev(''), '空');
  fails(ev('   '), '空');
  fails(ev('#'), '无法识别');
  fails(ev('1e999'), '超出范围');
  fails(ev('a.b(1)', { a: { b: 1 } }), '函数名不能带路径');
  fails(ev('@a(1)', { a: 1 }), '函数名不能带路径');
  fails(ev('`a`(1)', { a: 1 }), '函数名不能带路径');
  fails(ev('foo(1)'), '未知函数 foo');
  fails(ev('dice(6)'), 'roll(1, 6)');
  fails(ev('random(1, 6)'), 'roll(1, 6)');
  fails(ev('abs()'), '需要 1 个参数');
  fails(ev('abs(1, 2)'), '实际给了 2 个');
  fails(ev('round(1, 2, 3)'), '1～2');
  fails(ev('@'), '@ 后面');
  fails(ev('@ a', { a: 1 }), '@ 后面');
  fails(ev('`a'), '反引号没有闭合');
  fails(ev('``'), '不能为空');
  assert.deepEqual(ev(123), { error: '$expr 的值必须是字符串' });
});

test('$expr 路径：转义键、反引号段、旧式方括号、数组下标、数字字符串', () => {
  const { ev } = make();
  const stat = {
    角色: { 生命值: 10, '生命值(当前)': 7, 'max-hp': 20, '生命值（当前）': 3, '有 空格': 2 },
    a__DOT__b: 5,
    好感__LBRACKET__小明__RBRACKET__: 3,
    旧好感: { 小红: 4 },
    队伍: [5, 6],
    s: '3__DOT__5',
    neg: '-2',
    编号: '007',
    十六: '0x10',
    名字: '勇者',
    开关: true,
    空: null,
    对象: { x: 1 },
    $meta: { max: 9 },
  };
  assert.equal(ev('角色.生命值 + 1', stat), 11);
  assert.equal(ev('角色.`生命值(当前)` * 2', stat), 14);
  assert.equal(ev('角色.`max-hp`', stat), 20);
  assert.equal(ev('角色.`有 空格`', stat), 2);
  // 反引号里的全角括号不做归一化
  assert.equal(ev('角色.`生命值（当前）`', stat), 3);
  // 键名含 . 时整段放进反引号；值中的 __DOT__ 会先还原
  assert.equal(ev('`a.b` + 1__DOT__5', stat), 6.5);
  assert.equal(ev('`好感[小明]`', stat), 3);
  // 早期版本拆开存放的方括号键
  assert.equal(ev('`旧好感[小红]`', stat), 4);
  assert.equal(ev('`队伍[1]`', stat), 6);
  assert.equal(ev('队伍.length', stat), 2);
  assert.equal(ev('s * 2', stat), 7);
  assert.equal(ev('neg', stat), -2);
  assert.equal(ev('$meta.max', stat), 9);
  fails(ev('编号', stat), '不是数字');
  fails(ev('十六', stat), '不是数字');
  fails(ev('名字', stat), '勇者');
  fails(ev('开关', stat), '不是数字');
  fails(ev('空', stat), '不是数字');
  fails(ev('对象', stat), '不是数字');
  fails(ev('角色.魔力', stat), '变量 角色.魔力 不存在');
  fails(ev('角色.生命值(当前)', stat), '函数名不能带路径');
  fails(ev('名字.length', stat), '不存在');
});

test('$expr 路径：禁止原型相关的键，只读自有属性', () => {
  const { ev } = make();
  const stat = { a: { b: 1 }, list: [1] };
  for (const source of ['__proto__', 'a.__proto__', 'constructor', 'a.constructor', '`prototype`', '@__proto__']) {
    fails(ev(source, stat), '不能读取', source);
  }
  // 反引号整段是一个键名
  fails(ev('`a.__proto__`', stat), '不存在');
  fails(ev('a.toString', stat), '不存在');
  fails(ev('list.map', stat), '不存在');
  fails(ev('hasOwnProperty', stat), '不存在');
});

test('$expr：全角符号归一化', () => {
  const { ev } = make();
  assert.equal(ev('（１＋２）×３'), 9);
  assert.equal(ev('１０÷４－１'), 1.5);
  assert.equal(ev('max（1，2）'), 2);
  assert.equal(ev('2＾3'), 8);
  assert.equal(ev('1．5 * 2'), 3);
  assert.equal(ev('a　+　1', { a: 1 }), 2);
  assert.equal(ev('＠a', { a: 5 }, { a: 1 }), 1);
  assert.equal(ev('｀a b｀', { 'a b': 4 }), 4);
  fails(ev('5 ％ 2'), 'mod');
});

test('$expr：@ 读本楼开始前的值，读不到时报错', () => {
  const { ev } = make();
  const stat = { hp: 50, 新: 1 };
  const old = { hp: 80 };
  assert.equal(ev('hp - @hp', stat, old), -30);
  fails(ev('@新', stat, old), '本楼开始时变量 新 不存在');
});

test('$expr：PI、E 始终是常量；路径写法读同名根键', () => {
  const { ev } = make();
  assert.equal(ev('PI'), 3.14159265358979);
  assert.equal(ev('E'), 2.71828182845905);
  const stat = { PI: 3, E: { x: 2 } };
  assert.equal(ev('PI', stat), 3.14159265358979);
  assert.equal(ev('`PI`', stat), 3);
  assert.equal(ev('@PI', stat), 3);
  assert.equal(ev('E.x', stat), 2);
  assert.equal(ev('a.PI', { a: { PI: 7 } }), 7);
  fails(ev('pi'), '大写 PI');
  fails(ev('e * 2'), '大写 E');
  assert.equal(ev('pi', { pi: 1 }), 1);
  fails(ev('PI(1)'), '未知函数 PI');
});

test('$expr：上限', () => {
  const { ev, expr } = make();
  assert.equal(expr.EXPR_MAX_LENGTH, 1000);
  fails(ev(`1${' '.repeat(1000)}`), '最多 1000 个字符');
  assert.equal(ev(Array(150).fill('1').join('+')), 150); // 299 个记号
  fails(ev(Array(151).fill('1').join('+')), '最多 300 个记号');
  assert.equal(ev(`${'('.repeat(32)}1${')'.repeat(32)}`), 1);
  fails(ev(`${'('.repeat(33)}1${')'.repeat(33)}`), '最多嵌套 32 层');
  fails(ev(`${'abs('.repeat(33)}1${')'.repeat(33)}`), '最多嵌套 32 层');
  assert.equal(ev(`max(${Array(16).fill(1).join(',')})`), 1);
  fails(ev(`max(${Array(17).fill(1).join(',')})`), '最多 16 个');
  assert.equal(typeof ev(Array(64).fill('random()').join('+')), 'number');
  fails(ev(Array(65).fill('random()').join('+')), '最多抽取 64 次');
  // 每个表达式单独计数
  assert.equal(typeof ev('roll(1, 6)'), 'number');
});

test('$expr 基础函数：round 远离零、mod 地板取余、15 位规整、clamp、pow', () => {
  const { ev } = make();
  assert.equal(ev('round(-2.5)'), -3);
  assert.equal(ev('round(2.5)'), 3);
  assert.equal(ev('round(-2.4)'), -2);
  assert.equal(ev('round(1.005, 2)'), 1.01);
  assert.equal(ev('round(-1.005, 2)'), -1.01);
  assert.equal(ev('round(2.345, 1)'), 2.3);
  assert.equal(ev('round(1234.5678, 10)'), 1234.5678);
  assert.equal(ev('round(9007199254740991)'), 9007199254740991);
  fails(ev('round(1, 11)'), '0～10 的整数');
  fails(ev('round(1, 0.5)'), '0～10 的整数');
  fails(ev('round(1, -1)'), '0～10 的整数');
  assert.equal(ev('mod(-1, 7)'), 6);
  assert.equal(ev('mod(7, -3)'), -2);
  assert.equal(ev('mod(-7, -3)'), -1);
  assert.equal(ev('mod(5.5, 2)'), 1.5);
  assert.equal(ev('mod(6, 3)'), 0);
  fails(ev('mod(1, 0)'), '除数 y 不能为 0');
  assert.equal(ev('floor(2.9999999999999996)'), 3);
  assert.equal(ev('floor(0.1 * 3 * 10)'), 3);
  assert.equal(ev('ceil(1.0000000000000002)'), 1);
  assert.equal(ev('trunc(-2.7)'), -2);
  assert.equal(ev('floor(-2.5)'), -3);
  assert.equal(ev('ceil(-2.5)'), -2);
  assert.equal(ev('abs(-3) + sign(-5) + sign(0)'), 2);
  assert.equal(ev('min(3, 1, 2) + max(3, 1, 2)'), 4);
  assert.equal(ev('clamp(15, 0, 10)'), 10);
  assert.equal(ev('clamp(-5, 0, 10)'), 0);
  assert.equal(ev('clamp(5, 5, 5)'), 5);
  fails(ev('clamp(5, 10, 1)'), '最小值不能大于最大值');
  assert.equal(ev('pow(2, 10)'), 1024);
  assert.equal(ev('0^0'), 1);
  assert.equal(ev('(-2)^3'), -8);
  fails(ev('(-8)^(1/3)'), '负数不能取非整数次方');
  fails(ev('0^-1'), '0 不能取负数次方');
  fails(ev('10^400'), '超出数值范围');
  assert.equal(ev('sqrt(16)'), 4);
  fails(ev('sqrt(-1)'), 'sqrt 的参数不能为负数');
  fails(ev('1 / 0'), '除数不能为 0');
  fails(ev('1 / (1 / 0)'), '除数不能为 0');
  fails(ev('1e308 * 10'), '乘法的结果超出数值范围');
  fails(ev('1e308 + 1e308'), '加法的结果超出数值范围');
  assert.equal(ev('1e-320 * 1e-10'), 0); // 下溢为 0 是合法结果
});

test('$expr 初等函数：log、三角（弧度）、atan2(y, x)、定义域错误', () => {
  const { ev } = make();
  assert.equal(ev('log(1000, 10)'), 3);
  assert.equal(ev('log(8, 2)'), 3);
  assert.equal(ev('log(1e-5, 10)'), -5);
  assert.equal(ev('log(E)'), 1);
  assert.equal(ev('log(100)'), ev('ln(100)'));
  assert.equal(ev('log(27, 3)'), 3);
  assert.equal(ev('log10(1000) + log2(1024)'), 13);
  assert.equal(ev('exp(0) + exp(1)'), 3.71828182845905);
  assert.equal(ev('ln(1)'), 0);
  assert.deepEqual(ev('ln(0)'), { error: 'ln 的参数必须大于 0，实际为 0' });
  fails(ev('ln(-1)'), 'ln 的参数必须大于 0，实际为 -1');
  fails(ev('log(0)'), 'log 的参数必须大于 0');
  fails(ev('log(-1, 10)'), 'log 的参数必须大于 0');
  fails(ev('log(8, 1)'), '底数必须大于 0 且不等于 1');
  fails(ev('log(8, -2)'), '底数必须大于 0 且不等于 1');
  fails(ev('log10(0)'), 'log10 的参数必须大于 0');
  fails(ev('log2(-4)'), 'log2 的参数必须大于 0');
  fails(ev('exp(1000)'), '超出数值范围');
  assert.equal(ev('sin(PI / 2)'), 1);
  assert.equal(ev('cos(0)'), 1);
  assert.equal(ev('sin(PI)'), 1.22464679914735e-16); // PI 不是精确的 π
  assert.equal(ev('round(sin(PI), 10)'), 0);
  assert.equal(ev('tan(PI / 4)'), 1);
  assert.equal(ev('asin(1)'), 1.5707963267949);
  assert.equal(ev('acos(-1)'), 3.14159265358979);
  assert.equal(ev('atan(1) * 4'), 3.14159265358979);
  assert.equal(ev('atan2(1, 0)'), 1.5707963267949);
  assert.equal(ev('atan2(0, -1)'), 3.14159265358979);
  assert.equal(ev('atan2(-1, -1)'), -2.35619449019234);
  assert.equal(ev('atan2(0, 0)'), 0);
  fails(ev('asin(2)'), 'asin 的参数必须在 -1 到 1 之间');
  fails(ev('acos(-1.5)'), 'acos 的参数必须在 -1 到 1 之间');
  assert.equal(ev('sinh(0) + cosh(0) + tanh(0)'), 1);
  assert.equal(ev('asinh(0) + acosh(1) + atanh(0)'), 0);
  fails(ev('acosh(0.5)'), 'acosh 的参数必须大于等于 1');
  fails(ev('atanh(1)'), 'atanh 的参数必须在 -1 到 1 之间');
  fails(ev('atanh(-2)'), 'atanh 的参数必须在 -1 到 1 之间');
  fails(ev('cosh(1000)'), '超出数值范围');
  assert.equal(ev('hypot(3, 4)'), 5);
  assert.equal(ev('hypot(-5)'), 5);
  assert.equal(ev('hypot(1, 2, 2)'), 3);
  assert.equal(ev('deg(PI)'), 180);
  assert.equal(ev('rad(180)'), 3.14159265358979);
  assert.equal(ev('deg(rad(30))'), 30);
});

test('$expr 函数表包含路线图中的全部函数', () => {
  const { expr } = make();
  const names = [
    ...'abs sign floor ceil trunc round min max clamp pow sqrt mod'.split(' '),
    ...'exp ln log log10 log2 sin cos tan asin acos atan atan2 sinh cosh tanh'.split(' '),
    ...'random roll random_at asinh acosh atanh hypot deg rad'.split(' '),
  ];
  assert.deepEqual([...expr.BUILTIN_EXPR_FUNCTION_NAMES].sort(), [...names].sort());
});

test('$expr 随机：同种子同结果，按调用序号取值，roll 两端都含', () => {
  const { ev, random } = make();
  const first = ev('random()', {}, {}, 's1');
  assert.ok(first >= 0 && first < 1);
  assert.equal(ev('random()', {}, {}, 's1'), first);
  assert.notEqual(ev('random()', {}, {}, 's2'), first);
  // 第 k 次调用取序列的第 k 个值
  const rng = random.createSeededRandom('s1');
  const a = rng();
  const b = rng();
  assert.equal(ev('random() * 0 + random()', {}, {}, 's1'), Number(b.toPrecision(15)));
  assert.equal(first, Number(a.toPrecision(15)));
  // 同一序列中 roll 消耗一次
  const r = random.createSeededRandom('s3');
  assert.equal(
    ev('roll(1, 6) * 10 + roll(1, 6)', {}, {}, 's3'),
    (1 + Math.floor(r() * 6)) * 10 + 1 + Math.floor(r() * 6),
  );
  const faces = new Set();
  for (let i = 0; i < 300; i++) {
    const v = ev('roll(1, 6)', {}, {}, `seed${i}`);
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 6);
    faces.add(v);
  }
  assert.equal(faces.size, 6);
  assert.equal(ev('roll(3, 3)'), 3);
  assert.equal(ev('roll(-2, -2)'), -2);
  fails(ev('roll(1.5, 3)'), '必须是整数');
  fails(ev('roll(6, 1)'), '最小值不能大于最大值');
  fails(ev('roll(0, 1e10)'), '范围太大');
  fails(ev('roll(1)'), '需要 2 个参数');
});

test('$expr random_at：随机访问，与种子和调用顺序无关', () => {
  const { ev, random } = make();
  const v = ev('random_at(1, 2)', {}, {}, 'any');
  assert.equal(v, Number(random.randomAt(1, 2).toPrecision(15)));
  assert.equal(ev('random_at(1, 2)', {}, {}, 'other'), v);
  assert.equal(ev('random() * 0 + random_at(1, 2)', {}, {}, 'x'), v);
  assert.equal(random.randomAt(1, 2), random.createSeededRandom('1|2')());
  assert.notEqual(ev('random_at(1, 3)'), v);
  assert.notEqual(ev('random_at(2, 2)'), v);
});

test('$expr：函数解析器可以替换，未知函数仍然报错', () => {
  const { ev, expr } = make();
  const resolve = name =>
    name === 'double' ? { minArgs: 1, maxArgs: 1, call: ([x]) => x * 2 } : expr.resolveBuiltinExprFn(name);
  assert.equal(ev('double(21) + abs(-1)', {}, {}, 's', resolve), 43);
  fails(ev('triple(1)', {}, {}, 's', resolve), '未知函数 triple');
  const bad = () => ({ minArgs: 0, maxArgs: 0, call: () => NaN });
  fails(ev('x()', {}, {}, 's', bad), '不是有限数字');
  const thrower = () => ({
    minArgs: 0,
    maxArgs: 0,
    call: () => {
      throw new Error('炸了');
    },
  });
  fails(ev('x()', {}, {}, 's', thrower), '炸了');
});

test('det_math 与求值器：求值器源码不使用 ** 和原生近似函数', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ERA变量框架', 'core', 'crud', 'expr.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const allowed = new Set(['sqrt', 'abs', 'floor', 'ceil', 'trunc', 'round', 'sign', 'min', 'max', 'imul', 'PI', 'E']);
  assert.deepEqual(
    [...code.matchAll(/Math\.(\w+)/g)].map(m => m[1]).filter(name => !allowed.has(name)),
    [],
  );
  assert.ok(!code.includes('**'));
  assert.ok(!/\beval\s*\(|new Function/.test(code));
});

// ---------------------------------------------------------------------------
// 写入：只在 VariableEdit 中、目标为数字时求值
// ---------------------------------------------------------------------------

const E = data => `<VariableEdit>${JSON.stringify(data)}</VariableEdit>`;
const I = data => `<VariableInsert>${JSON.stringify(data)}</VariableInsert>`;
const P = (...ops) => `<VariablePatch>${JSON.stringify(ops)}</VariablePatch>`;
const X = source => ({ $expr: source });

async function apply(host, stat, mes, { mk = 'mk1', meta = {}, role = 'assistant' } = {}) {
  const result = await host.patcher.ApplyVarChangeForMessage({ message_id: 1, role, mes }, stat, meta, {}, mk);
  const log = plain(result.finalEditLog);
  // 回滚还原，日志正向重放一致
  assert.deepEqual(
    plain(host.timetravel.rollbackStatToMK(undefined, 'm', result.finalStat, ['m'], { m: log })),
    plain(stat),
  );
  assert.deepEqual(plain(host.timetravel.applyForward(_.cloneDeep(stat), log)), plain(result.finalStat));
  return { stat: plain(result.finalStat), log, issues: plain(result.commandIssues) };
}

test('VariableEdit 中的 $expr：求值、日志与 += 同构、可回滚、同块后面的键读到前面的结果', async () => {
  const { host } = make();
  const before = { hp: 10, 上限: { hp: 30 }, a: 1, b: 0 };
  const { stat, log, issues } = await apply(
    host,
    before,
    E({ hp: X('min(hp * 2 + 5, 上限.hp)'), a: X('a + 1'), b: X('a * 10') }),
  );
  assert.deepEqual(issues, []);
  assert.deepEqual(stat, { hp: 25, 上限: { hp: 30 }, a: 2, b: 20 });
  assert.deepEqual(log, [
    { op: 'update', path: 'hp', value_old: 10, value_new: 25 },
    { op: 'update', path: 'a', value_old: 1, value_new: 2 },
    { op: 'update', path: 'b', value_old: 0, value_new: 20 },
  ]);
});

test('VariableEdit 中的 $expr：@ 读本楼开始前的值，跨多个块不变', async () => {
  const { host } = make();
  const { stat } = await apply(
    host,
    { hp: 10 },
    `${E({ hp: X('@hp + 1') })}${E({ hp: X('@hp + 1') })}${E({ hp: X('hp + 1') })}`,
  );
  assert.equal(stat.hp, 12);
});

test('VariableEdit 中的 $expr：失败时报告问题并跳过该字段，其余照常', async () => {
  const { host } = make();
  const { stat, issues, log } = await apply(host, { hp: 10, mp: 1 }, E({ hp: X('ln(0)'), mp: X('mp + 1') }));
  assert.deepEqual(stat, { hp: 10, mp: 2 });
  assert.equal(log.length, 1);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'edit');
  assert.equal(issues[0].path, 'hp');
  assert.equal(issues[0].origin, 'text');
  assert.ok(issues[0].reason.startsWith('$expr 计算失败：ln 的参数必须大于 0，实际为 0'), issues[0].reason);
  assert.ok(issues[0].reason.includes('（表达式：ln(0)）'));
});

test('兼容：其他情况保持 1.6 的行为', async () => {
  const { host } = make();
  // 目标是对象且本身有 $expr 键：照旧更新这个子键
  let r = await apply(host, { o: { $expr: '旧', x: 1 } }, E({ o: X('1 + 1') }));
  assert.deepEqual(r.stat, { o: { $expr: '1 + 1', x: 1 } });
  assert.deepEqual(r.issues, []);
  // 目标是对象但没有 $expr 键：路径不存在
  r = await apply(host, { o: { x: 1 } }, E({ o: X('1') }));
  assert.deepEqual(r.stat, { o: { x: 1 } });
  assert.ok(r.issues[0].reason.includes('路径不存在'));
  // 目标是字符串、布尔、数组、null：不生效（与 1.6 相同），说明更清楚
  for (const value of ['10', '勇者', true, [1], null]) {
    r = await apply(host, { v: value }, E({ v: X('1 + 1') }));
    assert.deepEqual(r.stat, { v: value });
    assert.equal(r.issues.length, 1);
    assert.ok(r.issues[0].reason.includes('只能用于数字变量'), r.issues[0].reason);
  }
  // 目标不存在：路径不存在
  r = await apply(host, {}, E({ v: X('1') }));
  assert.deepEqual(r.stat, {});
  assert.ok(r.issues[0].reason.includes('路径不存在'));
  // 叶子不是只有一个键、或值不是字符串：不是表达式
  r = await apply(host, { v: 1 }, E({ v: { $expr: '1', x: 2 } }));
  assert.deepEqual(r.stat, { v: 1 });
  r = await apply(host, { v: 1 }, E({ v: { $expr: 2 } }));
  assert.deepEqual(r.stat, { v: 1 });
  // Insert、Patch 原样写入，不求值
  r = await apply(host, { hp: 1 }, I({ n: X('1 + 1') }));
  assert.deepEqual(r.stat, { hp: 1, n: { $expr: '1 + 1' } });
  r = await apply(host, { hp: 1 }, P({ op: 'replace', path: '/hp', value: X('1 + 1') }));
  assert.deepEqual(r.stat, { hp: { $expr: '1 + 1' } });
  // 增量运算不受影响
  r = await apply(host, { hp: 1 }, E({ hp: '+=2' }));
  assert.deepEqual(r.stat, { hp: 3 });
});

test('$expr 照常受 $meta.updatable 与路径检查保护，键名中的点与引号正确转义', async () => {
  const { host } = make();
  let r = await apply(host, { 锁: { $meta: { updatable: false }, v: 1 } }, E({ 锁: { v: X('2') } }));
  assert.equal(r.stat.锁.v, 1);
  assert.ok(r.issues[0].reason.includes('updatable'));
  // 变量里的键是转义后保存的；反引号里可以有引号
  r = await apply(host, { a__DOT__b: { c__DQUOTE__d: 1 } }, E({ 'a.b': { 'c"d': X('`a.b`.`c"d` + 1') } }));
  assert.deepEqual(r.stat, { a__DOT__b: { c__DQUOTE__d: 2 } });
  // 反引号之外不能有引号
  r = await apply(host, { a__DOT__b: { c: 1 } }, E({ 'a.b': { c: X('"a" + 1') } }));
  assert.equal(r.stat.a__DOT__b.c, 1);
  assert.ok(r.issues[0].reason.includes('引号'));
  assert.equal(r.issues[0].path, 'a.b.c');
  r = await apply(host, { a__DOT__b: { c: 1 } }, E({ 'a.b': { c: X('`a.b`.c + 1.5') } }));
  assert.deepEqual(r.stat, { a__DOT__b: { c: 2.5 } });
});

// ---------------------------------------------------------------------------
// 随机数种子规则
// ---------------------------------------------------------------------------

/** roll(1, 1e9) 在给定种子下的值 */
function rollWith(random, seed) {
  return 1 + Math.floor(random.createSeededRandom(seed)() * 1e9);
}
const R = X('roll(1, 1000000000)');

test('种子：正文指令用 `${mk}|expr|${路径}|${出现次数}`，失败的表达式也占一次', async () => {
  const { host, random } = make();
  const r = await apply(host, { hp: 0, mp: 0 }, `${E({ hp: R })}${E({ mp: R, hp: X('ln(0)') })}${E({ hp: R })}`);
  assert.equal(r.stat.mp, rollWith(random, 'mk1|expr|mp|0'));
  assert.equal(r.stat.hp, rollWith(random, 'mk1|expr|hp|2'));
  // 同一 MK 重算结果相同；不同 MK 不同
  const again = await apply(host, { hp: 0, mp: 0 }, `${E({ hp: R })}${E({ mp: R, hp: X('ln(0)') })}${E({ hp: R })}`);
  assert.deepEqual(again.stat, r.stat);
  const other = await apply(host, { hp: 0, mp: 0 }, `${E({ hp: R })}`, { mk: 'mk2' });
  assert.equal(other.stat.hp, rollWith(random, 'mk2|expr|hp|0'));
  // 编辑前面的其他路径的指令，后面的骰点不变
  const edited = await apply(host, { hp: 0, mp: 0, x: 0 }, `${E({ x: R })}${E({ x: R, mp: R })}${E({ hp: R })}`);
  assert.equal(edited.stat.mp, r.stat.mp);
  // 嵌套路径用反转义后的完整路径
  const nested = await apply(host, { a__DOT__b: { c: 0 } }, E({ 'a.b': { c: R } }));
  assert.equal(nested.stat.a__DOT__b.c, rollWith(random, 'mk1|expr|a.b.c|0'));
});

const op = (data, extra = {}) => ({ type: 'edit', data, after: 0, by: 'block', ...extra });

test('种子：旁路写入用稳定身份 `api|执行序号`，不占正文的出现次数', async () => {
  const { host, random } = make();
  const meta = { ApiOps: { mk1: { rev: 1, applied: 1, ops: [op({ hp: R }), op({ x: 1 }), op({ hp: R })] } } };
  const r = await apply(host, { hp: 0, mp: 0, x: 0 }, E({ hp: R }), { meta });
  // 两条写入都在正文之前执行，最后一条是正文
  assert.equal(r.stat.hp, rollWith(random, 'mk1|expr|hp|0'));
  const onlyApi = await apply(host, { hp: 0, x: 0 }, '', { meta });
  assert.equal(onlyApi.stat.hp, rollWith(random, 'mk1|expr|api|2|hp|0'));
  assert.equal(r.log[0].value_new, rollWith(random, 'mk1|expr|api|0|hp|0'));
});

test('种子：相同写入合并成 n 后重放的骰点与不合并时一致；压缩不会取代或越过 $expr', async () => {
  const { host } = make();
  const { appendApiOp } = host.api_ops;
  const build = (list, compact) => list.reduce((record, item) => appendApiOp(record, item, compact), undefined);
  const a = op({ hp: X('hp + roll(1, 100)') });
  const merged = build([a, a, a], true);
  assert.deepEqual(plain(merged.ops), [{ ...a, n: 3 }]);
  const separate = { rev: 3, applied: 0, ops: [a, a, a] };
  const run = async record => (await apply(host, { hp: 0 }, '', { meta: { ApiOps: { mk1: record } } })).stat;
  assert.deepEqual(await run(merged), await run(separate));

  // 后来的直接赋值不取代 $expr，也不越过它取代更早的赋值
  const set = v => op({ hp: v });
  assert.equal(build([a, set(5)], true).ops.length, 2);
  assert.equal(build([set(1), a, set(5)], true).ops.length, 3);
  // 越过的只有 $expr 之后的简单写入，$expr 的执行序号不变
  const record = build([a, set(1), op({ mp: 1 }), set(2)], true);
  assert.deepEqual(plain(record.ops), [a, op({ mp: 1 }), set(2)]);
  const ids = host.api_ops.interleaveApiOps([], record).map(c => c.exprId);
  assert.deepEqual(plain(ids), ['api|0', 'api|1', 'api|2']);
});

test('interleaveApiOps：展开 n 后按执行序号给出 exprId，正文指令没有', () => {
  const { host } = make();
  const text = [{ type: 'edit', data: [{ t: 1 }], block: 0 }];
  const commands = host.api_ops.interleaveApiOps(text, {
    rev: 1,
    applied: 0,
    ops: [op({ a: 1 }, { n: 2 }), { type: 'insert', data: { b: 1 }, after: 1, by: 'block' }],
  });
  assert.deepEqual(
    plain(commands).map(c => [c.origin ?? 'text', c.exprId ?? null]),
    [
      ['api', 'api|0'],
      ['api', 'api|1'],
      ['text', null],
      ['api', 'api|2'],
    ],
  );
});

test('beforeApply 钩子：保留 exprId；钩子新建的指令用 hook|id|序号；复制的指令加重复序号', () => {
  const { host } = make();
  const commands = [
    { type: 'edit', data: [{ t: 1 }] },
    { type: 'edit', data: [{ a: 1 }], origin: 'api', exprId: 'api|0' },
    { type: 'edit', data: [{ b: 1 }], origin: 'api', exprId: 'api|1' },
  ];
  const hook = {
    id: '卡.钩子',
    fn: ctx => {
      ctx.commands.reverse();
      ctx.commands.push({ ...ctx.commands[0] });
      ctx.commands.push({ type: 'edit', data: [{ c: X('roll(1, 6)') }] });
      ctx.commands.push({ type: 'edit', data: [{ d: 1 }] });
    },
  };
  const result = host.hooks.runBeforeApplyHook(hook, commands, {}, 'mk1');
  assert.equal(result.error, undefined);
  assert.deepEqual(
    plain(result.commands).map(c => [c.origin, c.exprId ?? null]),
    [
      ['api', 'api|1'],
      ['api', 'api|0'],
      ['text', null],
      ['api', 'api|1|dup1'],
      ['hook', 'hook|卡.钩子|0'],
      ['hook', 'hook|卡.钩子|1'],
    ],
  );
  // 没有改动时原样返回
  const same = host.hooks.runBeforeApplyHook({ id: 'x', fn: () => {} }, commands, {}, 'mk1');
  assert.equal(same.commands, commands);
});

test('钩子：新建指令中的 $expr 用 `${mk}|expr|hook|${id}|序号` 取种子；ctx.commands 看到原样的 $expr 叶子；ctx.math 可用', async () => {
  const { host, random } = make();
  let seen = null;
  let math = null;
  host.hook_registry.addHook('before', '卡.骰子', ctx => {
    seen = JSON.parse(JSON.stringify(ctx.commands));
    math = ctx.math;
    ctx.commands.push({ type: 'edit', data: [{ hp: R }] });
  });
  let afterMath = null;
  host.hook_registry.addHook('after', '卡.派生', ctx => {
    afterMath = ctx.math;
    ctx.stat.角度 = ctx.math.atan2(1, 1);
  });
  const r = await apply(host, { hp: 0, mp: 0.5 }, E({ mp: X('mp * 2') }));
  assert.deepEqual(seen, [{ type: 'edit', data: [{ mp: { $expr: 'mp * 2' } }] }]);
  assert.equal(r.stat.mp, 1);
  assert.equal(r.stat.hp, rollWith(random, 'mk1|expr|hook|卡.骰子|0|hp|0'));
  const det = host.load_src('utils/det_math');
  assert.equal(math, det.detMath);
  assert.equal(afterMath, det.detMath);
  assert.equal(r.stat.角度, det.atan2(1, 1));
});

test('createHookRandom 与共用的 createSeededRandom 序列相同（钩子行为不变）', () => {
  const { host, random } = make();
  const a = host.hooks.createHookRandom('mk|after|x');
  const b = random.createSeededRandom('mk|after|x');
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
  // 1.6 钩子随机数的固定值，防止抽取时改变算法
  const fixed = host.hooks.createHookRandom('seed');
  assert.deepEqual(
    [fixed(), fixed()].map(v => Math.floor(v * 1e6)),
    (() => {
      // 1.6 的原实现
      let hash = 2166136261;
      for (const ch of 'seed') {
        hash ^= ch.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
      }
      let state = hash >>> 0;
      const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return [next(), next()].map(v => Math.floor(v * 1e6));
    })(),
  );
});

test('试算：simulateText 默认用 era_simulate 取种子；传入 seedMk 时与该楼真正写入的骰点一致', async () => {
  const { host, random } = make();
  const simulate = host.load_src('core/simulate');
  const text = E({ hp: R });
  const preview = await simulate.simulateText(text, { hp: 0 });
  assert.equal(preview.stat.hp, rollWith(random, 'era_simulate|expr|hp|0'));
  const seeded = await simulate.simulateText(text, { hp: 0 }, 'mk9');
  const real = await apply(host, { hp: 0 }, text, { mk: 'mk9' });
  assert.equal(seeded.stat.hp, real.stat.hp);
  const failed = await simulate.simulateText(E({ hp: X('sqrt(-1)') }), { hp: 0 });
  assert.equal(failed.problems.length, 1);
  assert.ok(failed.problems[0].reason.includes('sqrt'));
});

test('“ERA 表达式规则”条目：示例是严格 JSON、表达式里没有双引号，并且都能求值', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ERA变量框架', 'initer', 'manual', 'worldbook_entries', 'era_expr_rule.txt'),
    'utf8',
  );
  const { host } = make();
  const entry = host.load_src('initer/manual/worldbook_entries/era_expr_rule');
  assert.equal(entry.eraExprRuleEntry.enabled, false);
  assert.equal(entry.eraExprRuleEntry.content, text);
  for (const keyword of ['弧度', 'atan2(y, x)', '`log(x)` 就是自然对数', 'PI', '反引号', 'roll(1, 6)', 'call(']) {
    assert.ok(text.includes(keyword), keyword);
  }
  const blocks = [...text.matchAll(/^<VariableEdit>\r?\n([\s\S]*?)\r?\n<\/VariableEdit>$/gm)].map(m => m[1]);
  assert.equal(blocks.length, 4);
  const stat = {
    公式: { 伤害: 'max(1, a * 2 - b)' },
    角色: { 生命值: 50, 生命上限: 100, 防御力: 3, 攻击力: 6 },
    敌人: { 攻击力: 8, 防御力: 4, 生命值: 20 },
    位置: { x: 0, y: 0 },
    朝向: 30,
    速度: 2,
    任务: { 进度: 0, '总步骤(含隐藏)': 3 },
  };
  for (const block of blocks) {
    const data = JSON.parse(block);
    const exprs = [];
    const walk = node => _.forEach(node, (value, key) => (key === '$expr' ? exprs.push(value) : walk(value)));
    walk(data);
    assert.ok(exprs.length > 0);
    for (const source of exprs) assert.ok(!source.includes('"'), source);
    const r = await apply(host, stat, `<VariableEdit>${block}</VariableEdit>`);
    assert.deepEqual(r.issues, [], block);
    assert.notDeepEqual(r.stat, plain(stat), block);
  }
  // 行内示例也能求值
  const inline = await apply(
    host,
    { 角色: { 生命值: 50, 生命上限: 60, 力量: 2 }, 战斗: { 伤害: 0 } },
    E({
      角色: { 生命值: X('min(角色.生命值 + 20, 角色.生命上限)') },
      战斗: { 伤害: X('roll(1, 6) + roll(1, 6) + 角色.力量') },
    }),
  );
  assert.deepEqual(inline.issues, []);
  assert.equal(inline.stat.角色.生命值, 60);
});
