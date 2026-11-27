/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：测试母版同步脚本（scripts/sync-template.cjs）：生成结果没有本仓库专有路径、母版改写规则全部匹配、默认不写入
 *       2026-11-27 同步可选条目“ERA 表达式规则”的原文
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 运行方式: node --test tests/era_sync_template.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RULES,
  transform,
  findForbidden,
  buildOutputs,
  sync,
  findTemplateDir,
} = require('../scripts/sync-template.cjs');

test('生成结果：母版改写规则全部匹配，没有本仓库专有路径', () => {
  const outputs = buildOutputs();
  assert.ok(outputs.length >= 15);
  for (const output of outputs) {
    assert.deepEqual(output.missing, [], `${output.source} 有母版改写规则没有匹配上`);
    assert.deepEqual(output.forbidden, [], `${output.target} 仍含本仓库专有路径`);
  }
  const targets = outputs.map(output => output.target);
  for (const target of [
    'docs/era/01-快速上手.md',
    'docs/era/示例/状态栏-事件版.html',
    'util/era.ts',
    'exported.era.d.ts',
    '初始模板/ERA角色卡/新建为src文件夹中的文件夹/世界书/ERA/变量操作规则.txt',
    '初始模板/ERA角色卡/新建为src文件夹中的文件夹/世界书/ERA/表达式规则.txt',
    '.agents/skills/era-character-card/SKILL.md',
  ]) {
    assert.ok(targets.includes(target), target);
  }
  assert.ok(!targets.some(target => target.includes('路线图')), '开发文档不同步');
  const skill = outputs.find(output => output.target.endsWith('SKILL.md')).text;
  const version = require('../package.json').version;
  assert.ok(skill.includes(`ERA-Heron@v${version}/artifact/bundle.js`), '导入地址使用当前版本');
});

test('路径改写：链接、文字路径、URL 与“来自 ERA-Heron 的”说明', () => {
  const { text } = transform(
    'doc/01-快速上手.md',
    [
      '见 doc/04-宏.md 与 `doc/示例/`；[开发工具/era.ts](../开发工具/era.ts)',
      '[`开发工具/exported.era.d.ts`](../开发工具/exported.era.d.ts)',
      '[给AI的制卡流程/SKILL.md](./给AI的制卡流程/SKILL.md)',
      '见 [README 的安装](../README.md#安装)；[02](./02-指令手册.md)',
      'https://github.com/Bailuci/ERA-Heron/blob/main/doc/01.md 与 docs/era/01.md',
    ].join('\r\n'),
  );
  assert.deepEqual(text.split('\n'), [
    '见 docs/era/04-宏.md 与 `docs/era/示例/`；[util/era.ts](../../util/era.ts)',
    '[`exported.era.d.ts`](../../exported.era.d.ts)',
    '[.agents/skills/era-character-card/SKILL.md](../../.agents/skills/era-character-card/SKILL.md)',
    '见 [ERA-Heron 的安装说明](https://github.com/Bailuci/ERA-Heron#安装)；[02](./02-指令手册.md)',
    'https://github.com/Bailuci/ERA-Heron/blob/main/doc/01.md 与 docs/era/01.md',
  ]);
  assert.deepEqual(findForbidden(text), []);
});

test('专有路径检查：能发现漏改的路径，放过 URL、指向网址的链接文字和来源说明', () => {
  const found = findForbidden(
    [
      '见 doc/05-接口与设置.md',
      '复制 开发工具/era.ts',
      '源码 src/ERA变量框架/index.ts，测试 tests/host.cjs，产物 artifact/bundle.js',
      '[`artifact/bundle.js`](https://github.com/Bailuci/ERA-Heron/blob/main/artifact/bundle.js)',
      '（来自 ERA-Heron 的 `src/ERA变量框架/a.txt`）',
      'import "https://cdn.jsdelivr.net/gh/Bailuci/ERA-Heron@v1.6.0/artifact/bundle.js"',
      // 相对写法
      '[源码](../src/ERA变量框架/index.ts)、[测试](../tests/a.cjs)、[工具](../开发工具/foo.ts)',
      '[文档](./doc/x.md)、[约定](../AGENTS.md)、[记录](../修改记录.md)',
      // 同一行后面有网址链接时，前面的路径仍要查出来
      '见 doc/05.md，另见 [说明](https://example.com/a)',
      // 规则顺序出错时的重复前缀；母版自己的 ../../README.md 不算
      '见 docs/era/.agents/skills/x/SKILL.md 和 docs/era/docs/era/01.md；[母版说明](../../README.md)',
      'docs/era/01-快速上手.md、util/era.ts、@util/era、.agents/skills/era-character-card/SKILL.md',
    ].join('\n'),
  );
  assert.deepEqual(
    found.map(item => [item.line, item.text]),
    [
      [1, 'doc/'],
      [2, '开发工具/'],
      [3, 'src/ERA变量框架'],
      [3, 'tests/'],
      [3, 'artifact/bundle.js'],
      [7, 'src/ERA变量框架'],
      [7, 'tests/'],
      [7, '开发工具/'],
      [8, 'doc/'],
      [8, '../AGENTS.md'],
      [8, '../修改记录.md'],
      [9, 'doc/'],
      [10, 'docs/era/.agents/'],
      [10, 'docs/era/docs/'],
    ],
  );
});

