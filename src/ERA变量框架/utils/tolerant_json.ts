/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25
 * 目的：新增 <VariablePatch> 指令、宽松解析、只读字段与指令问题报告；修复第三批改动在审查中发现的问题；修复复审中发现的问题
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 宽松 JSON 解析
 * @description
 * AI 输出的 JSON 常有小毛病：尾逗号、单引号、键没加引号、全角标点、注释、字符串里的裸换行、缺少收尾括号等。
 * 本解析器只在严格解析失败后使用，尽量还原 AI 的意图；无法还原时返回 `null`，不会猜测内容。
 *
 * 没有使用第三方库：ERA 的依赖在运行时从 CDN 加载，多一个依赖就多一个会让整个框架无法启动的失败点。
 */
'use strict';

class ParseFailure extends Error {}

const OPEN_QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '`': '`' };
const CLOSERS = [',', '，', '}', ']', ':', '：', ';', '；'];

class TolerantParser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly strict: boolean,
  ) {}

  /** 遇到没有收尾的对象或数组。 */
  private unclosed<T>(value: T): T {
    if (this.strict) throw new ParseFailure('缺少收尾的括号');
    return value;
  }

  /** 依次解析文本中的全部值（支持 JSONL 那样的多个值连写）。 */
  parseAll(): any[] {
    const values: any[] = [];
    for (;;) {
      this.skip();
      while (this.peek() !== undefined && /[,，;；]/.test(this.peek()!)) {
        this.pos++;
        this.skip();
      }
      if (this.peek() === undefined) return values;
      if (this.peek() !== '{' && this.peek() !== '[') throw new ParseFailure('顶层必须是对象或数组');
      values.push(this.value());
    }
  }

  private peek(offset = 0): string | undefined {
    return this.text[this.pos + offset];
  }

  /** 跳过空白和注释。 */
  private skip(): void {
    for (;;) {
      const char = this.peek();
      if (char === undefined) return;
      if (/\s/.test(char) || char === '﻿') {
        this.pos++;
      } else if (char === '/' && this.peek(1) === '/') {
        this.skipTo('\n');
      } else if (char === '#') {
        this.skipTo('\n');
      } else if (char === '/' && this.peek(1) === '*') {
        this.skipTo('*/');
      } else if (this.text.startsWith('<!--', this.pos)) {
        this.skipTo('-->');
      } else {
        return;
      }
    }
  }

  private skipTo(end: string): void {
    const index = this.text.indexOf(end, this.pos);
    this.pos = index === -1 ? this.text.length : index + end.length;
  }

  private value(): any {
    this.skip();
    const char = this.peek();
    if (char === undefined) throw new ParseFailure('缺少值');
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char in OPEN_QUOTES) return this.string();
    return this.bare();
  }

  private object(): Record<string, any> {
    const result: Record<string, any> = {};
    this.pos++;
    for (;;) {
      this.skip();
      const char = this.peek();
      if (char === undefined) return this.unclosed(result); // 缺少收尾的 }
      if (char === '}') {
        this.pos++;
        return result;
      }
      if (char === ',' || char === '，' || char === ';' || char === '；') {
        this.pos++;
        continue;
      }
      if (char === ']') return this.unclosed(result); // 括号写错，交给外层处理
      const key = char in OPEN_QUOTES ? this.string() : this.bareKey();
      this.skip();
      const separator = this.peek();
      if (separator !== ':' && separator !== '：' && separator !== '=') throw new ParseFailure('键后面缺少冒号');
      this.pos++;
      this.skip();
      const next = this.peek();
      if (next === undefined || next === ',' || next === '，' || next === '}') throw new ParseFailure('键后面缺少值');
      Object.defineProperty(result, key, {
        value: this.value(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  private array(): any[] {
    const result: any[] = [];
    this.pos++;
    for (;;) {
      this.skip();
      const char = this.peek();
      if (char === undefined) return this.unclosed(result); // 缺少收尾的 ]
      if (char === ']') {
        this.pos++;
        return result;
      }
      if (char === ',' || char === '，' || char === ';' || char === '；') {
        this.pos++;
        continue;
      }
      if (char === '}') return this.unclosed(result);
      result.push(this.value());
    }
  }

  private string(): string {
    const open = this.peek()!;
    const close = OPEN_QUOTES[open];
    this.pos++;
    let result = '';
    for (;;) {
      const char = this.peek();
      if (char === undefined) throw new ParseFailure('字符串没有结束');
      if (char === '\\') {
        result += this.escape();
        continue;
      }
      if (char === close) {
        if (this.isStringEnd()) {
          this.pos++;
          return result;
        }
        // 字符串内部没有转义的引号
      }
      result += char;
      this.pos++;
    }
  }

  /** 当前的收尾引号之后是分隔符、括号或文本末尾时，才认为字符串真正结束。 */
  private isStringEnd(): boolean {
    let i = this.pos + 1;
    while (i < this.text.length && /\s/.test(this.text[i])) i++;
    const next = this.text[i];
    if (next === undefined || CLOSERS.includes(next)) return true;
    if (next === '/' && (this.text[i + 1] === '/' || this.text[i + 1] === '*')) return true;
    if (next === '#' || this.text.startsWith('<!--', i)) return true;
    // 漏写逗号：换行后紧跟下一个键
    return /[\r\n]/.test(this.text.slice(this.pos + 1, i)) && next in OPEN_QUOTES;
  }

  private escape(): string {
    const next = this.peek(1);
    if (next === undefined) throw new ParseFailure('转义没有结束');
    if (next === 'u') {
      const hex = this.text.slice(this.pos + 2, this.pos + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        this.pos += 6;
        return String.fromCharCode(parseInt(hex, 16));
      }
    }
    this.pos += 2;
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\n': '\n' };
    return next in map ? map[next] : next;
  }

  private bareKey(): string {
    const match = /^[^\s:：=,，{}[\]"'“”‘’`]+/.exec(this.text.slice(this.pos));
    if (!match) throw new ParseFailure('无法识别的键');
    this.pos += match[0].length;
    return match[0];
  }

  /** 没有引号的值：数字、布尔、null；其他内容视为没加引号的文本。 */
  private bare(): any {
    const match = /^[^,，{}[\]\r\n"“”]+/.exec(this.text.slice(this.pos));
    if (!match) throw new ParseFailure('无法识别的值');
    // 没加引号的网址里也有 //：前面是空白，或前面是完整的数字、布尔、null 时才是注释
    const raw = match[0]
      .replace(/\s+(?:\/\/|\/\*).*$/, '')
      .replace(/^([+-]?[\d.]+(?:[eE][+-]?\d+)?|true|false|null)(?:\/\/|\/\*).*$/i, '$1');
    this.pos += raw.length;
    const text = raw.trim();
    if (text === '') throw new ParseFailure('缺少值');
    if (/^(?:true|True|TRUE)$/.test(text)) return true;
    if (/^(?:false|False|FALSE)$/.test(text)) return false;
    if (/^(?:null|None|undefined|NULL)$/.test(text)) return null;
    // `+5` 可能想表达增加，也可能只是数字
    if (this.strict && text.startsWith('+')) throw new ParseFailure('数字前有加号');
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
    return text;
  }
}

/**
 * 宽松地解析文本中的全部 JSON 值。
 * @param strict 缺少收尾的括号、含义不明确时视为无法还原，而不是自动补上。
 * @returns 解析出的值；无法还原时返回 `null`。
 */
export function parseTolerant(text: string, strict = false): any[] | null {
  try {
    const values = new TolerantParser(text, strict).parseAll();
    return values.length > 0 ? values : null;
  } catch (error) {
    if (error instanceof ParseFailure) return null;
    throw error;
  }
}
