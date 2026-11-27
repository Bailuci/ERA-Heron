/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：母版同步脚本（pnpm sync-template）：把文档、前端工具、类型声明、规则条目与制卡流程复制到 tavern_era_template，并按映射表改写路径
 *       2026-11-27 制卡流程已补上第 5 条正则，删除对应的临时规则；同步可选条目“ERA 表达式规则”的原文
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 用法:
//   pnpm sync-template                    只打印差异（dry-run），不写入
//   pnpm sync-template --write            写入母版
//   pnpm sync-template --template=<目录>  指定母版目录（默认向上查找 模板与参考/tavern_era_template，或环境变量 ERA_TEMPLATE_DIR）
//   pnpm sync-template --quiet            只打印每个文件的状态，不打印差异
//
// 母版的目录结构与本仓库不同（docs/era/、util/era.ts、根目录 exported.era.d.ts……），
// 文件中的路径按下面的 RULES 改写。母版专有的手写内容（例如 SKILL.md 里“本母版已内置……”）写成 required 规则：
// 源文件改动后规则匹配不上时，脚本会报错并拒绝写入，提醒先更新映射表，而不是悄悄丢掉母版的改写。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RULE_FILE_SOURCE = 'src/ERA变量框架/initer/manual/worldbook_entries/era_var_operation_rule.txt';
const RULE_FILE_TARGET = '初始模板/ERA角色卡/新建为src文件夹中的文件夹/世界书/ERA/变量操作规则.txt';
const EXPR_RULE_SOURCE = 'src/ERA变量框架/initer/manual/worldbook_entries/era_expr_rule.txt';
const EXPR_RULE_TARGET = '初始模板/ERA角色卡/新建为src文件夹中的文件夹/世界书/ERA/表达式规则.txt';
const SKILL_SOURCE = 'doc/给AI的制卡流程/SKILL.md';
const SKILL_TARGET = '.agents/skills/era-character-card/SKILL.md';
const REPO_URL = 'https://github.com/Bailuci/ERA-Heron';

/** 同步的文件：[本仓库路径, 母版路径]。文档只同步编号的使用文档和示例，不同步路线图、测试清单等开发文档。 */
function listFiles(root = ROOT) {
  const files = [];
  for (const name of fs.readdirSync(path.join(root, 'doc')).sort()) {
    if (/^\d\d-.+\.md$/.test(name)) files.push([`doc/${name}`, `docs/era/${name}`]);
  }
  for (const name of fs.readdirSync(path.join(root, 'doc', '示例')).sort()) {
    files.push([`doc/示例/${name}`, `docs/era/示例/${name}`]);
  }
  files.push(
    ['开发工具/era.ts', 'util/era.ts'],
    ['开发工具/exported.era.d.ts', 'exported.era.d.ts'],
    [RULE_FILE_SOURCE, RULE_FILE_TARGET],
    [EXPR_RULE_SOURCE, EXPR_RULE_TARGET],
    [SKILL_SOURCE, SKILL_TARGET],
  );
  return files;
}

/**
 * 改写规则，按顺序应用。
 * - `from`：要找的原文（字符串按字面匹配，全部替换）；
 * - `to`：替换成的内容，可以是 `({ version }) => string`；
 * - `files`：只作用于这些源文件（省略时作用于全部）；
 * - `required`：在 `files` 中的每个文件里都必须至少匹配一次，否则报错。母版专有的手写内容都是 required；
 * - `final`：替换结果不再被后面的规则改写（手写内容里可以保留“来自 ERA-Heron 的 `src/…`”这样的说明）。
 */
