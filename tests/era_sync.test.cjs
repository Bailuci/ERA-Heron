/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：测试：拆出测试宿主，新增同步层随机对拍测试；新增脚本设置“日志保留楼层数”；修复“复制消息”产生重复 MK 导致的状态错误；新增更新钩子 Era.onBeforeApply / Era.onAfterApply等；随机对拍加入“移动后直接删除”和含指令的用户消息；同步失败路径、快照口径、写入次数等测试；随机对拍加入表达式 $expr（random、roll、@）与新建表达式的 beforeApply 钩子；随机对拍检查 {{ERA-issues}} 的缓存与从头重放一致（2026-11-26）
 *       2026-11-26 随机对拍加入思考块、指令外层标签、Era.applyText 的旁路写入，覆盖新聊天与旧聊天两种解析版本
 *       2026-11-27 随机对拍加入分步更新写入的 <era_extra>（外层标签、未闭合的思考标签、值里的思考标签字样），新聊天中检查它确实生效
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// ERA 同步层（resyncStateOnHistoryChange）测试：用内存中的假聊天和假聊天变量驱动真实源码。
// 运行方式: node --test tests/era_sync.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');
const z = require('zod');
const { create_chat, create_files, plain } = require('./chat.cjs');

test('发送、swipe、滑回、删除之后，状态都与从头重放一致', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"hp":10,"a":{"x":1}}</VariableInsert>');
  await c.sync();
  c.send('user', '你好');
  await c.sync();
  c.send('assistant', '<VariableEdit>{"hp":"+=5"}</VariableEdit>');
  await c.sync();
  assert.equal(c.stat().hp, 15);
  c.swipe_new(2, '<VariableEdit>{"hp":"-=3"}</VariableEdit>');
  await c.sync();
  assert.equal(c.stat().hp, 7);
  c.chat[2].swipe_id = 0;
  await c.sync();
  assert.equal(c.stat().hp, 15);
  c.chat.splice(1, 1);
  await c.sync();
  assert.deepEqual(c.stat(), await c.replay());
  c.chat.pop();
  await c.sync();
  assert.deepEqual(c.stat(), { hp: 10, a: { x: 1 } });
});

test('同步是幂等的：没有变化时重复同步不改变状态和日志', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"hp":10}</VariableInsert>');
  c.send('assistant', '<VariableEdit>{"hp":"+=5"}</VariableEdit>');
  await c.sync();
  const before = plain({ stat: c.stat(), meta: c.meta() });
  await c.sync();
  await c.sync();
  assert.deepEqual(plain({ stat: c.stat(), meta: c.meta() }), before);
});

test('清理失效日志：默认保留，开启后只剩聊天中存在的消息，滑回旧 swipe 仍正确', async () => {
  for (const enabled of [false, true]) {
    const c = create_chat({ settings: { 清理失效日志: enabled } });
    c.send('assistant', '<VariableInsert>{"hp":10}</VariableInsert>');
    c.send('assistant', '<VariableEdit>{"hp":11}</VariableEdit>');
    await c.sync();
    c.swipe_new(1, '<VariableEdit>{"hp":12}</VariableEdit>');
    await c.sync();
    c.swipe_new(1, '<VariableEdit>{"hp":13}</VariableEdit>');
    await c.sync();
    assert.equal(Object.keys(c.meta().EditLogs).length, enabled ? 2 : 4);
    c.chat[1].swipe_id = 0;
    await c.sync();
    assert.equal(c.stat().hp, 11);
    c.chat.pop();
    await c.sync();
    assert.equal(c.stat().hp, 10);
  }
});

test('注册 schema 后只删除末尾消息，状态仍符合 schema', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"player":{"hp":10}}</VariableInsert>');
  c.send('user', '1');
  c.send('assistant', '2');
  await c.sync();
  c.host.registry.setActiveSchema(
    z.object({ player: z.object({ hp: z.number() }), bag: z.array(z.string()).default([]) }),
  );
  await c.sync();
  assert.deepEqual(c.stat(), { player: { hp: 10 }, bag: [] });
  c.chat.pop();
  await c.sync();
  assert.deepEqual(c.stat(), { player: { hp: 10 }, bag: [] });
});

test('rollbackTo 停在目标楼之后，再次普通同步能得到正确的最新状态', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"a":1}</VariableInsert>');
  c.send('assistant', '<VariableEdit>{"a":"+=1"}</VariableEdit>');
  c.send('assistant', '<VariableEdit>{"a":"+=1"}</VariableEdit>');
  c.send('assistant', '<VariableEdit>{"a":"+=10"}</VariableEdit><VariableInsert>{"b":1}</VariableInsert>');
  await c.sync();
  const { handleSyncEvent } = c.host.load_src('events/handlers/sync');
  await handleSyncEvent({ type: 'era:forceSync' }, {}, { mk: c.meta().SelectedMks.at(-1) }, 1, true);
  assert.deepEqual(c.stat(), { a: 2 });
  await handleSyncEvent({ type: 'manual_sync' }, {}, { mk: 'x' });
  assert.deepEqual(c.stat(), { a: 13, b: 1 });
});

