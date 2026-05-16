import { describe, it, expect } from 'vitest';
import { parseValue } from './configs.js';

describe('parseValue', () => {

  // 原始类型

  it('"true" → true', () => {
    expect(parseValue('true')).toBe(true);
  });

  it('"false" → false', () => {
    expect(parseValue('false')).toBe(false);
  });

  it('"null" → null', () => {
    expect(parseValue('null')).toBeNull();
  });

  it('整数 → number', () => {
    expect(parseValue('42')).toBe(42);
  });

  it('小数 → number', () => {
    expect(parseValue('3.14')).toBe(3.14);
  });

  it('纯字符串 → string', () => {
    expect(parseValue('hello')).toBe('hello');
  });

  it('带等号的字符串 → string', () => {
    expect(parseValue('a=b')).toBe('a=b');
  });

  // JSON 数组

  it('"[]" → []', () => {
    const result = parseValue('[]');
    expect(result).toEqual([]);
  });

  it('字符串数组 → array', () => {
    const result = parseValue('["a","b","c"]');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('数字数组 → array', () => {
    const result = parseValue('[1,2,3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('混合数组 → array', () => {
    const result = parseValue('[1,"x",true,null]');
    expect(result).toEqual([1, 'x', true, null]);
  });

  it('嵌套数组 → array', () => {
    const result = parseValue('[[1,2],[3,4]]');
    expect(result).toEqual([[1, 2], [3, 4]]);
  });

  // JSON 对象

  it('"{}" → {}', () => {
    const result = parseValue('{}');
    expect(result).toEqual({});
  });

  it('简单对象 → object', () => {
    const result = parseValue('{"host":"localhost","port":3306}');
    expect(result).toEqual({ host: 'localhost', port: 3306 });
  });

  it('嵌套对象 → object', () => {
    const result = parseValue('{"db":{"host":"127.0.0.1","port":5432}}');
    expect(result).toEqual({ db: { host: '127.0.0.1', port: 5432 } });
  });

  it('对象含数组值 → object', () => {
    const result = parseValue('{"ips":["10.0.0.1","10.0.0.2"],"count":2}');
    expect(result).toEqual({ ips: ['10.0.0.1', '10.0.0.2'], count: 2 });
  });

  // JSON 解析失败回落

  it('非合法 JSON 的 { 开头值 → 字符串', () => {
    expect(parseValue('{bad')).toBe('{bad');
  });

  it('非合法 JSON 的 [ 开头值 → 字符串', () => {
    expect(parseValue('[bad')).toBe('[bad');
  });

  it('{ 开头但 JSON 语法错 → 字符串', () => {
    expect(parseValue('{"a"}')).toBe('{"a"}');
  });

  // 边界

  it('空字符串 → 字符串', () => {
    expect(parseValue('')).toBe('');
  });

  it('空白字符串 → 字符串', () => {
    expect(parseValue('  ')).toBe('  ');
  });

  it('数字字符串（非纯数字）→ 字符串', () => {
    expect(parseValue('123abc')).toBe('123abc');
  });

  it('带引号的数字 → 字符串', () => {
    expect(parseValue('"42"')).toBe('"42"');
  });
});
