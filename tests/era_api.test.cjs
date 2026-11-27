/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：测试：写入事件、查询事件、Era.getVarsAt、等待式写入的目标楼被删除或滑走、全局接口 Era 的参数检查，
 *       以及 exported.era.d.ts、doc/05 与 api/global.ts 的一致性；1.7 新增、待文档阶段补写的成员暂时登记在 PENDING_DOCS_1_7
 *       2026-11-27 文档已补写，删除 PENDING_DOCS_1_7；检查新增的 Era 成员在 doc/05 中有小节（2.0.0 起不再标注版本）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 对外接口（events/handlers/api、api/）测试。运行方式: node --test tests/era_api.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const z = require('zod');
const { create_chat, plain } = require('./chat.cjs');

const ROOT = path.join(__dirname, '..');
const T = (tag, value) => `<Variable${tag}>${JSON.stringify(value)}</Variable${tag}>`;

/** 带有事件监听、定时器等接口的假聊天。 */
function create_env(options = {}) {
  const listeners = {};
  const toasts = [];
  const env = create_chat({
    ...options,
    globals: {
      eventOn: (name, fn) => {
        (listeners[name] ??= []).push(fn);
        return { stop() {} };
      },
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
    listeners,
    mk: i => env.host.mk.readMessageKey({ message_id: i, ...env.chat[i] }),
    /** 最后一次 `era:queryResult` 的载荷。 */
    query: () => plain(env.host.emitted.filter(e => e.name === 'era:queryResult').at(-1)?.payload),
    /** 与同步事件一致：同步后结算凭据。 */
    sync_settle: async (...args) => {
      await env.sync(...args);
      tickets.settleTickets();
    },
  };
}

const BASE = { a: { x: 1, y: 2, z: 3 }, list: ['a', 'b'] };

// ============================ 写入事件 ============================

test('写入事件：insert/delete ByPath、ByObject 与 era:patch 的结果与等价的正文指令相同，并随楼层回滚', async () => {
  const cases = [
    ['insertByPath', api => api.insertByPath('a.new', 5), T('Insert', { a: { new: 5 } })],
    ['insertByObject', api => api.insertByObject({ b: { x: 1 } }), T('Insert', { b: { x: 1 } })],
    ['deleteByPath', api => api.deleteByPath('a.y'), T('Delete', { a: { y: {} } })],
    ['deleteByObject', api => api.deleteByObject({ a: { z: {} } }), T('Delete', { a: { z: {} } })],
    ['updateByPath', api => api.updateByPath('a.x', '+=4'), T('Edit', { a: { x: '+=4' } })],
    [
      'patch',
      api =>
        api.patch([
          { op: 'insert', path: '/list/-', value: 'c' },
          { op: 'remove', path: '/list/0' },
        ]),
      T('Patch', [
        { op: 'insert', path: '/list/-', value: 'c' },
        { op: 'remove', path: '/list/0' },
      ]),
    ],
    [
      'patch（单个操作）',
      api => api.patch({ op: 'replace', path: '/a', value: { k: 1 } }),
      T('Patch', [{ op: 'replace', path: '/a', value: { k: 1 } }]),
    ],
  ];
  for (const [name, write, block] of cases) {
    const text = create_env();
    text.send('assistant', T('Insert', BASE));
    text.send('assistant', `剧情${block}`);
    await text.sync();
    const expected = plain(text.stat());

    for (const bypass of [false, true]) {
      const env = create_env({ settings: { API写入不修改消息: bypass } });
      env.send('assistant', T('Insert', BASE));
      env.send('assistant', '剧情');
      await env.sync();
      await write(env.handler);
      await env.sync();
      assert.deepEqual(plain(env.stat()), expected, `${name} bypass=${bypass}`);
      assert.equal(env.chat[1].swipes[0].includes('<Variable'), !bypass, `${name} bypass=${bypass} 正文`);
      assert.deepEqual(plain(env.stat()), plain(await env.replay()), `${name} bypass=${bypass} 重放`);
      env.chat.pop();
      await env.sync();
      assert.deepEqual(plain(env.stat()), BASE, `${name} bypass=${bypass} 回滚`);
    }
  }
});

// ============================ 查询事件 ============================

async function three_floors(options) {
  const env = create_env(options);
  env.send('assistant', T('Insert', { n: 0 }));
  env.send('user', '用户');
  env.send('assistant', T('Edit', { n: 2 }));
  await env.sync();
  return env;
}

test('查询事件：当前变量、按 MK / 消息 ID 取快照、范围查询，结果带回原始请求', async () => {
  const env = await three_floors();
  const { handler } = env;

  handler.handleGetCurrentVars({ tag: 1 });
  let q = env.query();
  assert.equal(q.queryType, 'getCurrentVars');
  assert.deepEqual(q.request, { tag: 1 });
  assert.deepEqual(q.result, {
    mk: env.mk(2),
    message_id: 2,
    is_user: false,
    stat: { n: 2 },
    statWithoutMeta: { n: 2 },
  });
  assert.deepEqual(q.selectedMks, [env.mk(0), env.mk(1), env.mk(2)]);

  handler.handleGetSnapshotAtMk({ mk: env.mk(1), id: 'x' });
  q = env.query();
  assert.equal(q.queryType, 'getSnapshotAtMk');
  assert.equal(q.request.id, 'x');
  assert.deepEqual(q.result, {
    mk: env.mk(1),
    message_id: 1,
    is_user: true,
    stat: { n: 0 },
    statWithoutMeta: { n: 0 },
  });

  handler.handleGetSnapshotAtMId({ message_id: 0 });
  assert.deepEqual(env.query().result.statWithoutMeta, { n: 0 });
  handler.handleGetSnapshotAtMId({ message_id: 2 });
  assert.deepEqual(env.query().result.statWithoutMeta, { n: 2 });

  handler.handleGetSnapshotsBetweenMks({ startMk: env.mk(1), endMk: env.mk(2) });
  q = env.query();
  assert.equal(q.queryType, 'getSnapshotsBetweenMks');
  assert.deepEqual(
    q.result.map(r => [r.message_id, r.is_user, r.statWithoutMeta.n]),
    [
      [1, true, 0],
      [2, false, 2],
    ],
  );
  handler.handleGetSnapshotsBetweenMks({});
  assert.equal(env.query().result.length, 3);

  handler.handleGetSnapshotsBetweenMIds({ startId: 0, endId: 1 });
  assert.deepEqual(
    env.query().result.map(r => r.message_id),
    [0, 1],
  );
  handler.handleGetSnapshotsBetweenMIds();
  assert.deepEqual(
    env.query().result.map(r => r.statWithoutMeta.n),
    [0, 0, 2],
  );
});

test('查询事件：参数缺失、越界、startId > endId 时返回 error', async () => {
  const env = await three_floors();
  const { handler } = env;
  const error = () => env.query().result.error;

  handler.handleGetSnapshotAtMk({});
  assert.match(error(), /缺少 "mk"/);
  handler.handleGetSnapshotAtMk({ mk: 'era_mk_none' });
  assert.match(error(), /找不到/);
  assert.equal(env.query().result.stat, null);
  handler.handleGetSnapshotAtMId({ message_id: '1' });
  assert.match(error(), /类型不正确/);
  for (const message_id of [-1, 3]) {
    handler.handleGetSnapshotAtMId({ message_id });
    assert.match(error(), /超出范围/);
  }
  handler.handleGetSnapshotsBetweenMIds({ startId: 2, endId: 1 });
  assert.match(error(), /无效或超出范围/);
  handler.handleGetSnapshotsBetweenMIds({ startId: 0, endId: 9 });
  assert.match(error(), /无效或超出范围/);
  handler.handleGetSnapshotsBetweenMks({ startMk: 'era_mk_none' });
  assert.ok(Array.isArray(env.query().result));
});

async function folded_env() {
  const env = create_env({ settings: { 日志保留楼层数: 2 } });
  env.send('assistant', T('Insert', { a: 1 }));
  for (let i = 0; i < 6; i++) env.send('assistant', T('Edit', { a: i + 2 }));
  await env.sync();
  await env.sync();
  assert.ok(env.meta().FoldedThroughMk);
  return env;
}

test('查询事件：日志折叠且没有存档时，旧楼返回 error，近期楼层照常', async () => {
  const env = await folded_env();
  env.handler.handleGetSnapshotAtMId({ message_id: 1 });
  assert.match(env.query().result.error, /已被清理/);
  env.handler.handleGetSnapshotAtMk({ mk: env.mk(1) });
  assert.match(env.query().result.error, /找不到/);
  env.handler.handleGetSnapshotAtMId({ message_id: 6 });
  assert.deepEqual(env.query().result.statWithoutMeta, { a: 7 });
});

test('era:requestWriteDone：没有历史时不广播，有历史时重播上一次的 writeDone', async () => {
  const env = create_env();
  const writeDone = () => env.host.emitted.filter(e => e.name === 'era:writeDone');
  env.handler.handleRequestWriteDone();
  assert.equal(writeDone().length, 0);

  const payload = { mk: 'era_mk_x', message_id: 0, stat: { n: 1 }, actions: {} };
  for (const listener of env.listeners['era:writeDone'] ?? []) listener(payload);
  env.handler.handleRequestWriteDone();
  assert.equal(writeDone().length, 1);
  assert.equal(writeDone()[0].payload.mk, 'era_mk_x');
});

// ============================ Era.getVarsAt ============================

test('getVarsAt：按消息 ID（含负数）、MK、对象取某一楼处理完之后的变量', async () => {
  const env = await three_floors();
  const { getVarsAt } = env.load('api/vars_at');
  const at = async where => plain(await getVarsAt(where));
  assert.deepEqual(await at(0), {
    mk: env.mk(0),
    message_id: 0,
    is_user: false,
    stat: { n: 0 },
    statWithoutMeta: { n: 0 },
  });
  assert.equal((await at(1)).is_user, true);
  assert.equal((await at(-1)).message_id, 2);
  assert.equal((await at(-1)).statWithoutMeta.n, 2);
  assert.equal((await at(env.mk(2))).statWithoutMeta.n, 2);
  assert.equal((await at({ message_id: 2, mk: env.mk(0) })).message_id, 0, '同时给出时以 mk 为准');

  // 编辑更早的楼层后，之后各楼的值随之变化
  env.chat[0].swipes[0] = env.chat[0].swipes[0].replace('{"n":0}', '{"n":5}');
  await env.sync(false, 0);
  assert.equal((await at(1)).statWithoutMeta.n, 5);
  assert.equal((await at(2)).statWithoutMeta.n, 2);
});

test('getVarsAt：楼层不存在、还没有计算到、MK 不在当前显示中、参数无效时失败', async () => {
  const env = await three_floors();
  const { getVarsAt } = env.load('api/vars_at');
  await assert.rejects(getVarsAt(9), /不存在/);
  await assert.rejects(getVarsAt('era_mk_none'), /不存在/);
  for (const where of [undefined, null, 1.5, NaN, {}, true]) {
    await assert.rejects(getVarsAt(where), /请提供/);
  }
  env.send('assistant', '还没有同步');
  await assert.rejects(getVarsAt(3), /还没有计算完成/);
  const old_mk = env.mk(2);
  env.swipe_new(2, T('Edit', { n: 9 }));
  await env.sync();
  await assert.rejects(getVarsAt(old_mk), /当前没有显示/);
  assert.equal((await getVarsAt(2)).statWithoutMeta.n, 9);
});

test('getVarsAt：日志折叠且没有存档时，旧楼明确失败', async () => {
  const env = await folded_env();
  const { getVarsAt } = env.load('api/vars_at');
  await assert.rejects(getVarsAt(1), /已折叠/);
  assert.deepEqual(plain(await getVarsAt(6)).statWithoutMeta, { a: 7 });
});

// ============================ 等待式写入的目标楼 ============================

/** 提交但不同步，返回带有超时的 Promise。 */
async function commit_pending(env, operations, detail) {
  const { ticket, promise } = env.tickets.createTicket(5000);
  promise.catch(() => {});
  await env.handler.commit({ operations, ...detail }, ticket);
  return promise;
}

test('commit：计算完成前目标楼被删除或滑走，立即失败并说明原因', async () => {
  for (const change of ['删除', '滑走']) {
    const env = create_env();
    env.send('assistant', T('Insert', { a: 1 }));
    env.send('assistant', '剧情');
    await env.sync();
    const started = Date.now();
    const promise = commit_pending(env, { edit: { a: 2 } }, { message_id: 1 });
    await new Promise(resolve => setImmediate(resolve));
    if (change === '删除') env.chat.pop();
    else env.swipe_new(1, '另一个回复');
    await env.sync_settle();
    await assert.rejects(promise, /目标消息已被删除或切换/, change);
    assert.ok(Date.now() - started < 3000, change);
    assert.equal(env.stat().a, 1, change);
  }
});

test('commit：目标楼还没有同步到时继续等待，同步后完成', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  env.send('assistant', '新消息');
  const promise = commit_pending(env, { edit: { a: 2 } }, { message_id: 1 });
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise(resolve => setImmediate(resolve));
  env.tickets.settleTickets();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  await env.sync_settle();
  assert.equal((await promise).statWithoutMeta.a, 2);
});

// ============================ 全局接口 Era ============================

test('Era：commit 的参数检查、注册失败的提示、hasHook、getVarsAt', async () => {
  const env = await three_floors();
  const { Era } = env.load('api/global');

  await assert.rejects(Era.commit(undefined), /没有要写入的内容/);
  await assert.rejects(Era.commit(null), /没有要写入的内容/);
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(Era.commit({ edit: cyclic }), /无法转换成 JSON/);

  const off = Era.registerSchema({});
  assert.equal(typeof off, 'function');
  assert.equal(Era.hasSchema(), false);
  assert.equal(env.toasts.at(-1)[0], 'error');
  assert.match(env.toasts.at(-1)[2], /变量结构注册失败/);
  off();

  const count = env.toasts.length;
  Era.registerSchema(z.object({ n: z.number() }), { resync: false });
  assert.equal(Era.hasSchema(), true);
  assert.equal(env.toasts.length, count);

  const bad = Era.onAfterApply('', () => {}, { resync: false });
  assert.equal(typeof bad, 'function');
  assert.match(env.toasts.at(-1)[2], /钩子注册失败/);
  Era.onBeforeApply('卡.钩子', () => {}, { resync: false });
  assert.equal(Era.hasHook('卡.钩子'), true);
  assert.equal(Era.hasHook('卡.钩子', 'before'), true);
  assert.equal(Era.hasHook('卡.钩子', 'after'), false);
  const unregister = Era.onAfterApply('卡.钩子', () => {}, { resync: false });
  assert.equal(Era.hasHook('卡.钩子', 'after'), true);
  unregister();
  assert.equal(Era.hasHook('卡.钩子', 'after'), false);
  assert.equal(Era.hasHook('不存在'), false);

  assert.equal(plain(await Era.getVarsAt(1)).statWithoutMeta.n, 0);
  assert.equal(plain(Era.getCurrentVars()).statWithoutMeta.n, 2);
});

// ============================ 类型声明与文档的一致性 ============================

function parse(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

const nameOf = node =>
  node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : null;

/** 收集对象字面量或类型字面量的成员名，`extra` 等嵌套对象记为 `extra.run`。 */
function collect(node, prefix = '') {
  const names = [];
  for (const member of node.properties ?? node.members ?? []) {
    const name = nameOf(member);
    if (!name) continue;
    names.push(prefix + name);
    // 只展开属性的值（如 `extra: { ... }`），不展开方法的返回类型
    const inner = ts.isPropertyAssignment(member)
      ? member.initializer
      : ts.isPropertySignature(member)
        ? member.type
        : null;
    if (inner && (ts.isObjectLiteralExpression(inner) || ts.isTypeLiteralNode(inner))) {
      names.push(...collect(inner, `${prefix}${name}.`));
    }
  }
  return names;
}

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => find(child, predicate));
}