test('规则顺序：带 doc/ 前缀的制卡流程路径改成母版路径，不会再加 docs/era/ 前缀', () => {
  const { text } = transform('doc/05-接口与设置.md', '见 `doc/给AI的制卡流程/SKILL.md` 与 给AI的制卡流程/SKILL.md');
  assert.equal(text, '见 `.agents/skills/era-character-card/SKILL.md` 与 .agents/skills/era-character-card/SKILL.md');
  assert.deepEqual(findForbidden(text), []);
});

test('参数：不认识的参数报错，--template 两种写法都支持', () => {
  const { parseArgs } = require('../scripts/sync-template.cjs');
  assert.deepEqual(parseArgs([]), { write: false, quiet: false });
  assert.deepEqual(parseArgs(['--write', '--template=a b']), { write: true, quiet: false, template: 'a b' });
  assert.deepEqual(parseArgs(['--template', 'D:/母版', '--quiet']), { write: false, quiet: true, template: 'D:/母版' });
  assert.match(parseArgs(['--write', '--tempalte=x']).error, /不认识的参数：--tempalte=x/);
  assert.match(parseArgs(['--template', '--write']).error, /不认识的参数：--template/);
  assert.match(parseArgs(['--template=']).error, /没有给出目录/);
  assert.match(parseArgs(['D:/母版']).error, /不认识的参数/);
});

test('母版改写规则匹配不上时报错，--write 不写入任何文件', () => {
  const required = RULES.filter(rule => rule.required);
  assert.ok(required.length >= 5);
  const { missing } = transform('doc/给AI的制卡流程/SKILL.md', '源文件被改写了，规则都匹配不上');
  assert.equal(missing.length, required.filter(rule => rule.files.includes('doc/给AI的制卡流程/SKILL.md')).length);

  // 用一份改坏了的源仓库副本跑 sync
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'era-sync-root-'));
  const template = fs.mkdtempSync(path.join(os.tmpdir(), 'era-sync-template-'));
  try {
    const real = path.join(__dirname, '..');
    for (const file of ['package.json', ...buildOutputs().map(output => output.source)]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(real, file), path.join(root, file));
    }
    const skill = path.join(root, 'doc/给AI的制卡流程/SKILL.md');
    fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('（复制位置见第 2 步）', ''));
    const logs = [];
    const { ok } = sync({ root, template, write: true, log: line => logs.push(line) });
    assert.equal(ok, false);
    assert.ok(logs.some(line => line.includes('母版改写规则没有匹配上')));
    assert.deepEqual(fs.readdirSync(template), [], '没有写入任何文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(template, { recursive: true, force: true });
  }
});

test('默认只比较不写入；--write 写入后再比较全部相同；母版多出的文档只提示不删除', () => {
  const template = fs.mkdtempSync(path.join(os.tmpdir(), 'era-sync-template-'));
  try {
    fs.mkdirSync(path.join(template, 'docs/era'), { recursive: true });
    fs.writeFileSync(path.join(template, 'docs/era/01-快速上手.md'), '旧内容\n');
    fs.writeFileSync(path.join(template, 'docs/era/00-已改名.md'), '旧文档\n');
    const logs = [];
    const log = line => logs.push(line);

    let result = sync({ template, log });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(template, 'docs/era/01-快速上手.md'), 'utf8'), '旧内容\n');
    assert.equal(fs.existsSync(path.join(template, 'util/era.ts')), false);
    assert.ok(
      logs.some(line => line.startsWith('- 旧内容')),
      '打印差异',
    );
    assert.ok(logs.some(line => line.startsWith('[多余] docs/era/00-已改名.md')));

    result = sync({ template, write: true, log });
    assert.equal(result.ok, true);
    for (const output of result.results) {
      assert.equal(fs.readFileSync(path.join(template, output.target), 'utf8'), output.text, output.target);
    }
    assert.ok(fs.existsSync(path.join(template, 'docs/era/00-已改名.md')), '不删除母版的文件');
    result = sync({ template, log });
    assert.ok(result.results.every(output => output.status === '相同'));
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
  }
});

test('与母版已提交的 SKILL.md 一致：手写改写的内容逐条出现在母版中（本机有母版时才检查）', t => {
  const template = findTemplateDir();
  let committed;
  try {
    committed = execFileSync('git', ['-C', template, 'show', 'HEAD:.agents/skills/era-character-card/SKILL.md'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    t.skip('本机没有母版仓库');
    return;
  }
  const version = committed.match(/ERA-Heron@v(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version);
  for (const rule of RULES.filter(rule => rule.files?.includes('doc/给AI的制卡流程/SKILL.md'))) {
    const expected = typeof rule.to === 'function' ? rule.to({ version }) : rule.to;
    assert.ok(committed.replace(/\r\n/g, '\n').includes(expected), `母版中没有：${expected.slice(0, 40)}`);
  }
});
