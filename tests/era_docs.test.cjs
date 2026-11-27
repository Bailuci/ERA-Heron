/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：为文档示例、规则提示词、隐藏正则与默认状态栏加最小测试保护：示例指令能被真实解析器执行并得到文档写的结果，隐藏正则与解析器支持的标签一致
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 文档、提示词与正则的测试。文档或核心逻辑改动后示例悄悄失效时，这里会失败。
// 运行方式: node --test tests/era_docs.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { create_host } = require('./host.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const squash = text => text.replace(/\s+/g, '');
const EMPTY_META = { EditLogs: {}, SelectedMks: [] };

/**
 * 用真实的 patcher 执行一条消息中的全部指令。
 * 变量在内部以转义形式保存（例如 `.` 存成 `__DOT__`）：参数 `raw` 与返回的 `raw` 是转义后的，返回的 `stat` 是还原后的。
 */
async function apply(host, raw, mes) {
  const result = await host.patcher.ApplyVarChangeForMessage({ message_id: 1, mes }, raw, EMPTY_META);
  return {
    raw: plain(result.finalStat),
    stat: plain(host.data.unescapeEraData(result.finalStat)),
    issues: plain(result.commandIssues ?? []),
  };
}

/** 按顺序取出文本中的全部指令块（与 message.ts 的 COMMAND_REGEX 一样，跳过说明文字里只提到标签名的地方）。 */
const COMMAND_BLOCK =
  /<(Variable(?:Insert|Edit|Delete|Patch))>(?:(?!<(?:era_data|Variable(?:Think|Insert|Edit|Delete|Patch))>|<\/\1>)[\s\S])*?<\/\1>/g;
const command_blocks = text => [...text.matchAll(COMMAND_BLOCK)].map(m => m[0]);

/** 把 "/pattern/flags" 形式的 find_regex 转成 RegExp。 */
function to_regexp(find_regex) {
  const match = find_regex.match(/^\/([\s\S]*)\/([a-z]*)$/);
  return match ? new RegExp(match[1], match[2]) : new RegExp(find_regex);
}

/** 快速初始化写入的正则（与 initer/manual/regex.ts 的顺序一致），只应用作用于 AI 输出和指定去向的。 */
function apply_era_regexes(host, text, destination) {
  const objects = [
    'hide_era_data',
    'replace_placeholder',
    'hide_era_metadata',
    'hide_era_thinking',
    'hide_status_placeholder',
  ].map(file => Object.values(host.load_src(`initer/manual/regex_objects/${file}`))[0]);
  return objects
    .filter(r => r.enabled && r.source.ai_output && r.destination[destination])
    .reduce((result, r) => result.replace(to_regexp(r.find_regex), r.replace_string), text);
}

// ---------------------------------------------------------------------------
// 隐藏正则与解析器
// ---------------------------------------------------------------------------

test('解析器支持的每种指令标签都能被“ERA 数据隐藏正则”去掉', async () => {
  const source = read('src/ERA变量框架/utils/message.ts');
  const match = source.match(/const COMMAND_REGEX =\s*\/<\(Variable\(([A-Za-z|]+)\)\)>/);
  assert.ok(match, '找不到 message.ts 中的 COMMAND_REGEX');
  const tags = match[1].split('|');
  assert.deepEqual(tags, ['Insert', 'Edit', 'Delete', 'Patch']);

  const host = create_host();
  const { HIDE_ERA_DATA_REGEX } = host.load_src('initer/manual/regex_objects/hide_era_data');
  const hide = to_regexp(HIDE_ERA_DATA_REGEX.find_regex);
  const bodies = { Insert: '{"a":1}', Edit: '{"a":2}', Delete: '{"a":{}}', Patch: '[{"op":"remove","path":"/a"}]' };
  for (const tag of tags) {
    for (const name of [`Variable${tag}`, `variable${tag.toLowerCase()}`, `VARIABLE${tag.toUpperCase()}`]) {
      const block = `<${name}>\n${bodies[tag]}\n</${name}>`;
      const { issues } = await apply(host, tag === 'Insert' ? {} : { a: 0 }, block);
      assert.deepEqual(issues, [], `${name} 能被解析`);
      assert.equal(`前${block}后`.replace(hide, ''), '前后', `${name} 能被隐藏`);
    }
  }
});

test('元数据、思考块、额外模型标签和状态栏占位符都能被对应的正则处理', () => {
  const host = create_host();
  const message = [
    '正文',
    '<VariableThink>\n想一想\n</VariableThink>',
    '<VariableEdit>{"a":1}</VariableEdit>',
    '<era_extra><VariablePatch>[]</VariablePatch></era_extra>',
    '<era_data>{"mk":"x"}</era_data>',
    host.era_data.settings.value.特殊符号值,
  ].join('\n');
  assert.equal(apply_era_regexes(host, message, 'prompt').trim(), '正文');
  const [text, status_bar] = apply_era_regexes(host, message, 'display').split('```html\n');
  assert.equal(text.trim(), '正文');
  assert.match(status_bar, /^<!doctype html>/);
});

