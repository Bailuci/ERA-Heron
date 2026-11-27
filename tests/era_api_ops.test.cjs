/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增脚本设置“API写入不修改消息”；新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复第三批改动在审查中发现的问题
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 旁路 API 写入（core/api_ops.ts 及其写入路径）测试。运行方式: node --test tests/era_api_ops.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');
const z = require('zod');
const { create_chat, plain } = require('./chat.cjs');

function api_chat(options = {}) {
  const c = create_chat({ ...options, settings: { API写入不修改消息: true, ...options.settings } });
  const handler = c.host.load_src('events/handlers/api/handler');
  return { ...c, api: handler, ops: () => c.meta().ApiOps ?? {} };
}

const edit = (data, after = 0) => ({ type: 'edit', data, after });

test('createApiOp：与调用者的对象脱离，宏在写入时固定，名字含引号时退回原样，非法数据抛错', () => {
  const { host } = create_chat();
  const { createApiOp } = host.api_ops;
  const data = { a: { b: 1 } };
  const op = createApiOp('edit', data, 0, false);
  data.a.b = 2;
  assert.deepEqual(plain(op), { ...edit({ a: { b: 1 } }), by: 'block' });
  assert.equal(createApiOp('edit', { n: '{{user}}' }, 0, false).data.n, 'User');
  host.context.SillyTavern.name1 = '引"号';
  assert.equal(createApiOp('edit', { n: '{{user}}' }, 0, false).data.n, '{{user}}');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => createApiOp('edit', cyclic, 0, false));
  assert.throws(() => createApiOp('edit', undefined, 0, false));
});

test('interleaveApiOps：无记录时返回原数组；按位置插入且保持写入顺序；重复写入互不共享', () => {
  const { interleaveApiOps } = create_chat().host.api_ops;
  const text = [1, 2].map((t, block) => ({ type: 'insert', data: [{ t }], block, legacy: true }));
  assert.equal(interleaveApiOps(text), text);
  const names = ops =>
    plain(interleaveApiOps(text, { rev: 1, applied: 0, ops })).map(c => Object.entries(c.data[0])[0].join(''));
  assert.deepEqual(names([edit({ o: 1 }, 0)]), ['o1', 't1', 't2']);
  assert.deepEqual(names([edit({ o: 1 }, 1)]), ['t1', 'o1', 't2']);
  assert.deepEqual(names([edit({ o: 1 }, 99), edit({ o: 2 }, 0)]), ['t1', 't2', 'o1', 'o2']);
  assert.deepEqual(names([{ ...edit({ o: 1 }, 1), by: 'block' }]), ['t1', 'o1', 't2']);
  const commands = interleaveApiOps([], { rev: 2, applied: 0, ops: [{ ...edit({ o: 1 }), n: 2 }] });
  assert.deepEqual(
    plain(commands).map(c => c.origin),
    ['api', 'api'],
  );
  assert.notEqual(commands[0].data[0], commands[1].data[0]);
});

test('appendApiOp：只做可证明安全的压缩', () => {
  const { appendApiOp } = create_chat().host.api_ops;
  const run = (list, compact = true) => plain(list.reduce((record, op) => appendApiOp(record, op, compact), undefined));
  const sets = Array.from({ length: 100 }, (_v, i) => edit({ a: { b: i } }));
  assert.deepEqual(run(sets), { rev: 100, applied: 0, ops: [edit({ a: { b: 99 } })] });
  assert.equal(run(_.flatMap(sets, (op, i) => [op, edit({ c: i })])).ops.length, 2);
  assert.deepEqual(run(Array(1000).fill(edit({ a: '+=1' }))).ops, [{ ...edit({ a: '+=1' }), n: 1000 }]);
  assert.equal(run([edit({ a: '+=1' }), edit({ a: '+=2' })]).ops.length, 2);
  assert.deepEqual(run([edit({ a: '+=1' }), edit({ a: '+=2' }), edit({ a: 5 })]).ops, [edit({ a: 5 })]);
  assert.equal(run(sets.slice(0, 2), false).ops.length, 2);
  assert.equal(run([edit({ a: 1 }), edit({ a: 1 })], false).ops[0].n, 2);
  for (const barrier of [
    { type: 'insert', data: { z: 1 }, after: 0 },
    { type: 'delete', data: { z: {} }, after: 0 },
    edit({ x: 1, y: 2 }),
    edit({ $meta: { updatable: false } }),
    edit({ a: { b: { c: 1 } } }),
    edit({ list: { 0: 1 } }),
    edit({ q: 1 }, 3),
  ]) {
    assert.equal(run([edit({ a: { b: 1 } }), barrier, edit({ a: { b: 2 } })]).ops.length, 3, JSON.stringify(barrier));
  }
  const record = Object.freeze({ rev: 1, applied: 1, ops: Object.freeze([edit({ a: 1 })]) });
  appendApiOp(record, edit({ a: 2 }), true);
});

