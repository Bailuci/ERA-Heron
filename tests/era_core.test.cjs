/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：为核心计算逻辑添加单元测试；补充审查问题的回归测试；修复 update 日志记录过期旧值导致的回滚错误；测试：拆出测试宿主，新增同步层随机对拍测试等
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// ERA 核心计算逻辑的单元测试。
// 在独立宿主中直接加载真实的 TypeScript 源码，不依赖构建产物或真实酒馆。
// 运行方式: node --test tests/era_core.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');
const z = require('zod');

const { create_host } = require('./host.cjs');

// vm 上下文里创建的对象原型与宿主不同，比较前先转成普通 JSON。
const plain = value => JSON.parse(JSON.stringify(value));
const message = (mes, message_id = 1) => ({ message_id, mes });
const EMPTY_META = { EditLogs: {}, SelectedMks: [] };

async function apply(host, stat, mes) {
  const result = await host.patcher.ApplyVarChangeForMessage(message(mes), stat, EMPTY_META);
  return { stat: plain(result.finalStat), log: plain(result.finalEditLog), rejections: plain(result.schemaRejections) };
}

/** 用 EditLog 把结果回滚，确认能回到修改前的状态。 */
function assert_rollback(host, before, after, log) {
  const rolled_back = host.timetravel.rollbackStatToMK(undefined, 'mk', after, ['mk'], { mk: log });
  assert.deepEqual(plain(rolled_back), before);
}

// ---------------------------------------------------------------------------
// 增量运算
// ---------------------------------------------------------------------------

test('resolveArithmetic 解析四种运算并处理边界', () => {
  const { resolveArithmetic } = create_host().arithmetic;
  assert.deepEqual(plain(resolveArithmetic('+=10', 90)), { kind: 'ok', value: 100 });
  assert.deepEqual(plain(resolveArithmetic(' -= 5 ', 90)), { kind: 'ok', value: 85 });
  assert.deepEqual(plain(resolveArithmetic('*=2', 4)), { kind: 'ok', value: 8 });
  assert.deepEqual(plain(resolveArithmetic('/=4', 10)), { kind: 'ok', value: 2.5 });
  assert.deepEqual(plain(resolveArithmetic('+=-3', 10)), { kind: 'ok', value: 7 });
  // 小数点在进入 crud 前会被转义
  assert.deepEqual(plain(resolveArithmetic('+=0__DOT__2', 0.1)), { kind: 'ok', value: 0.3 });
  // 纯数字字符串也可以参与运算
  assert.deepEqual(plain(resolveArithmetic('+=1', '41')), { kind: 'ok', value: 42 });
  assert.equal(resolveArithmetic('/=0', 10).kind, 'invalid');
  // 不是表达式、或当前值不是数字时，按普通值处理
  assert.equal(resolveArithmetic('+=10', '勇者').kind, 'none');
  assert.equal(resolveArithmetic('+=10', undefined).kind, 'none');
  assert.equal(resolveArithmetic('+10', 5).kind, 'none');
  assert.equal(resolveArithmetic(10, 5).kind, 'none');
});

test('VariableEdit 支持增量运算，且可回滚', async () => {
  const host = create_host();
  const before = { player: { hp: 90, gold: 10, name: '勇者' } };
  const { stat, log } = await apply(
    host,
    before,
    '<VariableEdit>{"player": {"hp": "+=10", "gold": "-=2.5"}}</VariableEdit>',
  );
  assert.deepEqual(stat, { player: { hp: 100, gold: 7.5, name: '勇者' } });
  assert.deepEqual(log, [
    { op: 'update', path: 'player.hp', value_old: 90, value_new: 100 },
    { op: 'update', path: 'player.gold', value_old: 10, value_new: 7.5 },
  ]);
  assert_rollback(host, before, stat, log);
});

