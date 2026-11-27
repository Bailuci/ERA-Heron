/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：新增折叠日志存档：旧楼日志存到单独文件，可回滚与查询，缺失时自动从头重放；修复第三批改动在审查中发现的问题；修复复审中发现的问题；存档编号复用，文件数不随重算增长
 * 2026-11-27：假文件接口移到 chat.cjs；存档段日志压缩
 * 2026-11-27：插入后删除合并成不带旧值的 delete（回归用例）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 折叠日志的存档（Sidecar）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { create_chat, create_files, plain } = require('./chat.cjs');

const step = i =>
  `<VariableEdit>{"n":"+=1","地点":"地点${i}"}</VariableEdit><VariableInsert>{"中文":{"k${i}":${i}}}</VariableInsert>`;

async function archived_chat(server, { keep = 2, count = 28, settings = {}, ...options } = {}) {
  const c = create_chat({
    settings: { 日志保留楼层数: keep, 折叠日志存档: true, ...settings },
    globals: server.globals,
    ...options,
  });
  c.send('assistant', '<VariableInsert>{"n":0,"地点":"无","中文":{}}</VariableInsert>');
  await c.sync();
  for (let i = 1; i < count; i++) {
    c.send('assistant', step(i));
    await c.sync();
  }
  return c;
}

/** 重新打开聊天：同样的变量和正文，但没有内存缓存。 */
async function reopen(c, server, settings = {}) {
  const next = create_chat({
    settings: { 日志保留楼层数: 2, 折叠日志存档: true, ...settings },
    globals: server.globals,
  });
  for (const m of c.chat) next.chat.push(plain(m));
  Object.assign(next.variables(), plain(c.variables()));
  next.archive = next.host.load_src('core/log_archive');
  return next;
}

const at = (c, i) => plain(c.host.snapshot.getStatAtMK(c.meta().SelectedMks[i]));

test('存档：分段保存，聊天中只留近期日志；重新打开后仍能查询旧楼', async () => {
  const server = create_files();
  const c = await archived_chat(server);
  const { EditLogs, LogArchive } = c.meta();
  assert.equal(server.files.size, 2);
  assert.equal(LogArchive.segments.length, 2);
  assert.ok(Object.keys(EditLogs).length <= 13);
  assert.equal(at(c, 5).n, 5);

  const next = await reopen(c, server);
  assert.equal(at(next, 5), null, '读取之前不可用');
  await next.archive.loadArchive(next.meta());
  for (const i of [0, 5, 9, 10, 15, 19, 20, 27]) assert.equal(at(next, i).n, i);
  assert.equal(next.host.snapshot.getStatsBetweenMKs().length, 28);
});

test('存档：重新打开后继续折叠，旧的各段仍然可用', async () => {
  const server = create_files();
  let c = await archived_chat(server);
  c = await reopen(c, server);
  for (let i = 28; i < 45; i++) {
    c.send('assistant', step(i));
    await c.sync();
  }
  assert.ok(server.files.size >= 3);
  c = await reopen(c, server);
  await c.archive.loadArchive(c.meta());
  for (const i of [0, 7, 15, 25, 35, 44]) assert.equal(at(c, i).n, i);
});

test('存档：修改旧楼时靠存档回滚，不从头重放；没有存档时从头重放，结果相同', async () => {
  for (const has_file of [true, false]) {
    const server = create_files();
    const c = await archived_chat(server);
    if (!has_file) server.files.clear();
    const next = await reopen(c, server);
    let calls = 0;
    next.host.hook_registry.addHook('after', 'count', () => void calls++);
    next.chat.splice(17, 1);
    await next.sync();
    assert.equal(next.stat().n, 26);
    assert.deepEqual(plain(next.stat()), plain(await next.replay()));
    assert.ok(has_file ? calls < 20 : calls >= 27, `${has_file} ${calls}`);
    for (let i = 0; i < 15; i++) {
      next.send('assistant', step(100 + i));
      await next.sync();
    }
    assert.ok(next.meta().FoldedThroughMk);
    assert.equal(next.stat().n, 41);
    const again = await reopen(next, server);
    await again.archive.loadArchive(again.meta());
    assert.equal(at(again, 30).n, 30);
    assert.deepEqual(plain(again.stat()), plain(await again.replay()));
  }
});

