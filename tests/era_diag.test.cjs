/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：测试：钩子的重入保护、变量结构诊断与一键修复、{{ERA-issues}}、聊天数据体积诊断、新卡状态栏旧楼不监听 era:writeDone；钩子里不 await 写入接口时没有未处理的 rejection
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 诊断与保护（1.7-3、1.7-6、1.7-7、1.7-8）。运行方式: node --test tests/era_diag.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const _ = require('lodash');
const z = require('zod');
const { create_chat, plain } = require('./chat.cjs');

const ROOT = path.join(__dirname, '..');
const T = (tag, value) => `<Variable${tag}>${JSON.stringify(value)}</Variable${tag}>`;
const tick = () => new Promise(resolve => setImmediate(resolve));

/** 带有同步事件总线（与酒馆一样：第一个监听器在 emit 的调用栈内执行）、弹窗等接口的假聊天。 */
function create_env(options = {}) {
  const listeners = {};
  const toasts = [];
  const emitted = [];
  let chat_id = 'chat';
  const env = create_chat({
    ...options,
    globals: {
      SillyTavern: {
        name1: 'User',
        name2: 'Char',
        characterId: 'test-card',
        characters: {},
        getCurrentChatId: () => chat_id,
      },
      eventOn: (name, fn) => {
        (listeners[name] ??= []).push(fn);
        return { stop() {} };
      },
      eventMakeFirst: (name, fn) => {
        (listeners[name] ??= []).unshift(fn);
        return { stop() {} };
      },
      eventRemoveListener: () => {},
      eventEmit: (name, ...args) => {
        emitted.push({ name, payload: args[0] });
        const [first] = listeners[name] ?? [];
        if (first) first(...args);
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
  const tickets = load('events/handlers/api/tickets');
  const commit_raw = load('events/handlers/api/handler').commit;
  const sync = async (...args) => {
    await env.sync(...args);
    tickets.settleTickets();
  };
  return {
    ...env,
    load,
    tickets,
    sync,
    listeners,
    toasts,
    emitted,
    switch_chat: id => (chat_id = id),
    mk: i => env.host.mk.readMessageKey({ message_id: i, ...env.chat[i] }),
    of: name => emitted.filter(e => e.name === name).map(e => plain(e.payload)),
    commit: async (operations, detail = {}) => {
      const { ticket, promise } = tickets.createTicket(500);
      promise.catch(() => {});
      await commit_raw({ operations, ...detail }, ticket);
      await sync();
      return promise;
    },
  };
}

// ============================ 1.7-7 重入保护 ============================

test('重入保护：runGuarded 期间写入入口被拒绝，钩子自己吞掉异常也会被记为违规', () => {
  const { load } = create_env();
  const reentry = load('core/reentry');
  assert.equal(reentry.isGuarded(), false);
  reentry.guardWrite('Era.commit'); // 保护之外什么都不做
  assert.equal(reentry.guardEvent('era:commit'), false);

  assert.throws(
    () =>
      reentry.runGuarded('钩子 测试 ', () => {
        try {
          reentry.guardWrite('Era.commit');
        } catch {
          // 吞掉
        }
        return 1;
      }),
    /钩子 测试 执行期间不能调用 Era\.commit/,
  );
  assert.equal(reentry.isGuarded(), false);
  // 嵌套：内层的违规同时记到外层
  assert.throws(() =>
    reentry.runGuarded('外层', () => {
      try {
        reentry.runGuarded('内层', () => reentry.guardEvent('era:patch'));
      } catch {
        // 内层报错
      }
    }),
  );
  // 非写入事件、正常返回值
  assert.equal(
    reentry.runGuarded('钩子', () => (reentry.guardEvent('era:getCurrentVars') ? 'x' : 'ok')),
    'ok',
  );
  // 异步入口：返回已处理的失败 Promise，违规照样记到
  let rejected;
  assert.throws(
    () =>
      reentry.runGuarded('钩子', () => {
        rejected = reentry.rejectIfGuarded('Era.extra.run');
      }),
    /Era\.extra\.run/,
  );
  assert.equal(typeof rejected?.then, 'function');
  assert.equal(reentry.rejectIfGuarded('Era.extra.run'), null);
});

test('重入保护：afterApply 钩子里调用 Era.commit 会让钩子报错、修改被丢弃，不会形成循环', async () => {
  for (const swallow of [false, true]) {
    const env = create_env();
    const { Era } = env.load('api/global');
    const attempts = [];
    env.host.hook_registry.addHook('after', '卡.回写', ctx => {
      ctx.stat.hook = 1;
      const p = Era.commit([{ edit: { a: '+=1' } }]);
      attempts.push(p);
      if (swallow) p.catch(() => {});
    });
    env.send('assistant', T('Insert', { a: 1 }));
    await env.sync();
    await env.sync();
    assert.deepEqual(plain(env.stat()), { a: 1 }, '钩子的修改被丢弃');
    assert.equal(env.meta().ApiOps, undefined, '没有产生旁路写入');
    assert.ok(attempts.length >= 2);
    for (const p of attempts) await assert.rejects(p, /执行期间不能调用 Era\.commit/);
    assert.ok(env.toasts.some(t => /卡\.回写/.test(t[2]) && /执行出错/.test(t[2])));
    assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  }
});

test('重入保护：afterApply 钩子里调用 Era.applyText 同样被拒绝、修改被丢弃', async () => {
  const env = create_env();
  const { Era } = env.load('api/global');
  const attempts = [];
  env.host.hook_registry.addHook('after', '卡.文本回写', ctx => {
    ctx.stat.hook = 1;
    attempts.push(Era.applyText(T('Edit', { a: '+=1' })));
  });
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  await env.sync();
  assert.deepEqual(plain(env.stat()), { a: 1 }, '钩子的修改被丢弃');
  assert.equal(env.meta().ApiOps, undefined, '没有产生旁路写入');
  assert.ok(attempts.length >= 1);
  for (const p of attempts) await assert.rejects(p, /执行期间不能调用 Era\.applyText/);
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
});

test('重入保护：钩子里调用 Era.applyText / Era.commit 不 await 也不会产生未处理的 rejection', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const env = create_env();
    const { Era } = env.load('api/global');
    env.host.hook_registry.addHook('after', '卡.不等待', () => {
      Era.applyText(T('Edit', { a: '+=1' }));
      Era.commit([{ edit: { a: '+=1' } }]);
    });
    env.send('assistant', T('Insert', { a: 1 }));
    await env.sync();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(plain(env.stat()), { a: 1 });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('重入保护：beforeApply 钩子里调用 Era.extra.run / wait 被拒绝', async () => {
  for (const call of ['run', 'wait']) {
    const env = create_env();
    const { Era } = env.load('api/global');
    let result;
    env.host.hook_registry.addHook('before', '卡.额外', ctx => {
      result = Era.extra[call]();
      ctx.commands.push({ type: 'insert', data: { 钩子: 1 } });
    });
    env.send('assistant', T('Insert', { a: 1 }));
    await env.sync();
    await assert.rejects(result, new RegExp(`Era\\.extra\\.${call}`));
    assert.deepEqual(plain(env.stat()), { a: 1 }, call);
  }
});

test('重入保护：钩子里发出的写入事件在入队前被拒绝，其余事件和钩子之外的写入事件照常入队', async () => {
  const env = create_env();
  const queue = env.load('events/queue');
  const dispatcher = env.load('events/dispatcher');
  const handled = [];
  dispatcher.dispatchAndExecuteTask = async job => void handled.push(job.type);
  const { GUARDED_EVENTS } = env.load('core/reentry');
  // 钩子在角色卡脚本里，用的是酒馆助手提供的 eventEmit
  const eventEmit = env.host.context.eventEmit;
  // 与 index.ts 一样：写入事件的监听器放在第一位
  for (const ev of [...GUARDED_EVENTS, 'era:getCurrentVars']) {
    const listener = detail => queue.pushExternalEvent(ev, detail);
    if (GUARDED_EVENTS.includes(ev)) env.host.context.eventMakeFirst(ev, listener);
    else env.host.context.eventOn(ev, listener);
  }
  for (const ev of ['era:updateByPath', 'era:commit', 'era:forceSync', 'era:insertByObject', 'era:deleteByPath']) {
    env.reset();
    handled.length = 0;
    env.host.hook_registry.addHook('after', '卡.事件', ctx => {
      ctx.stat.hook = 1;
      eventEmit(ev, { path: 'a', value: 2, mode: 'latest', operations: [] });
    });
    env.send('assistant', T('Insert', { a: 1 }));
    await env.sync();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(handled, [], `${ev} 不应入队`);
    assert.deepEqual(plain(env.stat()), { a: 1 }, ev);
    assert.ok(
      env.toasts.some(t => /卡\.事件/.test(t[2])),
      ev,
    );
    env.host.hook_registry.dropHook(env.host.hook_registry.getActiveHooks('after')[0]);
  }

  // 非写入事件不受限制
  env.reset();
  env.host.hook_registry.addHook('after', '卡.查询', ctx => {
    ctx.stat.hook = 1;
    eventEmit('era:getCurrentVars');
  });
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  await queue.waitForQueueIdle(1000);
  assert.deepEqual(handled, ['era:getCurrentVars']);
  assert.equal(env.stat().hook, 1);

  // 钩子之外照常入队
  handled.length = 0;
  eventEmit('era:updateByPath', { path: 'a', value: 2 });
  await queue.waitForQueueIdle(1000);
  assert.deepEqual(handled, ['era:updateByPath']);
});

test('重入保护：钩子之外的 Era.commit 照常执行', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { a: 1 }));
  await env.sync();
  const result = await env.commit([{ edit: { a: '+=1' } }]);
  assert.equal(result.statWithoutMeta.a, 2);
});

// ============================ 1.7-3 变量结构诊断 ============================

const Shop = z.object({
  金币: z.number(),
  等级: z.number().prefault(1),
  背包: z
    .object({
      容量: z.number().prefault(10),
      物品: z.array(z.string()).prefault([]),
    })
    .prefault({}),
  称号: z.string(),
});

test('结构诊断：问题分为“缺必填字段”和“类型不符”', () => {
  const { load } = create_env();
  const diag = load('core/schema_diag');
  assert.deepEqual(plain(diag.diagnoseStat(null, { a: 1 })), { registered: false, valid: true, issues: [] });
  const result = diag.diagnoseStat(Shop, {
    $meta: { necessary: 'all' },
    金币: '5',
    背包: { 物品: ['剑', 3] },
  });
  assert.equal(result.valid, false);
  const byPath = _.keyBy(plain(result.issues), 'path');
  assert.equal(byPath['金币'].kind, 'invalid');
  assert.equal(byPath['称号'].kind, 'missing');
  assert.equal(byPath['背包.物品[1]'].kind, 'invalid');
  assert.deepEqual(byPath['背包.物品[1]'].segments, ['背包', '物品', 1]);
  assert.equal(diag.diagnoseStat(Shop, { 金币: 1, 称号: '新人' }).valid, true);
  const thrown = diag.diagnoseStat(
    {
      safeParse() {
        throw new Error('坏了');
      },
    },
    {},
  );
  assert.equal(thrown.valid, false);
  assert.equal(thrown.error, '坏了');
});

test('结构修复：强转、删除让默认值接管、补空对象、逐级删除上层，必填又没有默认值的留给手填', () => {
  const { load } = create_env();
  const { deriveSchemaFix } = load('core/schema_diag');

  // 数字字符串 → 数字（保留原值，而不是删掉换成默认值）
  let plan = deriveSchemaFix(Shop, { 金币: '5', 称号: 'a', 等级: '3' });
  assert.equal(plan.valid, true);
  assert.deepEqual(plain(plan.target), { 金币: 5, 称号: 'a', 等级: 3 });
  assert.deepEqual(plain(plan.steps.map(s => s.action)), ['coerce', 'coerce']);

  // 不能强转的非法叶子：删掉，让 prefault 接管
  plan = deriveSchemaFix(Shop, { 金币: 1, 称号: 'a', 等级: '高', 背包: { 容量: [] } });
  assert.equal(plan.valid, true);
  assert.deepEqual(plain(plan.target), { 金币: 1, 称号: 'a', 背包: {} });

  // 新增的嵌套对象没有 prefault，但内层都有默认值：补一个空对象
  const Upgraded = z.object({ 金币: z.number(), 技能: z.object({ 点数: z.number().default(0) }) });
  plan = deriveSchemaFix(Upgraded, { 金币: 1 });
  assert.equal(plan.valid, true);
  assert.deepEqual(plain(plan.target), { 金币: 1, 技能: {} });
  assert.equal(plan.steps[0].action, 'fill');

  // 上层有 prefault、内层必填缺失：删掉上层
  const Nested = z.object({ 甲: z.object({ 乙: z.number() }).prefault({ 乙: 0 }) });
  plan = deriveSchemaFix(Nested, { 甲: { 丙: 1 } });
  assert.equal(plan.valid, true);
  assert.deepEqual(plain(plan.target), {});

  // 必填又没有默认值：留给手填，手填后通过
  plan = deriveSchemaFix(Shop, { 金币: 1 });
  assert.equal(plan.valid, false);
  assert.deepEqual(plain(plan.remaining.map(i => [i.kind, i.path])), [['missing', '称号']]);
  plan = deriveSchemaFix(Shop, { 金币: 1 }, { [JSON.stringify(['称号'])]: '新人' });
  assert.equal(plan.valid, true);
  assert.equal(plan.target.称号, '新人');
  assert.equal(plan.steps[0].action, 'manual');

  // 严格对象里多出来的键
  plan = deriveSchemaFix(z.strictObject({ a: z.number() }), { a: 1, b: 2 });
  assert.equal(plan.valid, true);
  assert.deepEqual(plain(plan.target), { a: 1 });
});

test('结构诊断：放行行为不变；同步后不合法时广播 era:schemaInvalid，按聊天和问题签名去重', async () => {
  const env = create_env();
  env.send('assistant', T('Insert', { 金币: 1 }));
  await env.sync();
  env.host.registry.setActiveSchema(Shop);
  env.send('assistant', T('Edit', { 金币: 5 }));
  await env.sync();
  // 放行：修改前就不合法，修改照常生效
  assert.equal(env.stat().金币, 5);
  let events = env.of('era:schemaInvalid');
  assert.equal(events.length, 1);
  assert.deepEqual(
    events[0].issues.map(i => [i.kind, i.path]),
    [['missing', '称号']],
  );
  assert.equal(events[0].message_id, 1);
  assert.equal(events[0].mk, env.mk(1));

  // 同一组问题不重复广播
  env.send('assistant', T('Edit', { 金币: 6 }));
  await env.sync();
  await env.sync();
  assert.equal(env.of('era:schemaInvalid').length, 1);

  // 问题变了：再广播
  env.send('assistant', T('Edit', { 金币: '很多' }));
  await env.sync();
  events = env.of('era:schemaInvalid');
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].issues.map(i => i.path).sort(), ['称号', '金币']);

  // 恢复合法后不广播；再次不合法时重新广播
  env.send('assistant', T('Edit', { 金币: 1 }) + T('Insert', { 称号: '新人' }));
  await env.sync();
  assert.equal(env.of('era:schemaInvalid').length, 2);
  env.chat.pop();
  await env.sync();
  assert.equal(env.of('era:schemaInvalid').length, 3);

  // 另一个聊天：重新计算签名
  env.switch_chat('other');
  await env.sync(true);
  assert.equal(env.of('era:schemaInvalid').length, 4);
});