test('同一条消息内的多次增量运算会累加', async () => {
  const host = create_host();
  const { stat } = await apply(
    host,
    { hp: 1 },
    '<VariableEdit>{"hp": "+=1"}</VariableEdit>剧情<VariableEdit>{"hp": "*=10"}</VariableEdit>',
  );
  assert.deepEqual(stat, { hp: 20 });
});

test('文本字段仍可写入以 += 开头的字符串；除以 0 被跳过', async () => {
  const host = create_host();
  const { stat, log } = await apply(
    host,
    { note: '旧', hp: 5 },
    '<VariableEdit>{"note": "+=10", "hp": "/=0"}</VariableEdit>',
  );
  assert.deepEqual(stat, { note: '+=10', hp: 5 });
  assert.equal(log.length, 1);
});

// ---------------------------------------------------------------------------
// 数组内的对象
// ---------------------------------------------------------------------------

test('数组内的对象默认被字符串化，开启设置后保留', async () => {
  const host = create_host();
  const mes = '<VariableInsert>{"bag": [{"name": "药水"}, 1]}</VariableInsert>';

  const legacy = await apply(host, {}, mes);
  assert.deepEqual(legacy.stat, { bag: ['{"name":"药水"}', 1] });

  host.era_data.settings.value.数组内保留对象 = true;
  const kept = await apply(host, {}, mes);
  assert.deepEqual(kept.stat, { bag: [{ name: '药水' }, 1] });

  const edited = await apply(host, kept.stat, '<VariableEdit>{"bag": [{"name": "解毒剂"}]}</VariableEdit>');
  assert.deepEqual(edited.stat, { bag: [{ name: '解毒剂' }] });
  assert_rollback(host, kept.stat, edited.stat, edited.log);
});

// ---------------------------------------------------------------------------
// Schema 校验
// ---------------------------------------------------------------------------

const PlayerSchema = z.object({
  player: z.object({
    hp: z.coerce.number().transform(value => _.clamp(value, 0, 100)),
    name: z.string(),
  }),
});

test('未注册 schema 时行为不变', async () => {
  const host = create_host();
  const { stat, log, rejections } = await apply(
    host,
    { player: { hp: 50, name: 'a' } },
    '<VariableEdit>{"player": {"hp": 999}}</VariableEdit>',
  );
  assert.deepEqual(stat, { player: { hp: 999, name: 'a' } });
  assert.equal(log.length, 1);
  assert.deepEqual(rejections, []);
});

test('schema 的纠正结果被写回并记入日志，且可回滚', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  const before = { player: { hp: 50, name: 'a' } };
  const { stat, log, rejections } = await apply(host, before, '<VariableEdit>{"player": {"hp": "999"}}</VariableEdit>');
  assert.deepEqual(stat, { player: { hp: 100, name: 'a' } });
  assert.deepEqual(rejections, []);
  assert.deepEqual(log.at(-1), { op: 'update', path: 'player.hp', value_old: '999', value_new: 100 });
  assert_rollback(host, before, stat, log);
});

test('增量运算的结果同样受 schema 钳制', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  const { stat } = await apply(
    host,
    { player: { hp: 95, name: 'a' } },
    '<VariableEdit>{"player": {"hp": "+=10"}}</VariableEdit>',
  );
  assert.equal(stat.player.hp, 100);
});

test('不合法的修改被拦截，同一指令块里的其他修改照常生效', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  const before = { player: { hp: 50, name: 'a' } };
  const { stat, log, rejections } = await apply(
    host,
    before,
    '<VariableEdit>{"player": {"hp": "不是数字", "name": "b"}}</VariableEdit>',
  );
  assert.deepEqual(stat, { player: { hp: 50, name: 'b' } });
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].path, 'player.hp');
  assert.equal(rejections[0].op, 'update');
  assert.equal(rejections[0].value, '不是数字');
  assert.deepEqual(
    log.map(entry => entry.path),
    ['player.name'],
  );
  assert_rollback(host, before, stat, log);
});