test('旁路写入与等价的正文指令块结果相同', async () => {
  const start = '<VariableInsert>{"a":{"x":1,"t":"文"},"k.1":"引\\"号"}</VariableInsert>';
  for (const keep of [false, true]) {
    for (const [tag, type, data] of [
      ['Insert', 'insert', { b: [{ 名: '药.水' }], 'q.1': '"' }],
      ['Edit', 'edit', { a: { x: '+=2.5', t: '</VariableEdit><era_data>' }, 'k.1': 1 }],
      ['Delete', 'delete', { a: { x: {} } }],
      ['Insert', 'insert', [{ c: 1 }, { d: 2 }]],
    ]) {
      const results = [];
      for (const bypass of [false, true]) {
        const c = api_chat({ settings: { 数组内保留对象: keep } });
        const safe = plain(data);
        if (!bypass && safe.a?.t) delete safe.a.t;
        c.send('assistant', start + (bypass ? '' : `<Variable${tag}>${JSON.stringify(safe)}</Variable${tag}>`));
        await c.sync();
        if (bypass) {
          if (safe.a?.t) delete safe.a.t;
          await c.push_op(0, { type, data: safe });
          await c.sync();
        }
        results.push(plain(c.stat()));
      }
      assert.deepEqual(results[1], results[0], `${tag} ${keep}`);
    }
  }
  // 正文里无法安全表达的内容也能写入
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"t":"a"}</VariableInsert>');
  await c.sync();
  await c.api.updateByPath('t', '</VariableEdit><era_data>');
  await c.sync();
  assert.equal(c.stat().t, '</VariableEdit><era_data>');
});

test('写入路径：正文不变，默认设置仍写正文，关闭设置后已有写入继续生效', async () => {
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"hp":1}</VariableInsert>');
  await c.sync();
  const text = c.chat[0].swipes[0];
  await c.api.updateByPath('hp', '+=4');
  await c.sync();
  assert.equal(c.chat[0].swipes[0], text);
  assert.equal(c.stat().hp, 5);
  c.host.era_data.settings.value.API写入不修改消息 = false;
  await c.api.updateByObject({ hp: '*=10' });
  await c.sync();
  assert.equal(c.stat().hp, 50);
  assert.ok(c.chat[0].swipes[0].includes('*=10'));
  assert.deepEqual(c.stat(), await c.replay());

  const off = api_chat({ settings: { API写入不修改消息: false } });
  off.send('assistant', '<VariableInsert>{"hp":1}</VariableInsert>');
  await off.sync();
  await off.api.updateByPath('hp', 2);
  assert.equal(off.meta().ApiOps, undefined);
});

test('目标消息：末尾是用户消息、没有 MK、流式输出、没有 AI 消息、空聊天', async () => {
  let generating = false;
  const c = api_chat({ globals: { builtin: { duringGenerating: () => generating } } });
  const { findApiWriteTarget, clearProvisionalKey, ensureMessageKey } = c.host.mk;
  assert.equal(await findApiWriteTarget(), null);
  c.send('user', 'u');
  assert.equal((await findApiWriteTarget()).msg.message_id, 0);
  c.send('assistant', 'a');
  assert.equal((await findApiWriteTarget()).msg.message_id, 1);
  assert.ok(c.chat[1].swipes[0].includes('era-message-key'));
  c.send('user', 'u2');
  assert.equal((await findApiWriteTarget()).msg.message_id, 1);
  generating = true;
  c.send('assistant', '流式…');
  assert.equal((await findApiWriteTarget()).msg.message_id, 1);
  await ensureMessageKey({ message_id: 3, role: 'assistant', swipes: ['流式…'], swipe_id: 0 });
  assert.equal((await findApiWriteTarget()).msg.message_id, 1);
  clearProvisionalKey();
  assert.equal((await findApiWriteTarget()).msg.message_id, 3);
});

test('脚本新建的、还没有 MK 的 AI 消息：随后的 API 写入在它的正文之后生效', async () => {
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"hp":1}</VariableInsert>');
  await c.sync();
  c.send('assistant', '<VariableEdit>{"hp":10}</VariableEdit>');
  await c.api.updateByPath('hp', 50);
  await c.sync();
  assert.equal(c.stat().hp, 50);
});

test('复制消息：同步前写入只执行一次；已有写入随复制一起重放', async () => {
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  c.send('assistant', '剧情');
  await c.sync();
  await c.api.updateByPath('n', '+=1');
  await c.sync();
  c.chat.push(plain(c.chat[1]));
  await c.api.updateByPath('n', '+=10');
  await c.sync();
  assert.equal(c.stat().n, 12); // 原楼 +1，复制楼 +1，再 +10
  assert.deepEqual(c.stat(), await c.replay());
});

