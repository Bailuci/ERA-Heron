/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：测试：拆出测试宿主，新增同步层随机对拍测试；新增脚本设置“日志保留楼层数”；新增更新钩子 Era.onBeforeApply / Era.onAfterApply；同步过程中切换聊天时放弃本次结果等；可替换外部模块（如 opencc-js）；可以卡住事件队列（hold_queue）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
// 测试宿主：在独立的 vm 上下文中直接加载真实的 TypeScript 源码，不依赖构建产物或真实酒馆。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const _ = require('lodash');
const z = require('zod');

const SRC_ROOT = path.join(__dirname, '..', 'src', 'ERA变量框架');

/** 转译结果按文件缓存，避免每个宿主都重新转译全部源码。 */
const compiled = new Map();
function compile(filename) {
  if (!compiled.has(filename)) {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    });
    compiled.set(filename, new vm.Script(`(function (require, module, exports) {${outputText}\n})`, { filename }));
  }
  return compiled.get(filename);
}

/**
 * @param overrides 覆盖或补充注入到 vm 上下文的全局变量。
 * @param externals 覆盖外部模块，例如给 `opencc-js` 一个简单的繁简转换。
 */
function create_host(overrides = {}, externals = {}) {
  const emitted = [];
  const toasts = [];
  const context = vm.createContext({
    _,
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    SillyTavern: {
      name1: 'User',
      name2: 'Char',
      characterId: 'test-card',
      characters: {},
      getCurrentChatId: () => 'chat',
    },
    builtin: { duringGenerating: () => false },
    tavern_events: new Proxy({}, { get: (_target, key) => String(key) }),
    eventEmit: (name, payload) => emitted.push({ name, payload }),
    eventOn: () => {},
    toastr: { warning: (...args) => toasts.push(args) },
    getVariables: () => ({}),
    getScriptId: () => 'test',
    // 事件队列、页面加载回调等需要；页面加载回调在测试中不执行
    setTimeout,
    clearTimeout,
    $: () => ({ on() {} }),
    ...overrides,
  });

  const external = {
    lodash: _,
    zod: z,
    vue: { ref: value => ({ value }), readonly: value => value },
    'opencc-js': { Converter: () => text => text },
    ...externals,
  };

  const modules = new Map();
  /** 卡住事件队列：满足条件的任务等到放行后才执行。 */
  const holds = [];
  const wrap_dispatcher = exports => {
    const original = exports.dispatchAndExecuteTask;
    exports.dispatchAndExecuteTask = async (job, ...rest) => {
      for (const hold of [...holds]) if (hold.match(job)) await hold.promise;
      return original(job, ...rest);
    };
  };
  function resolve_file(base) {
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`无法解析模块: ${base}`);
  }
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const local_require = request => {
      if (request in external) return external[request];
      // UI 层依赖真实页面，测试中用空实现代替
      if (request.endsWith('/ui/patch')) return { forceRenderRecentMessages() {} };
      if (request.startsWith('ERA变量框架/')) {
        return load(resolve_file(path.join(SRC_ROOT, request.slice('ERA变量框架/'.length))));
      }
      if (request.endsWith('?raw')) {
        return {
          default: fs.readFileSync(path.resolve(path.dirname(filename), request.slice(0, -4)), 'utf8'),
          __esModule: true,
        };
      }
      if (request.startsWith('.')) {
        return load(resolve_file(path.resolve(path.dirname(filename), request)));
      }
      throw new Error(`测试宿主未提供模块: ${request}`);
    };
    compile(filename).runInContext(context)(local_require, module, module.exports);
    if (/[\\/]events[\\/]dispatcher\.ts$/.test(filename)) wrap_dispatcher(module.exports);
    return module.exports;
  }

  const load_src = relative => load(resolve_file(path.join(SRC_ROOT, relative)));
  return {
    context,
    /**
     * 卡住事件队列：之后执行的任务中，满足 `match(job)` 的（默认全部）要等到调用返回的函数才执行。
     * 用来构造“写入已到正文、同步还没完成”等情况。
     */
    hold_queue(match = () => true) {
      let release;
      const hold = { match, promise: new Promise(resolve => (release = resolve)) };
      holds.push(hold);
      return () => {
        holds.splice(holds.indexOf(hold), 1);
        release();
      };
    },
    emitted,
    toasts,
    patcher: load_src('core/crud/patcher'),
    arithmetic: load_src('core/crud/arithmetic'),
    schema: load_src('core/schema'),
    sync: load_src('core/sync'),
    api_ops: load_src('core/api_ops'),
    mk: load_src('core/key/mk'),
    snapshot: load_src('core/snapshot'),
    load_src,
    hook_registry: load_src('api/hook_registry'),
    hooks: load_src('core/hooks'),
    registry: load_src('api/schema_registry'),
    timetravel: load_src('core/timetravel'),
    data: load_src('utils/data'),
    era_data: load_src('utils/era_data'),
  };
}

module.exports = { create_host };