test('删除必需字段会被拦截', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  const before = { player: { hp: 50, name: 'a' } };
  const { stat, rejections } = await apply(host, before, '<VariableDelete>{"player": {"name": {}}}</VariableDelete>');
  assert.deepEqual(stat, before);
  assert.equal(rejections[0].op, 'delete');
});

test('修改前的状态本就不合法时全部放行', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  // player.name 缺失，初始状态不符合 schema
  const { stat, rejections } = await apply(
    host,
    { player: { hp: 50 } },
    '<VariableEdit>{"player": {"hp": "不是数字"}}</VariableEdit>',
  );
  assert.deepEqual(stat, { player: { hp: '不是数字' } });
  assert.deepEqual(rejections, []);
});

test('开场白可以在空变量上完成初始化', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  const { stat, rejections } = await apply(
    host,
    {},
    '<VariableInsert>{"player": {"hp": "80", "name": "a"}}</VariableInsert>',
  );
  assert.deepEqual(stat, { player: { hp: 80, name: 'a' } });
  assert.deepEqual(rejections, []);
});

test('$meta / $template 不参与校验，也不会被 schema 删除', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  const before = {
    player: { $meta: { necessary: 'self' }, hp: 50, name: 'a' },
    $template: { x: 1 },
  };
  const { stat } = await apply(host, before, '<VariableEdit>{"player": {"hp": 200}}</VariableEdit>');
  assert.deepEqual(stat, {
    player: { $meta: { necessary: 'self' }, hp: 100, name: 'a' },
    $template: { x: 1 },
  });
});

test('根对象默认保留 schema 未定义的键，嵌套对象按 schema 处理', async () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  const { stat } = await apply(
    host,
    { player: { hp: 50, name: 'a', extra: 1 }, world: { day: 1 } },
    '<VariableEdit>{"world": {"day": 2}}</VariableEdit>',
  );
  assert.deepEqual(stat, { player: { hp: 50, name: 'a' }, world: { day: 2 } });
});

test('没有指令的消息也会用 schema 纠正现有状态，但空变量除外', async () => {
  const host = create_host();
  const Defaults = z.object({ day: z.coerce.number().prefault(1), weather: z.string().prefault('晴') });
  host.registry.setActiveSchema(Defaults);

  const fixed = await apply(host, { day: '3' }, '只有剧情，没有指令');
  assert.deepEqual(fixed.stat, { day: 3, weather: '晴' });
  assert_rollback(host, { day: '3' }, fixed.stat, fixed.log);

  const empty = await apply(host, {}, '只有剧情，没有指令');
  assert.deepEqual(empty.stat, {});
  assert.deepEqual(empty.log, []);
});

test('带点号的键在纠正后保持转义一致', async () => {
  const host = create_host();
  host.registry.setActiveSchema(z.object({ items: z.record(z.string(), z.coerce.number()) }));
  const { stat, log } = await apply(host, {}, '<VariableInsert>{"items": {"v1.5 药水": "3"}}</VariableInsert>');
  assert.deepEqual(stat, { items: { 'v1__DOT__5 药水': 3 } });
  assert_rollback(host, {}, stat, log);
});

test('schema 抛异常时不影响变量写入', async () => {
  const host = create_host();
  host.registry.setActiveSchema({
    safeParse() {
      throw new Error('boom');
    },
  });
  const { stat, rejections } = await apply(host, { hp: 1 }, '<VariableEdit>{"hp": 2}</VariableEdit>');
  assert.deepEqual(stat, { hp: 2 });
  assert.deepEqual(rejections, []);
});

