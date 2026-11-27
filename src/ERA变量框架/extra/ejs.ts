/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：分步更新按目标楼的状态渲染世界书条目中的 EJS（提示词模板插件），隔离写函数
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 分步更新的 EJS 渲染
 * @description
 * 借用提示词模板插件（ST-Prompt-Template）的 `EjsTemplate` 渲染发给更新模型的条目，但读到的是**目标楼**的状态：
 * - `getvar` 及其所有别名（任何 scope），只要键以 `stat_data` 开头，都读目标楼的状态；模板里直接访问的 `variables` 也替换；
 * - 写函数（`setvar`、`incvar`…）、激活世界书、注入提示词、激活正则、执行斜杠命令都换成空操作并记 warning：
 *   `[era_both]` 条目在主生成里已经被插件渲染过一次，再执行会让副作用发生两次。
 *   插件导出的 `evalTemplate` 会把它的预演标志清零，`runType: 'preparation'` 挡不住 `setvar`（插件 1.17.9 源码），所以只能自己换掉；
 * - `define` 只定义在本次渲染的环境里，不写进插件的全局定义；同一次解析的条目按 order 依次渲染，共用一个环境。
 *
 * 插件没有安装或在插件设置里关闭时不渲染，与主生成一致。
 */
'use strict';

/** 插件导出的接口中用到的部分。 */
export interface EjsEngine {
  evalTemplate(code: string, context?: Record<string, any> | null, options?: Record<string, any>): Promise<string>;
  prepareContext(context?: Record<string, any>, end?: number): Promise<Record<string, any>>;
  getFeatures?(): Record<string, any>;
}

/** 当前可用的提示词模板插件；没有安装、或在插件设置里关闭了（总开关或“生成时处理”）时为 `null`。 */
export function getEjsEngine(): EjsEngine | null {
  let engine: any;
  try {
    engine = (globalThis as any).EjsTemplate ?? (globalThis as any).window?.parent?.EjsTemplate;
  } catch {
    engine = undefined;
  }
  if (!engine || typeof engine.evalTemplate !== 'function' || typeof engine.prepareContext !== 'function') return null;
  try {
    const features = engine.getFeatures?.();
    if (features && (features.enabled === false || features.generate_enabled === false)) return null;
  } catch {
    // 旧版插件没有 getFeatures
  }
  return engine;
}

export interface Decorator {
  name: string;
  arg: string;
}

/**
 * 拆出条目开头的装饰器（以 `@@` 开头的连续行），与插件和酒馆的写法一致：`@@@` 开头的行是转义，表示正文从这一行开始。
 */
export function parseDecorators(content: string): { decorators: Decorator[]; content: string } {
  if (!content.startsWith('@@')) return { decorators: [], content };
  const decorators: Decorator[] = [];
  let start = 0;
  while (start < content.length && content.startsWith('@@', start)) {
    let end = content.indexOf('\n', start);
    if (end === -1) end = content.length;
    const line = content.slice(start, end).replace(/\r$/, '');
    if (line.startsWith('@@@')) {
      return { decorators, content: line.slice(1) + content.slice(end) };
    }
    const space = line.indexOf(' ');
    decorators.push(
      space === -1 ? { name: line.trim(), arg: '' } : { name: line.slice(0, space), arg: line.slice(space + 1).trim() },
    );
    start = end + 1;
  }
  return { decorators, content: content.slice(start) };
}

/** 有这些装饰器的条目是插件的特殊条目（生成前后、渲染、初始变量、预处理等），不发给更新模型。 */
const SPECIAL_DECORATOR =
  /^@@(generate_|render_|iframe$|message_formatting$|preprocessing$|only_preload$|initial_variables$)/;
