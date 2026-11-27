/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：测试脚本设置的逐字段容错与保存校验、繁体转简体、消息尾部占位符、强制重载
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create_chat, plain } = require('./chat.cjs');

// ---------------------------------------------------------------------------
// 脚本设置
// ---------------------------------------------------------------------------

test('设置：某一项不合法时只有它回到默认值，其余设置保留', () => {
  const { era_data } = create_chat().host;
  const { settings, invalid } = era_data.parseScriptSettings({
    强制重载消息数: '',
    日志保留楼层数: '',
    数组内保留对象: true,
    下划线只读: 'yes',
    宽松解析: false,
    特殊符号值: '<自定义/>',
  });
  assert.equal(settings.强制重载消息数, 2);
  assert.equal(settings.日志保留楼层数, 0);
  assert.equal(settings.数组内保留对象, true);
  assert.equal(settings.下划线只读, false);
  assert.equal(settings.宽松解析, false);
  assert.equal(settings.特殊符号值, '<自定义/>');
  assert.deepEqual(plain(invalid).sort(), ['下划线只读', '强制重载消息数', '日志保留楼层数'].sort());

  for (const value of [0, -1, '3', null]) {
    assert.equal(era_data.parseScriptSettings({ 强制重载消息数: value }).settings.强制重载消息数, 2, String(value));
  }
  assert.equal(era_data.parseScriptSettings({ 日志保留楼层数: -1 }).settings.日志保留楼层数, 0);
  assert.equal(
    era_data.parseScriptSettings({ 日志保留楼层数: 2.5 }).settings.日志保留楼层数,
    2.5,
    '小数沿用原来的向下取整',
  );
  assert.deepEqual(plain(era_data.parseScriptSettings(undefined).invalid), [], '缺失的项使用默认值，不算不合法');
  assert.deepEqual(
    plain(era_data.parseScriptSettings('坏了').settings),
    plain(era_data.parseScriptSettings({}).settings),
  );
});

test('设置：加载时容错并提示，保存时拒绝不合法的值并指出字段', async () => {
  const c = create_chat();
  const { era_data } = c.host;
  c.others.script = { 强制重载消息数: '', 数组内保留对象: true, 清理失效日志: true };
  era_data.initEraSettings();
  assert.equal(era_data.settings.value.数组内保留对象, true, '其余设置不再被一起重置');
  assert.equal(era_data.settings.value.清理失效日志, true);
  assert.equal(era_data.settings.value.强制重载消息数, 2);
  assert.equal(c.host.toasts.length, 1);
  assert.match(c.host.toasts[0][0], /强制重载消息数/);

  await assert.rejects(
    era_data.updateScriptSettings(current => ({ ...current, 强制重载消息数: '', 日志保留楼层数: -3 })),
    error => {
      assert.equal(error.name, 'InvalidSettingsError');
      assert.deepEqual(plain(error.fields).sort(), ['强制重载消息数', '日志保留楼层数'].sort());
      return true;
    },
  );
  assert.equal(c.others.script.强制重载消息数, '', '没有保存');
  assert.equal(era_data.settings.value.强制重载消息数, 2);

  const saved = await era_data.updateScriptSettings(current => ({ ...current, 强制重载消息数: 5 }));
  assert.equal(saved.强制重载消息数, 5);
  assert.equal(c.others.script.强制重载消息数, 5);
  assert.equal(c.others.script.数组内保留对象, true);
  assert.equal(era_data.settings.value.强制重载消息数, 5);

  // 启动时的“补全设置”会把已存的不合法值改成默认值
  c.others.script.日志保留楼层数 = '';
  await era_data.updateScriptSettings(current => current);
  assert.equal(c.others.script.日志保留楼层数, 0);
});

// ---------------------------------------------------------------------------
// 繁体转简体
// ---------------------------------------------------------------------------

const opencc = {
  'opencc-js': { Converter: () => text => text.replace(/體/g, '体').replace(/戰/g, '战').replace(/靈/g, '灵') },
};