test('注销 schema 时只注销自己注册的那个', () => {
  const host = create_host();
  const other = z.object({});
  host.registry.setActiveSchema(PlayerSchema);
  assert.equal(host.registry.clearActiveSchema(other), false);
  assert.notEqual(host.registry.getActiveSchema(), null);
  assert.equal(host.registry.clearActiveSchema(PlayerSchema), true);
  assert.equal(host.registry.getActiveSchema(), null);
  assert.equal(host.registry.setActiveSchema({ notASchema: true }), false);
});

// ---------------------------------------------------------------------------
// 回归测试：代码审查中发现的问题
// ---------------------------------------------------------------------------

test('增量运算不舍入大整数，也不把编号类字符串当成数字', () => {
  const { resolveArithmetic } = create_host().arithmetic;
  assert.deepEqual(plain(resolveArithmetic('+=1', 1795596777033)), { kind: 'ok', value: 1795596777034 });
  assert.deepEqual(plain(resolveArithmetic('+=0__DOT__01', 1234567890123.45)), { kind: 'ok', value: 1234567890123.46 });
  for (const text of ['007', '0x10', '1e3', '0b11', '']) {
    assert.equal(resolveArithmetic('+=1', text).kind, 'none', text);
  }
  assert.deepEqual(plain(resolveArithmetic('+=1', '-0__DOT__5')), { kind: 'ok', value: 0.5 });
});

test('schema 的默认值不会抢在同一条消息后面的 VariableInsert 之前占位', async () => {
  const host = create_host();
  host.registry.setActiveSchema(
    z.object({
      world: z.object({ day: z.coerce.number().prefault(1) }).prefault({}),
      player: z.object({ hp: z.coerce.number().prefault(100), name: z.string().prefault('无名') }).prefault({}),
      gold: z.coerce.number().prefault(0),
    }),
  );
  const { stat, log, rejections } = await apply(
    host,
    {},
    '<VariableInsert>{"world": {"day": 3}}</VariableInsert>剧情' +
      '<VariableInsert>{"player": {"hp": 80, "name": "Alice"}}</VariableInsert>',
  );
  // gold 没有被任何指令初始化，由消息末尾的完整纠正补上默认值
  assert.deepEqual(stat, { world: { day: 3 }, player: { hp: 80, name: 'Alice' }, gold: 0 });
  assert.deepEqual(rejections, []);
  assert_rollback(host, {}, stat, log);
});

test('只有 $template 的变量视为空，不会被提前写入默认值', async () => {
  const host = create_host();
  host.registry.setActiveSchema(z.object({ gold: z.coerce.number().prefault(0) }));
  const { stat } = await apply(host, {}, '<VariableInsert>{"$template": {"a": 1}}</VariableInsert>');
  assert.deepEqual(stat, { $template: { a: 1 } });
});

test('根 schema 没有 loose() 时同样保留未定义的顶层键；关闭选项后才删除', async () => {
  const Wrapped = z.object({ hp: z.coerce.number().prefault(1) }).prefault({});
  const mes = '<VariableEdit>{"hp": "5"}</VariableEdit>';

  const keep = create_host();
  keep.registry.setActiveSchema(Wrapped);
  assert.deepEqual((await apply(keep, { hp: 1, other: { a: 1 } }, mes)).stat, { hp: 5, other: { a: 1 } });

  const drop = create_host();
  drop.registry.setActiveSchema(Wrapped, { keepUnknownRootKeys: false });
  const dropped = await apply(drop, { hp: 1, other: { a: 1 } }, mes);
  assert.deepEqual(dropped.stat, { hp: 5 });
  assert_rollback(drop, { hp: 1, other: { a: 1 } }, dropped.stat, dropped.log);
});

test('旧数据中未转义的方括号键：纠正时换成转义后的写法，不会被拆成多层路径', async () => {
  const host = create_host();
  host.registry.setActiveSchema(z.object({ items: z.record(z.string(), z.coerce.number()) }));
  const before = { items: { '药水[小]': '3' } };
  const { stat, log } = await apply(host, before, '只有剧情');
  assert.deepEqual(plain(host.data.unescapeEraData(stat)), { items: { '药水[小]': 3 } });
  assert.deepEqual(plain(stat), { items: { 药水__LBRACKET__小__RBRACKET__: 3 } });
  assert_rollback(host, before, stat, log);
});

