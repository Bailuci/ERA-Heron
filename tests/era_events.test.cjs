/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：测试事件合并、事件队列的异常恢复、发给 AI 的提示词中的宏替换时机、用户消息中的指令；提示词中的状态栏占位符
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 事件层测试：合并规则、队列、宏替换与 MESSAGE_SENT。用内存中的假聊天驱动真实源码。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create_chat, plain } = require('./chat.cjs');

const T = (type, data) => `<Variable${type}>${JSON.stringify(data)}</Variable${type}>`;

/** 带事件队列的假聊天。 */
function live(options = {}) {
  const c = create_chat({
    ...options,
    globals: { setTimeout, clearTimeout, $: () => ({ on() {} }), ...options.globals },
  });
  const queue = c.host.load_src('events/queue');
  const merger = c.host.load_src('events/merger');
  return { ...c, queue, merger };
}

const job = (type, timestamp = 0, extra = {}) => ({ type, timestamp, ...extra });

// ---------------------------------------------------------------------------
// 事件合并
// ---------------------------------------------------------------------------

test('合并：同组 SYNC 事件后者覆盖前者，但保留完全重算与清理需求', () => {
  const { merger } = live();
  const { mergeEventBatch, isFullSyncJob, needsPruneJob } = merger;

  let jobs = mergeEventBatch([job('manual_full_sync'), job('era:apiWrite', 10)]);
  assert.deepEqual(plain(jobs.map(j => j.type)), ['era:apiWrite']);
  assert.ok(isFullSyncJob(jobs[0]), '强制完全重算不会被覆盖');
  assert.ok(needsPruneJob(jobs[0]));

  jobs = mergeEventBatch([job('CHAT_CHANGED'), job('MESSAGE_RECEIVED', 10)]);
  assert.deepEqual(plain(jobs.map(j => j.type)), ['MESSAGE_RECEIVED']);
  assert.ok(!isFullSyncJob(jobs[0]));
  assert.ok(needsPruneJob(jobs[0]), '载入聊天的清理不会被覆盖');

  jobs = mergeEventBatch([job('MESSAGE_RECEIVED'), job('MESSAGE_DELETED', 10)]);
  assert.deepEqual(plain(jobs.map(j => j.type)), ['MESSAGE_DELETED']);
  assert.ok(!isFullSyncJob(jobs[0]) && !needsPruneJob(jobs[0]), '普通事件不带标记');

  // 合并链：标记一路传下去
  jobs = mergeEventBatch([job('manual_full_sync'), job('MESSAGE_RECEIVED', 1), job('manual_sync', 2)]);
  assert.equal(jobs.length, 1);
  assert.ok(isFullSyncJob(jobs[0]));
});

test('合并：组合事件、超时、未配对的起始事件和不同组的事件', () => {
  const { mergeEventBatch } = live().merger;
  const types = batch => plain(mergeEventBatch(batch).map(j => j.type));

  assert.deepEqual(types([job('MESSAGE_SWIPED', 0), job('GENERATION_STARTED', 600)]), ['combo_swipe_and_regenerate']);
  assert.deepEqual(types([job('MESSAGE_SWIPED', 0), job('GENERATION_STARTED', 601)]), ['MESSAGE_SWIPED']);
  assert.deepEqual(types([job('MESSAGE_UPDATED', 0), job('GENERATION_STARTED', 1500)]), ['combo_edit_and_continue']);
  assert.deepEqual(types([job('MESSAGE_UPDATED', 0)]), [], '未配对的组合起始事件被丢弃');
  assert.deepEqual(types([job('GENERATION_STARTED', 0)]), [], '对冲检测事件本身不执行');
  assert.deepEqual(types([job('era:insertByPath', 0), job('era:updateByPath', 1)]), [
    'era:insertByPath',
    'era:updateByPath',
  ]);
  assert.deepEqual(types([job('MESSAGE_RECEIVED', 0), job('MESSAGE_SENT', 1), job('MESSAGE_RECEIVED', 2)]), [
    'MESSAGE_RECEIVED',
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
  ]);
});

test('合并：被组合事件替换的前一个事件带有需求时，改成一次普通同步保留下来', () => {
  const { mergeEventBatch, isFullSyncJob, needsPruneJob } = live().merger;
  const jobs = mergeEventBatch([job('manual_full_sync', 0), job('MESSAGE_SWIPED', 10), job('GENERATION_STARTED', 20)]);
  assert.deepEqual(plain(jobs.map(j => j.type)), ['manual_sync', 'combo_swipe_and_regenerate']);
  assert.ok(isFullSyncJob(jobs[0]) && needsPruneJob(jobs[0]));
  assert.ok(!isFullSyncJob(jobs[1]));
});