test('结构诊断：变量为空或没有注册 schema 时不广播', async () => {
  const env = create_env({ schema: Shop });
  env.send('assistant', '还没有变量');
  await env.sync();
  assert.equal(env.of('era:schemaInvalid').length, 0);
  const plainEnv = create_env();
  plainEnv.send('assistant', T('Insert', { a: '任意' }));
  await plainEnv.sync();
  assert.equal(plainEnv.of('era:schemaInvalid').length, 0);
});

test('Era.checkSchema：检查最新变量或某一楼处理完之后的变量', async () => {
  const env = create_env();
  const { Era } = env.load('api/global');
  env.send('assistant', T('Insert', { 金币: 1, 称号: 'a' }));
  env.send('assistant', T('Delete', { 称号: {} }));
  await env.sync();
  assert.deepEqual(plain(await Era.checkSchema()), { registered: false, valid: true, issues: [] });
  env.host.registry.setActiveSchema(z.object({ 金币: z.number(), 称号: z.string() }));
  assert.deepEqual(plain(await Era.checkSchema()), {
    registered: true,
    valid: false,
    issues: [{ kind: 'missing', path: '称号', message: plain(await Era.checkSchema()).issues[0].message }],
  });
  assert.equal((await Era.checkSchema(env.mk(0))).valid, true);
  await assert.rejects(Era.checkSchema('era_mk_none'), /无法计算/);
});