test('同步过程中切换聊天时，不写入任何结果', async () => {
  const c = create_chat({
    hooks: [['切换', () => void (c.host.context.SillyTavern.getCurrentChatId = () => '另一个聊天')]],
  });
  c.send('assistant', '<VariableInsert>{"a":1}</VariableInsert>');
  await c.sync();
  assert.deepEqual(c.stat(), {});
  assert.deepEqual(c.meta(), {});
});

// ---------------------------------------------------------------------------
// 日志折叠
// ---------------------------------------------------------------------------

async function folded_chat(keep = 2, count = 8) {
  const c = create_chat({ settings: { 日志保留楼层数: keep } });
  c.send('assistant', '<VariableInsert>{"n":0,"log":{}}</VariableInsert>');
  await c.sync();
  for (let i = 1; i < count; i++) {
    c.send(
      'assistant',
      `<VariableEdit>{"n":"+=1"}</VariableEdit><VariableInsert>{"log":{"k${i}":${i}}}</VariableInsert>`,
    );
    await c.sync();
  }
  return c;
}

test('折叠：只保留近期日志，深处修改后从头重放，关闭设置并完全重算后复原', async () => {
  const c = await folded_chat();
  const { SelectedMks, EditLogs, FoldedThroughMk } = c.meta();
  assert.equal(FoldedThroughMk, SelectedMks[5]);
  assert.deepEqual(Object.keys(EditLogs).sort(), SelectedMks.slice(5).sort());

  // 保留区的快照仍可查询，折叠区不可查询
  assert.equal(plain(c.host.snapshot.getStatAtMK(SelectedMks[5])).n, 5);
  assert.equal(plain(c.host.snapshot.getStatAtMK(SelectedMks[6])).n, 6);
  assert.equal(c.host.snapshot.getStatAtMK(SelectedMks[4]), null);
  assert.equal(c.host.snapshot.getStatsBetweenMKs().length, 3);
  assert.deepEqual(plain(c.host.snapshot.getStatsBetweenMKs(SelectedMks[0], SelectedMks[2])), []);

  c.chat.splice(2, 1);
  await c.sync();
  assert.deepEqual(c.stat(), await c.replay());

  c.host.era_data.settings.value.日志保留楼层数 = 0;
  await c.sync(true);
  assert.equal(c.meta().FoldedThroughMk, undefined);
  assert.equal(Object.keys(c.meta().EditLogs).length >= c.chat.length, true);
  assert.deepEqual(c.stat(), await c.replay());
});

test('折叠：旧楼正文里的指令被剥离时停止折叠，不丢数据', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  for (let i = 1; i < 8; i++) c.send('assistant', '<VariableEdit>{"n":"+=1"}</VariableEdit>');
  await c.sync();
  // 绕过 ERA 直接改正文：状态仍由日志保持为 7
  const m = c.chat[3];
  m.swipes[0] = m.swipes[0].replace(/<VariableEdit>.*<\/VariableEdit>/, '');
  c.host.era_data.settings.value.日志保留楼层数 = 2;
  await c.sync();
  assert.equal(c.stat().n, 7);
  assert.equal(c.meta().FoldedThroughMk, c.meta().SelectedMks[2]);
});

test('折叠：旧版 ERA（忽略折叠标记）执行完全重算也能得到正确结果', async () => {
  const c = await folded_chat();
  delete c.meta().FoldedThroughMk;
  c.host.era_data.settings.value.日志保留楼层数 = 0;
  await c.sync(true);
  assert.deepEqual(c.stat(), await c.replay());
});

test('折叠 + 钩子：空闲同步不会从头重放', async () => {
  for (const keep of [1, 2, 3]) {
    for (const tail of ['assistant', 'user']) {
      let calls = 0;
      const c = create_chat({ settings: { 日志保留楼层数: keep }, hooks: [['h', () => void calls++]] });
      c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
      for (let i = 0; i < 10; i++) {
        c.send('user', 'u');
        c.send('assistant', '<VariableEdit>{"n":"+=1"}</VariableEdit>');
        await c.sync();
      }
      if (tail === 'user') c.send('user', 'u');
      await c.sync();
      calls = 0;
      await c.sync();
      assert.ok(calls <= 2, `keep ${keep} ${tail}: ${calls}`);
      assert.equal(c.stat().n, 10);
    }
  }
});

test('折叠后在注册钩子之前从头重放，重新注册后钩子会再次应用到全部历史', async () => {
  const hook = ({ stat, old_stat }) => void (stat.count = (old_stat.count ?? 0) + 1);
  const c = create_chat({ settings: { 日志保留楼层数: 2 } });
  const h = c.host.hook_registry.addHook('after', 'h', hook);
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  for (let i = 0; i < 9; i++) c.send('assistant', '剧情');
  await c.sync();
  assert.equal(c.stat().count, 10);
  c.host.hook_registry.dropHook(h);
  c.chat.splice(5);
  await c.sync();
  c.host.hook_registry.addHook('after', 'h', hook);
  await c.sync();
  assert.equal(c.stat().count, 5);
});

