/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：测试：面板变量编辑工作台生成的操作与 ERA 真实的 <VariablePatch> 执行结果一致
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');
const { create_host } = require('./host.cjs');
const { plain } = require('./chat.cjs');

const host = create_host();
const raw = host.load_src('ui/workbench');
/** vm 中创建的对象与本上下文的原型不同，比较前转成普通数据。 */
const wb = new Proxy(raw, {
  get: (target, key) =>
    typeof target[key] === 'function'
      ? (...args) => {
          const result = target[key](...args);
          return typeof result?.then === 'function' ? result : convert(result);
        }
      : target[key],
});
function convert(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.has === 'function' && typeof value.add === 'function') return new Set([...value]);
  if (Array.isArray(value)) return [...value].map(convert);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
}

/** 用真实的 patcher 执行一组操作，返回结果与问题。 */
async function realApply(start, ops, setup = () => {}) {
  const h = create_host();
  h.era_data.settings.value.数组内保留对象 = true;
  setup(h);
  const r = await h.patcher.ApplyVarChangeForMessage(
    { message_id: 1, role: 'assistant', mes: wb.opsToText(ops) },
    start,
    {},
  );
  return { stat: plain(h.data.unescapeEraData(r.finalStat)), issues: plain(r.commandIssues) };
}

function localApply(start, ops) {
  const copy = _.cloneDeep(start);
  const results = ops.map(op => wb.applyLocal(copy, op));
  return { stat: plain(copy), results };
}

test('工作台: JSON Pointer 编码与解码', () => {
  const keys = ['a/b', 'c~d', 'x.y', '中文 键', '0'];
  assert.deepEqual(wb.fromPointer(wb.toPointer(keys)), keys);
  assert.equal(wb.toPointer(['a/b', 'c~d']), '/a~1b/c~0d');
  assert.equal(wb.displayPath(wb.toPointer(['player', 'bag', '0', 'name'])), 'player.bag[0].name');
  assert.equal(wb.displayPath(''), '（根）');
});

const DIFF_CASES = [
  ['改值、加键、删键', { a: 1, b: { c: 2, d: 3 } }, { a: 2, b: { c: 2, e: 4 }, f: 'x' }],
  ['对象换成标量、标量换成对象', { a: { x: 1 }, b: 5 }, { a: 7, b: { y: [1, 2] } }],
  ['数组整体替换', { l: [1, 2, 3], m: [{ n: 1 }] }, { l: [3, 2], m: [{ n: 2 }, { n: 3 }] }],
  ['特殊键名', { 'a/b': 1, 'c~d': { 'x.y': 1 } }, { 'a/b': 2, 'c~d': { 'x.y': 3, 'z/w': true } }],
  ['删除整个分支', { keep: 1, drop: { deep: { deeper: [1] } } }, { keep: 1 }],
  ['null 与空对象', { a: null, b: {} }, { a: {}, b: null }],
];

for (const [name, current, next] of DIFF_CASES) {
  test(`工作台: 差异操作经真实 Patch 执行后得到目标（${name}）`, async () => {
    const { ops, ignored } = wb.diffToOps(current, next);
    assert.deepEqual(ignored, []);
    const real = await realApply(current, ops);
    assert.deepEqual(real.issues, []);
    assert.deepEqual(real.stat, next);
    // 本地草稿与真实结果一致
    const local = localApply(current, ops);
    assert.ok(local.results.every(Boolean));
    assert.deepEqual(local.stat, next);
  });
}

test('工作台: 差异忽略 $meta 与 $template，真实执行时保留原有的保护规则', async () => {
  const current = { p: { hp: 1, $meta: { necessary: 'self' } }, g: { $template: { n: 0 } } };
  const pure = { p: { hp: 1 }, g: {} };
  const next = { p: { hp: 5, $meta: { necessary: 'all' } }, g: { $template: { n: 9 } } };
  const { ops, ignored } = wb.diffToOps(pure, next);
  assert.deepEqual(ops, [{ op: 'replace', path: '/p/hp', value: 5 }]);
  assert.deepEqual(ignored.sort(), ['/g/$template', '/p/$meta']);
  const real = await realApply(current, ops);
  assert.deepEqual(real.stat, { p: { hp: 5, $meta: { necessary: 'self' } }, g: { $template: { n: 0 } } });
});

test('工作台: 粘贴的内容不是对象时报错', () => {
  assert.throws(() => wb.diffToOps({}, [1, 2]), /JSON 对象/);
  assert.throws(() => wb.diffToOps({}, 'x'), /JSON 对象/);
});

test('工作台: 节点编辑的操作与真实 Patch 一致（修改、追加、删除数组元素、新建深层键）', async () => {
  const start = { player: { hp: 10, bag: ['a', 'b', 'c'] }, flags: {} };
  const ops = [
    { op: 'replace', path: '/player/hp', value: 7 },
    { op: 'insert', path: '/player/bag/-', value: 'd' },
    { op: 'remove', path: '/player/bag/0' },
    { op: 'remove', path: '/player/bag/0' },
    { op: 'replace', path: '/flags/seen', value: true },
    { op: 'replace', path: '/world/time', value: { day: 1 } },
  ];
  const real = await realApply(start, ops);
  assert.deepEqual(real.issues, []);
  const local = localApply(start, ops);
  assert.ok(local.results.every(Boolean));
  assert.deepEqual(local.stat, real.stat);
  assert.deepEqual(real.stat, {
    player: { hp: 7, bag: ['c', 'd'] },
    flags: { seen: true },
    world: { time: { day: 1 } },
  });
});