// ============================ 1.7-3 一键修复 ============================

/** 变量从一开始就不符合结构（金币是字符串、缺少必填的称号）：每一楼都整轮放行。 */
async function broken_env(options = {}) {
  const env = create_env({ schema: Shop, ...options });
  env.send('assistant', T('Insert', { 金币: '5', 等级: 2 }));
  env.send('user', '你好');
  env.send('assistant', T('Edit', { 等级: 3 }));
  await env.sync();
  return env;
}

test('一键修复：试算通过后写入最新 AI 楼，状态合法；撤销后恢复原状', async () => {
  const env = await broken_env();
  const fix = env.load('ui/schema_fix');
  const before = plain(env.stat());
  let preview = await fix.prepareSchemaFix();
  assert.equal(preview.diagnosis.valid, false);
  assert.deepEqual(plain(preview.plan.remaining.map(i => i.path)), ['称号']);
  assert.equal(preview.ready, false, '还有必填字段没有值');

  preview = await fix.prepareSchemaFix({ [JSON.stringify(['称号'])]: '旅人' });
  assert.equal(preview.ready, true);
  assert.equal(preview.mk, env.mk(2));
  assert.deepEqual(plain(preview.ops), [
    { op: 'replace', path: '/金币', value: 5 },
    { op: 'replace', path: '/称号', value: '旅人' },
  ]);
  const undo = await fix.applySchemaFix(preview, (ops, opts) => env.commit(ops, opts));
  // 合法之后 schema 照常补全默认值（修复前不合法时整轮放行，不会补）
  assert.deepEqual(plain(env.stat()), { 金币: 5, 等级: 3, 背包: { 容量: 10, 物品: [] }, 称号: '旅人' });
  assert.equal(env.load('core/schema_diag').diagnoseStat(Shop, env.stat()).valid, true);
  assert.equal(env.chat[2].swipes[0].includes('旅人'), false, '正文不变');
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  assert.equal(fix.canUndoSchemaFix(undo), true);

  const undoing = fix.undoSchemaFix(undo);
  while (env.meta().ApiOps[undo.mk].rev === undo.rev) await tick();
  await env.sync();
  await undoing;
  assert.deepEqual(plain(env.stat()), before);
  assert.deepEqual(env.meta().ApiOps[undo.mk].ops, []);
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  await assert.rejects(fix.undoSchemaFix(undo), /无法撤销/);
});