test('旧版遗留的重复 MK：丢弃日志并从头重放', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  c.send('assistant', '<VariableEdit>{"n":"+=5"}</VariableEdit>');
  await c.sync();
  c.chat.push(plain(c.chat[1]));
  const meta = c.meta();
  meta.SelectedMks.push(meta.SelectedMks[1]);
  c.variables().stat_data = { n: 999 };
  await c.sync();
  assert.deepEqual(c.stat(), { n: 10 });
  assert.equal(new Set(c.meta().SelectedMks).size, 3);
});

test('正文 API 写入后、同步之前新回复到达：写入不会丢失', async () => {
  const c = create_chat();
  const { updateByPath } = c.host.load_src('events/handlers/api/handler');
  c.send('assistant', '<VariableInsert>{"hp":10}</VariableInsert>');
  await c.sync();
  c.send('user', 'u');
  await c.register_only();
  await updateByPath('hp', '+=5');
  c.send('assistant', '新回复');
  await c.sync();
  assert.equal(c.stat().hp, 15);
});

test('复制消息换 MK 时保留正文里的宏，writeDone 报告新的 MK', async () => {
  const c = create_chat();
  c.send('assistant', 'hi');
  await c.sync();
  c.chat[0].swipes[0] = c.chat[0].swipes[0].replace('hi', 'hi {{user}}');
  c.chat.push(plain(c.chat[0]));
  const { handleSyncEvent } = c.host.load_src('events/handlers/sync');
  const payload = { mk: c.meta().SelectedMks[0], message_id: 1 };
  await handleSyncEvent({ type: 'manual_sync' }, {}, payload);
  assert.ok(c.chat[1].swipes[0].includes('hi {{user}}'));
  assert.equal(payload.mk, c.meta().SelectedMks[1]);
});

test('设置面板把数字清空成空字符串时，设置仍能解析', () => {
  const { SettingsSchema } = create_chat().host.load_src('utils/constants');
  assert.equal(SettingsSchema.parse({ 日志保留楼层数: '' }).日志保留楼层数, 0);
});

// ---------------------------------------------------------------------------
// 随机操作对拍
// ---------------------------------------------------------------------------

/** mulberry32：固定种子的伪随机数，失败时可以复现。 */
function create_random(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)] };
}

/**
 * @param text 正文中混入的内容（不传时与之前的随机序列完全相同）：
 *   - `think`：思考块里写示例指令（含嵌套、没有闭合、丢了开头标签的情况），插入键 `思考`；
 *   - `outer`：真正的指令包在 `<ERA_Update>` 里，标签外写示例指令，插入键 `外`；
 *   - `open`：更常在末尾留下没有闭合的思考标签（主回复被截断）。
 */
function random_text(r, text, dense = false) {
  const key = () => r.pick(['a', 'b', 'c']);
  const value = () =>
    r.pick([
      1,
      5,
      '文',
      '+=2',
      { x: 1 },
      { x: 2, y: { z: 3 } },
      [1, 2],
      null,
      true,
      // 表达式：骰点、读当前值与本楼开始前的值、求值失败（也占用一次出现次数）
      { $expr: 'roll(1, 6)' },
      { $expr: 'b * 2 + random()' },
      { $expr: '@b + roll(0, 3)' },
      { $expr: 'ln(0)' },
    ]);
  const blocks = [];
  // dense：一楼里多条指令、更常写同一路径及其前缀，使日志压缩有东西可合并
  for (let i = dense ? 3 + r.int(8) : r.int(4); i > 0; i--) {
    const tag = r.pick(['Insert', 'Insert', 'Edit', 'Edit', 'Delete']);
    const leaf = tag === 'Delete' ? {} : value();
    const body = { [key()]: r.int(dense ? 3 : 2) === 1 ? leaf : { [r.pick(['x', 'y', 'w'])]: leaf } };
    blocks.push(`<Variable${tag}>${JSON.stringify(body)}</Variable${tag}>`);
  }
  if (!text) return `剧情${r.int(1000)}${blocks.join('间隔')}`;
  const decoy = name =>
    `<VariableInsert>{"${name}":${r.int(9)}}</VariableInsert><VariableEdit>{"a":{"x":"${name}"}}</VariableEdit>`;
  const think = () => {
    const tag = r.pick(['think', 'thinking', 'THINK']);
    const inner = r.int(3) === 0 ? `<thinking>嵌套${decoy('思考')}</thinking>` : '';
    return `<${tag}>想想${decoy('思考')}${inner}</${tag}>`;
  };
  const parts = blocks.map(block => {
    const real = text.outer && r.int(4) !== 0 ? `<ERA_Update>${block}</ERA_Update>` : block;
    return `${text.think && r.int(2) ? think() : ''}${text.outer && r.int(3) === 0 ? decoy('外') : ''}${real}`;
  });
  const head = text.think && r.int(8) === 0 ? `丢了开头${decoy('思考')}</think>` : '';
  const tail = text.think && r.int(text.open ? 2 : 8) === 0 ? `<think>没写完${decoy('思考')}` : '';
  return `${head}剧情${r.int(1000)}${parts.join('间隔')}${tail}`;
}

