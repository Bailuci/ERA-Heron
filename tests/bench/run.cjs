/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：性能基准（路线图 1.7-11）：在 Node 中直接运行真实源码，固定几个场景并与提交进仓库的基线比较；同时记录 artifact/bundle.js 体积
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 性能基准。运行方式:
//   pnpm bench              运行并与 tests/bench/baseline.json 比较，只打印警告，不以失败退出
//   pnpm bench --update     运行并把结果写成新的基线（改动确实影响性能、并确认可以接受时使用）
//   pnpm bench --json       额外输出一行 JSON 结果，便于其他工具读取
//   pnpm bench --only=a,b   只运行这几个场景（与 --update 一起用时，其余场景保留旧基线）
//   pnpm bench --repeats=N  每个场景运行 N 次取最快（默认 5）
//
// 不同机器的绝对耗时差别很大（作者的 Windows 与 CI 的 Linux），所以每个场景同时记录“相对耗时”：
// 场景耗时除以同一进程里一段固定纯 JS 负载（calibration）的耗时。比较时以相对耗时为准。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const _ = require('lodash');
const z = require('zod');
const { create_chat } = require('../chat.cjs');

const ROOT = path.join(__dirname, '..', '..');
const BASELINE_FILE = path.join(__dirname, 'baseline.json');
const BUNDLE_FILE = path.join(ROOT, 'artifact', 'bundle.js');

/** 相对耗时超过基线的这个倍数时警告。计时有噪声，阈值放宽。 */
const TIME_TOLERANCE = 1.5;
/** bundle 体积超过基线的这个倍数时警告。 */
const SIZE_TOLERANCE = 1.1;

const T = (type, data) => `<Variable${type}>${JSON.stringify(data)}</Variable${type}>`;

/** 确定性的伪随机数，场景每次生成的数据都相同。 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 50 个角色，每个角色 10 个字段，外加一个日志对象。 */
function initial_world() {
  const characters = {};
  for (let i = 0; i < 50; i++) {
    characters[`角色${i}`] = {
      生命: 100,
      体力: 100,
      好感: 0,
      金钱: 1000,
      位置: '城镇',
      状态: '正常',
      等级: 1,
      经验: 0,
      背包: { 药水: 3, 钥匙: 0 },
      $meta: { 说明: `第 ${i} 个角色` },
    };
  }
  return { 世界: { 天数: 1, 时间: '清晨', 天气: '晴' }, 角色: characters, 日志: {} };
}

/** 第 `floor` 楼的 AI 回复：改几个角色的数值、追加一条日志，偶尔删除一条旧日志。 */
function floor_text(random, floor) {
  const edits = { 世界: { 天数: `+=1` } };
  for (let k = 0; k < 5; k++) {
    const who = `角色${Math.floor(random() * 50)}`;
    edits.角色 ??= {};
    edits.角色[who] = { 生命: `-=${1 + Math.floor(random() * 5)}`, 好感: '+=1', 位置: `地点${floor % 7}` };
  }
  let text = `第 ${floor} 楼的剧情。`.repeat(20);
  text += T('Edit', edits);
  text += T('Insert', { 日志: { [`第${floor}楼`]: { 事件: `事件${floor}`, 参与: [`角色${floor % 50}`] } } });
  if (floor > 20 && floor % 5 === 0) text += T('Delete', { 日志: { [`第${floor - 20}楼`]: null } });
  return text;
}

/** 一条 N 楼的长聊天（AI 与用户交替），尚未同步。 */
function long_chat(floors, options = {}) {
  const c = create_chat(options);
  const random = lcg(42);
  c.send('assistant', T('Insert', initial_world()));
  for (let i = 1; i < floors; i++) {
    c.send('user', `用户第 ${i} 句`);
    c.send('assistant', floor_text(random, i));
  }
  return c;
}

/** 一个约 1.2 万个叶子的大对象。 */
function big_object() {
  const random = lcg(7);
  const data = {};
  for (let i = 0; i < 200; i++) {
    const group = {};
    for (let j = 0; j < 20; j++) {
      group[`条目${j}`] = { 数值: Math.floor(random() * 1000), 名称: `名称${i}-${j}`, 标记: random() > 0.5 };
    }
    data[`分组${i}`] = group;
  }
  return { 图鉴: data };
}

const world_schema = z.object({
  世界: z.object({ 天数: z.number(), 时间: z.string(), 天气: z.string() }),
  角色: z.record(
    z.string(),
    z.object({
      生命: z.number().min(0).max(100),
      体力: z.number().min(0).max(100),
      好感: z.number(),
      金钱: z.number(),
      位置: z.string(),
      状态: z.string(),
      等级: z.number(),
      经验: z.number(),
      背包: z.record(z.string(), z.number()),
    }),
  ),
  日志: z.record(z.string(), z.any()),
  统计: z.object({ 总生命: z.number() }).default({ 总生命: 0 }),
});