test('存档：文件被改动、损坏、缺少其中一段时，只使用可信的部分', async () => {
  const changes = {
    中间的值: text => text.replace('地点3', '地点X'),
    格式错误: () => '[]',
    不是JSON: () => 'x',
    空文件: () => '',
  };
  for (const [name, change] of Object.entries(changes)) {
    const server = create_files();
    const c = await archived_chat(server);
    const [first] = c.meta().LogArchive.segments;
    server.files.set(first.path, change(server.files.get(first.path)));
    const next = await reopen(c, server);
    await next.archive.loadArchive(next.meta());
    assert.equal(at(next, 3), null, name);
    assert.equal(at(next, 15).n, 15, name);
    next.chat.splice(5, 1);
    await next.sync();
    assert.deepEqual(plain(next.stat()), plain(await next.replay()), name);
  }
});

test('存档：只访问自己的文件', async () => {
  const server = create_files();
  const c = await archived_chat(server);
  for (const path of ['https://example.com/era_logs_a_b_0.json', '/user/files/../x.json', '/user/files/secret.json']) {
    const next = await reopen(c, server);
    for (const segment of next.variables().ERAMetaData.LogArchive.segments) segment.path = path;
    server.log.length = 0;
    await next.archive.loadArchive(next.meta());
    assert.deepEqual(server.log, []);
  }
});

test('存档：保存失败时不折叠，日志留在聊天里；恢复后不会立刻反复重试', async () => {
  const server = create_files();
  server.fail = true;
  const c = await archived_chat(server, { count: 20 });
  assert.equal(c.meta().FoldedThroughMk, undefined);
  assert.equal(Object.keys(c.meta().EditLogs).length, 20);
  assert.equal(server.log.length, 1);
  assert.equal(at(c, 3).n, 3);
});

test('存档：保存期间切换聊天，结果不写进另一个聊天', async () => {
  const server = create_files();
  const c = await archived_chat(server, { count: 11 });
  server.during = () => (server.chat = 'other');
  c.send('assistant', step(11));
  const before = plain(c.variables());
  await c.sync();
  assert.deepEqual(plain(c.variables()).stat_data, before.stat_data);
  assert.equal(c.meta().FoldedThroughMk, undefined);
});

test('存档：编辑旧楼后存档失效，之后的回滚不会用到过时的内容', async () => {
  const server = create_files();
  const c = await archived_chat(server);
  c.host.era_data.settings.value.折叠日志存档 = false;
  const mk = /<era_data>.*<\/era_data>/.exec(c.chat[2].swipes[0])[0];
  c.chat[2].swipes[0] = `<VariableInsert>{"中文":{"新":1}}</VariableInsert><VariableEdit>{"n":"+=1"}</VariableEdit>${mk}`;
  await c.sync(true);
  const next = await reopen(c, server);
  next.chat.splice(3, 1);
  await next.sync();
  assert.deepEqual(plain(next.stat()), plain(await next.replay()));
  next.chat.splice(3, 12);
  await next.sync();
  assert.deepEqual(plain(next.stat()), plain(await next.replay()));
});

test('存档：中途关闭再开启，断开的各段不会被误用', async () => {
  const server = create_files();
  const c = await archived_chat(server);
  c.host.era_data.settings.value.折叠日志存档 = false;
  for (let i = 0; i < 3; i++) {
    c.send('assistant', step(200 + i));
    await c.sync();
  }
  assert.equal(at(c, 5), null);
  c.host.era_data.settings.value.折叠日志存档 = true;
  for (let i = 0; i < 15; i++) {
    c.send('assistant', step(300 + i));
    await c.sync();
  }
  assert.equal(at(c, 5), null);
  assert.equal(at(c, 33).n, 33);
  c.chat.splice(5, 1);
  await c.sync();
  assert.deepEqual(plain(c.stat()), plain(await c.replay()));
});

