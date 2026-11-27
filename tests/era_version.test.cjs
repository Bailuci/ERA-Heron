/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：校验分散在各处的版本号一致（package.json、constants.ts、修改记录、README 与文档中的导入地址）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
// 版本号一致性测试。发版时只改了 package.json 而漏改其他地方，这里会失败并指出位置。
// 运行方式: node --test tests/era_version.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;

/** 列出目录下全部 Markdown 文件（相对仓库根目录） */
function markdown_files(dir) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...markdown_files(relative));
    else if (entry.name.endsWith('.md')) result.push(relative);
  }
  return result;
}

test('package.json 的版本号是 X.Y.Z 形式', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('constants.ts 的 ERA_VERSION 与 package.json 一致', () => {
  const match = read('src/ERA变量框架/utils/constants.ts').match(/export const ERA_VERSION = '([^']+)'/);
  assert.ok(match, 'constants.ts 中找不到 ERA_VERSION');
  assert.equal(match[1], VERSION);
});

test('更新日志.md 最新一节的版本号与 package.json 一致', () => {
  const match = read('更新日志.md').match(/^## (\d+\.\d+\.\d+)\b/m);
  assert.ok(match, '更新日志.md 中找不到“## X.Y.Z”形式的版本标题');
  assert.equal(match[1], VERSION);
});

test('README 中的当前版本与脚本名与 package.json 一致', () => {
  const readme = read('README.md');
  assert.match(readme, new RegExp(`当前版本：\\*\\*${VERSION.replace(/\./g, '\\.')}\\*\\*`));
  for (const [, version] of readme.matchAll(/ERA-Heron (\d+\.\d+\.\d+)/g)) {
    assert.equal(version, VERSION, `README.md 中的脚本名“ERA-Heron ${version}”`);
  }
});

test('README 与 doc/ 中固定版本的导入地址都指向当前版本', () => {
  const files = ['README.md', ...markdown_files('doc')];
  let found = 0;
  for (const file of files) {
    for (const [whole, version] of read(file).matchAll(/ERA-Heron@v(\d+\.\d+\.\d+)/g)) {
      found++;
      assert.equal(version, VERSION, `${file} 中的“${whole}”`);
    }
  }
  assert.ok(found > 0, '没有找到任何 ERA-Heron@vX.Y.Z 形式的导入地址');
});