const RULES = [
  // ---- SKILL.md：以母版已提交版本中手工改写的内容为准 ----
  {
    files: [SKILL_SOURCE],
    required: true,
    final: true,
    from:
      '| 前端读写工具与类型声明 | `开发工具/era.ts`、`开发工具/exported.era.d.ts` |\n' +
      `| 规则条目的原文 | \`${RULE_FILE_SOURCE}\` |\n`,
    to:
      '| 前端读写工具与类型声明 | `util/era.ts`（`@util/era`）、根目录 `exported.era.d.ts` |\n' +
      `| 规则条目的原文 | \`${RULE_FILE_TARGET}\`（来自 ERA-Heron 的 \`${RULE_FILE_SOURCE}\`） |\n` +
      '| 开箱即用的 ERA 角色卡骨架 | `初始模板/ERA角色卡/`（用法见其中的 `使用说明.md`） |\n',
  },
  {
    files: [SKILL_SOURCE],
    required: true,
    final: true,
    from: '把 `开发工具/era.ts` 复制到与模板的 `mvu.ts` 同一目录、`开发工具/exported.era.d.ts` 复制到与 `exported.mvu.d.ts` 同一类型目录，然后 `import',
    to: '本母版已内置 `util/era.ts` 与根目录的 `exported.era.d.ts`（不要移进 `@types/`，`bump_deps` 会清空它），直接 `import',
  },
  {
    files: [SKILL_SOURCE],
    required: true,
    final: true,
    from: '导入并启用 ERA 脚本（`artifact/bundle.js` 的内容作为酒馆助手角色脚本）',
    to: ({ version }) =>
      `导入并启用 ERA 脚本（酒馆助手角色脚本，内容为 \`import 'https://testingcf.jsdelivr.net/gh/Bailuci/ERA-Heron@v${version}/artifact/bundle.js';\`）`,
  },
  {
    files: [SKILL_SOURCE],
    required: true,
    final: true,
    from: '在“工具”页点“**ERA 快速初始化**”。它会：',
    to: '在“工具”页点“**ERA 快速初始化**”（以 `初始模板/ERA角色卡/` 为起点时，`index.yaml` 已经写好 ERA 脚本、这两个条目和五条正则，不用再点）。它会：',
  },
  {
    files: [SKILL_SOURCE],
    required: true,
    final: true,
    from: '`开发工具/era.ts`（复制位置见第 2 步）',
    to: '`util/era.ts`（`@util/era`）',
  },

  // ---- 05-接口与设置.md 第 9 节：母版已内置这两个文件，不需要复制 ----
  {
    files: ['doc/05-接口与设置.md'],
    required: true,
    final: true,
    from: '仓库的 [`开发工具/`](../开发工具/) 提供两个文件，供使用酒馆助手前端模板（vue + pinia）的项目复制：',
    to: '本母版已内置以下两个文件（来自 ERA-Heron 的 `开发工具/`），供酒馆助手前端模板（vue + pinia）的项目使用：',
  },
  {
    files: ['doc/05-接口与设置.md'],
    required: true,
    final: true,
    from:
      '| 文件 | 放到哪里 | 内容 |\n' +
      '| --- | --- | --- |\n' +
      "| [`era.ts`](../开发工具/era.ts) | 与模板的 `mvu.ts` 同一目录（`@util` 别名指向的目录），之后可以 `import { defineEraDataStore } from '@util/era'` | 下表的函数 |\n" +
      '| [`exported.era.d.ts`](../开发工具/exported.era.d.ts) | 与 `exported.mvu.d.ts` 同一类型目录（如 `@types/iframe/`） | 全局 `Era` 和 `era:*` 事件的类型声明 |\n',
    to:
      '| 文件 | 位置 | 内容 |\n' +
      '| --- | --- | --- |\n' +
      "| [`util/era.ts`](../../util/era.ts) | 与 `mvu.ts` 同一目录，可以 `import { defineEraDataStore } from '@util/era'` | 下表的函数 |\n" +
      '| [`exported.era.d.ts`](../../exported.era.d.ts) | 根目录（不要移进 `@types/`，`bump_deps` 会清空它） | 全局 `Era` 和 `era:*` 事件的类型声明 |\n',
  },

  // ---- 通用路径：先改链接，再改文字 ----
  { from: '](../开发工具/era.ts)', to: '](../../util/era.ts)' },
  { from: '](../开发工具/exported.era.d.ts)', to: '](../../exported.era.d.ts)' },
  { from: '](./给AI的制卡流程/SKILL.md)', to: `](../../${SKILL_TARGET})` },
  { from: '[README 的安装](../README.md#安装)', to: `[ERA-Heron 的安装说明](${REPO_URL}#安装)` },
  { from: '](../README.md', to: `](${REPO_URL}/blob/main/README.md` },
  // 带 doc/ 前缀的写法要先改，并且不再被后面的 doc/ 规则改写
  { from: SKILL_SOURCE, to: SKILL_TARGET, final: true },
  { from: '给AI的制卡流程/SKILL.md', to: SKILL_TARGET },
  { from: '开发工具/era.ts', to: 'util/era.ts' },
  { from: '开发工具/exported.era.d.ts', to: 'exported.era.d.ts' },
  { from: RULE_FILE_SOURCE, to: RULE_FILE_TARGET },
  { from: EXPR_RULE_SOURCE, to: EXPR_RULE_TARGET },
  { from: /(?<![\w/.-])doc\//g, to: 'docs/era/' },
];

/**
 * 母版里不应出现的本仓库专有路径（包括 `../src/…`、`./doc/…` 这样的相对写法）。
 * 明确写了“来自 ERA-Heron 的 `…`”的说明除外；网址和指向网址的链接文字先被遮住，不参与检查。
 */
const FORBIDDEN = [
  /(?<![\w-])(?<!ERA-Heron 的 `)(?:doc\/|开发工具\/?|src\/ERA变量框架|artifact\/bundle\.js|tests\/)/g,
  // 指向本仓库根目录文件的相对链接（母版里同名文件的内容不同）
  /(?<![\w./])\.\.\/(?:README|AGENTS|CLAUDE|更新日志)\.md/g,
  // 规则顺序出错时会出现的重复前缀
  /docs\/era\/(?:docs\/|\.agents\/|util\/|exported\.era|初始模板\/)/g,
];

/** 把网址和指向网址的链接文字换成等长的空格，保持列号不变。 */
const maskUrls = line =>
  line
    .replace(/\[[^\]\n]*\](?=\(https?:)/g, match => ' '.repeat(match.length))
    .replace(/https?:\/\/[^\s)\]>'"`]+/g, match => ' '.repeat(match.length));

/** 找出文本中的本仓库专有路径：[{ line, text, context }]，按行内位置排序。 */
function findForbidden(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    const masked = maskUrls(line);
    const matches = FORBIDDEN.flatMap(pattern => [...masked.matchAll(pattern)]).sort((a, b) => a.index - b.index);
    for (const match of matches) found.push({ line: index + 1, text: match[0], context: line.trim() });
  });
  return found;
}