const mk_of = m => m.swipes[m.swipe_id].match(/era_mk_\w+/)?.[0];

/** 示例指令（思考块里、外层标签外）在旧聊天中生效过的次数，用来确认对拍确实覆盖了它们。 */
const decoy_hits = { legacy: 0 };
/** 随机对拍中比较过的、含问题的 {{ERA-issues}} 报告数。 */
let issue_reports_checked = 0;
/** 随机对拍中写出的存档段数，以及其中压缩成功、没有通过自检的楼层数。 */
const compress_hits = { segments: 0, compressed: 0, rejected: 0 };
/** 随机对拍中写入过 <era_extra> 的次数。 */
let extra_hits = 0;

async function fuzz(seed, options) {
  const r = create_random(seed);
  // archive：接上假的文件接口，折叠日志真的写成存档段（重放用另一个文件服务器）；统计日志压缩的结果
  const c = create_chat(
    options.archive
      ? { ...options, globals: create_files().globals, replay: { globals: create_files().globals } }
      : options,
  );
  if (options.archive) {
    const module = c.host.load_src('core/log_compress');
    const original = module.compressSegmentLogs;
    module.compressSegmentLogs = (...args) => {
      const result = original(...args);
      compress_hits.segments++;
      compress_hits.compressed += result.compressed;
      compress_hits.rejected += result.rejected;
      return result;
    };
  }
  c.send('assistant', '<VariableInsert>{"a":{"x":1},"b":2}</VariableInsert>');
  await c.sync();
  const trace = [];
  const shadow = {}; // 不压缩的写入列表，用于验证压缩不改变结果
  // 与 handler.ts 一致：注册了 schema 或任何钩子时不压缩
  const compact = !options.schema && !options.hooks && !options.before_hooks;
  let ops_done = 0;
  for (let step = 0; step < 25; step++) {
    const op = r.pick([
      ...(options.text ? ['text_op', 'text_op'] : []),
      ...(options.text?.extra ? ['extra', 'extra', 'extra'] : []),
      'send',
      'send',
      'send',
      'user',
      'swipe',
      'back',
      'delete',
      'edit',
      'full',
      'rollbackTo',
      'copy',
      'user_mk',
      'user_cmd',
      'api',
      'op',
      'op',
      'op_old',
      'continue',
      'swap',
      'swap_delete',
    ]);
    const index = r.int(c.chat.length);
    const last = c.chat.at(-1);
    trace.push(`${op}@${index}`);
    let args = [];
    let extra_written = false;
    if (op === 'send') c.send('assistant', random_text(r, options.text, options.dense));
    else if (op === 'extra') {
      // 分步更新：额外模型的输出写在目标楼正文末尾的 <era_extra> 中，与 handleWriteExtra 的拼接相同
      const targets = c.chat.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
      if (targets.length > 0) {
        const target = r.int(3) === 0 ? r.pick(targets) : targets.at(-1);
        const m = c.chat[target];
        const blocks = [`<VariableInsert>{"额外":${r.int(9)}}</VariableInsert>`];
        // 值里的思考标签字样不能影响正文的遮蔽
        if (r.int(2))
          blocks.push(`<VariableEdit>{"c":"${r.pick(['<think>', '</think>', '<thinking>'])}"}</VariableEdit>`);
        if (r.int(2))
          blocks.push(
            `<VariableEdit>${JSON.stringify({ b: r.pick([1, '+=2', { $expr: 'roll(1, 6)' }]) })}</VariableEdit>`,
          );
        const { appendExtraBlock } = c.host.load_src('utils/message');
        m.swipes[m.swipe_id] = appendExtraBlock(m.swipes[m.swipe_id], r.int(6) === 0 ? '' : blocks.join('\n'));
        extra_written = m.swipes[m.swipe_id].includes('<era_extra>');
        args = [false, target];
      }
    } else if (op === 'user') c.send('user', '用户消息');
    else if (op === 'text_op') {
      // Era.applyText：文本中的指令保存为 origin: 'text' 的旁路写入
      const target = c.chat.findLastIndex(m => m.role === 'assistant');
      const pushed =
        target >= 0 ? await c.push_text(target, random_text(r, options.text, options.dense), compact) : null;
      if (pushed) {
        for (const item of pushed.ops) shadow[pushed.mk] = c.host.api_ops.appendApiOp(shadow[pushed.mk], item, false);
        ops_done++;
      }
      if (r.int(2)) continue;
    } else if (op === 'op' || op === 'op_old') {
      const target = op === 'op' ? c.chat.findLastIndex(m => m.role === 'assistant') : index;
      const key = r.pick(['a', 'b', 'c']);
      const type = r.pick(['edit', 'edit', 'edit', 'insert', 'delete']);
      const leaf =
        type === 'delete'
          ? {}
          : r.pick([1, 2, '+=3', '+=3', '文', { x: 2 }, { $expr: 'b + roll(1, 6)' }, { $expr: '@a.x + random()' }]);
      const pushed =
        target >= 0 ? await c.push_op(target, { type, data: { [key]: r.int(2) ? leaf : { x: leaf } } }, compact) : null;
      if (pushed) {
        shadow[pushed.mk] = c.host.api_ops.appendApiOp(shadow[pushed.mk], pushed.op, false);
        ops_done++;
      }
      if (r.int(2)) continue; // 同步可能被合并到之后的事件里
    } else if (op === 'continue') {
      const m = c.chat.findLast(item => item.role === 'assistant');
      if (m) m.swipes[m.swipe_id] += `继续${random_text(r, options.text, options.dense)}`;
      if (m) args = [false, c.chat.indexOf(m)];
    } else if (op === 'api') {
      // API 写入：把指令块追加到最后一条 AI 消息，然后普通同步
      const m = c.chat.findLast(item => item.role === 'assistant');
      const block = `<VariableEdit>${JSON.stringify({ b: r.int(9) })}</VariableEdit>`;
      // 与 performApiWrite 一致：设置了指令外层标签时包在外层标签里
      if (m) m.swipes[m.swipe_id] += options.text?.outer ? `\n<ERA_Update>${block}</ERA_Update>` : `\n${block}`;
    } else if (op === 'user_mk') {
      c.send('user', '用户消息');
      await c.register_only();
      c.send('assistant', random_text(r, options.text, options.dense));
    } else if (op === 'user_cmd') {
      // 含指令的用户消息：走真实的 MESSAGE_SENT 处理，之后 AI 回复
      c.send('user', random_text(r, options.text, options.dense));
      await c.host.load_src('events/dispatcher').dispatchAndExecuteTask({ type: 'MESSAGE_SENT', timestamp: 0 }, null);
      c.send('assistant', random_text(r, options.text, options.dense));
    } else if (op === 'swipe') c.swipe_new(c.chat.length - 1, random_text(r, options.text, options.dense));
    else if (op === 'back') last.swipe_id = r.int(last.swipes.length);
    else if (op === 'delete' && c.chat.length > 1) c.chat.splice(index, 1);
    else if (op === 'edit') {
      // 编辑保留 MK，对应 MESSAGE_EDITED 的定向同步
      const m = c.chat[index];
      const mk = m.swipes[m.swipe_id].match(/<era_data>.*?<\/era_data>/)?.[0] ?? '';
      m.swipes[m.swipe_id] = random_text(r, options.text, options.dense) + mk;
      args = [false, index];
    } else if (op === 'full') args = [true];
    else if (op === 'copy' && r.int(3) === 0) {
      // 酒馆的“复制消息”：两楼拥有相同的 MK
      await c.sync();
      c.chat.splice(index + 1, 0, plain(c.chat[index]));
      const before = mk_of(c.chat[index]);
      await c.sync();
      if (shadow[before]) shadow[mk_of(c.chat[index + 1])] = plain(shadow[before]);
    } else if (op === 'rollbackTo') {
      await c.sync(false, index, true);
      const at = plain(c.stat());
      const tail = c.chat.splice(index + 1);
      assert.deepEqual(at, plain(await c.replay()), `seed ${seed} 第 ${step} 步 rollbackTo: ${trace.join(' ')}`);
      c.chat.push(...tail);
      // rollbackTo 之后紧接另一次定向同步
      const next = r.int(c.chat.length);
      const kind = r.int(3);
      if (kind === 0) args = [false, next];
      if (kind === 1) {
        await c.sync(false, next, true);
        const at2 = plain(c.stat());
        const tail2 = c.chat.splice(next + 1);
        assert.deepEqual(
          at2,
          plain(await c.replay()),
          `seed ${seed} 第 ${step} 步 连续 rollbackTo: ${trace.join(' ')}`,
        );
        c.chat.push(...tail2);
      }
    } else if (op === 'swap' && c.chat.length > 2) {
      // 移动楼层后被一次定向同步感知
      const j = r.int(c.chat.length);
      [c.chat[index], c.chat[j]] = [c.chat[j], c.chat[index]];
      args = r.int(2) ? [false, r.int(c.chat.length)] : [];
    } else if (op === 'swap_delete' && c.chat.length > 3) {
      // 移动楼层本身没有同步事件，紧接着删除一条
      const j = r.int(c.chat.length);
      [c.chat[index], c.chat[j]] = [c.chat[j], c.chat[index]];
      c.chat.splice(r.int(c.chat.length), 1);
    }
    await c.sync(...args);
    const where = `seed ${seed} 第 ${step} 步: ${trace.join(' ')}`;
    assert.deepEqual(plain(c.stat()), plain(await c.replay()), where);
    // {{ERA-issues}} 只是缓存：按 MK 查到的最新 AI 楼报告必须与从头重放的一致
    const mine = c.host.load_src('core/latest_report').getLatestReport();
    const replayed = c.replay_host().load_src('core/latest_report').getLatestReport();
    if (mine) {
      assert.deepEqual(plain(mine.issues), plain(replayed?.issues), `ERA-issues ${where}`);
      issue_reports_checked += mine.issues.length > 0 ? 1 : 0;
    }
    if (!_.isEmpty(shadow)) assert.deepEqual(plain(c.stat()), plain(await c.replay(shadow)), `压缩 ${where}`);
    for (const mk of c.meta().SelectedMks) {
      const record = c.meta().ApiOps?.[mk];
      if (record) assert.equal(record.applied, record.rev, where);
    }
    // 新聊天里 <era_extra> 不受外层标签、正文里没闭合的思考标签影响（schema 会去掉未声明的键，不检查）
    if (extra_written && !options.schema) assert.ok(c.stat().额外 !== undefined, `分步更新没有生效 ${where}`);
    if (extra_written) extra_hits++;
    if (options.text) {
      const stat = c.stat();
      const decoyed = stat.思考 !== undefined || stat.外 !== undefined || ['思考', '外'].includes(stat.a?.x);
      if (options.legacy) decoy_hits.legacy += decoyed ? 1 : 0;
      else assert.ok(!decoyed, `示例指令生效了 ${where}`);
      assert.equal(c.meta().ParserVersion, options.legacy ? undefined : 3, where);
    }
  }
  return ops_done;
}