test('一键修复：生成预览后聊天、最新 AI 楼、swipe、正文或写入变了时拒绝写入', async () => {
  const manual = { [JSON.stringify(['称号'])]: '旅人' };
  const commit = env => (ops, opts) => env.commit(ops, opts);
  for (const change of ['聊天', '新消息', 'swipe', '编辑', '写入']) {
    const env = await broken_env();
    const fix = env.load('ui/schema_fix');
    const preview = await fix.prepareSchemaFix(manual);
    assert.equal(preview.ready, true);
    if (change === '聊天') env.switch_chat('other');
    if (change === '新消息') env.send('assistant', '新的回复');
    if (change === 'swipe') env.swipe_new(2, '另一个回复');
    if (change === '编辑') env.chat[2].swipes[0] = env.chat[2].swipes[0].replace('等级', '等级 ');
    if (change === '写入') await env.commit([{ edit: { 等级: 4 } }]);
    await assert.rejects(fix.applySchemaFix(preview, commit(env)), /重新诊断/, change);
  }
});

test('一键修复：修复之后又有写入时不能撤销', async () => {
  const env = await broken_env();
  const fix = env.load('ui/schema_fix');
  const preview = await fix.prepareSchemaFix({ [JSON.stringify(['称号'])]: '旅人' });
  const undo = await fix.applySchemaFix(preview, (ops, opts) => env.commit(ops, opts));
  await env.commit([{ edit: { 等级: 9 } }]);
  assert.equal(fix.canUndoSchemaFix(undo), false);
  await assert.rejects(fix.undoSchemaFix(undo), /无法撤销/);
  assert.equal(env.stat().等级, 9);
});