test('hasImmediateCombo：只认标记为 immediate、在时限内、紧邻的组合', () => {
  const { hasImmediateCombo } = live().merger;
  assert.equal(hasImmediateCombo([job('MESSAGE_SWIPED', 0)]), false);
  assert.equal(hasImmediateCombo([job('MESSAGE_SWIPED', 0), job('GENERATION_STARTED', 600)]), true);
  assert.equal(hasImmediateCombo([job('MESSAGE_SWIPED', 0), job('GENERATION_STARTED', 700)]), false);
  assert.equal(hasImmediateCombo([job('MESSAGE_UPDATED', 0), job('GENERATION_STARTED', 1400)]), true);
  assert.equal(
    hasImmediateCombo([job('MESSAGE_SWIPED', 0), job('MESSAGE_RECEIVED', 1), job('GENERATION_STARTED', 2)]),
    false,
    '中间隔着别的事件',
  );
  assert.equal(
    hasImmediateCombo([job('MESSAGE_RECEIVED', 0), job('MESSAGE_SWIPED', 1), job('GENERATION_STARTED', 2)]),
    true,
  );
});

// ---------------------------------------------------------------------------
// 事件队列
// ---------------------------------------------------------------------------

test('队列：任务抛错后释放锁，之后的事件仍会处理；等待式写入的凭据被拒绝', async () => {
  const env = live();
  const dispatcher = env.host.load_src('events/dispatcher');
  const handled = [];
  const rejected = [];
  dispatcher.dispatchAndExecuteTask = async j => {
    handled.push(j.type);
    throw new Error(`炸了: ${j.type}`);
  };
  env.queue.pushToQueue('era:insertByPath', {}, { reject: error => rejected.push(error.message) });
  assert.equal(await env.queue.waitForQueueIdle(2000), true);
  assert.deepEqual(rejected, ['炸了: era:insertByPath']);

  dispatcher.dispatchAndExecuteTask = async j => {
    handled.push(j.type);
    if (j.type === 'manual_write') throw new Error('炸了');
  };
  env.queue.pushToQueue('manual_write');
  assert.equal(await env.queue.waitForQueueIdle(2000), true);
  env.queue.pushToQueue('manual_sync');
  assert.equal(await env.queue.waitForQueueIdle(2000), true);
  assert.deepEqual(handled, ['era:insertByPath', 'manual_write', 'manual_sync']);
  assert.ok(env.queue.isQueueIdle());
});

test('队列：合并阶段抛错时丢弃这一批并释放锁', async () => {
  const env = live();
  const dispatcher = env.host.load_src('events/dispatcher');
  const handled = [];
  dispatcher.dispatchAndExecuteTask = async j => void handled.push(j.type);
  const { mergeEventBatch } = env.merger;
  env.merger.mergeEventBatch = () => {
    throw new Error('合并出错');
  };
  const rejected = [];
  env.queue.pushToQueue('era:insertByPath', {}, { reject: error => rejected.push(error.message) });
  assert.equal(await env.queue.waitForQueueIdle(2000), true);
  assert.deepEqual(rejected, ['合并出错']);
  env.merger.mergeEventBatch = mergeEventBatch;
  env.queue.pushToQueue('manual_sync');
  assert.equal(await env.queue.waitForQueueIdle(2000), true);
  assert.deepEqual(handled, ['manual_sync']);
});