const FuzzSchema = z.object({
  a: z.any(),
  b: z.union([z.number().transform(v => Math.min(v, 6)), z.string()]).prefault(2),
  d: z.number().prefault(7),
});

const FuzzHooks = [
  [
    '计数',
    ({ stat, old_stat }) => {
      stat.count = (old_stat.count ?? 0) + 1;
    },
  ],
  [
    '随机',
    ({ stat, random }) => {
      stat.dice = Math.floor(random() * 1000);
      stat['带.点'] = { v: Math.floor(random() * 10), list: [1, { k: Math.floor(random() * 3) }] };
    },
  ],
  [
    '删除',
    ({ stat }) => {
      if (stat.count % 3 === 0) delete stat.c;
      if (_.isPlainObject(stat.a)) stat.a.hook = { x: stat.count };
    },
    1,
  ],
];

/** beforeApply 钩子：按随机数新建含 $expr 的指令，并把一部分数字赋值改成表达式。 */
const FuzzBeforeHooks = [
  [
    '骰子',
    ctx => {
      if (ctx.random() < 0.5) ctx.commands.push({ type: 'edit', data: [{ b: { $expr: 'roll(1, 6) + @b * 0' } }] });
      for (const command of ctx.commands) {
        if (command.type !== 'edit') continue;
        for (const block of command.data) {
          if (typeof block.c === 'number') block.c = { $expr: `${block.c} + roll(0, 9)` };
        }
      }
    },
  ],
];