test('繁体转简体：开启后指令中的繁体键和值被转换；关闭时保持原样', async () => {
  for (const enabled of [true, false]) {
    const c = create_chat({ settings: { 繁体转简体: enabled }, externals: opencc });
    c.send('assistant', '<VariableInsert>{"體力":10,"屬性":"靈"}</VariableInsert>');
    c.send('assistant', '<VariableEdit>{"體力":"+=1"}</VariableEdit>');
    await c.sync();
    assert.deepEqual(plain(c.stat()), enabled ? { 体力: 11, 屬性: '灵' } : { 體力: 11, 屬性: '靈' });
    assert.deepEqual(plain(c.stat()), plain(await c.replay()));
  }
});

test('繁体转简体：旁路写入在写入时固定转换结果，之后关闭设置重放，结果不变', async () => {
  const c = create_chat({ settings: { 繁体转简体: true }, externals: opencc });
  c.send('assistant', '<VariableInsert>{"hp":1}</VariableInsert>');
  await c.sync();
  const msg = { message_id: 0, ...c.chat[0] };
  const mk = c.host.mk.readMessageKey(msg);
  const op = c.host.api_ops.createApiOp('insert', { 戰力: 5 }, 1, true);
  await c.host.era_data.updateEraMetaData(meta => {
    meta.ApiOps = { [mk]: c.host.api_ops.appendApiOp(undefined, op, true) };
    return meta;
  });
  await c.sync();
  assert.deepEqual(plain(c.stat()), { hp: 1, 战力: 5 });

  const off = create_chat({ settings: { 繁体转简体: false }, externals: opencc });
  for (const m of c.chat) off.chat.push(plain(m));
  off.variables().ERAMetaData = { ApiOps: plain(c.meta().ApiOps) };
  off.variables().ERAMetaData.ApiOps[mk].applied = 0;
  await off.sync(true);
  assert.deepEqual(plain(off.stat()), { hp: 1, 战力: 5 });
});

// ---------------------------------------------------------------------------
// 消息尾部占位符
// ---------------------------------------------------------------------------

test('占位符：只追加一次；用户消息、关闭设置时不追加；保留正文中的宏', async () => {
  const c = create_chat();
  const { ensurePlaceholder } = c.host.load_src('macro/placeholder');
  c.send('assistant', '你好 {{user}}');
  c.send('user', '用户');
  await ensurePlaceholder(0);
  await ensurePlaceholder(0);
  await ensurePlaceholder(1);
  assert.equal(c.chat[0].swipes[0], '你好 {{user}}\n<StatusPlaceHolderImpl/>');
  assert.equal(c.chat[1].swipes[0], '用户');

  const d = create_chat({ settings: { 在ai消息尾部生成特殊符号: false } });
  d.send('assistant', '你好');
  await d.host.load_src('macro/placeholder').ensurePlaceholder(0);
  assert.equal(d.chat[0].swipes[0], '你好');

  const e = create_chat({ settings: { 特殊符号值: '<自定义/>' } });
  e.send('assistant', '你好\n\n');
  await e.host.load_src('macro/placeholder').ensurePlaceholder(0);
  assert.equal(e.chat[0].swipes[0], '你好\n<自定义/>');
});

// ---------------------------------------------------------------------------
// 强制重载
// ---------------------------------------------------------------------------

test('强制重载：读取校验后的设置，数量至少为 1，不会重载整个聊天', async () => {
  for (const [count, expected] of [
    [0, 1],
    ['', 1],
    [1.7, 1],
    [3, 3],
  ]) {
    const c = create_chat({ settings: { 强制重载功能: true, 强制重载消息数: count } });
    for (let i = 0; i < 6; i++) c.send('assistant', `第 ${i} 楼`);
    let rendered = 0;
    const original = c.host.context.setChatMessages;
    c.host.context.setChatMessages = async (...args) => {
      rendered++;
      return original(...args);
    };
    await c.host.load_src('ui/patch').forceRenderRecentMessages();
    assert.equal(rendered, expected, `强制重载消息数 = ${JSON.stringify(count)}`);
  }
  const off = create_chat();
  let rendered = 0;
  off.host.context.setChatMessages = async () => void rendered++;
  off.send('assistant', '1');
  await off.host.load_src('ui/patch').forceRenderRecentMessages();
  assert.equal(rendered, 0, '默认关闭');
});