/** 派生数值钩子：汇总全体角色的生命。 */
function total_hp_hook(ctx) {
  const roles = ctx.stat?.角色 ?? {};
  let total = 0;
  for (const role of Object.values(roles)) total += Number(role?.生命) || 0;
  ctx.stat.统计 = { 总生命: total };
}

/**
 * 场景。`prepare` 在计时之外准备数据，`run` 是被计时的部分。
 * 每个场景都会先运行一次预热，再取若干次中最快的一次（见 `measure`）。
 */
const SCENARIOS = [
  {
    name: 'calibration',
    desc: '固定纯 JS 负载（JSON 往返与深拷贝），用来换算相对耗时',
    prepare: () => initial_world(),
    run: world => {
      let copy = world;
      for (let i = 0; i < 160; i++) copy = JSON.parse(JSON.stringify(_.cloneDeep(copy)));
      return copy;
    },
  },
  {
    name: 'full_resync_long_chat',
    desc: '长聊天完全重算：400 楼（200 楼 AI），每楼改 5 个角色、追加日志',
    prepare: () => long_chat(200),
    run: async c => {
      await c.sync(true);
    },
  },
  {
    name: 'append_one_floor',
    desc: '长聊天末尾追加一楼后的普通同步（每轮对话的常态开销）',
    prepare: async () => {
      const c = long_chat(200);
      await c.sync(true);
      return c;
    },
    // 每次运行都由 prepare 生成新的聊天，这里只计时追加后的那一次同步
    run: async c => {
      c.send('assistant', floor_text(lcg(9), 999));
      await c.sync();
    },
  },
  {
    name: 'big_insert',
    desc: '大对象 Insert：一次插入约 1.2 万个叶子的对象',
    prepare: () => {
      const c = create_chat();
      c.send('assistant', T('Insert', big_object()));
      return c;
    },
    run: async c => {
      await c.sync(true);
    },
  },
  {
    name: 'api_ops_150_rounds',
    desc: '单楼 ApiOps 150 回合：同一楼连续 150 次旁路写入，每次写入后同步',
    prepare: async () => {
      const c = create_chat({ settings: { API写入不修改消息: true } });
      c.send('assistant', T('Insert', initial_world()));
      await c.sync();
      return c;
    },
    run: async c => {
      for (let i = 0; i < 150; i++) {
        await c.push_op(0, {
          type: 'edit',
          data: { 世界: { 天数: '+=1' }, 角色: { [`角色${i % 50}`]: { 金钱: `-=${i % 7}` } } },
        });
        await c.sync();
      }
    },
  },
  {
    name: 'full_resync_schema_hooks',
    desc: '带 schema 和钩子的完全重算：120 楼（60 楼 AI）',
    prepare: () => long_chat(60, { schema: world_schema, hooks: [['总生命', total_hp_hook, 0]] }),
    run: async c => {
      await c.sync(true);
    },
  },
];

async function time(scenario) {
  const input = await scenario.prepare();
  const start = performance.now();
  await scenario.run(input);
  return performance.now() - start;
}

/**
 * 运行若干次，取最快的一次：机器上的其他负载只会让计时变慢，最快值最接近代码本身的开销。
 * 每次运行前紧挨着测一次校准负载（取 3 次中最快的），相对耗时按当时的校准值换算，
 * 这样机器负载在运行期间变化时，相对耗时仍然可比。
 */
async function measure(scenario, calibration, repeats) {
  const times = [];
  const ratios = [];
  // 第一次是预热：转译源码、JIT
  for (let i = 0; i <= repeats; i++) {
    const unit = Math.min(await time(calibration), await time(calibration), await time(calibration));
    const elapsed = await time(scenario);
    if (i === 0) continue;
    times.push(elapsed);
    ratios.push(elapsed / unit);
  }
  return { ms: Math.min(...times), relative: Math.min(...ratios) };
}

function bundle_size() {
  if (!fs.existsSync(BUNDLE_FILE)) return null;
  const content = fs.readFileSync(BUNDLE_FILE);
  return { bytes: content.length, gzip: zlib.gzipSync(content, { level: 9 }).length };
}

/** 运行全部场景，返回与基线文件同样结构的结果。 */
async function run_all({ repeats = 5, only } = {}) {
  const calibration = SCENARIOS.find(scenario => scenario.name === 'calibration');
  const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
  const scenarios = {};
  for (const scenario of SCENARIOS) {
    if (only && scenario !== calibration && !only.includes(scenario.name)) continue;
    const { ms, relative } =
      scenario === calibration
        ? { ms: Math.min(...(await sequential(repeats * 2 + 1, () => time(calibration)))), relative: 1 }
        : await measure(scenario, calibration, repeats);
    scenarios[scenario.name] = { desc: scenario.desc, ms: round(ms, 1), relative: round(relative, 2) };
  }
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    scenarios,
    bundle: bundle_size(),
  };
}

