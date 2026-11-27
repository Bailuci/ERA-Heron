/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-27
 * 目的：测试补全后的保护规则（解析版本 3）：整体覆盖对象、用非对象值删除子节点、VariablePatch 改动 $meta；旧聊天的结果不变
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 运行方式: node --test tests/era_protect.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create_host } = require('./host.cjs');
const { create_chat, plain } = require('./chat.cjs');

const T = (tag, value) => `<Variable${tag}>${JSON.stringify(value)}</Variable${tag}>`;
const P = (...ops) => `<VariablePatch>${JSON.stringify(ops)}</VariablePatch>`;

/** 解析版本 2 建立的聊天（2.0.2 及更早）：保护规则保持原样。 */
const OLD = { ParserVersion: 2, EditLogs: {} };
/** 没有任何元数据的新聊天：使用补全后的保护规则。 */
const NEW = {};

async function run(start, mes, meta, setup = () => {}) {
  const host = create_host();
  setup(host);
  const r = await host.patcher.ApplyVarChangeForMessage({ message_id: 1, role: 'assistant', mes }, start, meta);
  return { stat: plain(host.data.unescapeEraData(r.finalStat)), issues: plain(r.commandIssues) };
}

/** 新聊天里被拦下并报告原因；旧聊天里照旧生效，结果是 `legacy`。 */
const guarded = (name, start, mes, reason, legacy, setup) =>
  test(name, async () => {
    const strict = await run(start, mes, NEW, setup);
    assert.deepEqual(strict.stat, start, '新聊天：变量不变');
    assert.ok(strict.issues.length >= 1, '新聊天：报告原因');
    assert.match(strict.issues[0].reason, reason);
    const old = await run(start, mes, OLD, setup);
    assert.deepEqual(old.stat, legacy, '旧聊天：结果与原来相同');
  });

const 保护区 = () => ({ 保护区: { 值: { hp: 100, $meta: { updatable: false } }, 别的: 1 } });

guarded(
  'Edit：用标量覆盖受 updatable:false 保护的对象',
  保护区(),
  T('Edit', { 保护区: { 值: 0 } }),
  /受 \$meta\.updatable 保护.*不能整体覆盖/,
  { 保护区: { 值: 0, 别的: 1 } },
);

guarded(
  'Edit：用标量覆盖父对象，连带抹掉受保护的子节点',
  保护区(),
  T('Edit', { 保护区: 0 }),
  /受 \$meta\.updatable 保护.*不能整体覆盖/,
  { 保护区: 0 },
);

guarded(
  'Edit：用数组覆盖对象，其中有 necessary 保护的子节点',
  { 队伍: { 甲: { hp: 1, $meta: { necessary: 'self' } } } },
  T('Edit', { 队伍: [] }),
  /受 \$meta\.necessary 保护.*不能整体覆盖/,
  { 队伍: [] },
);

const readonly = host => (host.era_data.settings.value.下划线只读 = true);

guarded(
  'Edit：开启下划线只读后，用标量覆盖对象不能抹掉其中的 _ 字段',
  { 档案: { _密钥: 'k', 备注: { _内部: 1 } } },
  T('Edit', { 档案: 0 }),
  /以 _ 开头的只读字段.*不能整体覆盖/,
  { 档案: 0 },
  readonly,
);

test('Edit：没有受保护内容的对象仍然可以整体覆盖；关闭下划线只读时 _ 字段不拦', async () => {
  const start = { a: { x: 1, y: { z: 2 } }, 档案: { _密钥: 'k' } };
  const { stat, issues } = await run(start, T('Edit', { a: 0, 档案: 1 }), NEW);
  assert.deepEqual(stat, { a: 0, 档案: 1 });
  assert.deepEqual(issues, []);
});

test('Edit：解除保护的写法在新聊天里照常可用', async () => {
  const { stat, issues } = await run(
    保护区(),
    T('Edit', { 保护区: { 值: { $meta: { updatable: true } } } }) + T('Edit', { 保护区: { 值: 0 } }),
    NEW,
  );
  // 第一条解除了保护，第二条才生效
  assert.deepEqual(stat, { 保护区: { 值: 0, 别的: 1 } });
  assert.deepEqual(issues, []);
});

const 队伍 = () => ({ 队伍: { 甲: 1, 乙: 2, $meta: { necessary: 'children' } } });

guarded(
  'Delete：用 null 删除 necessary:"children" 的直属子节点',
  队伍(),
  T('Delete', { 队伍: { 甲: null } }),
  /受 \$meta\.necessary 保护/,
  { 队伍: { 乙: 2, $meta: { necessary: 'children' } } },
);

