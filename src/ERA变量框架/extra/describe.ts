/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增额外模型分步更新、等待式提交、试算与变量结构说明；工具与自定义公式函数的说明（2026-11-27）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 变量结构说明
 * @description 把已注册的 zod schema 转换成紧凑的类型说明，让模型知道每个变量的类型、枚举值和范围。
 */
'use strict';

import { z } from 'zod';
import { getActiveSchema } from '../api/schema_registry';
import { getActiveExprFns, getActiveTools } from '../api/tool_registry';
import { Logger } from '../utils/log';

const logger = new Logger();
const quote = (value: unknown): string => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));

function describeNode(node: any, root: any, indent: string, depth: number): string {
  if (!_.isPlainObject(node) || depth > 12) return 'any';
  if (typeof node.$ref === 'string') {
    const target = node.$ref === '#' ? root : _.get(root, node.$ref.replace(/^#\//, '').split('/'));
    return describeNode(target, root, indent, depth + 1);
  }
  if ('const' in node) return quote(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(quote).join(' | ');
  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union)) {
    return _.uniq(union.map((item: any) => describeNode(item, root, indent, depth + 1))).join(' | ');
  }
  if (Array.isArray(node.allOf)) {
    return node.allOf.map((item: any) => describeNode(item, root, indent, depth + 1)).join(' & ');
  }
  if (Array.isArray(node.type)) {
    return node.type.map((type: string) => describeNode({ ...node, type }, root, indent, depth + 1)).join(' | ');
  }
  switch (node.type) {
    case 'array': {
      const item = describeNode(node.items ?? {}, root, indent, depth + 1);
      return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case 'number':
    case 'integer': {
      const min = node.minimum ?? node.exclusiveMinimum;
      const max = node.maximum ?? node.exclusiveMaximum;
      const bounded = [min, max].some(value => value !== undefined && Math.abs(value) < Number.MAX_SAFE_INTEGER);
      return bounded ? `number /* ${min ?? ''}~${max ?? ''} */` : 'number';
    }
    case 'string':
    case 'boolean':
    case 'null':
      return node.type;
    case 'object': {
      const inner = `${indent}  `;
      const lines = Object.entries<any>(node.properties ?? {}).map(([key, value]) => {
        const comment = value?.description ? ` // ${value.description}` : '';
        return `${inner}${key}: ${describeNode(value, root, inner, depth + 1)};${comment}`;
      });
      if (_.isPlainObject(node.additionalProperties) && !_.isEmpty(node.additionalProperties)) {
        const names = node.propertyNames;
        const keys = names?.enum?.map(quote).join(' | ') ?? names?.description ?? '键名';
        lines.push(`${inner}[${keys}]: ${describeNode(node.additionalProperties, root, inner, depth + 1)};`);
      }
      return lines.length === 0 ? 'object' : `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      return 'any';
  }
}

/** 把 JSON Schema 转换成紧凑的类型说明。 */
export const describeJsonSchema = (schema: any): string => describeNode(schema, schema, '', 0);

/** 当前注册的变量结构说明；没有注册或无法转换时返回空字符串。 */
export function describeActiveSchema(): string {
  const active = getActiveSchema();
  if (!active) return '';
  try {
    const options = { io: 'input', unrepresentable: 'any' } as const;
    const schema = active.schema as any;
    const json =
      typeof schema.toJSONSchema === 'function' ? schema.toJSONSchema(options) : z.toJSONSchema(schema, options);
    return describeJsonSchema(json);
  } catch (error) {
    logger.debug('describeActiveSchema', '变量结构无法转换成说明', error);
    return '';
  }
}

/** 把工具参数的 zod schema 转换成类型说明；只写了说明文字时原样返回。 */
function describeParameters(parameters: any): string {
  if (parameters === undefined || parameters === null) return '{}';
  if (typeof parameters === 'string') return parameters;
  try {
    const options = { io: 'input', unrepresentable: 'any' } as const;
    const json =
      typeof parameters.toJSONSchema === 'function'
        ? parameters.toJSONSchema(options)
        : typeof parameters.safeParse === 'function'
          ? z.toJSONSchema(parameters, options)
          : parameters;
    return describeJsonSchema(json);
  } catch (error) {
    logger.debug('describeParameters', '工具参数无法转换成说明', error);
    return 'object';
  }
}

/** `{{ERA-tools}}`（1.8 起）：当前注册的工具及调用写法；没有工具时为空。 */
export function describeTools(): string {
  const tools = getActiveTools();
  if (tools.length === 0) return '';
  const lines = tools.map(tool => {
    const description = tool.description ? `：${tool.description}` : '';
    return `- ${tool.name}${description}\n  参数：${describeParameters(tool.parameters).replace(/\n/g, '\n  ')}`;
  });
  return [
    '可以调用以下工具，由程序计算并更新变量。写法：<EraFCall name="工具名">{"参数名": 值}</EraFCall>，参数是严格的 JSON。',
    ...lines,
  ].join('\n');
}

/** `{{ERA-exprFns}}`（1.8 起）：`$expr` 里可以调用的自定义公式函数；没有时为空。 */
export function describeExprFns(): string {
  const fns = getActiveExprFns();
  if (fns.length === 0) return '';
  const lines = fns.map(fn => {
    const count = fn.minArgs === fn.maxArgs ? `${fn.minArgs} 个参数` : `${fn.minArgs}～${fn.maxArgs} 个参数`;
    return `- ${fn.name}（${count}）${fn.description ? `：${fn.description}` : ''}`;
  });
  return ['$expr 里还可以调用以下函数（参数和结果都是数字）：', ...lines].join('\n');
}