test('存档：SelectedMks 有空缺时从头重放，不会清空变量', async () => {
  for (const archive of [true, false]) {
    for (const keep of [2, 0]) {
      const server = create_files();
      const c = await archived_chat(server, { count: 16, keep, settings: { 折叠日志存档: archive } });
      c.send('assistant', step(16));
      c.send('assistant', step(17));
      await c.register_only();
      assert.ok(!c.meta().SelectedMks[16]);
      c.chat.pop();
      await c.sync();
      assert.deepEqual(plain(c.stat()), plain(await c.replay()), `${archive} ${keep}`);
      assert.equal(c.stat().n, 16);
    }
  }
});

test('存档：同名聊天、分支使用各自的文件；删除聊天时只删自己的', async () => {
  const server = create_files();
  await archived_chat(server);
  const own = [...server.files.keys()];
  server.character = 1;
  const other = await archived_chat(server);
  assert.equal(server.files.size, 4);
  const { deleteArchive } = other.host.load_src('core/log_archive');
  server.character = undefined;
  await deleteArchive('chat');
  assert.equal(server.files.size, 4, '不确定是谁的聊天时不删除');
  server.character = 1;
  await deleteArchive('别的聊天');
  assert.equal(server.files.size, 4);
  await deleteArchive('chat');
  assert.deepEqual([...server.files.keys()], own);
});

test('存档：在注册钩子之前靠存档重算，注册后钩子会应用到全部楼层', async () => {
  const server = create_files();
  const hook = ({ stat, old_stat }) => void (stat.count = (old_stat.count ?? 0) + 1);
  const c = await archived_chat(server, { hooks: [['count', hook]] });
  assert.equal(c.stat().count, 28);
  const next = await reopen(c, server);
  next.chat.splice(17, 1);
  await next.sync();
  next.host.hook_registry.addHook('after', 'count', hook);
  await next.sync();
  assert.equal(next.stat().count, 27);
});

test('存档：读取期间切换聊天，不会改动另一个聊天的正文', async () => {
  const server = create_files();
  const c = await reopen(await archived_chat(server), server);
  c.chat.splice(5, 0, { role: 'assistant', swipes: ['脚本插入的楼层'], swipe_id: 0 });
  const before = plain(c.chat);
  const original = server.globals.fetch;
  c.host.context.fetch = async (...args) => {
    server.chat = 'other';
    return original(...args);
  };
  await c.sync();
  assert.deepEqual(plain(c.chat), before);
});

test('存档：只重算了一部分时，之后注册的钩子仍会应用到全部楼层', async () => {
  const server = create_files();
  const hook = ({ stat, old_stat }) => void (stat.count = (old_stat.count ?? 0) + 1);
  const c = await archived_chat(server, { hooks: [['count', hook]] });
  const next = await reopen(c, server);
  next.chat.splice(5, 1);
  await next.sync();
  next.host.hook_registry.addHook('after', 'count', hook);
  await next.sync(false, 15, true);
  await next.sync();
  assert.equal(next.stat().count, 27);
});

test('SelectedMks 有空缺的未折叠聊天：在注册钩子之前从头重放，注册后会再次应用', async () => {
  const hook = ({ stat, old_stat }) => void (stat.count = (old_stat.count ?? 0) + 1);
  const c = create_chat({ hooks: [['count', hook]] });
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  for (let i = 0; i < 4; i++) c.send('assistant', step(i));
  await c.sync();
  c.send('user', 'u');
  c.send('user', 'u');
  await c.register_only();
  const next = create_chat();
  for (const m of c.chat) next.chat.push(plain(m));
  Object.assign(next.variables(), plain(c.variables()));
  next.chat.pop();
  await next.sync();
  next.host.hook_registry.addHook('after', 'count', hook);
  await next.sync();
  assert.equal(next.stat().count, 5);
});