test('状态栏两条正则匹配的是 特殊符号值 的默认值', () => {
  const host = create_host();
  const placeholder = host.era_data.settings.value.特殊符号值;
  assert.equal(placeholder, '<StatusPlaceHolderImpl/>');
  for (const file of ['replace_placeholder', 'hide_status_placeholder']) {
    const regex = Object.values(host.load_src(`initer/manual/regex_objects/${file}`))[0];
    assert.match(`x\n${placeholder}`, to_regexp(regex.find_regex), file);
  }
});

// ---------------------------------------------------------------------------
// 规则提示词
// ---------------------------------------------------------------------------

test('“ERA 变量操作规则”的格式示例能被正确执行，隐藏后只剩正文', async () => {
  const host = create_host();
  const rule = read('src/ERA变量框架/initer/manual/worldbook_entries/era_var_operation_rule.txt');
  const example = rule.slice(rule.indexOf('### 格式示例'), rule.indexOf('</format_request>'));
  assert.deepEqual(
    command_blocks(example).map(b => b.match(/^<(\w+)>/)[1]),
    ['VariableInsert', 'VariableEdit', 'VariablePatch'],
  );

  const { stat, issues } = await apply(host, { characters: { player: { hp: 20, inventory: [] } } }, example);
  assert.deepEqual(issues, []);
  assert.deepEqual(stat, {
    characters: { player: { hp: 15, inventory: ['Potion'] }, Elara: { class: 'Archer' } },
  });

  const body = example.slice(example.indexOf('\n'));
  assert.equal(apply_era_regexes(host, body, 'prompt').trim(), '{其他内容（如正文）和格式...}');
});

// ---------------------------------------------------------------------------
// doc/02 综合示例
// ---------------------------------------------------------------------------

test('doc/02“综合示例”的每一步与文档写的结果一致', async () => {
  const host = create_host();
  const text = read('doc/02-指令手册.md');
  const doc = squash(text);
  let raw = {};
  let stat = {};
  /** 执行一步，并确认这条指令确实写在文档里。 */
  const step = async mes => {
    assert.ok(doc.includes(squash(mes)), `文档中找不到指令：${mes}`);
    ({ raw, stat } = await apply(host, raw, mes));
  };
  const characters = () => stat.world_state.characters;

  // 1. 初始化
  await step(command_blocks(text.split('### 1. 初始化')[1])[0]);
  assert.equal(stat.world_state.capital.population, 1000);
  assert.equal(stat.world_state.game_version, '1.0.0');

  // 2. Insert
  await step('<VariableInsert>{ "world_state": { "characters": { "player": { "hp": 15 } } } }</VariableInsert>');
  assert.deepEqual(characters().player, { level: 1, hp: 15, inventory: [], $meta: { necessary: 'self' } });

  await step(command_blocks(text.split('**场景 B：部分生效')[1])[0]);
  assert.deepEqual(characters().final_boss, { level: 1, hp: 8888, inventory: [], $meta: { necessary: 'self' } });

  const scene_c = command_blocks(text.split('**场景 C：嵌套模板**')[1]);
  await step(scene_c[0]);
  await step(scene_c[1]);
  assert.deepEqual(characters().player.follower, {
    $template: { level: 10, hp: 200, faction: 'None', sex: 'female' },
    lili: { level: 1, hp: 200, faction: 'None', sex: 'female' },
    cityGuard: { level: 10, hp: 200, faction: 'None', sex: 'female' },
  });

  await step('<VariableInsert>{ "world_state": { "game_version": "1.0.1" } }</VariableInsert>');
  assert.equal(stat.world_state.game_version, '1.0.0');

  // 3. Edit
  await step('<VariableEdit>{ "world_state": { "capital": { "population": 1001 } } }</VariableEdit>');
  assert.equal(stat.world_state.capital.population, 1000);
  await step(
    '<VariableEdit>{ "world_state": { "capital": { "population": 1002, "$meta": { "updatable": true } } } }</VariableEdit>',
  );
  assert.equal(stat.world_state.capital.population, 1002);
  assert.deepEqual(stat.world_state.capital.$meta, { updatable: true, necessary: 'all' });
  const before = structuredClone(stat);
  await step('<VariableEdit>{ "world_state": { "lost_city": { "population": 1 } } }</VariableEdit>');
  assert.deepEqual(stat, before);

  // 4. Delete
  await step('<VariableDelete>{ "world_state": { "capital": { "description": {} } } }</VariableDelete>');
  assert.equal(stat.world_state.capital.description, 'The bustling capital city.');
  await step('<VariableDelete>{ "world_state": { "characters": { "player": { "inventory": {} } } } }</VariableDelete>');
  assert.equal('inventory' in characters().player, false);
  await step(
    '<VariableDelete>{ "world_state": { "characters": { "final_boss": { "hp": {}, "$meta": {} } } } }</VariableDelete>',
  );
  assert.deepEqual(characters().final_boss, { level: 1, inventory: [] });
  await step('<VariableDelete>{ "world_state": { "characters": { "player": {} } } }</VariableDelete>');
  assert.ok(characters().player);
  await step('<VariableDelete>{ "world_state": { "characters": { "final_boss": {} } } }</VariableDelete>');
  assert.equal('final_boss' in characters(), false);
});