async function sequential(count, fn) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(await fn());
  return results;
}

/**
 * 与基线比较，返回警告列表。只比较两边都有的场景；相对耗时为准。
 * 导出给测试使用。
 */
function compare(result, baseline, { time = TIME_TOLERANCE, size = SIZE_TOLERANCE } = {}) {
  const warnings = [];
  for (const [name, current] of Object.entries(result.scenarios)) {
    if (name === 'calibration') continue;
    const base = baseline?.scenarios?.[name];
    if (!base) continue;
    if (current.relative > base.relative * time) {
      warnings.push(
        `${name} 变慢：相对耗时 ${current.relative}（基线 ${base.relative}，${(current.relative / base.relative).toFixed(2)} 倍）`,
      );
    }
  }
  if (result.bundle && baseline?.bundle && result.bundle.bytes > baseline.bundle.bytes * size) {
    warnings.push(
      `bundle.js 变大：${result.bundle.bytes} 字节（基线 ${baseline.bundle.bytes}，+${(((result.bundle.bytes - baseline.bundle.bytes) / baseline.bundle.bytes) * 100).toFixed(1)}%）`,
    );
  }
  return warnings;
}

function format_table(result, baseline) {
  const lines = [`Node ${result.node}，${result.platform}`];
  for (const [name, current] of Object.entries(result.scenarios)) {
    const base = baseline?.scenarios?.[name];
    const ratio =
      base && name !== 'calibration'
        ? `  (基线 ${base.relative}，×${(current.relative / base.relative).toFixed(2)})`
        : '';
    lines.push(
      `${name.padEnd(28)} ${String(current.ms).padStart(9)} ms  相对 ${String(current.relative).padStart(7)}${ratio}`,
    );
  }
  if (result.bundle) {
    const base = baseline?.bundle;
    lines.push(
      `${'bundle.js'.padEnd(28)} ${result.bundle.bytes} 字节（gzip ${result.bundle.gzip}）` +
        (base ? `  基线 ${base.bytes}（gzip ${base.gzip}）` : ''),
    );
  } else {
    lines.push('bundle.js                    未找到 artifact/bundle.js，跳过体积比较');
  }
  return lines.join('\n');
}

/**
 * 生成要写入的新基线。只运行了部分场景（`--only`）时，其余场景保留旧基线的记录；
 * 相对耗时已经按各自运行时的校准值换算，可以混用。
 * 体积以 CI 构建、已提交的 artifact/bundle.js 为准；读不到时保留旧值。
 */
function merge_baseline(result, baseline, updated) {
  return {
    ...result,
    scenarios: { ...baseline?.scenarios, ...result.scenarios },
    bundle: result.bundle ?? baseline?.bundle ?? null,
    updated,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const ci = args.includes('--ci') || !!process.env.GITHUB_ACTIONS;
  const repeats = Number(args.find(arg => arg.startsWith('--repeats='))?.slice(10)) || 5;
  const only = args
    .find(arg => arg.startsWith('--only='))
    ?.slice(7)
    .split(',');
  const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null;
  const unknown = (only ?? []).filter(name => !SCENARIOS.some(scenario => scenario.name === name));
  if (unknown.length > 0) {
    console.error(`没有这些场景：${unknown.join('、')}。可用：${SCENARIOS.map(scenario => scenario.name).join('、')}`);
    process.exitCode = 1;
    return;
  }

  const result = await run_all({ repeats, only });
  console.log(format_table(result, baseline));
  if (args.includes('--json')) console.log(JSON.stringify(result));

  if (update) {
    const recorded = merge_baseline(result, baseline, new Date().toISOString().slice(0, 10));
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(recorded, null, 2) + '\n');
    console.log(`已写入基线 ${path.relative(ROOT, BASELINE_FILE)}`);
    return;
  }
  if (!baseline) {
    console.log('没有基线文件，运行 pnpm bench --update 生成。');
    return;
  }
  const warnings = compare(result, baseline);
  for (const warning of warnings) console.log(ci ? `::warning title=性能基准::${warning}` : `警告：${warning}`);
  if (warnings.length === 0) console.log('与基线相比没有明显退化。');
  // 只警告不阻断：计时受机器负载影响
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    // 基准本身出错也不阻断 CI，但要让人看到
    console.log(`::warning title=性能基准::运行失败：${error?.message ?? error}`);
  });
}

module.exports = { SCENARIOS, run_all, compare, merge_baseline, bundle_size, long_chat, world_schema, total_hp_hook };
