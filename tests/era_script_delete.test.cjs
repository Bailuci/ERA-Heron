/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-28
 * 目的：脚本删楼（不发事件）之后直接新建不带指令的玩家楼：被删楼层的改动必须回滚，结果与从头重放一致
 *       2026-11-28 记录末尾为空时的完全重算
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 运行方式: node --test tests/era_script_delete.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create_chat, plain } = require('./chat.cjs');

const T = (type, data) => `<Variable${type}>${JSON.stringify(data)}</Variable${type}>`;

function create_env() {
  const env = create_chat({ globals: { setTimeout, clearTimeout, $: () => ({ on() {} }) } });
  const queue = env.host.load_src('events/queue');
  const fire = async (type, detail) => {
    queue.pushToQueue(type, detail);
    await queue.waitForQueueIdle(8000);
  };
  const stat = () => plain(env.host.data.unescapeEraData(env.stat()));
  return { env, queue, fire, stat };
}

/** 开场、玩家、AI（`killer`）三楼。 */
async function story(killer, user = '攻击') {
  const ctx = create_env();
  ctx.env.send('assistant', T('Insert', { hp: 10 }));
  await ctx.fire('MESSAGE_RECEIVED', 0);
  ctx.env.send('user', user);
  await ctx.fire('MESSAGE_SENT', 1);
  ctx.env.send('assistant', killer);
  await ctx.fire('MESSAGE_RECEIVED', 2);
  return ctx;
}

const same_as_replay = async (ctx, label) =>
  assert.deepEqual(plain(ctx.env.stat()), plain(await ctx.env.replay()), `${label}：与从头重放一致`);

test('脚本删掉末尾的 AI 楼后直接发送不带指令的玩家消息：被删楼新增的键不残留', async () => {
  const ctx = await story(T('Insert', { loot: '剑' }));
  assert.deepEqual(ctx.stat(), { hp: 10, loot: '剑' });
  ctx.env.chat.pop(); // 脚本删楼：不发任何事件
  ctx.env.send('user', '改为防御');
  await ctx.fire('MESSAGE_SENT', 2);
  assert.deepEqual(ctx.stat(), { hp: 10 }, '玩家楼建好时就已经回滚');
  await same_as_replay(ctx, '发送后');
  ctx.env.send('assistant', '你举起盾。');
  await ctx.fire('MESSAGE_RECEIVED', 3);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  await ctx.fire('manual_full_sync', undefined);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  await same_as_replay(ctx, '完全重算后');
});

test('脚本删掉末尾的 AI 楼后直接发送：被删楼对已有值的修改同样回滚', async () => {
  const ctx = await story(T('Edit', { hp: 7 }));
  assert.deepEqual(ctx.stat(), { hp: 7 });
  ctx.env.chat.pop();
  ctx.env.send('user', '改为防御');
  await ctx.fire('MESSAGE_SENT', 2);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  ctx.env.send('assistant', '你举起盾。');
  await ctx.fire('MESSAGE_RECEIVED', 3);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  await same_as_replay(ctx, '回复后');
});

test('脚本一次删掉带规划的玩家楼和 AI 楼后直接发送：规划写入的改动不残留', async () => {
  const plan = `攻击\n<era_plan>\n<PlanSummary>命中</PlanSummary>\n${T('Insert', { buff: 1 })}\n</era_plan>`;
  const ctx = await story('你一剑命中。', plan);
  assert.deepEqual(ctx.stat(), { hp: 10, buff: 1 });
  ctx.env.chat.pop();
  ctx.env.chat.pop();
  ctx.env.send('user', '改为防御');
  await ctx.fire('MESSAGE_SENT', 1);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  ctx.env.send('assistant', '你举起盾。');
  await ctx.fire('MESSAGE_RECEIVED', 2);
  await ctx.fire('manual_full_sync', undefined);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  await same_as_replay(ctx, '完全重算后');
});

test('正常发送不带指令的玩家消息仍然只登记 MK，不触发重算', async () => {
  const ctx = await story('你一剑命中。');
  const before = plain(ctx.env.meta().EditLogs);
  ctx.env.send('user', '继续');
  await ctx.fire('MESSAGE_SENT', 3);
  const meta = ctx.env.meta();
  assert.equal(meta.SelectedMks.length, 4);
  assert.ok(meta.SelectedMks[3], '新玩家楼登记了 MK');
  assert.deepEqual(plain(meta.EditLogs), before, '日志没有变化');
});

test('rollbackTo 截断记录之后发送玩家消息：不因为这条判断而重算被截掉的楼', async () => {
  const ctx = await story(T('Edit', { hp: 7 }));
  ctx.env.send('user', '继续');
  await ctx.fire('MESSAGE_SENT', 3);
  // 界面原生删除末尾两楼会发事件，这里直接按事件同步，再正常发送
  ctx.env.chat.pop();
  ctx.env.chat.pop();
  await ctx.fire('MESSAGE_DELETED', 2);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  ctx.env.send('user', '改为防御');
  await ctx.fire('MESSAGE_SENT', 2);
  assert.deepEqual(ctx.stat(), { hp: 10 });
  await same_as_replay(ctx, '原生删除后发送');
});

test('旧聊天记录的最后一项是空的（末楼是玩家消息）：完全重算不会在现有变量上重复执行第 0 楼', async () => {
  const ctx = create_env();
  ctx.env.send('assistant', T('Insert', { hp: 10, n: 0 }));
  await ctx.fire('MESSAGE_RECEIVED', 0);
  ctx.env.send('assistant', T('Edit', { n: '+=1' }));
  await ctx.fire('MESSAGE_RECEIVED', 1);
  assert.deepEqual(ctx.stat(), { hp: 10, n: 1 });
  // 旧版本不给玩家楼登记：末楼是玩家消息，记录的最后一项是 null
  ctx.env.send('user', '继续');
  ctx.env.meta().SelectedMks.push(null);
  await ctx.env.sync(true);
  assert.deepEqual(ctx.stat(), { hp: 10, n: 1 }, '没有重复累加');
  await same_as_replay(ctx, '完全重算后');
});
