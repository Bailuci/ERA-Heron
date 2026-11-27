/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26 至 2026-11-27
 * 目的：性能基准（路线图 1.7-11）的自检：基线文件覆盖全部场景，比较逻辑只按相对耗时与体积给出警告，场景本身可以运行
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 运行方式: node --test tests/era_bench.test.cjs（基准本身用 pnpm bench 运行）
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SCENARIOS, run_all, compare } = require('./bench/run.cjs');
const baseline = require('./bench/baseline.json');

test('基线文件覆盖全部场景，并记录了 bundle 体积', () => {
  assert.deepEqual(Object.keys(baseline.scenarios).sort(), SCENARIOS.map(s => s.name).sort());
  for (const result of Object.values(baseline.scenarios)) {
    assert.ok(result.ms > 0 && result.relative > 0);
  }
  assert.equal(baseline.scenarios.calibration.relative, 1);
  assert.ok(baseline.bundle.bytes > 100_000 && baseline.bundle.gzip > 0);
});

test('比较：按相对耗时判断，体积超过阈值警告，缺少的场景跳过', () => {
  const base = {
    scenarios: { calibration: { ms: 10, relative: 1 }, a: { ms: 100, relative: 10 }, b: { ms: 50, relative: 5 } },
    bundle: { bytes: 1000, gzip: 300 },
  };
  // 机器整体慢一倍：绝对耗时翻倍，相对耗时不变，不警告
  const slower_machine = {
    scenarios: { calibration: { ms: 20, relative: 1 }, a: { ms: 200, relative: 10 }, b: { ms: 100, relative: 5 } },
    bundle: { bytes: 1050, gzip: 310 },
  };
  assert.deepEqual(compare(slower_machine, base), []);
  const regressed = {
    scenarios: { calibration: { ms: 10, relative: 1 }, a: { ms: 160, relative: 16 }, c: { ms: 1, relative: 0.1 } },
    bundle: { bytes: 1200, gzip: 400 },
  };
  const warnings = compare(regressed, base);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^a 变慢/);
  assert.match(warnings[1], /^bundle\.js 变大/);
  assert.deepEqual(compare(regressed, null), []);
});

test('场景可以运行，结果结构与基线一致', async () => {
  const result = await run_all({ repeats: 1, only: ['big_insert'] });
  assert.deepEqual(Object.keys(result.scenarios), ['calibration', 'big_insert']);
  assert.ok(result.scenarios.big_insert.ms > 0);
  assert.equal(result.scenarios.calibration.relative, 1);
});

test('场景的数据真的被执行了：天数累加、日志按楼追加和删除、钩子与 schema 生效', async () => {
  const { long_chat, world_schema, total_hp_hook } = require('./bench/run.cjs');
  const c = long_chat(30);
  await c.sync(true);
  assert.equal(c.stat().世界.天数, 30);
  assert.ok(c.stat().日志.第29楼);
  assert.equal(c.stat().日志.第5楼, undefined, '第 25 楼删除了第 5 楼的日志');
  const s = long_chat(10, { schema: world_schema, hooks: [['总生命', total_hp_hook, 0]] });
  await s.sync(true);
  const roles = Object.values(s.stat().角色);
  assert.equal(
    s.stat().统计.总生命,
    roles.reduce((sum, role) => sum + role.生命, 0),
  );
});

test('--update 只运行部分场景时，其余场景保留旧基线；读不到 bundle 时保留旧体积', () => {
  const { merge_baseline } = require('./bench/run.cjs');
  const old = {
    scenarios: { calibration: { ms: 10, relative: 1 }, a: { ms: 100, relative: 10 }, b: { ms: 50, relative: 5 } },
    bundle: { bytes: 1000, gzip: 300 },
  };
  const partial = {
    node: 'v22',
    platform: 'linux-x64',
    scenarios: { calibration: { ms: 20, relative: 1 }, b: { ms: 80, relative: 4 } },
    bundle: null,
  };
  assert.deepEqual(merge_baseline(partial, old, '2026-11-27'), {
    node: 'v22',
    platform: 'linux-x64',
    scenarios: { calibration: { ms: 20, relative: 1 }, a: { ms: 100, relative: 10 }, b: { ms: 80, relative: 4 } },
    bundle: { bytes: 1000, gzip: 300 },
    updated: '2026-11-27',
  });
  assert.deepEqual(merge_baseline(partial, null, 'x').scenarios, partial.scenarios);
});