test('工作台: 本地草稿拒绝无法执行的操作', () => {
  const start = { a: 1, l: [1] };
  assert.equal(wb.applyLocal(_.cloneDeep(start), { op: 'remove', path: '/missing' }), false);
  assert.equal(wb.applyLocal(_.cloneDeep(start), { op: 'remove', path: '/l/5' }), false);
  assert.equal(wb.applyLocal(_.cloneDeep(start), { op: 'replace', path: '/a/b', value: 1 }), false);
  assert.equal(wb.applyLocal(_.cloneDeep(start), { op: 'replace', path: '', value: 1 }), false);
});

test('工作台: 保护提示与真实执行的拒绝一致', async () => {
  const stat = {
    locked: { hp: 1, $meta: { updatable: false } },
    keep: { a: 1, b: 2, $meta: { necessary: 'children' } },
    self: { x: 1, $meta: { necessary: 'self' } },
    closed: { a: 1, $meta: { unInsertAble: 'self' } },
    open: { a: 1 },
  };
  const cases = [
    [{ op: 'replace', path: '/locked/hp', value: 2 }, true],
    [{ op: 'remove', path: '/keep/a' }, true],
    [{ op: 'remove', path: '/self' }, true],
    [{ op: 'remove', path: '/self/x' }, false],
    [{ op: 'replace', path: '/closed/new', value: 1 }, true],
    [{ op: 'replace', path: '/closed/a', value: 2 }, false],
    [{ op: 'replace', path: '/open/a', value: 2 }, false],
  ];
  for (const [op, blocked] of cases) {
    const hints = wb.protectionHints(stat, op, false);
    assert.equal(
      hints.some(hint => hint.level === 'block'),
      blocked,
      `提示: ${JSON.stringify(op)} -> ${JSON.stringify(hints)}`,
    );
    const real = await realApply(stat, [op]);
    assert.equal(real.issues.length > 0, blocked, `真实执行: ${JSON.stringify(op)} -> ${JSON.stringify(real.issues)}`);
  }
});

test('工作台: 下划线只读只给出说明；试算中由它产生的问题可识别', async () => {
  const hints = wb.protectionHints({ _secret: 1 }, { op: 'replace', path: '/_secret', value: 2 }, true);
  assert.deepEqual(
    hints.map(hint => hint.level),
    ['info'],
  );
  assert.deepEqual(wb.protectionHints({ _secret: 1 }, { op: 'replace', path: '/_secret', value: 2 }, false), []);
  const real = await realApply({ _secret: 1 }, [{ op: 'replace', path: '/_secret', value: 2 }], h => {
    h.era_data.settings.value.下划线只读 = true;
  });
  assert.equal(real.issues.length, 1);
  assert.ok(wb.isUnderscoreOnlyProblem(real.issues[0]), JSON.stringify(real.issues[0]));
  assert.ok(!wb.isUnderscoreOnlyProblem({ path: 'a.b', reason: '路径不存在' }));
});

test('工作台: 搜索按键名、路径、值匹配，并给出需要展开的祖先', () => {
  const stat = { player: { name: 'Alice', bag: ['sword', 'potion'] }, world: { day: 3 } };
  const byName = wb.searchTree(stat, 'alice');
  assert.deepEqual([...byName.matches], ['/player/name']);
  assert.deepEqual([...byName.ancestors].sort(), ['', '/player']);
  const byPath = wb.searchTree(stat, 'player.bag[1]');
  assert.deepEqual([...byPath.matches], ['/player/bag/1']);
  const byKey = wb.searchTree(stat, 'WORLD');
  assert.ok(byKey.matches.has('/world'));
  assert.ok(byKey.matches.has('/world/day')); // 路径 world.day 也包含 world
  const limited = wb.searchTree({ a: _.range(50) }, '', 10);
  assert.equal(limited.matches.size, 0);
  const truncated = wb.searchTree({ list: _.range(50).map(i => `item${i}`) }, 'item', 10);
  assert.equal(truncated.matches.size, 10);
  assert.equal(truncated.truncated, true);
});

test('工作台: 按类型解析输入', () => {
  assert.equal(wb.parseInput('12.5', 'number'), 12.5);
  assert.throws(() => wb.parseInput('', 'number'), /数字/);
  assert.throws(() => wb.parseInput('abc', 'number'), /数字/);
  assert.equal(wb.parseInput('true', 'boolean'), true);
  assert.equal(wb.parseInput('anything', 'null'), null);
  assert.equal(wb.parseInput(' 原样 ', 'string'), ' 原样 ');
  assert.deepEqual(wb.parseInput('{"a":[1]}', 'json'), { a: [1] });
  assert.throws(() => wb.parseInput('{a:', 'json'), /JSON/);
  assert.equal(wb.kindOf([1]), 'json');
  assert.equal(wb.kindOf(null), 'null');
});