test('没有登记过的 AI 楼层不会被永久跳过', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  await c.sync();
  c.send('assistant', '<VariableEdit>{"n":"+=1"}</VariableEdit>');
  c.send('user', 'u');
  await c.register_only();
  c.send('assistant', '<VariableEdit>{"n":"+=10"}</VariableEdit>');
  await c.sync();
  assert.equal(c.stat().n, 11);
});

test('存档：分支从 0 开始编号，不覆盖仍在使用的文件，删除时能找全', async () => {
  const server = create_files();
  const c = await archived_chat(server);
  server.chat = 'branch';
  const branch = await reopen(c, server);
  for (let i = 28; i < 45; i++) {
    branch.send('assistant', step(i));
    await branch.sync();
  }
  const { getSegmentPath, deleteArchive } = branch.archive;
  assert.ok(server.files.has(getSegmentPath('a.png\nbranch', 0)));
  for (const i of [3, 15, 25, 40]) {
    await branch.archive.loadArchive(branch.meta());
    assert.equal(at(branch, i).n, i);
  }
  await deleteArchive('branch');
  assert.ok([...server.files.keys()].every(path => !path.includes(getSegmentPath('a.png\nbranch', 0).slice(0, -6))));
  assert.equal(server.files.size, 2);
});

test('存档：完全重算、修改旧楼之后复用编号，文件数不再增长，删除聊天时仍能找全', async () => {
  const server = create_files();
  const c = await archived_chat(server);
  const initial = server.files.size;
  assert.ok(initial >= 2);
  for (let round = 0; round < 3; round++) {
    await c.sync(true);
    assert.ok(server.files.size <= initial, `第 ${round} 次完全重算后 ${server.files.size} 个文件`);
    assert.deepEqual(plain(c.stat()), plain(await c.replay()));
  }
  for (let round = 0; round < 3; round++) {
    await c.host.load_src('core/log_archive').loadArchive(c.meta());
    c.chat.splice(15, 1);
    c.send('assistant', step(200 + round));
    await c.sync();
    assert.ok(server.files.size <= initial + 1, `第 ${round} 次修改旧楼后 ${server.files.size} 个文件`);
    assert.deepEqual(plain(c.stat()), plain(await c.replay()));
  }
  const next = await reopen(c, server);
  await next.archive.loadArchive(next.meta());
  assert.ok(at(next, 1), '旧楼仍可查询');
  await next.archive.deleteArchive('chat');
  assert.equal(server.files.size, 0, '删除聊天时一个不剩');
});

// ---------------------------------------------------------------------------
// 存档段的日志压缩（1.9-1）

const compressor = () => {
  const module = create_chat().host.load_src('core/log_compress');
  // 宿主在另一个 realm 中运行，比较前转成普通对象
  return {
    compressFloorLog: log => plain(module.compressFloorLog(log)),
    compressSegmentLogs: (...args) => plain(module.compressSegmentLogs(...args)),
  };
};
const upd = (path, value_old, value_new) => ({ op: 'update', path, value_old, value_new });
const ins = (path, value_new) => ({ op: 'insert', path, value_new });
const del = (path, value_old) => ({ op: 'delete', path, value_old });

test('日志压缩：同一路径的更新链合并，合并后的条目在后一条的位置', () => {
  const { compressFloorLog } = compressor();
  assert.deepEqual(compressFloorLog([upd('a.b', 1, 2), upd('c', 0, 1), upd('a.b', 2, 3)]), [
    upd('c', 0, 1),
    upd('a.b', 1, 3),
  ]);
  // a[0] 与 a.0 是同一路径
  assert.deepEqual(compressFloorLog([upd('a[0]', 1, 2), upd('a.0', 2, 3), upd('a.0', 3, 4)]), [upd('a.0', 1, 4)]);
  // 首尾决定合并结果：insert 开头的仍是 insert，delete 结尾的是 delete，delete 后 insert 是 update
  assert.deepEqual(compressFloorLog([ins('k', 1), upd('k', 1, 2)]), [ins('k', 2)]);
  assert.deepEqual(compressFloorLog([upd('k', 1, 2), del('k', 2)]), [del('k', 1)]);
  assert.deepEqual(compressFloorLog([del('k', 1), ins('k', 5)]), [upd('k', 1, 5)]);
  // 缺少旧值的 update 回滚时是删除，等同 insert
  assert.deepEqual(compressFloorLog([{ op: 'update', path: 'k', value_new: 1 }, upd('k', 1, 2)]), [ins('k', 2)]);
});