test('队列：处理期间推入的事件不会丢失，waitForQueueIdle 在全部处理完后才返回', async () => {
  const env = live();
  const dispatcher = env.host.load_src('events/dispatcher');
  const handled = [];
  dispatcher.dispatchAndExecuteTask = async j => {
    handled.push(j.type);
    if (j.type === 'manual_write') env.queue.pushToQueue('manual_sync');
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  env.queue.pushToQueue('manual_write');
  assert.equal(env.queue.isQueueIdle(), false);
  assert.equal(await env.queue.waitForQueueIdle(3000), true);
  assert.deepEqual(handled, ['manual_write', 'manual_sync']);
  assert.equal(await env.queue.waitForQueueIdle(10), true, '空闲时立即返回');
});

test('队列：真实的同步任务出错时，后续事件仍会同步', async () => {
  const env = live();
  env.send('assistant', T('Insert', { hp: 10 }));
  const original = env.host.context.getChatMessages;
  let broken = true;
  env.host.context.getChatMessages = (...args) => {
    if (broken) throw new Error('酒馆助手：无效的消息范围');
    return original(...args);
  };
  env.queue.pushToQueue('manual_sync');
  await env.queue.waitForQueueIdle(3000);
  assert.deepEqual(env.stat(), {});
  broken = false;
  env.queue.pushToQueue('manual_sync');
  await env.queue.waitForQueueIdle(3000);
  assert.deepEqual(env.stat(), { hp: 10 });
});

// ---------------------------------------------------------------------------
// 发给 AI 的提示词中的宏
// ---------------------------------------------------------------------------

function prompt_env() {
  const env = live();
  const { handleGenerateAfterData } = env.host.load_src('macro/parser');
  const generate = async (contents, dry_run = false) => {
    const data = { prompt: contents.map(content => ({ role: 'system', content })) };
    const result = handleGenerateAfterData(data, dry_run);
    const pending = result instanceof Promise || typeof result?.then === 'function';
    await result;
    return { contents: data.prompt.map(p => p.content), pending };
  };
  return { ...env, generate };
}

test('提示词宏：队列空闲时在监听器内同步替换；不区分大小写、允许空格', async () => {
  const env = prompt_env();
  env.send('assistant', T('Insert', { player: { hp: 10, $meta: { x: 1 } } }));
  await env.sync();
  const data = {
    prompt: [
      { role: 'system', content: '{{ERA:player.hp}}' },
      { role: 'user', content: '{{ era : player.hp }} / {{era:player}} / {{Era-WithMeta:player}}' },
      { role: 'assistant', content: '没有宏' },
    ],
  };
  const result = env.host.load_src('macro/parser').handleGenerateAfterData(data, false);
  assert.equal(result, undefined, '空闲时不需要等待');
  assert.deepEqual(
    data.prompt.map(p => p.content),
    ['10', '10 / {"hp":10} / {"hp":10,"$meta":{"x":1}}', '没有宏'],
  );
  const dry = await env.generate(['{{ERA:player.hp}}'], true);
  assert.deepEqual(dry.contents, ['{{ERA:player.hp}}'], '演习运行不替换');
});

test('提示词宏：队列忙时监听器返回 Promise，完成时已按同步后的变量替换', async () => {
  const env = prompt_env();
  env.send('assistant', T('Insert', { hp: 10 }));
  await env.sync();
  env.send('user', '攻击');
  env.send('assistant', T('Edit', { hp: 7 }));
  env.queue.pushToQueue('MESSAGE_RECEIVED');
  assert.equal(env.queue.isQueueIdle(), false);
  const { contents, pending } = await env.generate(['生命 {{ERA:hp}}']);
  assert.equal(pending, true);
  assert.deepEqual(contents, ['生命 7']);
  assert.equal(env.stat().hp, 7);
});

test('提示词宏：滑动重新生成时，按回退后的变量替换', async () => {
  const env = prompt_env();
  env.send('assistant', T('Insert', { hp: 10 }));
  env.send('user', '攻击');
  env.send('assistant', T('Edit', { hp: 7 }));
  await env.sync();
  // 滑到新的一页并开始生成：新页面还是空的
  env.swipe_new(2, '');
  const now = Date.now();
  env.queue.pushToQueue('MESSAGE_SWIPED', 2);
  env.queue.pushToQueue('GENERATION_STARTED');
  const { contents } = await env.generate(['生命 {{ERA:hp}}']);
  assert.ok(Date.now() - now < 3000);
  assert.deepEqual(contents, ['生命 10']);
});

// ---------------------------------------------------------------------------
// 用户消息中的指令
// ---------------------------------------------------------------------------

test('用户消息含指令时，发送时就计算，首次结果等于从头重算', async () => {
  const env = live();
  env.send('assistant', T('Insert', { hp: 10 }));
  await env.sync();
  env.send('user', `喝药${T('Edit', { hp: '+=100' })}`);
  env.queue.pushToQueue('MESSAGE_SENT', 1);
  await env.queue.waitForQueueIdle(3000);
  assert.equal(env.stat().hp, 110, '发送时已计算');
  env.send('assistant', T('Edit', { hp: '-=5' }));
  env.queue.pushToQueue('MESSAGE_RECEIVED', 2);
  await env.queue.waitForQueueIdle(3000);
  assert.equal(env.stat().hp, 105);
  assert.deepEqual(plain(env.stat()), plain(await env.replay()));
  await env.sync(true);
  assert.equal(env.stat().hp, 105, '完全重算结果不变');
});

test('用户消息没有指令时，发送时只登记 MK、不写入变量', async () => {
  const env = live();
  env.send('assistant', T('Insert', { hp: 10 }));
  await env.sync();
  const writes = env.writes();
  env.send('user', '你好');
  env.queue.pushToQueue('MESSAGE_SENT', 1);
  await env.queue.waitForQueueIdle(3000);
  assert.equal(env.meta().SelectedMks.length, 2);
  assert.deepEqual(env.stat(), { hp: 10 });
  assert.equal(env.writes(), writes + 1, '只登记 MK');
});

// ---------------------------------------------------------------------------
// 发给 AI 的提示词中的状态栏占位符（没有更新规则的旧卡缺少隐藏正则）
// ---------------------------------------------------------------------------

/** 按角色组装提示词并调用真实的 GENERATE_AFTER_DATA 监听器。 */
async function generate_roles(env, messages, dry_run = false) {
  const data = { prompt: messages.map(([role, content]) => ({ role, content })) };
  await env.host.load_src('macro/parser').handleGenerateAfterData(data, dry_run);
  return data.prompt.map(p => p.content);
}

test('占位符：只从 AI 消息中去掉（连同前面的空白、不区分大小写），系统提示词和用户输入里作者写的不动', async () => {
  const env = prompt_env();
  const contents = await generate_roles(env, [
    ['system', '每条回复以 <StatusPlaceHolderImpl/> 结尾'],
    ['assistant', '第一楼正文\n<StatusPlaceHolderImpl/>'],
    ['user', '用户提到 <statusplaceholderimpl/> 呢'],
    ['assistant', '甲\n<StatusPlaceHolderImpl/>\n乙 <statusplaceholderimpl/>'],
    ['assistant', '没有占位符'],
    ['assistant', '{{ERA:hp}}<StatusPlaceHolderImpl/>'],
  ]);
  assert.deepEqual(contents, [
    '每条回复以 <StatusPlaceHolderImpl/> 结尾',
    '第一楼正文',
    '用户提到 <statusplaceholderimpl/> 呢',
    '甲\n乙',
    '没有占位符',
    '',
  ]);
  const dry = await generate_roles(env, [['assistant', '正文\n<StatusPlaceHolderImpl/>']], true);
  assert.deepEqual(dry, ['正文\n<StatusPlaceHolderImpl/>'], '演习运行不处理');
});

test('占位符：多模态消息只处理文字部分', async () => {
  const env = prompt_env();
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' } };
  const [content] = await generate_roles(env, [
    ['assistant', [{ type: 'text', text: '正文\n<StatusPlaceHolderImpl/>' }, image]],
  ]);
  assert.deepEqual(content, [{ type: 'text', text: '正文' }, image]);
});

test('占位符：自定义 特殊符号值 按字面匹配，只在追加功能开启时处理；默认值始终处理；空白值不处理', async () => {
  const env = prompt_env();
  const settings = env.host.era_data.settings.value;
  settings.特殊符号值 = '[状态.*]';
  const messages = [
    ['assistant', '正文 [状态.*]'],
    ['assistant', '[状态栏]'],
    ['assistant', '<StatusPlaceHolderImpl/>'],
  ];
  assert.deepEqual(await generate_roles(env, messages), ['正文', '[状态栏]', '<StatusPlaceHolderImpl/>']);
  settings.在ai消息尾部生成特殊符号 = false;
  assert.deepEqual(
    await generate_roles(env, messages),
    ['正文 [状态.*]', '[状态栏]', '<StatusPlaceHolderImpl/>'],
    '功能关闭时自定义值不是 ERA 追加的，不处理',
  );
  settings.特殊符号值 = '<StatusPlaceHolderImpl/>';
  assert.deepEqual(
    await generate_roles(env, [['assistant', '正文\n\n<StatusPlaceHolderImpl/>']]),
    ['正文'],
    '默认值即使功能关闭也处理：旧消息里可能留着以前追加的占位符',
  );
  const { stripStatusPlaceholder } = env.host.load_src('macro/parser');
  const prompt = [{ role: 'assistant', content: 'a \n b' }];
  stripStatusPlaceholder(prompt, ' ');
  assert.equal(prompt[0].content, 'a \n b');
});
