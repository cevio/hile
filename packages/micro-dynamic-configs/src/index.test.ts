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

    it('推送 change:key 事件', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const listener = vi.fn();
      server.on('change:name', listener);
      await server.save({ name: 'hello' });
      expect(listener).toHaveBeenCalledWith('hello', '');
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
      teardown();
      server.emit('change:x', 1, 0);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('subscribe / unsubscribe / disconnect', () => {
    function getHandler(path: string) {
      const entry = app.register.mock.calls.find((c: any) => c[0] === path);
      return entry ? entry[1] : null;
    }

    it('subscribe 注册客户端并返回当前值', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const handler = getHandler('/-/dynamic-configs/subscribe');
      expect(handler).not.toBeNull();
      const client = { host: '10.0.0.1', port: 50001 };
      const result = await handler({ data: ['name', 'port'], client });
      expect(result).toEqual({ name: '', port: 8080 });
    });

    it('subscribe 不存在的字段返回空', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const handler = getHandler('/-/dynamic-configs/subscribe');
      const client = { host: '10.0.0.1', port: 50001 };
      const result = await handler({ data: ['nonexistent'], client });
      expect(result).toEqual({});
    });

    it('unsubscribe 移除客户端', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const sub = getHandler('/-/dynamic-configs/subscribe');
      const unsub = getHandler('/-/dynamic-configs/unsubscribe');
      const client = { host: '10.0.0.1', port: 50001 };
      await sub({ data: ['name'], client });
      const result = await unsub({ data: ['name'], client });
      expect(typeof result).toBe('number');
    });

    it('onClientDisconnect 清理所有 stacks', async () => {
      const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'test' });
      await server.initialize();
      const handler = getHandler('/-/dynamic-configs/subscribe');
      const client = { host: '10.0.0.1', port: 50001 };
      await handler({ data: ['name', 'port'], client });
      // 模拟断连
      app.events.emit('disconnect', client);
      // 再次 subscribe 同一客户端 → 重新注册，返回当前值
      const result = await handler({ data: ['name'], client });
      expect(result).toEqual({ name: '' });
    });
  });
});

// -------------------------------------------------------------------
// Client
// -------------------------------------------------------------------
import { MicroDynamicConfigClients, DynamicConfigClient } from './client.js';

function createMockClient(requestResult?: any) {
  const events = new EventEmitter();
  const allData = requestResult ?? { name: 'mock', port: 8080 };
  return {
    host: '10.0.0.2',
    port: 60001,
    request: vi.fn().mockImplementation((url: string, data?: any) => {
      // 模拟服务端行为：subscribe 只返回被请求的字段
      if (url === '/-/dynamic-configs/subscribe' && Array.isArray(data)) {
        const filtered: any = {};
        for (const key of data) {
          if (key in allData) filtered[key] = allData[key];
        }
        return { response: vi.fn().mockResolvedValue(filtered) };
      }
      return { response: vi.fn().mockResolvedValue(allData) };
    }),
    events,
    dispose: vi.fn(),
  };
}

function createMockAppForClient() {
  return {
    get: vi.fn(),
    register: vi.fn(),
  } as any;
}

describe('DynamicConfigClient', () => {
  it('getValue 返回缓存值', async () => {
    const mockClient = createMockClient({ name: 'cached', port: 3000 });
    const app = createMockAppForClient();
    app.get.mockResolvedValue(mockClient);
    const mgr = new MicroDynamicConfigClients(app);
    const value = await mgr.subscribe<{ name: string; port: number }>('ns', ['name', 'port']);
    expect(value).toEqual({ name: 'cached', port: 3000 });
  });

  it('close 后 getValue reject', async () => {
    const app = createMockAppForClient();
    const mgr = new MicroDynamicConfigClients(app);
    const client = new DynamicConfigClient(mgr, 'test-ns', []);
    await client.close();
    await expect(client.getValue()).rejects.toThrow('Client is closed');
  });

  it('setValue 更新已订阅字段，跳过未订阅字段', async () => {
    const mockClient = createMockClient({ a: 1, b: 2 });
    const app = createMockAppForClient();
    app.get.mockResolvedValue(mockClient);
    const mgr = new MicroDynamicConfigClients(app);
    // 先 subscribe，fields=['a'] → 服务端只返回 { a: 1 }
    await mgr.subscribe<{ a: number; b: number }>('ns', ['a']);
    const raw = (mgr as any).clients.get('ns') as DynamicConfigClient<{ a: number; b: number }>;
    // b 不在 fields 中，setValue 不生效
    raw.setValue('b', 20);
    raw.setValue('a', 10);
    const value = await raw.getValue();
    expect(value.a).toBe(10);
    // b 未被写入（setValue 过滤），初始 subscribe 也未请求 b
    expect((value as any).b).toBeUndefined();
  });

  it('close 后 pending subscribe 不会复活 client', async () => {
    const mockClient = createMockClient({ name: 'revived' });
    const app = createMockAppForClient();
    let resolveGet!: (c: any) => void;
    app.get.mockReturnValue(new Promise(resolve => { resolveGet = resolve; }));
    const mgr = new MicroDynamicConfigClients(app);
    const promise = mgr.subscribe('ns', ['name']);
    // subscribe 还在 pending，此时 close
    await mgr.close();
    // 让 subscribe 完成
    resolveGet(mockClient);
    await promise.catch(() => {});
    // close 后 clients map 已被 clear，再次 subscribe 应创建新 client
    app.get.mockResolvedValue(createMockClient({ name: 'fresh' }));
    const value = await mgr.subscribe('ns', ['name']);
    expect(value).toEqual({ name: 'fresh' });
  });
});

describe('MicroDynamicConfigClients', () => {
  it('subscribe 返回 DynamicConfigClient 的值', async () => {
    const mockClient = createMockClient({ key: 'val' });
    const app = createMockAppForClient();
    app.get.mockResolvedValue(mockClient);
    const mgr = new MicroDynamicConfigClients(app);
    const value = await mgr.subscribe('ns', ['key']);
    expect(value).toEqual({ key: 'val' });
  });

  it('register 被调用注册 change handler', () => {
    const app = createMockAppForClient();
    new MicroDynamicConfigClients(app);
    expect(app.register).toHaveBeenCalledWith(
      '/-/dynamic-configs/change',
      expect.any(Function),
    );
  });
});