test('日志压缩：中间有前缀或后代路径的操作时不合并', () => {
  const { compressFloorLog } = compressor();
  // 前缀夹插：a.b 更新、a 被整体替换、a.b 再更新
  const prefix = [upd('a.b', 1, 2), upd('a', { b: 2 }, { b: 5 }), upd('a.b', 5, 6)];
  assert.deepEqual(compressFloorLog(prefix), prefix);
  // 后代夹插
  const child = [upd('a', 1, { x: 1 }), upd('a.x', 1, 2), upd('a', { x: 2 }, 3)];
  assert.deepEqual(compressFloorLog(child), child);
  // 只是名字相近的路径不相关
  assert.deepEqual(compressFloorLog([upd('a.b', 1, 2), upd('a.bc', 1, 2), upd('ab', 1, 2), upd('a.b', 2, 3)]), [
    upd('a.bc', 1, 2),
    upd('ab', 1, 2),
    upd('a.b', 1, 3),
  ]);
  // 无法分析的条目与一切相关
  const odd = [upd('a', 1, 2), { op: 'move', path: 'z' }, upd('a', 2, 3)];
  assert.deepEqual(compressFloorLog(odd), odd);
  const empty = [upd('a', 1, 2), { op: 'update', path: '' }, upd('a', 2, 3)];
  assert.deepEqual(compressFloorLog(empty), empty);
});

test('日志压缩：insert 后紧跟 delete 合并成不带旧值的 delete，中间有相关操作时不合并', () => {
  const { compressFloorLog } = compressor();
  assert.deepEqual(compressFloorLog([ins('a.k', 1), upd('b', 1, 2), del('a.k', 1)]), [
    upd('b', 1, 2),
    { op: 'delete', path: 'a.k' },
  ]);
  // 再插入时与这条 delete 合并成 insert
  assert.deepEqual(compressFloorLog([ins('k', 1), del('k', 1), ins('k', 2)]), [ins('k', 2)]);
  const between = [ins('a.k', { z: 1 }), upd('a.k.z', 1, 2), del('a.k', { z: 2 })];
  assert.deepEqual(compressFloorLog(between), between);
  const parent = [ins('a.k', 1), del('a', { k: 1 }), ins('a', {}), del('a.k', undefined)];
  assert.equal(compressFloorLog(parent).length, 3); // 只有 del a + ins a 合并
});

test('日志压缩：逐楼自检，正向或回滚结果与原日志不同的楼保留原日志', () => {
  const { compressSegmentLogs } = compressor();
  const logs = {
    // 合并成 delete 后少了 insert 顺带建立的父对象 a.b，正向结果不同
    m1: [ins('a.b.c', 1), del('a.b.c', 1)],
    // 可以压缩
    m2: [upd('n', 0, 1), upd('n', 1, 2), upd('n', 2, 3)],
    // 没有可压缩的
    m3: [upd('n', 3, 4)],
  };
  const result = compressSegmentLogs([ins('n', 0)], logs, ['m1', 'm2', 'm3']);
  assert.deepEqual(result.logs.m1, logs.m1);
  assert.deepEqual(result.logs.m2, [upd('n', 0, 3)]);
  assert.deepEqual(result.logs.m3, logs.m3);
  assert.equal(result.compressed, 1);
  assert.equal(result.rejected, 1);
  // 字符串形式的旧日志同样可以压缩
  const text = compressSegmentLogs([], { m: JSON.stringify([ins('k', 1), upd('k', 1, 2)]) }, ['m']);
  assert.deepEqual(text.logs.m, [ins('k', 2)]);
});

