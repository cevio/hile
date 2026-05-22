import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { z } from 'zod';

// -------------------------------------------------------------------
// Server
// -------------------------------------------------------------------
import { MicroDynamicConfigsServer } from './server.js';

function createMockApp() {
  const events = new EventEmitter();
  return {
    namespace: 'test-ns',
    clients: new Map<string, any>(),
    events,
    register: vi.fn(),
    publish: vi.fn().mockResolvedValue({ update: vi.fn(), unpublish: vi.fn() }),
  } as any;
}

function createMockRedis() {
  return {
    exists: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  } as any;
}

/** 所有字段都有默认值，确保 constructor 中 schema.parse({}) 通过 */
function createTestSchema() {
  return z.object({
    name: z.string().default(''),
    port: z.number().default(8080),
    debug: z.boolean().default(false),
  });
}

describe('MicroDynamicConfigsServer', () => {
  let app: any;
  let redis: any;
  let schema: z.ZodObject<any>;

  beforeEach(() => {
    app = createMockApp();
    redis = createMockRedis();
    schema = createTestSchema();
  });

  describe('save()', () => {
    it('空对象返回 0', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const result = await server.save({});
      expect(result).toBe(0);
    });

    it('校验通过后持久化到 Redis', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      await server.save({ name: 'hello', port: 3000 });
      expect(redis.set).toHaveBeenCalledWith(
        'test',
        expect.stringContaining('"name":"hello"'),
      );
      expect(redis.set).toHaveBeenCalledWith(
        'test',
        expect.stringContaining('"port":3000'),
      );
    });

    it('值未变化时跳过写入', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      await server.save({ name: 'hello' });
      redis.set.mockClear();
      const result = await server.save({ name: 'hello' });
      expect(result).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('校验失败时抛出 error，_value 不变', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      await expect(server.save({ port: 'not-a-number' as any })).rejects.toThrow();
      expect(server.value.port).toBe(8080);
    });

    it('多字段中单个字段校验失败不污染 _value', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      await expect(server.save({ name: 'ok', port: 'bad' as any })).rejects.toThrow();
      // name 不应被写入
      expect(server.value.name).toBe('');
      expect(server.value.port).toBe(8080);
    });

    it('未知字段跳过', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const result = await server.save({ unknown: 'x' as any });
      expect(result).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('推送 change:key 事件并注册 publisher', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const listener = vi.fn();
      server.on('change:name', listener);
      await server.save({ name: 'hello' });
      expect(listener).toHaveBeenCalledWith('hello', '');
      // initialize() 中为每个 schema 字段注册了 publisher
      expect(app.publish).toHaveBeenCalledWith('test-ns:name', '');
    });

    it('初始化时为每个字段注册 publisher', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      expect(app.publish).toHaveBeenCalledTimes(3);
      expect(app.publish).toHaveBeenCalledWith('test-ns:name', '');
      expect(app.publish).toHaveBeenCalledWith('test-ns:port', 8080);
      expect(app.publish).toHaveBeenCalledWith('test-ns:debug', false);
    });

    it('值未变化时不下发 publish', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      await server.save({ name: 'hello' });
      app.publish.mockClear();
      await server.save({ name: 'hello' });
      expect(app.publish).not.toHaveBeenCalled();
    });

    it('deep diff 检测嵌套变化', async () => {
      const nestedSchema = z.object({
        config: z.object({ host: z.string(), port: z.number() }).default({ host: 'localhost', port: 1234 }),
      });
      const server = new MicroDynamicConfigsServer({ app, redis, redis_key: 'test', schema: nestedSchema });
      await server.initialize();
      await server.save({ config: { host: 'example.com', port: 8080 } });
      expect(redis.set).toHaveBeenCalledOnce();
      redis.set.mockClear();
      // 相同值再次写入
      const result = await server.save({ config: { host: 'example.com', port: 8080 } });
      expect(result).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('Redis 写入失败时 throw，_value 不变', async () => {
      redis.set.mockRejectedValue(new Error('Redis unavailable'));
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      await expect(server.save({ name: 'hello' })).rejects.toThrow('Redis unavailable');
      expect(server.value.name).toBe('');
    });
  });

  describe('initialize()', () => {
    it('从 Redis 加载持久化数据', async () => {
      redis.exists.mockResolvedValue(1);
      redis.get.mockResolvedValue(JSON.stringify({ name: 'from-redis', port: 9090 }));
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      expect(server.value.name).toBe('from-redis');
      expect(server.value.port).toBe(9090);
    });

    it('Redis 无数据时使用 schema 默认值', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      expect(server.value.port).toBe(8080);
      expect(server.value.debug).toBe(false);
    });

    it('teardown 清理监听器', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const listener = vi.fn();
      server.on('change:x', listener);
      const teardown = await server.initialize();
      await teardown();
      server.emit('change:x', 1, 0);
      expect(listener).not.toHaveBeenCalled();
    });
  });

});