function eraMembers() {
  const global = find(
    parse('src/ERA变量框架/api/global.ts'),
    n =>
      ts.isVariableDeclaration(n) &&
      nameOf(n) === 'Era' &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer),
  );
  const declared = find(
    parse('开发工具/exported.era.d.ts'),
    n => ts.isVariableDeclaration(n) && nameOf(n) === 'Era' && n.type && ts.isTypeLiteralNode(n.type),
  );
  assert.ok(global && declared, '找不到 Era 的定义或声明');
  return { implemented: collect(global.initializer).sort(), declared: collect(declared.type).sort() };
}

test('exported.era.d.ts 声明的 Era 与 api/global.ts 实现的一致', () => {
  const { implemented, declared } = eraMembers();
  assert.ok(implemented.includes('getVarsAt') && implemented.includes('hasHook'));
  assert.deepEqual(
    implemented.filter(name => !declared.includes(name)),
    [],
    'global.ts 中有 d.ts 没有声明的方法',
  );
  assert.deepEqual(
    declared.filter(name => !implemented.includes(name)),
    [],
    'd.ts 声明了 global.ts 中没有的方法',
  );
});

test('exported.era.d.ts 的 ListenerType 包含全部对外事件', () => {
  const { host } = create_env();
  const { ERA_API_EVENTS, ERA_EVENT_EMITTER } = host.load_src('utils/constants');
  const listener = find(
    parse('开发工具/exported.era.d.ts'),
    n => ts.isInterfaceDeclaration(n) && n.name.text === 'ListenerType',
  );
  const declared = listener.members.map(nameOf);
  const internal = ['era:writeExtra', 'era:apiWrite'];
  const events = [...Object.values(ERA_API_EVENTS), ...Object.values(ERA_EVENT_EMITTER)].filter(
    e => !internal.includes(e),
  );
  assert.deepEqual(
    events.filter(e => !declared.includes(e)),
    [],
  );
});