test('回归：insert 后 delete 合并后，回滚仍删除该路径，清掉后一楼回滚留下的空对象', () => {
  const { compressSegmentLogs } = compressor();
  const logs = {
    // 父对象 t 已存在：插入后删除，正向结果不变
    m1: [ins('t.k', 1), del('t.k', 1)],
    // 后一楼在 t.k 下插入子路径；回滚它会留下空对象 t.k = {}
    m2: [ins('t.k.z', 5)],
  };
  const result = compressSegmentLogs([ins('t', {})], logs, ['m1', 'm2']);
  // 以前整体抵消成空，回滚 m1 后 t.k = {} 残留，与原日志不同而被拒绝
  assert.deepEqual(result.logs.m1, [{ op: 'delete', path: 't.k' }]);
  assert.equal(result.compressed, 1);
  assert.equal(result.rejected, 0);
  const { timetravel } = create_chat().host;
  const rolled = timetravel.applyRollback(timetravel.applyRollback({ t: { k: { z: 5 } } }, logs.m2), result.logs.m1);
  assert.deepEqual(plain(rolled), { t: {} });
  // 正向对不存在的路径删除等于不做，不建立父对象
  assert.deepEqual(plain(timetravel.applyForward({}, [{ op: 'delete', path: 'x.y' }])), {});
});

/** 每楼含可合并的更新链、前缀夹插与插入后删除。 */
const dense_step = i =>
  `<VariableEdit>{"n":"+=1"}</VariableEdit><VariableEdit>{"a":{"b":${i}}}</VariableEdit>` +
  `<VariableEdit>{"n":"+=1"}</VariableEdit>` +
  (i % 3 === 0
    ? `<VariableDelete>{"a":{}}</VariableDelete><VariableInsert>{"a":{"b":${-i},"c":[${i}]}}</VariableInsert>`
    : '') +
  `<VariableEdit>{"a":{"b":${i * 2}}}</VariableEdit>` +
  `<VariableInsert>{"临时":{"k${i}":1}}</VariableInsert><VariableDelete>{"临时":{"k${i}":{}}}</VariableDelete>` +
  `<VariableEdit>{"n":"+=1"}</VariableEdit>`;

test('日志压缩：存档段里的日志被压缩，还原后查询、回滚与不折叠时完全相同', async () => {
  const server = create_files();
  const c = create_chat({ settings: { 日志保留楼层数: 2, 折叠日志存档: true }, globals: server.globals });
  const ref = create_chat();
  for (const chat of [c, ref]) {
    chat.send('assistant', '<VariableInsert>{"n":0,"a":{"b":0},"临时":{}}</VariableInsert>');
    await chat.sync();
    for (let i = 1; i < 28; i++) {
      chat.send('assistant', dense_step(i));
      await chat.sync();
    }
  }
  assert.ok(server.files.size >= 2);
  // 存档里的日志条目比不折叠时少
  let archived = 0;
  let original = 0;
  for (const text of server.files.values()) {
    const file = JSON.parse(text);
    for (const [mk, log] of Object.entries(file.logs)) {
      const i = c.meta().SelectedMks.indexOf(mk);
      archived += log.length;
      original += ref.meta().EditLogs[ref.meta().SelectedMks[i]].length;
    }
  }
  assert.ok(archived < original * 0.7, `${archived} / ${original}`);

  const next = await reopen(c, server);
  await next.archive.loadArchive(next.meta());
  for (let i = 0; i < 28; i++) {
    assert.deepEqual(at(next, i), plain(ref.host.snapshot.getStatAtMK(ref.meta().SelectedMks[i])), `第 ${i} 楼`);
  }
  // 修改旧楼：靠还原的（压缩过的）日志回滚
  for (const index of [16, 9, 4]) {
    next.chat.splice(index, 1);
    await next.sync();
    assert.deepEqual(plain(next.stat()), plain(await next.replay()), `删除第 ${index} 楼`);
  }
});