test('跨字段约束：被拒绝的条目会在其他条目生效后重试', async () => {
  const host = create_host();
  host.registry.setActiveSchema(
    z
      .object({ hp: z.number(), maxHp: z.number(), name: z.string() })
      .refine(data => data.hp <= data.maxHp, { message: 'hp 不能超过 maxHp' }),
  );
  const before = { hp: 50, maxHp: 100, name: 'a' };
  const { stat, log, rejections } = await apply(
    host,
    before,
    '<VariableEdit>{"hp": 150, "maxHp": 200, "name": 5}</VariableEdit>',
  );
  assert.deepEqual(stat, { hp: 150, maxHp: 200, name: 'a' });
  assert.deepEqual(
    rejections.map(rejection => rejection.path),
    ['name'],
  );
  assert_rollback(host, before, stat, log);
});

test('有条目被拒绝后，保留条目的 value_old 取自实际状态，回滚正确', async () => {
  const host = create_host();
  host.registry.setActiveSchema(z.object({ hp: z.number().max(100), name: z.string() }));
  const before = { hp: 50, name: 'a' };
  const { stat, log } = await apply(
    host,
    before,
    '<VariableEdit>{"hp": "+=100"}\n{"hp": "-=80"}\n{"name": 5}</VariableEdit>',
  );
  assert.equal(stat.name, 'a');
  assert_rollback(host, before, stat, log);
});

test('schema 输出非 JSON 类型时不会在每条消息上重复产生日志', async () => {
  const host = create_host();
  host.registry.setActiveSchema(z.object({ t: z.coerce.date() }));
  const first = await apply(host, { t: '2024-01-01' }, '只有剧情');
  assert.equal(first.stat.t, '2024-01-01T00:00:00__DOT__000Z');
  const second = await apply(host, first.stat, '只有剧情');
  assert.deepEqual(second.log, []);
});

test('纠正数组时保留数组元素里的 $meta', async () => {
  const host = create_host();
  host.registry.setActiveSchema(z.object({ arr: z.array(z.object({ n: z.coerce.number() })) }));
  const before = { arr: [{ n: '1', $meta: { updatable: false } }] };
  const { stat, log } = await apply(host, before, '只有剧情');
  assert.deepEqual(stat, { arr: [{ $meta: { updatable: false }, n: 1 }] });
  assert_rollback(host, before, stat, log);
});

test('切换角色卡后，遗留的 schema 会被自动注销', () => {
  const host = create_host();
  host.registry.setActiveSchema(PlayerSchema);
  assert.notEqual(host.registry.getActiveSchema(), null);
  host.context.SillyTavern.characterId = 'another-card';
  assert.equal(host.registry.getActiveSchema(), null);
});

test('仅由 schema 默认值提供的字段，在同一条消息里也能被 VariableEdit 修改', async () => {
  const host = create_host();
  host.registry.setActiveSchema(z.object({ x: z.number(), c: z.coerce.number().prefault(0) }));
  const before = { x: 1 };
  const { stat, log } = await apply(host, before, '<VariableEdit>{"c": "+=5"}</VariableEdit>');
  assert.deepEqual(stat, { x: 1, c: 5 });
  assert_rollback(host, before, stat, log);
});

test('fillDefaultsOnEmpty 开启后，空变量也会用 schema 默认值初始化', async () => {
  const Defaults = z.object({ day: z.coerce.number().prefault(1) });

  const off = create_host();
  off.registry.setActiveSchema(Defaults);
  assert.deepEqual((await apply(off, {}, '<VariableEdit>{"day": 2}</VariableEdit>')).stat, {});

  const on = create_host();
  on.registry.setActiveSchema(Defaults, { fillDefaultsOnEmpty: true });
  assert.deepEqual((await apply(on, {}, '只有剧情')).stat, { day: 1 });
  const edited = await apply(on, {}, '<VariableEdit>{"day": 2}</VariableEdit>');
  assert.deepEqual(edited.stat, { day: 2 });
  assert_rollback(on, {}, edited.stat, edited.log);
});

