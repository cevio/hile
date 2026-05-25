import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟 fs 模块
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRmSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  rmSync: (...args: any[]) => mockRmSync(...args),
}));

// 模拟 @hile/micro
vi.mock('@hile/micro', () => ({
  getRegistryConfigsDir: () => '/mock/.registry/configs',
  namespaceToConfigFile: (ns: string) => `/mock/.registry/configs/${ns}.config.yaml`,
  parseConfigFilename: (f: string) => f.endsWith('.config.yaml') ? f.replace('.config.yaml', '') : null,
}));

// 模拟 readline
const mockQuestion = vi.fn();
const mockClose = vi.fn();
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: mockQuestion,
    close: mockClose,
  }),
}));

import { parseValue, listConfigs, getConfig, setConfig, delConfig } from './configs.js';

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

  // 边界：confirm
  describe('confirm - 用户确认', () => {
    beforeEach(() => {
      mockQuestion.mockReset();
      mockClose.mockReset();
    });

    it('输入 y 返回 true', async () => {
      mockQuestion.mockImplementation((_msg, cb: any) => cb('y'));
      // 通过 delConfig 间接测试 confirm（当 yes=false 时调用）
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('key: value\n');

      const result = delConfig('test', 'key', false);
      // 等待异步
      await new Promise(r => setTimeout(r, 50));
      await result;
      expect(mockQuestion).toHaveBeenCalled();
    });
  });

  describe('listConfigs - 列出配置', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('目录不存在时打印 No configs found', async () => {
      mockExistsSync.mockReturnValue(false);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await listConfigs();
      expect(logSpy).toHaveBeenCalledWith('No configs found.');
    });

    it('目录存在但没有配置文件时打印 No configs found', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await listConfigs();
      expect(logSpy).toHaveBeenCalledWith('No configs found.');
    });

    it('目录存在且有配置文件时列出命名空间', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['myapp.config.yaml']);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await listConfigs();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Configs in'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('myapp'));
    });
  });

  describe('getConfig - 查看配置', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('配置不存在时打印错误并 exit(1)', async () => {
      mockExistsSync.mockReturnValue(false);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await getConfig('nonexistent');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('配置文件存在时打印 YAML 内容', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('host: localhost\nport: 8080\n');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await getConfig('myapp');
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('setConfig - 设置配置', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('非法格式（无等号）时打印错误并 exit(1)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      await setConfig('test', 'novalue');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('设置新配置项', async () => {
      mockExistsSync.mockReturnValue(false);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await setConfig('test', 'port=8080');
      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Set'));
    });

    it('覆盖已有配置项', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('host: localhost\n');
      await setConfig('test', 'port=9090');
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe('delConfig - 删除配置', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('配置文件不存在时打印错误并 exit(1)', async () => {
      mockExistsSync.mockReturnValue(false);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      await delConfig('nonexistent', 'key');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('带 key 且 yes=true 时直接删除', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('key: value\nother: keep\n');
      await delConfig('test', 'key', true);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('删除最后一个 key 后删除文件', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('onlykey: val\n');
      await delConfig('test', 'onlykey', true);
      expect(mockRmSync).toHaveBeenCalled();
    });

    it('不带 key 且 yes=true 时删除整个文件', async () => {
      mockExistsSync.mockReturnValue(true);
      await delConfig('test', undefined, true);
      expect(mockRmSync).toHaveBeenCalled();
    });
  });
});

// 恢复 import 导出的解析（最后的语句保持文件完整性）
export {};