test('一键修复：钩子把修复改回去时试算不通过；变量合法时没有要修复的', async () => {
  const env = await broken_env({
    hooks: [
      [
        '卡.捣乱',
        ({ stat }) => {
          stat.金币 = '捣乱';
        },
      ],
    ],
  });
  const fix = env.load('ui/schema_fix');
  const preview = await fix.prepareSchemaFix({ [JSON.stringify(['称号'])]: '旅人' });
  assert.equal(preview.ready, false);
  assert.equal(preview.after.valid, false);
  await assert.rejects(
    fix.applySchemaFix(preview, () => {}),
    /没有通过检查/,
  );

  const good = create_env({ schema: Shop });
  good.send('assistant', T('Insert', { 金币: 1, 称号: 'a' }));
  await good.sync();
  const ok = await good.load('ui/schema_fix').prepareSchemaFix();
  assert.equal(ok.diagnosis.valid, true);
  assert.equal(ok.plan, null);
  assert.equal(ok.ready, false);
});

test('工作台预览用楼内试算器：与 atomic 提交的结果一致，钩子不会多执行一次', async () => {
  const counter = ({ stat, old_stat }) => {
    stat.次数 = (old_stat.次数 ?? 0) + 1;
  };
  const env = create_env({ hooks: [['卡.计数', counter]] });
  env.send('assistant', T('Insert', { a: 1 }));
  env.send('assistant', '剧情');
  await env.sync();
  assert.equal(env.stat().次数, 2);
  const { previewCommit } = env.load('ui/floor_preview');
  const preview = await previewCommit([{ patch: [{ op: 'replace', path: '/a', value: 5 }] }]);
  assert.equal(preview.mk, env.mk(1));
  assert.deepEqual(plain(preview.result.problems), []);
  const result = await env.commit([{ patch: [{ op: 'replace', path: '/a', value: 5 }] }], { atomic: true });
  assert.deepEqual(
    plain(env.load('utils/data').unescapeEraData(env.load('utils/era_data').removeMetaFields(preview.result.stat))),
    plain(result.statWithoutMeta),
  );
  // Era.simulate 把修改当成新的一楼，钩子多执行一次
  const { Era } = env.load('api/global');
  const simulated = await Era.simulate('<VariablePatch>[{"op":"replace","path":"/a","value":5}]</VariablePatch>');
  assert.equal(result.statWithoutMeta.次数, 2);
  assert.equal(simulated.stat.次数, 3, '钩子在“新的一楼”上又执行了一次');

  // 新问题与 atomic 的判断一致
  const bad = await previewCommit([{ patch: [{ op: 'remove', path: '/不存在' }] }]);
  assert.equal(bad.result.problems.length, 1);
  await assert.rejects(env.commit([{ patch: [{ op: 'remove', path: '/不存在' }] }], { atomic: true }), /放弃/);
});