// ---------------------------------------------------------------------------
// 跨消息回滚：value_old 必须取自实时状态
// ---------------------------------------------------------------------------

/** 依次计算多条消息，并断言从末尾回滚到任意一条消息都能还原当时的状态。 */
async function assert_history(host, messages) {
  const history = [{}];
  const EditLogs = {};
  const SelectedMks = [];
  let stat = {};
  for (let i = 0; i < messages.length; i++) {
    const result = await host.patcher.ApplyVarChangeForMessage(message(messages[i], i), stat, {
      EditLogs,
      SelectedMks: [...SelectedMks],
    });
    stat = result.finalStat;
    EditLogs[`mk${i}`] = result.finalEditLog;
    SelectedMks.push(`mk${i}`);
    history.push(plain(stat));
  }
  for (let i = 0; i < messages.length; i++) {
    const target = i === 0 ? undefined : `mk${i - 1}`;
    const rolled = host.timetravel.rollbackStatToMK(target, SelectedMks.at(-1), stat, SelectedMks, EditLogs);
    assert.deepEqual(plain(rolled), history[i], `回滚到第 ${i} 条消息之前`);
  }
}

test('父路径被插入后又补充了子路径，再整体编辑父路径，仍可正确回滚', async () => {
  await assert_history(create_host(), [
    '<VariableInsert>{"a":{"x":1}}</VariableInsert>',
    '<VariableInsert>{"a":{"y":2}}</VariableInsert>',
    '<VariableEdit>{"a":"gone"}</VariableEdit>',
  ]);
});

test('子路径被编辑或删除后，再整体编辑父路径，仍可正确回滚', async () => {
  await assert_history(create_host(), [
    '<VariableInsert>{"a":{"x":1,"z":3}}</VariableInsert>',
    '<VariableEdit>{"a":{"x":5}}</VariableEdit><VariableDelete>{"a":{"z":{}}}</VariableDelete>',
    '<VariableEdit>{"a":0}</VariableEdit>',
  ]);
});

test('同一条消息内连续编辑同一路径，仍可正确回滚', async () => {
  await assert_history(create_host(), [
    '<VariableInsert>{"hp":10}</VariableInsert>',
    '<VariableEdit>{"hp":20}</VariableEdit><VariableEdit>{"hp":"+=5"}</VariableEdit>',
    '<VariableEdit>{"hp":"-=1"}</VariableEdit><VariableDelete>{"hp":{}}</VariableDelete>',
  ]);
});

// ---------------------------------------------------------------------------
// 更新钩子
// ---------------------------------------------------------------------------

function with_hooks(hooks, phase = 'after') {
  const host = create_host();
  for (const [id, fn, order] of hooks) host.hook_registry.addHook(phase, id, fn, { order });
  return host;
}

test('afterApply：修改、插入、删除、整体赋值都记入日志且可回滚', async () => {
  const before = { hp: 1, gone: { $meta: { necessary: 'self' }, x: 1 }, keep: 1 };
  for (const fn of [
    ({ stat }) => {
      stat.hp += 10;
      stat['带.点'] = '引"号';
      delete stat.gone;
    },
    ctx => {
      ctx.stat = { ..._.omit(ctx.stat, 'gone'), hp: 12, '带.点': '引"号' };
    },
  ]) {
    const host = with_hooks([['h', fn]]);
    const { stat, log } = await apply(host, before, '<VariableEdit>{"hp":2}</VariableEdit>');
    assert.deepEqual(stat, { hp: 12, keep: 1, 带__DOT__点: '引__DQUOTE__号' });
    assert_rollback(host, before, stat, log);
  }
});

