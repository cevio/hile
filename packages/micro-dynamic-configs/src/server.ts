import { Application, Client } from "@hile/micro";
import { isDeepStrictEqual } from "node:util";
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import { Redis } from "ioredis";
import { EventEmitter } from 'node:events';

export class MicroDynamicConfigsServer<T extends Application, Z extends ZodObject<ZodRawShape>> extends EventEmitter {
  private _value: z.infer<Z>;
  private readonly stacks = new Map<string, Set<string>>();
  private readonly app: T;
  private readonly schema: Z;
  private readonly redis: Redis;
  private readonly redis_key: string;
  constructor(
    options: {
      app: T,
      redis: Redis,
      schema: Z,
      redis_key: string,
    },
  ) {
    super();
    this.app = options.app;
    this.schema = options.schema;
    this.redis = options.redis;
    this.redis_key = options.redis_key;
    this._value = this.schema.parse({});
    for (const key of Object.keys(this.schema.shape)) {
      this.stacks.set(key, new Set());
      this.on('change:' + key, (newValue, oldValue) => {
        if (this.stacks.has(key)) {
          const pool = this.stacks.get(key)!;
          for (const client of pool) {
            if (this.app.clients.has(client)) {
              this.app.clients.get(client)!.push('/-/dynamic-configs/change', {
                key, newValue, oldValue,
                namespace: this.app.namespace,
              });
            }
          }
        }
      });
    }
    this.registerSubscribe();
    this.registerUnsubscribe();
    this.app.events.on('disconnect', this.onClientDisconnect);
  }

  private onClientDisconnect = (client: Client) => {
    const key = client.host + ':' + client.port;
    for (const [, pool] of this.stacks) {
      pool.delete(key);
    }
  };

  get value() {
    return this._value;
  }

  public async initialize() {
    if (await this.redis.exists(this.redis_key)) {
      const value = await this.redis.get(this.redis_key);
      if (value) {
        this._value = this.schema.parse(JSON.parse(value));
      }
    }
    return async () => {
      this.removeAllListeners();
      this.app.events.off('disconnect', this.onClientDisconnect);
      this.stacks.clear();
    }
  }

  private registerSubscribe() {
    this.app.register<string[], { client: Client }>('/-/dynamic-configs/subscribe', async ({ data, client }) => {
      const out: Record<string, any> = {};
      for (const key of data) {
        if (this.stacks.has(key)) {
          this.stacks.get(key)!.add(client.host + ':' + client.port);
          out[key] = this._value[key];
        }
      }
      return out;
    });
  }

  private registerUnsubscribe() {
    this.app.register<string[], { client: Client }>('/-/dynamic-configs/unsubscribe', async ({ data, client }) => {
      for (const key of data) {
        if (this.stacks.has(key)) {
          const pool = this.stacks.get(key)!;
          const _key = client.host + ':' + client.port;
          if (pool.has(_key)) {
            pool.delete(_key);
          }
        }
      }
      return Date.now();
    });
  }

  public async save(value: Partial<z.infer<Z>>) {
    const keys = Object.keys(value);
    if (!keys.length) return 0;

    // Pass 1: validate & diff, don't mutate _value yet
    const entries: { key: string; parsed: any; oldValue: any }[] = [];
    for (const key of keys) {
      const _key = key as keyof z.infer<Z>;
      if (!Object.prototype.hasOwnProperty.call(this.schema.shape, _key)) {
        continue;
      }
      const fieldSchema = this.schema.shape[_key as keyof typeof this.schema.shape] as ZodTypeAny;
      const parsed = fieldSchema.parse(value[_key]) as z.infer<Z>[typeof _key];
      const oldValue = this._value[_key];
      if (isDeepStrictEqual(oldValue, parsed)) {
        continue;
      }
      entries.push({ key, parsed, oldValue });
    }

    if (!entries.length) return 0;

    // Pass 2: persist to Redis first, then update memory + emit
    const next = { ...this._value } as any;
    for (const { key, parsed } of entries) next[key] = parsed;
    await this.redis.set(this.redis_key, JSON.stringify(next));
    for (const { key, parsed } of entries) {
      (this._value as any)[key] = parsed;
    }
    for (const { key, parsed: newValue, oldValue } of entries) {
      this.emit('change:' + key, newValue, oldValue);
    }
    return entries.length;
  }
}