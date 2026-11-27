/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：测试斜杠命令 /era-get、/era-issues 与它们共用的数据读取（core/issues.ts）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 运行方式: node --test tests/era_commands.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create_chat } = require('./chat.cjs');

const T = (type, data) => `<Variable${type}>${JSON.stringify(data)}</Variable${type}>`;

function env() {
  const c = create_chat();
  const commands = c.host.load_src('ui/commands');
  const issues = c.host.load_src('core/issues');
  return { ...c, commands, issues };
}

test('/era-get：去转义、去 $meta 的 JSON；meta=true 保留；空路径返回全部；找不到为空串；字面键名', async () => {
  const c = env();
  c.send(
    'assistant',
    T('Insert', { 角色: { 甲: { 生命: 5, $meta: { 说明: '主角' } } }, 'a.b': { c: 2 }, 名字: '小白' }),
  );
  await c.sync();
  const get = (path, named = {}) => c.commands.eraGet(named, path);
  assert.equal(await get('角色.甲'), '{"生命":5}');
  assert.equal(await get('角色.甲', { meta: 'true' }), '{"生命":5,"$meta":{"说明":"主角"}}');
  assert.equal(await get('角色.甲.生命'), '5');
  assert.equal(await get(' 名字 '), '"小白"', '字符串按 JSON 返回');
  assert.equal(await get('a.b.c'), '2', '键名本身含 . 时按字面匹配');
  assert.equal(await get('不存在.路径'), '');
  assert.deepEqual(JSON.parse(await get('')), { 角色: { 甲: { 生命: 5 } }, 'a.b': { c: 2 }, 名字: '小白' });
  assert.deepEqual(JSON.parse(await get('$ALLDATA')), JSON.parse(await get('')));
});

test('/era-issues：列出最新 AI 楼没有生效的指令；末尾是用户消息时仍看最新 AI 楼；没有问题时为空', async () => {
  const c = env();
  c.send('assistant', T('Insert', { hp: 10 }));
  c.send('user', '你好');
  c.send('assistant', T('Edit', { hp: '+=1', 不存在: { x: '+=1' } }) + T('Insert', { hp: 1 }));
  await c.sync();
  assert.equal(c.stat().hp, 11);

  const text = await c.commands.eraIssues({});
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^- 不存在：路径不存在/);
  assert.match(lines[1], /^- hp：/);

  const json = JSON.parse(await c.commands.eraIssues({ format: 'json' }));
  assert.equal(json.message_id, 2);
  assert.equal(json.mk, c.meta().SelectedMks[2]);
  assert.equal(json.problems.length, 2);
  assert.equal(json.problems[0].origin, 'text');
  assert.equal(json.unavailable, undefined);

  c.send('user', '继续');
  await c.sync();
  assert.equal(await c.commands.eraIssues({}), text, '末尾的用户消息不影响结果');

  c.send('assistant', T('Edit', { hp: '+=1' }));
  await c.sync();
  assert.equal(await c.commands.eraIssues({}), '');
  assert.deepEqual(JSON.parse(await c.commands.eraIssues({ format: 'json' })).problems, []);
  assert.equal(c.stat().hp, 12, '读取问题不改变变量');
});

test('/era-issues：没有 AI 消息、还没同步过时给出说明', async () => {
  const c = env();
  assert.deepEqual(JSON.parse(await c.commands.eraIssues({ format: 'json' })), {
    message_id: null,
    mk: null,
    problems: [],
  });
  c.send('assistant', T('Insert', { hp: 10 }));
  const json = JSON.parse(await c.commands.eraIssues({ format: 'json' }));
  assert.equal(json.message_id, 0);
  assert.match(json.unavailable, /没有同步/);
  assert.equal(await c.commands.eraIssues({}), '');
});

test('/era-issues：被变量结构拦截的修改也会列出', async () => {
  const z = require('zod');
  const c = create_chat({ schema: z.object({ hp: z.number().max(100) }) });
  const { eraIssues } = c.host.load_src('ui/commands');
  c.send('assistant', T('Insert', { hp: 10 }));
  c.send('assistant', T('Edit', { hp: 500 }));
  await c.sync();
  assert.equal(c.stat().hp, 10);
  assert.match(await eraIssues({}), /^- hp：/);
});

test('注册：两个命令都注册，带参数说明；卸载后调用返回空串并提示', async () => {
  const c = env();
  const registered = [];
  Object.assign(c.host.context.SillyTavern, {
    SlashCommandParser: { addCommandObject: command => registered.push(command) },
    SlashCommand: { fromProps: props => props },
    SlashCommandArgument: { fromProps: props => ({ unnamed: props }) },
    SlashCommandNamedArgument: { fromProps: props => ({ named: props }) },
  });
  c.send('assistant', T('Insert', { hp: 10 }));
  await c.sync();
  const stop = c.commands.registerDataCommands();
  assert.deepEqual(
    registered.map(command => command.name),
    ['era-get', 'era-issues'],
  );
  assert.equal(registered[0].namedArgumentList[0].named.name, 'meta');
  assert.equal(registered[1].namedArgumentList[0].named.name, 'format');
  assert.equal(await registered[0].callback({}, 'hp'), '10');
  stop();
  assert.equal(await registered[0].callback({}, 'hp'), '');
  assert.equal(c.host.toasts.length, 1);

  // 没有斜杠命令接口时不注册
  delete c.host.context.SillyTavern.SlashCommandParser;
  assert.equal(c.commands.registerDataCommands(), null);
});