test('afterApply：钩子看到反转义、不含保留字段的数据；写入 $meta 被忽略', async () => {
  const seen = [];
  const host = with_hooks([
    [
      'h',
      ({ stat, old_stat, commands }) => {
        seen.push(plain({ stat, old_stat, commands }));
        stat.a.$meta = { updatable: true };
        old_stat.a = 'x';
      },
    ],
  ]);
  const before = { a: { $meta: { necessary: 'all' }, k__DOT__1: 1 }, $template: { t: 1 } };
  const { stat, log } = await apply(host, before, '<VariableEdit>{"a":{"k.1":2}}</VariableEdit>');
  assert.deepEqual(seen, [
    {
      stat: { a: { 'k.1': 2 } },
      old_stat: { a: { 'k.1': 1 } },
      commands: [{ type: 'edit', data: [{ a: { 'k.1': 2 } }] }],
    },
  ]);
  assert.deepEqual(stat, { a: { $meta: { necessary: 'all' }, k__DOT__1: 2 }, $template: { t: 1 } });
  assert.equal(log.length, 1);
});

test('afterApply：空变量和用户消息不执行；无修改时不产生日志', async () => {
  let calls = 0;
  const host = with_hooks([['h', () => calls++]]);
  await apply(host, {}, '剧情');
  await apply(host, { $template: { a: 1 } }, '剧情');
  await host.patcher.ApplyVarChangeForMessage({ message_id: 1, role: 'user', mes: '你好' }, { a: 1 }, EMPTY_META);
  assert.equal(calls, 0);
  const { log } = await apply(host, { a: [{ $meta: { x: 1 }, k__DOT__1: '引__DQUOTE__号' }] }, '剧情');
  assert.equal(calls, 1);
  assert.deepEqual(log, []);
});

test('afterApply：出错、返回 Promise、非法结果时丢弃该钩子的修改，不影响其他钩子，只弹窗一次', async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const host = with_hooks([
    [
      'a',
      ({ stat }) => {
        stat.bad = 1;
        throw new Error('boom');
      },
    ],
    ['b', async ({ stat }) => (stat.bad = 1)],
    [
      'c',
      async () => {
        throw new Error('rejected');
      },
    ],
    ['d', ctx => void (ctx.stat = null)],
    ['e', ctx => void (ctx.stat = cyclic)],
    ['f', ({ stat }) => void (stat.ok = 1)],
  ]);
  const first = await apply(host, { hp: 1 }, '<VariableEdit>{"hp":2}</VariableEdit>');
  assert.deepEqual(first.stat, { hp: 2, ok: 1 });
  await apply(host, { hp: 1 }, '剧情');
  assert.equal(host.toasts.length, 5);
});

test('afterApply：执行顺序由 order 和 id 决定，与注册顺序无关', async () => {
  const push = name => [name, ({ stat }) => void (stat.s += name)];
  const host = with_hooks([
    [...push('z')],
    [...push('b')],
    [...push('a')],
    ['y', ({ stat }) => void (stat.s += 'y'), -1],
  ]);
  assert.equal((await apply(host, { s: '' }, '剧情')).stat.s, 'yabz');
});

test('afterApply：输出经过 schema 钳制、拦截，并补回被删掉的默认值', async () => {
  const host = with_hooks([
    [
      'h',
      ({ stat }) => {
        stat.hp = 999;
        stat.name = 5;
        delete stat.d;
        stat.ok = 1;
      },
    ],
  ]);
  host.registry.setActiveSchema(
    z.object({
      hp: z.coerce.number().transform(v => Math.min(v, 100)),
      name: z.string(),
      d: z.number().prefault(7),
      ok: z.number().optional(),
    }),
  );
  const before = { hp: 1, name: 'a', d: 7 };
  const { stat, log, rejections } = await apply(host, before, '剧情');
  assert.deepEqual(stat, { hp: 100, name: 'a', d: 7, ok: 1 });
  assert.deepEqual(
    rejections.map(r => r.path),
    ['name'],
  );
  assert_rollback(host, before, stat, log);
});