guarded(
  'Delete：用字符串、数组等非对象值删除 necessary:"children" 的直属子节点',
  队伍(),
  T('Delete', { 队伍: { 甲: '', 乙: [] } }),
  /受 \$meta\.necessary 保护/,
  { 队伍: { $meta: { necessary: 'children' } } },
);

test('Delete：空对象写法新旧聊天都拦；解除保护后可以删', async () => {
  for (const meta of [NEW, OLD]) {
    const blocked = await run(队伍(), T('Delete', { 队伍: { 甲: {} } }), meta);
    assert.deepEqual(blocked.stat, 队伍());
    assert.match(blocked.issues[0].reason, /necessary/);
    const lifted = await run(队伍(), T('Delete', { 队伍: { $meta: {} } }) + T('Delete', { 队伍: { 甲: null } }), meta);
    assert.deepEqual(lifted.stat, { 队伍: { 乙: 2 } });
  }
});

const 背包 = () => ({
  背包: { 药: 1, $meta: { necessary: 'self' } },
  公式: { 伤害: 'a', $meta: { updatable: false } },
});

guarded(
  'Patch：remove $meta 之后再删除',
  背包(),
  P({ op: 'remove', path: '/背包/$meta' }) + T('Delete', { 背包: {} }),
  /VariablePatch 不能改动 \$meta/,
  { 公式: { 伤害: 'a', $meta: { updatable: false } } },
);

guarded(
  'Patch：remove $meta 之后再 replace',
  背包(),
  P({ op: 'remove', path: '/公式/$meta' }, { op: 'replace', path: '/公式/伤害', value: 999 }),
  /VariablePatch 不能改动 \$meta/,
  { 背包: { 药: 1, $meta: { necessary: 'self' } }, 公式: { 伤害: 999 } },
);

guarded(
  'Patch：replace $meta 里的字段',
  背包(),
  P({ op: 'replace', path: '/背包/$meta/necessary', value: 'none' }),
  /VariablePatch 不能改动 \$meta/,
  { 背包: { 药: 1, $meta: { necessary: 'none' } }, 公式: { 伤害: 'a', $meta: { updatable: false } } },
);

guarded(
  'Patch：整体替换时用新值自带的 $meta 换掉原来的保护',
  背包(),
  P({ op: 'replace', path: '/背包', value: { 药: 1, $meta: { necessary: 'none' } } }),
  /VariablePatch 不能改动 \$meta/,
  { 背包: { 药: 1, $meta: { necessary: 'none' } }, 公式: { 伤害: 'a', $meta: { updatable: false } } },
);

test('Patch：新聊天里不涉及 $meta 的操作不受影响；新建的对象可以自带 $meta', async () => {
  const { stat, issues } = await run(
    背包(),
    P(
      { op: 'replace', path: '/背包/药', value: 5 },
      { op: 'replace', path: '/背包', value: { 药: 6 } },
      { op: 'insert', path: '/新区', value: { x: 1, $meta: { updatable: false } } },
    ),
    NEW,
  );
  assert.deepEqual(issues, []);
  assert.deepEqual(stat, {
    背包: { 药: 6, $meta: { necessary: 'self' } },
    公式: { 伤害: 'a', $meta: { updatable: false } },
    新区: { x: 1, $meta: { updatable: false } },
  });
});

test('新旧聊天：从头重放的结果与同步一致（保护规则按聊天的解析版本取）', async () => {
  for (const legacy of [false, true]) {
    const c = create_chat({ legacy });
    c.send('assistant', `开场${T('Insert', 保护区())}`);
    await c.sync();
    c.send('assistant', `覆盖${T('Edit', { 保护区: { 值: 0 } })}`);
    await c.sync();
    const expected = legacy ? { 保护区: { 值: 0, 别的: 1 } } : 保护区();
    assert.deepEqual(plain(c.host.data.unescapeEraData(c.stat())), expected, `legacy=${legacy}`);
    assert.deepEqual(plain(await c.replay()), plain(c.stat()), `重放 legacy=${legacy}`);
  }
});

test('Era.simulate 与正文使用同一套保护规则', async () => {
  const c = create_chat();
  c.send('assistant', `开场${T('Insert', 保护区())}`);
  await c.sync();
  const { simulateText } = c.host.load_src('core/simulate');
  const result = await simulateText(T('Edit', { 保护区: { 值: 0 } }), c.stat());
  assert.match(result.problems[0].reason, /不能整体覆盖/);
});