// ============================ 1.7-8 {{ERA-issues}} ============================

test('{{ERA-issues}}：列出最新 AI 楼没有生效的正文指令和原因，没有问题时为空', async () => {
  const env = create_env({ schema: z.object({ hp: z.number() }).loose() });
  const { parseEraMacros } = env.load('macro/parse');
  const issues = () => parseEraMacros('[{{ERA-issues}}]');
  env.send('assistant', T('Insert', { hp: 10 }));
  await env.sync();
  assert.equal(issues(), '[]');

  env.send('assistant', T('Edit', { 不存在: 1 }) + T('Edit', { hp: '很多' }) + '<VariableEdit>{坏</VariableEdit>');
  await env.sync();
  const text = issues();
  assert.match(text, /^\[上一条回复中有 3 处变量指令没有生效/);
  // 无法解析的块在解析阶段就记下，排在最前
  assert.match(text, /1\. 指令块无法解析（开头：{坏）/);
  assert.match(text, /2\. <VariableEdit> 不存在：/);
  assert.match(text, /3\. hp：修改不符合变量结构，已被拦截（写入的值 "很多"）/);

  // 末尾的用户消息不影响；旁路写入的问题不是 AI 写的，不列出
  env.send('user', '继续');
  await env.sync();
  await env.commit([{ edit: { 也不存在: 1 } }]);
  assert.equal(issues(), text);

  // 新的 AI 楼没有问题时为空；删掉它后，露出的上一楼仍能找到报告（快速同步不会重新计算它）
  env.send('assistant', '剧情');
  await env.sync();
  assert.equal(issues(), '[]');
  env.chat.pop();
  await env.sync();
  assert.equal(issues(), text);

  // 切到新的 swipe 还没有同步时，不拿旧回复的问题冒充
  env.swipe_new(1, '新的回复');
  assert.equal(issues(), '[]');
  // 换了聊天
  env.chat[1].swipe_id = 0;
  env.switch_chat('other');
  assert.equal(issues(), '[]');
});

test('{{ERA-issues}}：问题很多时只列出前 10 条', () => {
  const { load } = create_env();
  const { formatIssuesForModel } = load('core/latest_report');
  const many = Array.from({ length: 12 }, (_v, i) => ({
    kind: 'command',
    type: 'delete',
    path: `p${i}`,
    reason: '路径不存在',
    origin: 'text',
  }));
  const text = formatIssuesForModel(many);
  assert.match(text, /有 12 处/);
  assert.match(text, /10\. <VariableDelete> p9/);
  assert.doesNotMatch(text, /p10/);
  assert.match(text, /另有 2 处/);
  assert.equal(formatIssuesForModel([]), '');
});

// ============================ 1.7-6 长聊天诊断 ============================

test('聊天数据体积：按 UTF-8 字节统计变量、日志、旁路写入与正文', () => {
  const { load } = create_env();
  const size = load('ui/size_diag');
  assert.equal(size.utf8Length('a中😀'), 1 + 3 + 4);
  assert.equal(size.formatBytes(512), '512 B');
  assert.equal(size.formatBytes(2048), '2.0 KB');
  const report = size.measureChatSize(
    {
      stat_data: { 名: '甲' },
      ERAMetaData: {
        EditLogs: { m1: [], m2: [{ op: 'insert', path: 'a', value_new: 1 }] },
        ApiOps: { m2: { rev: 2, applied: 2, ops: [{ type: 'edit', data: {}, after: 0, n: 2 }] } },
        SelectedMks: ['m1', 'm2'],
      },
    },
    [
      { message_id: 0, swipes: ['你好', '别的'], swipe_id: 0 },
      { message_id: 1, message: 'abc' },
    ],
    3,
  );
  assert.equal(report.messages, 2);
  assert.equal(report.stat, size.utf8Length(JSON.stringify({ 名: '甲' })));
  assert.equal(report.logFloors, 2);
  assert.equal(report.apiOpCount, 2);
  assert.equal(report.text, 6 + 3);
  assert.equal(report.allSwipes, 6 + 6 + 3);
  assert.equal(report.iframes, 3);
  assert.equal(report.archived, false);
});

/** 在假的 iframe 环境里运行默认状态栏的脚本。 */
async function run_status_bar({ self, last }) {
  const html = fs.readFileSync(path.join(ROOT, 'src/ERA变量框架/initer/manual/regex_objects/status_bar.html'), 'utf8');
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  const ready = [];
  const listeners = [];
  const rendered = [];
  const stopped = [];
  const chain = new Proxy(function () {}, {
    get: (_t, key) => (key === 'text' ? value => (rendered.push(value), chain) : () => chain),
    apply: () => chain,
  });
  const state = { last };
  const context = vm.createContext({
    _,
    $: arg => (typeof arg === 'function' ? void ready.push(arg) : chain),
    waitGlobalInitialized: async () => {},
    getCurrentMessageId: () => self,
    getLastMessageId: () => state.last,
    eventOn: (name, fn) => {
      listeners.push({ name, fn });
      return { stop: () => stopped.push(name) };
    },
    Era: {
      getCurrentVars: () => ({ statWithoutMeta: { 地点: '最新' } }),
      getVarsAt: async id => ({ statWithoutMeta: { 地点: `第${id}楼` } }),
    },
  });
  vm.runInContext(script, context);
  for (const fn of ready) await fn();
  return { listeners, rendered, stopped, state };
}

test('新卡的默认状态栏：最后一楼监听 era:writeDone，旧楼只显示那一楼的变量、不监听', async () => {
  const latest = await run_status_bar({ self: 5, last: 5 });
  assert.deepEqual(
    latest.listeners.map(l => l.name),
    ['era:writeDone'],
  );
  assert.ok(latest.rendered.includes('最新'));
  // 后面有了新消息：本楼变成旧楼，停止监听，不再刷新
  latest.state.last = 6;
  const count = latest.rendered.length;
  latest.listeners[0].fn({ statWithoutMeta: { 地点: '更新' } });
  assert.deepEqual(latest.stopped, ['era:writeDone']);
  assert.equal(latest.rendered.length, count);

  const old = await run_status_bar({ self: 2, last: 5 });
  assert.deepEqual(old.listeners, []);
  assert.ok(old.rendered.includes('第2楼'));
});