test('beforeApply：可以修正、追加、删除指令；无效指令被忽略；出错时指令不变', async () => {
  const host = with_hooks(
    [
      [
        '修正',
        ({ commands }) => {
          commands[0].data[0] = { hp: commands[0].data[0]['h-p'] };
          commands.push({ type: 'insert', data: { 'k.1': 1 } }, { type: '乱写', data: {} }, { type: 'edit', data: 1 });
        },
      ],
      [
        '出错',
        ctx => {
          ctx.commands = [];
          throw new Error('boom');
        },
      ],
    ],
    'before',
  );
  const { stat, log } = await apply(host, { hp: 1 }, '<VariableEdit>{"h-p":"+=5"}</VariableEdit>');
  assert.deepEqual(stat, { hp: 6, k__DOT__1: 1 });
  assert_rollback(host, { hp: 1 }, stat, log);
});

test('钩子注册表：替换、按身份注销、参数无效、切换角色卡', () => {
  const { hook_registry: registry, context } = create_host();
  const old = registry.addHook('after', 'x', () => {});
  registry.addHook('after', 'x', () => {});
  registry.addHook('before', 'x', () => {});
  assert.equal(registry.dropHook(old), false);
  assert.equal(registry.getActiveHooks('after').length, 1);
  assert.equal(registry.getActiveHooks('before').length, 1);
  assert.equal(
    registry.addHook('after', '', () => {}),
    null,
  );
  assert.equal(registry.addHook('after', 'y', 1), null);
  context.SillyTavern.characterId = 'another-card';
  assert.equal(registry.hasActiveHooks(), false);
});

test('createHookRandom：同种子同序列，不同种子不同序列', () => {
  const { createHookRandom } = create_host().hooks;
  const take = seed => {
    const random = createHookRandom(seed);
    return Array.from({ length: 50 }, random);
  };
  assert.deepEqual(take('a'), take('a'));
  assert.notDeepEqual(take('a'), take('b'));
  assert.ok(take('a').every(v => v >= 0 && v < 1));
});

test('钩子抛出空消息或无法转成字符串的错误时，仍会提示，且不影响该消息的指令', async () => {
  const thrown = [new Error(), '', Object.create(null)];
  const host = with_hooks(
    thrown.map((error, i) => [
      `h${i}`,
      () => {
        throw error;
      },
    ]),
  );
  const { stat } = await apply(host, { hp: 1 }, '<VariableEdit>{"hp":2}</VariableEdit>');
  assert.deepEqual(stat, { hp: 2 });
  assert.equal(host.toasts.length, 3);
});

test('钩子改变数组长度时，未改动的元素保留 $meta；无关的字符串化数组不产生日志', async () => {
  const host = with_hooks([['h', ({ stat }) => void stat.inv.unshift({ n: 0 })]]);
  const before = { inv: [{ $meta: { updatable: false }, n: 1 }], list: ['{"a":1}'] };
  const { stat, log } = await apply(host, before, '剧情');
  assert.deepEqual(stat.inv, [{ n: 0 }, { $meta: { updatable: false }, n: 1 }]);
  assert.deepEqual(
    log.map(entry => entry.path),
    ['inv'],
  );
  assert_rollback(host, before, stat, log);
});

test('群聊中 schema 和钩子以群组为归属', () => {
  const host = create_host();
  host.context.SillyTavern.groupId = 'g1';
  host.registry.setActiveSchema(PlayerSchema);
  host.context.SillyTavern.characterId = 'member';
  assert.notEqual(host.registry.getActiveSchema(), null);
});