// ---------------------------------------------------------------------------
// doc/01 与示例
// ---------------------------------------------------------------------------

/** doc/01 第 5 步开场白初始化后的变量。 */
async function doc01_opening(host) {
  const section = read('doc/01-快速上手.md').split('## 5. 在开场白中初始化变量')[1].split('\n## ')[0];
  assert.equal(command_blocks(section).length, 1, '第 5 步只用一个 <VariableInsert>');
  const result = await apply(host, {}, section);
  assert.deepEqual(result.issues, []);
  return result;
}

test('doc/01 第 5 步的开场白能初始化全部变量，第 3、9 步的示例有效', async () => {
  const host = create_host();
  const { raw, stat } = await doc01_opening(host);
  assert.deepEqual(Object.keys(stat), ['主角', '背包', '人物', '时间', '地点']);
  assert.equal(stat.主角.体力, 100);
  assert.deepEqual(stat.人物.村长, { 好感: 10, 状态: '友好' });

  // 第 9 步：控制台试算的指令
  const simulate = read('doc/01-快速上手.md').match(/Era\.simulate\('([^']+)'\)/)[1];
  const tried = await apply(host, raw, simulate);
  assert.deepEqual(tried.issues, []);
  assert.equal(tried.stat.主角.体力, 90);

  // 第 3 步：AI 插入新人物时从模板补齐
  const inserted = await apply(host, raw, '<VariableInsert>{"人物": {"猎人": {"状态": "警惕"}}}</VariableInsert>');
  assert.deepEqual(inserted.stat.人物.猎人, { 好感: 0, 状态: '警惕' });
});

test('变量意图说明示例中的指令依次执行都能生效，解除保护后会恢复', async () => {
  const host = create_host();
  const init = command_blocks(read('doc/02-指令手册.md').split('### 1. 初始化')[1])[0];
  let { raw } = await apply(host, {}, init);
  const blocks = command_blocks(read('doc/示例/变量意图说明示例.txt'));
  assert.equal(blocks.length, 9);
  const states = [];
  for (const block of blocks) {
    const result = await apply(host, raw, block);
    assert.deepEqual(result.issues, [], `指令没有生效：${block}`);
    assert.notDeepEqual(result.raw, raw, `指令没有改变变量：${block}`);
    raw = result.raw;
    states.push(result);
  }
  const capital = states[1].stat.world_state.capital;
  // 首都：人口被修改，保护随后恢复，之后的修改仍被拒绝
  assert.equal(states[0].stat.world_state.capital.population, 800);
  assert.equal(capital.population, 800);
  assert.equal(capital.$meta.updatable, false);
  const blocked = await apply(
    host,
    states[1].raw,
    '<VariableEdit>{ "world_state": { "capital": { "population": 1 } } }</VariableEdit>',
  );
  assert.equal(blocked.stat.world_state.capital.population, 800);
  // 角色：从模板创建、受伤、背包增删，最后被删除
  const alex = i => states[i].stat.world_state.characters.Alex;
  assert.deepEqual(alex(2), { level: 1, hp: 10, inventory: [], $meta: { necessary: 'self' }, class: '剑士' });
  assert.equal(alex(3).hp, 8);
  assert.deepEqual(alex(4).inventory, ['Potion']);
  assert.deepEqual(alex(5).inventory, []);
  const final = states.at(-1).stat.world_state;
  assert.equal('Alex' in final.characters, false);
  assert.equal(final.game_version, '2.0.0');
});

// ---------------------------------------------------------------------------
// 默认状态栏
// ---------------------------------------------------------------------------

test('默认状态栏用推荐写法读取 doc/01 示例中存在的变量，并且不会被酒馆当成分组引用', async () => {
  const html = read('src/ERA变量框架/initer/manual/regex_objects/status_bar.html');
  const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
  assert.match(script, /await waitGlobalInitialized\('Era'\)/);
  assert.match(script, /Era\.getCurrentVars\(\)\.statWithoutMeta/);
  assert.match(script, /eventOn\('era:writeDone'/);
  assert.doesNotMatch(script, /innerHTML/, '变量文字不能拼进 innerHTML');
  // 酒馆正则会把“替换为”中的 $数字、$<名字> 当作分组引用，把 {{ }} 当作宏
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /\$\d|\$</);
  assert.doesNotMatch(script, /{{/);
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script>[\s\S]*?<\/script>/, '');
  assert.doesNotMatch(visible, /\*\*/, '显示的文字里不要写 Markdown 星号');

  const { stat } = await doc01_opening(create_host());
  const paths = [...script.matchAll(/_\.get\(stat, '([^']+)'\)/g)].map(m => m[1]);
  assert.ok(paths.length >= 5);
  for (const p of paths) {
    const value = p.split('.').reduce((node, key) => node?.[key], stat);
    assert.notEqual(value, undefined, `默认状态栏读取的路径 ${p} 在 doc/01 的示例变量中不存在`);
  }
});