const MARK = '';

const version = (root = ROOT) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/**
 * 按规则改写一个文件的内容。
 * @returns `{ text, missing }`，`missing` 是没有匹配上的 required 规则（用 `from` 的开头描述）。
 */
function transform(source, text, context = { version: version() }) {
  const finals = [];
  const missing = [];
  let result = text.replace(/\r\n/g, '\n');
  for (const rule of RULES) {
    if (rule.files && !rule.files.includes(source)) continue;
    const replacement = typeof rule.to === 'function' ? rule.to(context) : rule.to;
    const pattern =
      typeof rule.from === 'string' ? new RegExp(rule.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : rule.from;
    let count = 0;
    result = result.replace(pattern, () => {
      count++;
      if (!rule.final) return replacement;
      finals.push(replacement);
      // 用占位标记（Unicode 私用区字符）保护替换结果，最后再换回来
      return `${MARK}${finals.length - 1}${MARK}`;
    });
    if (rule.required && count === 0) missing.push(String(rule.from).split('\n')[0].slice(0, 60));
  }
  result = result.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_m, index) => finals[Number(index)]);
  return { text: result, missing };
}

/** 生成全部同步结果，不读写母版。 */
function buildOutputs(root = ROOT) {
  const context = { version: version(root) };
  return listFiles(root).map(([source, target]) => {
    const { text, missing } = transform(source, fs.readFileSync(path.join(root, source), 'utf8'), context);
    return { source, target, text, missing, forbidden: findForbidden(text) };
  });
}

/** 逐行比较，返回带 2 行上下文的差异文本；相同时返回空串。 */
function lineDiff(before, after, context = 2) {
  const a = before.split('\n');
  const b = after.split('\n');
  // 去掉相同的首尾，只对中间做 LCS
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < start; k++) ops.push([' ', a[k]]);
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      ops.push([' ', x[i++]]);
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push(['-', x[i++]]);
    } else {
      ops.push(['+', y[j++]]);
    }
  }
  for (let k = endA; k < a.length; k++) ops.push([' ', a[k]]);
  const changed = ops.map((op, index) => (op[0] === ' ' ? -1 : index)).filter(index => index >= 0);
  if (changed.length === 0) return '';
  const keep = new Set();
  for (const index of changed) {
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep.add(k);
  }
  const lines = [];
  let last = -1;
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue;
    if (last !== -1 && k !== last + 1) lines.push('  …');
    lines.push(`${ops[k][0]} ${ops[k][1]}`);
    last = k;
  }
  return lines.join('\n');
}