test('doc/05 介绍了 Era 的每个方法', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'doc/05-接口与设置.md'), 'utf8');
  const { implemented } = eraMembers();
  const missing = implemented.filter(name => {
    const [head, sub] = name.split('.');
    if (!sub) return !doc.includes(`Era.${head}`);
    return !doc.includes(`Era.${name}`) && !doc.includes(`.${sub}(`);
  });
  assert.deepEqual(missing, []);
});

/** 后来新增的 Era 成员，以及新增的事件与斜杠命令：doc/05 中要有自己的小节。 */
const NEW_IN_1_7 = [
  'Era.version',
  'Era.features',
  'Era.parseCommands',
  'Era.applyText',
  'Era.keepMessageKey',
  'Era.math',
  'Era.registerEntryFilter',
  'Era.hasEntryFilter',
  'Era.checkSchema',
  'era:schemaInvalid',
  '/era-get',
  '/era-issues',
  'Era.registerTool',
  'Era.setMessageText',
  'Era.registerExprFn',
];

test('doc/05 中新增的接口、事件与命令有自己的小节', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'doc/05-接口与设置.md'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const isHeading = line => /^#{2,4} /.test(line);
  for (const name of NEW_IN_1_7) {
    const index = lines.findIndex(line => isHeading(line) && line.includes(`\`${name}\``));
    assert.notEqual(index, -1, `doc/05 没有 ${name} 的小节`);
  }
  // 新成员必须已经在 Era 上实现，避免名单与实现脱节
  const { implemented } = eraMembers();
  for (const name of NEW_IN_1_7.filter(item => item.startsWith('Era.'))) {
    assert.ok(implemented.includes(name.slice(4)), `${name} 不在 api/global.ts 中`);
  }
});
