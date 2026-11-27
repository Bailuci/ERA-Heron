/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：“更新旧卡的规则”（initer/manual/update.ts）的测试：替换与备份、并发、失败隔离、正则字段保留、补上缺少的正则、旧版意图说明升级与结果提示
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 在假的世界书与正则存储上运行真实的 update.ts。
// 运行方式: node --test tests/era_initer.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const _ = require('lodash');

const { create_host } = require('./host.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const ENTRIES = path.join(__dirname, '..', 'src', 'ERA变量框架', 'initer', 'manual', 'worldbook_entries');
const RULE = fs.readFileSync(path.join(ENTRIES, 'era_var_operation_rule.txt'), 'utf8');
const RULE_NAME = 'ERA 变量操作规则';
const INTENT_NAME = 'ERA 变量意图说明';
const BACKUP = '（更新前的备份）';
const LEGACY_INTENT = '{{//请在这里补充对你设计的变量系统的说明，以便ai理解你的意图并正确的更新变量}}';

/** 2025-10-27 最早一批快速初始化写入的数据隐藏正则（5dc1a93），一条正则同时隐藏 era_data 和 VariableThink。 */
const EARLIEST_DATA_FIND = String.raw`/<(era_data|variable(?:think|insert|edit|delete))>[\s\S]*?</\1>/gsi`;
/** 1.5.0 之前、拆分正则之后的数据隐藏正则（45c956c），不认识 VariablePatch。 */
const OLD_DATA_FIND = String.raw`/<(variable(?:insert|edit|delete))>\s*(?=[\s\S]*?\S[\s\S]*?<\/\1>)((?:(?!<(?:era_data|variable(?:think|insert|edit|delete))>|<\/\1>)[\s\S])*?)\s*<\/\1>/gi`;

let next_uid = 1;
const entry = (name, content, extra = {}) => ({
  uid: next_uid++,
  name,
  content,
  enabled: true,
  position: { type: 'at_depth', role: 'system', depth: 0, order: 9999 },
  ...extra,
});
const regex = (script_name, find_regex, extra = {}) => ({
  id: `id-${script_name}`,
  script_name,
  enabled: true,
  run_on_edit: true,
  find_regex,
  replace_string: '',
  trim_strings: [],
  source: { user_input: true, ai_output: true, slash_command: false, world_info: false, reasoning: false },
  destination: { display: true, prompt: true },
  min_depth: null,
  max_depth: null,
  ...extra,
});

/**
 * 一个只有内存状态的假酒馆：世界书、角色卡局部正则、角色卡数据。
 * @param fail.read / fail.write 读取或写入时抛错的世界书名
 */
function create_tavern({ worldbooks = {}, bound, regexes = [], card = {}, fail = {} } = {}) {
  const state = {
    worldbooks: _.cloneDeep(worldbooks),
    regexes: _.cloneDeep(regexes),
    writes: { worldbook: 0, regex: 0 },
  };
  const bound_names = bound ?? Object.keys(worldbooks);
  let id = 1;
  const host = create_host({
    getCharWorldbookNames: () => ({ primary: bound_names[0] ?? null, additional: bound_names.slice(1) }),
    getWorldbook: async name => {
      if (fail.read?.includes(name) || !(name in state.worldbooks)) throw new Error(`读取失败: ${name}`);
      return _.cloneDeep(state.worldbooks[name]);
    },
    updateWorldbookWith: async (name, updater) => {
      state.writes.worldbook++;
      await new Promise(resolve => setImmediate(resolve));
      if (fail.write?.includes(name)) throw new Error(`写入失败: ${name}`);
      const updated = plain(await updater(_.cloneDeep(state.worldbooks[name])));
      state.worldbooks[name] = updated.map(e => (e.uid === undefined ? { ...e, uid: next_uid++ } : e));
      return _.cloneDeep(state.worldbooks[name]);
    },
    getTavernRegexes: () => _.cloneDeep(state.regexes),
    updateTavernRegexesWith: async updater => {
      state.writes.regex++;
      await new Promise(resolve => setImmediate(resolve));
      const updated = plain(await updater(_.cloneDeep(state.regexes)));
      state.regexes = updated.map(r => (r.id ? r : { ...r, id: `new-${id++}` }));
      return _.cloneDeep(state.regexes);
    },
    isCharacterTavernRegexesEnabled: () => true,
    getCharData: () => card,
  });
  const update = host.load_src('initer/manual/update');
  return {
    state,
    update,
    run: async () => plain(await update.updateEraRules()),
    describe: result => plain(update.describeUpdateResult(result)),
    book: name => state.worldbooks[name],
    regex_named: name => state.regexes.filter(r => r.script_name === name),
  };
}

/** 把 "/pattern/flags" 形式的 find_regex 转成 RegExp。 */
function to_regexp(find_regex) {
  const match = find_regex.match(/^\/([\s\S]*)\/([a-z]*)$/);
  return match ? new RegExp(match[1], match[2]) : new RegExp(find_regex);
}

/** 按顺序应用全部启用的、作用于某个去向的正则（模拟酒馆处理 AI 输出）。 */
function apply_regexes(regexes, text, destination) {
  return regexes
    .filter(r => r.enabled && r.source.ai_output && r.destination[destination])
    .reduce((result, r) => result.replace(to_regexp(r.find_regex), r.replace_string), text);
}

// ---------------------------------------------------------------------------
// 规则条目
// ---------------------------------------------------------------------------

test('过期的规则条目被替换，原内容只备份一次；再次更新不会重复备份', async () => {
  const old = entry(RULE_NAME, '旧版规则', { position: { type: 'at_depth', role: 'system', depth: 0, order: 42 } });
  const other = entry('世界观', '一些设定');
  const t = create_tavern({ worldbooks: { 主世界书: [old, other] } });

  const first = await t.run();
  assert.deepEqual(first.worldbooks, ['主世界书']);
  const book = t.book('主世界书');
  assert.equal(book.length, 3);
  const updated = book.find(e => e.name === RULE_NAME);
  assert.equal(updated.uid, old.uid);
  assert.equal(updated.content, RULE);
  assert.deepEqual(updated.position, old.position, '条目的其他字段保留作者的设置');
  assert.deepEqual(
    book.find(e => e.name === '世界观'),
    other,
  );
  const backup = book.find(e => e.name === RULE_NAME + BACKUP);
  assert.equal(backup.content, '旧版规则');
  assert.equal(backup.enabled, false);
  assert.notEqual(backup.uid, old.uid, '备份是新条目');

  const second = await t.run();
  assert.deepEqual(second.worldbooks, []);
  assert.equal(t.book('主世界书').length, 3);
  assert.equal(t.state.writes.worldbook, 1);
});

test('只差 CRLF 或首尾空白的规则条目不算过期', async () => {
  const t = create_tavern({
    worldbooks: { 书: [entry(RULE_NAME, `\n  ${RULE.replace(/\n/g, '\r\n')}  \n`)] },
  });
  const result = await t.run();
  assert.deepEqual(result.worldbooks, []);
  assert.equal(result.ruleEntryFound, true);
  assert.equal(t.state.writes.worldbook, 0);
});

test('条目名前后有空格也能识别；已有的备份条目不会再被备份或改写', async () => {
  const old_backup = entry(RULE_NAME + BACKUP, '更早的规则', { enabled: false });
  const t = create_tavern({ worldbooks: { 书: [entry(` ${RULE_NAME} `, '旧版规则'), old_backup] } });
  await t.run();
  const book = t.book('书');
  assert.equal(book.length, 3);
  assert.deepEqual(
    book.find(e => e.uid === old_backup.uid),
    old_backup,
  );
  assert.deepEqual(
    book.filter(e => e.name === RULE_NAME + BACKUP).map(e => e.content),
    ['更早的规则', '旧版规则'],
  );
});

test('连续点击（并发）只执行一次', async () => {
  const t = create_tavern({
    worldbooks: { 书: [entry(RULE_NAME, '旧版规则')] },
    regexes: [regex('ERA 数据隐藏正则', OLD_DATA_FIND)],
  });
  const [a, b] = await Promise.all([t.update.updateEraRules(), t.update.updateEraRules()]);
  assert.equal(a, b, '两次调用拿到同一个结果');
  assert.equal(t.state.writes.worldbook, 1);
  assert.equal(t.state.writes.regex, 1);
  assert.equal(t.book('书').filter(e => e.name === RULE_NAME + BACKUP).length, 1);
  assert.equal(t.regex_named('ERA 数据隐藏正则' + BACKUP).length, 1);
  // 结束后可以再次执行
  const again = await t.run();
  assert.deepEqual(again.worldbooks, []);
});

test('一个世界书读取或写入失败，只记入 failed，不影响其他世界书', async () => {
  const t = create_tavern({
    worldbooks: {
      读不了: [entry(RULE_NAME, '旧版规则')],
      写不了: [entry(RULE_NAME, '旧版规则')],
      正常: [entry(RULE_NAME, '旧版规则')],
    },
    bound: ['读不了', '已删除', '写不了', '正常'],
    fail: { read: ['读不了'], write: ['写不了'] },
  });
  const result = await t.run();
  assert.deepEqual(result.worldbooks, ['正常']);
  assert.deepEqual(result.failed.sort(), ['写不了', '已删除', '读不了'].sort());
  assert.equal(t.book('正常').find(e => e.name === RULE_NAME).content, RULE);
  assert.equal(t.book('写不了').length, 1, '写入失败的世界书保持原样');
  const report = t.describe(result);
  assert.equal(report.upToDate, false);
  assert.ok(report.warnings.some(w => w.includes('无法读取或更新')));
});

// ---------------------------------------------------------------------------
// 正则
// ---------------------------------------------------------------------------

test('过期的正则只改 find_regex，其余字段保留；备份关闭并分配新 id', async () => {
  const custom = {
    replace_string: '[隐藏]',
    destination: { display: false, prompt: true },
    min_depth: 2,
    run_on_edit: false,
  };
  const t = create_tavern({
    regexes: [
      regex('ERA 数据隐藏正则', OLD_DATA_FIND, custom),
      regex('ERA 元数据隐藏正则', '/<era_data>[\\s\\S]*?<\\/era_data>/gi'),
      regex('ERA 思考块隐藏正则', '/<variablethink>[\\s\\S]*?<\\/variablethink>/gi'),
      regex('ERA 状态栏占位符隐藏正则', '/x/g'),
      regex('作者自己的正则', '/foo/g'),
    ],
  });
  const data = await t.run();
  assert.deepEqual(data.regexes, ['ERA 数据隐藏正则', 'ERA 元数据隐藏正则', 'ERA 思考块隐藏正则']);
  assert.deepEqual(data.addedRegexes, []);

  const [updated] = t.regex_named('ERA 数据隐藏正则');
  assert.equal(updated.id, 'id-ERA 数据隐藏正则');
  assert.deepEqual(
    _.omit(updated, 'find_regex'),
    _.omit(regex('ERA 数据隐藏正则', OLD_DATA_FIND, custom), 'find_regex'),
  );
  assert.notEqual(updated.find_regex, OLD_DATA_FIND);
  assert.match('<VariablePatch>[]</VariablePatch>', to_regexp(updated.find_regex));

  const [backup] = t.regex_named('ERA 数据隐藏正则' + BACKUP);
  assert.equal(backup.find_regex, OLD_DATA_FIND);
  assert.equal(backup.enabled, false);
  assert.match(backup.id, /^new-/);
  assert.equal(backup.replace_string, '[隐藏]');

  // 名字不是 ERA 的正则、名字相同但已是最新的正则都不动
  assert.deepEqual(t.regex_named('作者自己的正则'), [regex('作者自己的正则', '/foo/g')]);
  assert.deepEqual(t.regex_named('ERA 状态栏占位符隐藏正则'), [regex('ERA 状态栏占位符隐藏正则', '/x/g')]);
});

test('最早一批旧卡：更新后 <era_data>、<VariableThink>、指令块仍被隐藏，并补上缺少的正则', async () => {
  const t = create_tavern({
    regexes: [
      regex('ERA 数据隐藏正则', EARLIEST_DATA_FIND, { trim_strings: undefined }),
      regex('ERA 状态栏模板', '/<StatusPlaceHolderImpl\\/>/gsi', {
        replace_string: '[状态栏]',
        source: { user_input: false, ai_output: true, slash_command: false, world_info: false },
        destination: { display: true, prompt: false },
      }),
    ],
  });
  const message =
    '<VariableThink>想一想</VariableThink>正文<VariablePatch>[]</VariablePatch><VariableInsert>{"a":1}</VariableInsert>' +
    '<era_data>{"mk":"x"}</era_data>\n<StatusPlaceHolderImpl/>';
  // 更新前：最早的数据正则隐藏了 era_data 和 VariableThink，但不认识 VariablePatch
  assert.equal(apply_regexes(t.state.regexes, message, 'display'), '正文<VariablePatch>[]</VariablePatch>\n[状态栏]');

  const result = await t.run();
  assert.deepEqual(result.regexes, ['ERA 数据隐藏正则']);
  assert.deepEqual(result.addedRegexes, ['ERA 元数据隐藏正则', 'ERA 思考块隐藏正则', 'ERA 状态栏占位符隐藏正则']);
  for (const name of result.addedRegexes) {
    const [added] = t.regex_named(name);
    assert.match(added.id, /^new-/);
    assert.equal(added.enabled, true);
  }

  assert.equal(apply_regexes(t.state.regexes, message, 'display'), '正文\n[状态栏]');
  assert.equal(apply_regexes(t.state.regexes, message, 'prompt'), '正文', '提示词里也不再有占位符');

  const report = t.describe(result);
  assert.ok(report.updated.some(line => line.includes('已补上缺少的正则')));
});

test('没有 ERA 数据隐藏正则的卡（没用过快速初始化）不会被补正则', async () => {
  const t = create_tavern({ regexes: [regex('作者自己的正则', '/foo/g')] });
  const result = await t.run();
  assert.deepEqual(result.addedRegexes, []);
  assert.equal(t.state.writes.regex, 0);
});

// ---------------------------------------------------------------------------
// 找不到规则条目、变量宏与旧版意图说明
// ---------------------------------------------------------------------------

test('找不到规则条目时如实提示，不报告“已经是最新版本”', async () => {
  const none = create_tavern({ worldbooks: { 书: [entry('世界观', '设定')] } });
  const result = await none.run();
  assert.equal(result.ruleEntryFound, false);
  const report = none.describe(result);
  assert.equal(report.upToDate, false);
  assert.ok(report.warnings.some(w => w.includes(`没有名为“${RULE_NAME}”的条目`)));

  const unbound = create_tavern();
  const unbound_report = unbound.describe(await unbound.run());
  assert.equal(unbound_report.upToDate, false);
  assert.ok(unbound_report.warnings.some(w => w.includes('没有绑定世界书')));
});

test('规则是最新、有变量宏、正则齐全时报告已是最新', async () => {
  const t = create_tavern({
    worldbooks: { 书: [entry(RULE_NAME, RULE), entry(INTENT_NAME, '<当前变量>\n{{ERA:$ALLDATA}}\n</当前变量>')] },
  });
  const report = t.describe(await t.run());
  assert.deepEqual(report, { updated: [], warnings: [], upToDate: true });
});

test('未改动过的最早版本意图说明：没有任何变量宏时补上 <变量结构> 和 <当前变量>，并备份', async () => {
  const t = create_tavern({
    worldbooks: {
      附加: [entry('世界观', '设定')],
      主: [entry(RULE_NAME, '旧版规则'), entry(INTENT_NAME, `${LEGACY_INTENT}\r\n`)],
    },
    bound: ['附加', '主'],
  });
  const result = await t.run();
  assert.deepEqual(result.intentUpgraded, ['主']);
  assert.equal(result.variableMacroFound, true);
  const intent = t.book('主').find(e => e.name === INTENT_NAME);
  assert.ok(intent.content.startsWith(LEGACY_INTENT));
  assert.match(intent.content, /<变量结构>\n{{ERA-schema}}\n<\/变量结构>/);
  assert.match(intent.content, /<当前变量>\n{{ERA:\$ALLDATA}}\n<\/当前变量>$/);
  assert.doesNotMatch(intent.content, /【路径/, '不会把模板里的占位说明发给 AI');
  const backup = t.book('主').find(e => e.name === INTENT_NAME + BACKUP);
  assert.equal(backup.enabled, false);
  assert.equal(backup.content, `${LEGACY_INTENT}\r\n`);

  const report = t.describe(result);
  assert.ok(report.updated.some(line => line.includes('补上 <变量结构> 和 <当前变量>')));
  assert.deepEqual(report.warnings, []);

  // 再次更新不会重复修改
  const again = await t.run();
  assert.deepEqual(again.intentUpgraded, []);
});

test('其他条目或角色卡里已有变量宏时，不改动旧版意图说明', async () => {
  const in_entry = create_tavern({
    worldbooks: { 书: [entry(RULE_NAME, RULE), entry(INTENT_NAME, LEGACY_INTENT), entry('状态', '{{ ERA : 主角 }}')] },
  });
  const r1 = await in_entry.run();
  assert.deepEqual(r1.intentUpgraded, []);
  assert.equal(r1.variableMacroFound, true);
  assert.equal(in_entry.book('书').find(e => e.name === INTENT_NAME).content, LEGACY_INTENT);

  const in_card = create_tavern({
    worldbooks: { 书: [entry(RULE_NAME, RULE), entry(INTENT_NAME, LEGACY_INTENT)] },
    card: { description: '当前状态：{{ERA-withmeta:$ALLDATA}}' },
  });
  assert.deepEqual((await in_card.run()).intentUpgraded, []);

  // 关闭的条目里的宏不会发给 AI，不算
  const disabled_macro = create_tavern({
    worldbooks: {
      书: [
        entry(RULE_NAME, RULE),
        entry(INTENT_NAME, LEGACY_INTENT),
        entry('旧', '{{ERA:$ALLDATA}}', { enabled: false }),
      ],
    },
  });
  assert.deepEqual((await disabled_macro.run()).intentUpgraded, ['书']);
});

test('作者改过或关闭的意图说明不会被改动，只提示缺少变量宏', async () => {
  for (const intent of [entry(INTENT_NAME, '我自己写的说明'), entry(INTENT_NAME, LEGACY_INTENT, { enabled: false })]) {
    const t = create_tavern({ worldbooks: { 书: [entry(RULE_NAME, RULE), intent] } });
    const result = await t.run();
    assert.deepEqual(result.intentUpgraded, []);
    assert.equal(result.variableMacroFound, false);
    assert.equal(t.book('书').length, 2);
    assert.deepEqual(t.book('书')[1], intent);
    assert.equal(t.state.writes.worldbook, 0);
    const report = t.describe(result);
    assert.equal(report.upToDate, false);
    assert.ok(report.warnings.some(w => w.includes('{{ERA:$ALLDATA}}')));
  }
});