/** 默认的母版目录：环境变量，或从本仓库向上逐级查找 `模板与参考/tavern_era_template`（兼容 git worktree）。 */
function findTemplateDir() {
  if (process.env.ERA_TEMPLATE_DIR) return path.resolve(process.env.ERA_TEMPLATE_DIR);
  for (let dir = path.resolve(ROOT, '..'); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, '模板与参考', 'tavern_era_template');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * 比较（并可写入）母版。返回 `{ ok, results }`；`ok` 为 false 时表示有问题，`--write` 不会写入任何文件。
 * @param log 输出函数，测试时可以收集起来。
 */
function sync({ template, write = false, quiet = false, root = ROOT, log = console.log } = {}) {
  const outputs = buildOutputs(root);
  const problems = [];
  for (const output of outputs) {
    for (const rule of output.missing)
      problems.push(`${output.source}：母版改写规则没有匹配上（${rule}…），请更新映射表`);
    for (const item of output.forbidden) {
      problems.push(`${output.target}:${item.line}：仍含本仓库专有路径 ${item.text}（${item.context.slice(0, 80)}）`);
    }
  }
  const results = outputs.map(output => {
    const file = path.join(template, output.target);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    const status = current === null ? '新增' : current === output.text ? '相同' : '有差异';
    return { ...output, file, current, status };
  });

  log(`母版：${template}${write ? '' : '（dry-run，不写入；加 --write 写入）'}`);
  for (const result of results) {
    log(`[${result.status}] ${result.source} → ${result.target}`);
    if (!quiet && result.status === '有差异') log(lineDiff(result.current, result.text));
  }
  // 母版中有、但本仓库已经没有的文档（例如改名后留下的旧文件），不自动删除
  const targets = new Set(results.map(result => result.target));
  for (const dir of ['docs/era', 'docs/era/示例']) {
    const full = path.join(template, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      const target = `${dir}/${name}`;
      if (fs.statSync(path.join(full, name)).isFile() && !targets.has(target)) {
        log(`[多余] ${target}：本仓库没有对应的文件，请手动确认是否删除`);
      }
    }
  }
  for (const problem of problems) log(`错误：${problem}`);

  if (problems.length > 0) {
    if (write) log('有错误，没有写入任何文件。');
    return { ok: false, results };
  }
  const changed = results.filter(result => result.status !== '相同');
  if (write) {
    for (const result of changed) {
      fs.mkdirSync(path.dirname(result.file), { recursive: true });
      fs.writeFileSync(result.file, result.text);
    }
    log(`已写入 ${changed.length} 个文件。请在母版中检查 git diff 后再提交。`);
  } else {
    log(`${changed.length} 个文件需要更新。`);
  }
  return { ok: true, results };
}

/**
 * 解析命令行参数。`--template` 可以写成 `--template=<目录>` 或 `--template <目录>`；
 * 不认识的参数直接报错，避免拼错的参数被忽略后写入默认的母版。
 * @returns `{ template?, write, quiet }` 或 `{ error }`
 */
function parseArgs(args) {
  const options = { write: false, quiet: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg.startsWith('--template=')) options.template = arg.slice('--template='.length);
    else if (arg === '--template' && args[i + 1] && !args[i + 1].startsWith('--')) options.template = args[++i];
    else return { error: `不认识的参数：${arg}。可用：--write、--quiet、--template=<目录>` };
  }
  if (options.template === '') return { error: '--template 没有给出目录' };
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    console.error(options.error);
    process.exitCode = 1;
    return;
  }
  const template = options.template ?? findTemplateDir();
  if (!template || !fs.existsSync(template)) {
    console.error(
      options.template
        ? `母版目录不存在：${template}`
        : '找不到母版目录。用 --template=<目录> 或环境变量 ERA_TEMPLATE_DIR 指定。',
    );
    process.exitCode = 1;
    return;
  }
  const { ok } = sync({ template: path.resolve(template), write: options.write, quiet: options.quiet });
  if (!ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  RULES,
  listFiles,
  transform,
  findForbidden,
  buildOutputs,
  lineDiff,
  sync,
  findTemplateDir,
  parseArgs,
};