for (const [name, options, seeds] of [
  ['表达式 + 两种钩子', { hooks: FuzzHooks, before_hooks: FuzzBeforeHooks }, 30],
  ['表达式 + beforeApply 钩子 + 折叠', { before_hooks: FuzzBeforeHooks, settings: { 日志保留楼层数: 2 } }, 20],
  ['钩子', { hooks: FuzzHooks }, 40],
  ['钩子 + schema', { hooks: FuzzHooks, schema: FuzzSchema }, 20],
  ['钩子 + 清理 + 折叠', { hooks: FuzzHooks, settings: { 清理失效日志: true, 日志保留楼层数: 2 } }, 30],
  ['默认设置', {}, 40],
  ['清理失效日志', { settings: { 清理失效日志: true } }, 40],
  ['日志折叠 1 楼', { settings: { 日志保留楼层数: 1 } }, 30],
  ['日志折叠 1 楼 + 钩子', { hooks: FuzzHooks, settings: { 日志保留楼层数: 1 } }, 20],
  ['日志折叠', { settings: { 日志保留楼层数: 3 } }, 80],
  ['日志折叠 + 清理', { settings: { 日志保留楼层数: 2, 清理失效日志: true } }, 40],
  ['日志折叠 + schema', { settings: { 日志保留楼层数: 2 }, schema: FuzzSchema }, 25],
  ['日志折叠 + 存档', { settings: { 日志保留楼层数: 2, 折叠日志存档: true } }, 80],
  [
    '日志折叠 + 存档 + 清理 + 钩子',
    { hooks: FuzzHooks, settings: { 日志保留楼层数: 1, 折叠日志存档: true, 清理失效日志: true } },
    30,
  ],
  ['日志折叠 + 存档 + schema', { schema: FuzzSchema, settings: { 日志保留楼层数: 2, 折叠日志存档: true } }, 30],
  [
    '日志折叠 + 存档 + 压缩（一楼多条指令）',
    { archive: true, dense: true, settings: { 日志保留楼层数: 2, 折叠日志存档: true } },
    60,
  ],
  [
    '日志折叠 + 存档 + 压缩 + 钩子 + 清理',
    {
      archive: true,
      dense: true,
      hooks: FuzzHooks,
      settings: { 日志保留楼层数: 1, 折叠日志存档: true, 清理失效日志: true },
    },
    25,
  ],
  ['数组内保留对象', { settings: { 数组内保留对象: true } }, 20],
  ['注册 schema', { schema: FuzzSchema }, 25],
  ['新聊天：遮蔽思考块', { text: { think: true } }, 40],
  ['新聊天：遮蔽思考块 + 钩子', { text: { think: true }, hooks: FuzzHooks }, 20],
  ['新聊天：遮蔽思考块 + schema', { text: { think: true }, schema: FuzzSchema }, 15],
  [
    '新聊天：指令外层标签 + 思考块 + 折叠',
    { text: { think: true, outer: true }, settings: { 指令外层标签: '<ERA_Update>', 日志保留楼层数: 2 } },
    30,
  ],
  [
    '新聊天：思考块 + 下划线只读 + 折叠存档',
    { text: { think: true }, settings: { 下划线只读: true, 日志保留楼层数: 2, 折叠日志存档: true } },
    20,
  ],
  ['旧聊天：思考块里的指令照旧执行', { text: { think: true, outer: true }, legacy: true }, 30],
  [
    '新聊天：指令外层标签 + 思考块 + 分步更新',
    { text: { think: true, outer: true, extra: true }, settings: { 指令外层标签: 'ERA_Update' } },
    30,
  ],
  ['新聊天：未闭合的思考标签 + 分步更新', { text: { think: true, open: true, extra: true } }, 30],
  [
    '新聊天：未闭合的思考标签 + 分步更新 + 钩子 + 折叠',
    { text: { think: true, open: true, extra: true }, hooks: FuzzHooks, settings: { 日志保留楼层数: 2 } },
    20,
  ],
  ['旧聊天：分步更新', { text: { think: true, open: true, outer: true, extra: true }, legacy: true }, 20],
]) {
  test(`随机操作序列后状态等于从头重放（${name}）`, async () => {
    let ops = 0;
    const hits = decoy_hits.legacy;
    for (let seed = 1; seed <= seeds; seed++) ops += await fuzz(seed, options);
    assert.ok(ops > seeds); // 旁路写入确实被执行过
    if (options.legacy) assert.ok(decoy_hits.legacy > hits, '旧聊天中思考块里的指令应当照旧执行');
  });
}

