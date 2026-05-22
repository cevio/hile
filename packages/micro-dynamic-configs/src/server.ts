import { Application } from "@hile/micro";
import { isDeepStrictEqual } from "node:util";
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import { Redis } from "ioredis";
import { EventEmitter } from 'node:events';

export class MicroDynamicConfigsServer<T extends Application, Z extends ZodObject<ZodRawShape>> extends EventEmitter {
  private _value: z.infer<Z>;

  private readonly app: T;
  private readonly schema: Z;
  private readonly redis: Redis;
  private readonly redis_key: string;
  private readonly publishers = new Map<string, {
    update: (payload: unknown) => Promise<any>;
    unpublish: () => Promise<any>;
  }>();
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
  }

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
    const keys = Object.keys(this.schema.shape);
    for (const key of keys) {
      const publisher = await this.app.publish(`${this.app.namespace}:${key}`, this._value[key]);
      this.publishers.set(key, publisher);
    }
    return async () => {
      for (const publisher of this.publishers.values()) {
        await publisher.unpublish();
      }
      this.publishers.clear();
      this.removeAllListeners();
    }
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
      if (this.publishers.has(key)) {
        await this.publishers.get(key)!.update(newValue);
      }
      this.emit('change:' + key, newValue, oldValue);
    }
    return entries.length;
  }
}