/** 名字里带这些标记的条目同上。 */
const SPECIAL_NAME = /\[GENERATE:|\[RENDER:|@INJECT|\[InitialVariables\]/;

export function isSpecialEntry(name: string, decorators: Decorator[]): boolean {
  return SPECIAL_NAME.test(name) || decorators.some(item => SPECIAL_DECORATOR.test(item.name));
}

/** 改变变量或酒馆状态的函数：在更新模型流程中换成空操作。 */
const WRITE_FUNCTIONS = [
  'setvar',
  'setLocalVar',
  'setGlobalVar',
  'setMessageVar',
  'incvar',
  'incLocalVar',
  'incGlobalVar',
  'incMessageVar',
  'decvar',
  'decLocalVar',
  'decGlobalVar',
  'decMessageVar',
  'delvar',
  'delLocalVar',
  'delGlobalVar',
  'delMessageVar',
  'insvar',
  'insertLocalVar',
  'insertGlobalVar',
  'insertMessageVar',
  'patchVariables',
  'setVariableSchema',
  'activewi',
  'activateWorldInfo',
  'activateWorldInfoByKeywords',
  'injectPrompt',
  'activateRegex',
  'execute',
];

/** 读取变量的函数：键以 `stat_data` 开头时改为读目标楼的状态。 */
const READ_FUNCTIONS = ['getvar', 'getLocalVar', 'getGlobalVar', 'getMessageVar'];

const isStatKey = (key: unknown): key is string => typeof key === 'string' && /^stat_data(?:$|[.[])/.test(key);

export interface EjsRenderer {
  /** 渲染一段模板；`label` 用于告警。出错或超时时抛出异常。 */
  render(content: string, label: string): Promise<string>;
  /** `@@if` 的条件：出错时抛出异常。 */
  test(expression: string, label: string): Promise<boolean>;
}

/**
 * 创建一次解析共用的渲染环境。
 * @param statRaw 目标楼的状态（转义过的原始状态，与主生成时插件读到的 `stat_data` 一致）。
 * @param warnings 写函数被调用等情况记在这里。
 * @param deadline 渲染的截止时间（`Date.now()` 的值）；过了截止时间的渲染按超时失败。
 */
export async function createEjsRenderer(
  engine: EjsEngine,
  statRaw: any,
  extras: { mk: string },
  warnings: string[],
  deadline: number,
): Promise<EjsRenderer> {
  const ctx: Record<string, any> = await engine.prepareContext({ runType: 'preparation', isDryRun: true });
  let current = '';
  const warned = new Set<string>();

  const baseVariables = (() => {
    try {
      return ctx.variables;
    } catch {
      return {};
    }
  })();
  Object.defineProperty(ctx, 'variables', {
    value: { ...(_.isPlainObject(baseVariables) ? baseVariables : {}), stat_data: _.cloneDeep(statRaw) },
    writable: true,
    configurable: true,
    enumerable: true,
  });

  for (const name of READ_FUNCTIONS) {
    const original = ctx[name];
    ctx[name] = (key: unknown, options?: any) => {
      if (isStatKey(key)) {
        const value = _.get({ stat_data: statRaw }, key);
        return value === undefined ? (_.isPlainObject(options) ? options.defaults : undefined) : _.cloneDeep(value);
      }
      return typeof original === 'function' ? original(key, options) : undefined;
    };
  }
  for (const name of WRITE_FUNCTIONS) {
    ctx[name] = () => {
      const key = `${current}\u0000${name}`;
      if (!warned.has(key)) {
        warned.add(key);
        warnings.push(`条目“${current}”调用了 ${name}，更新模型流程中不执行`);
      }
      return name === 'execute' ? '' : undefined;
    };
  }
  ctx.define = (name: string, value: unknown, merge = false) => {
    const old = _.get(ctx, name);
    let next = value;
    if (merge && (old === undefined || _.isArray(old)) && _.isArray(value)) next = _.concat(old ?? [], value);
    else if (merge && (old === undefined || _.isPlainObject(old)) && _.isPlainObject(value)) {
      next = _.mergeWith({}, old ?? {}, value, (_dst: unknown, src: unknown) => (_.isArray(src) ? src : undefined));
    }
    _.set(ctx, name, next);
    return old;
  };
  ctx.era = { purpose: 'extra', mk: extras.mk };

  const run = async (code: string, label: string): Promise<string> => {
    current = label;
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('渲染超时');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        engine.evalTemplate(code, ctx),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('渲染超时')), left);
        }),
      ]);
      return String(result ?? '');
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    render: run,
    async test(expression, label) {
      return (await run(`<%- !!(${expression}) %>`, label)).trim() === 'true';
    },
  };
}