test('随机对拍确实比较过含问题的 {{ERA-issues}} 报告，也写入过 <era_extra>', () => {
  assert.ok(issue_reports_checked > 0);
  assert.ok(extra_hits > 0);
});

test('随机对拍确实写出过存档段，并压缩过日志', () => {
  assert.ok(compress_hits.segments > 0);
  assert.ok(compress_hits.compressed > 0, JSON.stringify(compress_hits));
});

// ---------------------------------------------------------------------------
// 审查修复
// ---------------------------------------------------------------------------

test('快速同步：移动楼层后紧接着删除一条空日志楼，结果仍等于从头重放', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"s":""}</VariableInsert>');
  c.send('assistant', '<VariableEdit>{"s":"B"}</VariableEdit>');
  c.send('assistant', '<VariableEdit>{"s":"C"}</VariableEdit>');
  c.send('assistant', '没有指令');
  await c.sync();
  [c.chat[1], c.chat[2]] = [c.chat[2], c.chat[1]];
  c.chat.pop();
  await c.sync();
  assert.deepEqual(plain(c.stat()), { s: 'B' });
  assert.deepEqual(plain(c.stat()), plain(await c.replay()));
});

test('快速同步：顺序不变时仍只修正 SelectedMks', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"s":1}</VariableInsert>');
  c.send('assistant', '没有指令');
  c.send('assistant', '<VariableEdit>{"s":2}</VariableEdit>');
  await c.sync();
  const logs = plain(c.meta().EditLogs);
  c.chat.splice(1, 1);
  await c.sync();
  assert.deepEqual(plain(c.stat()), { s: 2 });
  assert.equal(c.meta().SelectedMks.length, 2);
  assert.deepEqual(plain(c.meta().EditLogs), logs, '没有重算');
});

test('用户消息中的指令：发送时计算，首次结果等于从头重放', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"hp":10}</VariableInsert>');
  await c.sync();
  c.send('user', '<VariableEdit>{"hp":"+=100"}</VariableEdit>');
  await c.host.load_src('events/dispatcher').dispatchAndExecuteTask({ type: 'MESSAGE_SENT', timestamp: 0 }, null);
  c.send('assistant', '回复');
  await c.sync();
  assert.equal(c.stat().hp, 110);
  await c.sync(true);
  assert.equal(c.stat().hp, 110);
});

test('一次普通同步只写入一次聊天变量，stat 与元数据一起写入', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"hp":10}</VariableInsert>');
  await c.sync();
  c.send('assistant', '<VariableEdit>{"hp":11}</VariableEdit>');
  await c.host.mk.ensureMessageKey({ message_id: 1, ...c.chat[1] });
  const mk = c.host.mk.readMessageKey({ message_id: 1, ...c.chat[1] });
  const { handleSyncEvent } = c.host.load_src('events/handlers/sync');
  const before = c.writes();
  await handleSyncEvent({ type: 'MESSAGE_RECEIVED' }, {}, { mk, message_id: 1 });
  assert.equal(c.writes() - before, 1);
  assert.equal(c.stat().hp, 11);
  assert.equal(c.meta().SelectedMks[1], mk);
});