test('写入期间切换聊天则放弃', async () => {
  const c = api_chat();
  c.send('assistant', '没有 MK');
  let calls = 0;
  c.host.context.SillyTavern.getCurrentChatId = () => `chat${calls++}`;
  await c.api.updateByPath('hp', 1);
  assert.equal(c.meta().ApiOps, undefined);
});

test('尚未执行的写入：普通同步从它开始，执行后不再重复，且阻止快速同步', async () => {
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  c.send('assistant', '1');
  c.send('assistant', '2');
  await c.sync();
  await c.push_op(1, edit({ n: '+=1' }));
  c.chat.splice(2, 1); // 删除空日志的消息，本来会走快速同步
  await c.sync();
  assert.equal(c.stat().n, 1);
  const record = Object.values(c.ops())[0];
  assert.equal(record.applied, record.rev);
  await c.sync();
  assert.equal(c.stat().n, 1);
});

test('rollbackTo 包含目标之前尚未执行的写入', async () => {
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  for (let i = 0; i < 3; i++) c.send('assistant', '<VariableEdit>{"n":"+=1"}</VariableEdit>');
  await c.sync();
  await c.push_op(1, edit({ n: '+=100' }));
  await c.sync(false, 2, true);
  assert.equal(c.stat().n, 102);
  await c.sync();
  assert.equal(c.stat().n, 103);
});

test('同步期间到来的写入不会丢失', async () => {
  let c;
  let pushed = false;
  c = api_chat({
    hooks: [
      [
        '推入',
        () => {
          if (!pushed) {
            pushed = true;
            c.variables().ERAMetaData.ApiOps = {
              [c.chat[0].swipes[0].match(/era_mk_\w+/)[0]]: { rev: 1, applied: 0, ops: [edit({ n: 7 }, 1)] },
            };
          }
        },
      ],
    ],
  });
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  await c.host.mk.ensureMessageKey({ message_id: 0, role: 'assistant', swipes: [...c.chat[0].swipes], swipe_id: 0 });
  await c.host.era_data.updateEraMetaData(meta => meta);
  await c.sync();
  assert.equal(c.stat().n, 0);
  await c.sync();
  assert.equal(c.stat().n, 7);
});

test('“继续”追加的指令优先于旧的写入；钩子和 schema 对写入照常生效', async () => {
  const seen = [];
  const c = api_chat({
    before_hooks: [['看', ({ commands }) => void seen.push(commands.length)]],
    schema: z.object({ n: z.coerce.number().transform(v => Math.min(v, 100)) }),
  });
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  c.send('assistant', '剧情');
  c.send('user', '用户');
  await c.sync();
  await c.api.updateByPath('n', 999);
  await c.api.updateByPath('n', '坏');
  await c.sync();
  assert.equal(c.stat().n, 100);
  assert.equal(Object.values(c.ops())[0].ops.length, 2); // 有 schema / 钩子时不压缩
  assert.ok(seen.includes(2));
  c.chat[1].swipes[0] += '<VariableEdit>{"n":3}</VariableEdit>';
  await c.sync(false, 1);
  assert.equal(c.stat().n, 3);
});

test('清理：保留其他 swipe 的写入，删除已不存在的消息的写入', async () => {
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  c.send('assistant', 'a');
  await c.sync();
  await c.api.updateByPath('n', 1);
  await c.sync();
  c.swipe_new(1, 'b');
  await c.sync();
  await c.api.updateByPath('n', 2);
  await c.sync();
  await c.host.api_ops.pruneApiOps();
  assert.equal(Object.keys(c.ops()).length, 2);
  c.chat[1].swipe_id = 0;
  await c.sync();
  assert.equal(c.stat().n, 1);
  c.chat.pop();
  await c.sync();
  await c.host.api_ops.pruneApiOps();
  assert.equal(c.meta().ApiOps, undefined);
  assert.equal(c.stat().n, 0);
});

test('同一路径的多次写入只产生一条 update 日志', async () => {
  const c = api_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  c.send('assistant', '<VariableEdit>{"n":1}</VariableEdit><VariableEdit>{"n":2}</VariableEdit>');
  await c.sync();
  for (let i = 0; i < 5; i++) await c.api.updateByPath('n', `+=${i + 1}`);
  await c.sync();
  assert.equal(c.stat().n, 17);
  assert.equal(c.meta().EditLogs[c.meta().SelectedMks[1]].length, 3);
  c.chat.pop();
  await c.sync();
  assert.equal(c.stat().n, 0);
});