test('同步被放弃或失败时，不更新 SelectedMks 末楼、不发出 writeDone', async () => {
  // 放弃：同步过程中切换聊天
  const c = create_chat({
    hooks: [['切换', () => void (c.host.context.SillyTavern.getCurrentChatId = () => '另一个聊天')]],
  });
  c.send('assistant', '<VariableInsert>{"a":1}</VariableInsert>');
  assert.equal(await c.host.sync.resyncStateOnHistoryChange(), 'aborted');
  c.host.context.SillyTavern.getCurrentChatId = () => 'chat';
  const { handleSyncEvent } = c.host.load_src('events/handlers/sync');
  await handleSyncEvent({ type: 'manual_sync' }, {}, { mk: 'era_mk_旧聊天', message_id: 0 });
  assert.deepEqual(plain(c.meta().SelectedMks ?? []), []);
  assert.equal(c.host.emitted.filter(e => e.name === 'era:writeDone').length, 0);

  // 失败：同步中抛出异常
  const d = create_chat();
  d.send('assistant', '<VariableInsert>{"a":1}</VariableInsert>');
  await d.sync();
  const meta = plain(d.meta());
  d.send('assistant', '<VariableEdit>{"a":2}</VariableEdit>');
  d.host.context.SillyTavern.getCurrentChatId = () => {
    throw new Error('坏了');
  };
  assert.equal(await d.host.sync.resyncStateOnHistoryChange(), 'failed');
  await d.host
    .load_src('events/handlers/sync')
    .handleSyncEvent({ type: 'manual_sync' }, {}, { mk: 'era_mk_x', message_id: 1 });
  assert.deepEqual(plain(d.meta()), meta);
  assert.deepEqual(plain(d.stat()), { a: 1 });
  assert.equal(d.host.emitted.filter(e => e.name === 'era:writeDone').length, 0);
});

test('合并后的完全重算任务确实完全重算', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"a":1}</VariableInsert>');
  c.send('assistant', '<VariableEdit>{"a":2}</VariableEdit>');
  await c.sync();
  // 不经过编辑事件直接改动旧楼正文：只有完全重算才会按新正文计算
  c.chat[0].swipes[0] = c.chat[0].swipes[0].replace('{"a":1}', '{"a":1,"b":5}');
  const { mergeEventBatch } = c.host.load_src('events/merger');
  const [merged] = mergeEventBatch([
    { type: 'manual_full_sync', timestamp: 0 },
    { type: 'era:apiWrite', timestamp: 1 },
  ]);
  const { handleSyncEvent } = c.host.load_src('events/handlers/sync');
  await handleSyncEvent(merged, {}, { mk: c.meta().SelectedMks[1], message_id: 1 });
  assert.deepEqual(plain(c.stat()), { a: 2, b: 5 });
});

test('历史快照与当前变量口径一致：保留日志无法解释的键', async () => {
  const c = create_chat();
  c.send('assistant', '<VariableInsert>{"hp":10}</VariableInsert>');
  await c.sync();
  c.variables().stat_data.external = 1;
  c.send('assistant', '<VariableEdit>{"hp":11}</VariableEdit>');
  await c.sync();
  const mks = c.meta().SelectedMks;
  assert.deepEqual(plain(c.stat()), { hp: 11, external: 1 });
  assert.deepEqual(plain(c.host.snapshot.getStatAtMK(mks[1])), plain(c.stat()));
  assert.deepEqual(plain(c.host.snapshot.getStatAtMK(mks[0])), { hp: 10, external: 1 });
  assert.deepEqual(plain(c.host.snapshot.getStatsBetweenMKs().map(item => item.stat)), [
    { hp: 10, external: 1 },
    { hp: 11, external: 1 },
  ]);
});

test('注入 MK 时保留正文中的 {{user}} 等宏', async () => {
  const c = create_chat();
  c.send('assistant', 'hi {{user}} and {{char}}<VariableInsert>{"who":"{{user}}"}</VariableInsert>');
  await c.sync();
  const text = c.chat[0].swipes[0];
  assert.ok(text.startsWith('hi {{user}} and {{char}}'), text);
  assert.match(text, /<era_data>/);
  assert.equal(c.stat().who, 'User', '计算时仍按展开后的正文');
});

test('重算不修改之前读取到的元数据对象，结果仍等于从头重放', async () => {
  const c = create_chat({ settings: { 日志保留楼层数: 2 } });
  c.send('assistant', '<VariableInsert>{"n":0}</VariableInsert>');
  for (let i = 0; i < 6; i++) c.send('assistant', '<VariableEdit>{"n":"+=1"}</VariableEdit>');
  await c.sync();
  const meta = c.variables().ERAMetaData;
  const snapshot = plain(meta);
  c.chat.splice(5, 1);
  c.send('assistant', '<VariableEdit>{"n":"+=10"}</VariableEdit>');
  await c.sync();
  assert.deepEqual(plain(meta), snapshot);
  assert.deepEqual(plain(c.stat()), plain(await c.replay()));
});
