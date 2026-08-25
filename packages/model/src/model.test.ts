import { describe, it, expect } from 'vitest';
import { defineService } from '@hile/core';
import {
  createExecutionContext,
  MissingExecutionContextError,
  type InvocationContext,
} from '@hile/context';
import { type PipelineMiddleware } from './pipeline';
import { defineModel, isModel, loadModel, type ModelDefinition } from './model';

const A = defineService('test.a', async () => ({ a: 1 }));
const B = defineService('test.b', async () => ({ b: 2 }));
const PA: PipelineMiddleware = async (_ctx, next) => next();
const PB: PipelineMiddleware = async (_ctx, next) => next();
const invocation: InvocationContext = {
  context: createExecutionContext({ requestId: 'model-test' }),
  signal: new AbortController().signal,
};

describe('defineModel', () => {
  it('passes the explicit invocation context to pipelines and main', async () => {
    const seen: unknown[] = [];
    const m = defineModel({
      pipelines: [
        async (ctx, next) => {
          seen.push(ctx.invocation);
          await next();
        },
      ],
      async main(_input: Record<string, never>, currentInvocation) {
        seen.push(currentInvocation);
        return currentInvocation.context.values.requestId;
      },
    });

    await expect(loadModel(m, {}, invocation)).resolves.toBe('model-test');
    expect(seen).toEqual([invocation, invocation]);
  });

  it('handler 可调用（services + pipelines + main）', async () => {
    const m = defineModel({
      services: [A, B],
      pipelines: [PA, PB],
      async main([a, b], input: { id: number }) {
        return { a, b, id: input.id };
      },
    });
    expect(typeof m.handler).toBe('function');
    expect(m.flag).toBe(Symbol.for('@hile/model'));
    expect(isModel(m)).toBe(true);
    const result = await m.handler({ id: 42 }, invocation);
    expect(result).toEqual({ a: { a: 1 }, b: { b: 2 }, id: 42 });
  });

  it('无 services：pipelines + main', async () => {
    const m = defineModel({
      pipelines: [PA, PB],
      async main(input: { id: number }) {
        return input.id;
      },
    });
    await expect(m.handler({ id: 7 }, invocation)).resolves.toBe(7);
  });

  it('无 services、无 pipelines：仅 main', async () => {
    const m = defineModel({
      async main(input: { id: number }) {
        return input.id;
      },
    });
    await expect(m.handler({ id: 3 }, invocation)).resolves.toBe(3);
  });

  it('无 services、无 pipelines：函数简写', async () => {
    const m = defineModel(async (input: { id: number }) => input.id);
    expect(isModel(m)).toBe(true);
    await expect(m.handler({ id: 3 }, invocation)).resolves.toBe(3);
    await expect(loadModel(m, { id: 9 }, invocation)).resolves.toBe(9);
  });

  it('services + main（无 pipelines）', async () => {
    const m = defineModel({
      services: [A],
      async main([a], input: { id: number }) {
        return { a, id: input.id };
      },
    });
    await expect(m.handler({ id: 1 }, invocation)).resolves.toEqual({ a: { a: 1 }, id: 1 });
  });

  it('返回值符合 ModelDefinition', () => {
    const m: ModelDefinition<{ id: number }, { a: { a: number }; id: number }> = defineModel({
      services: [A],
      async main([a], input: { id: number }) {
        return { a, id: input.id };
      },
    });
    expect(isModel(m)).toBe(true);
  });

  it('isModel 拒绝非 defineModel 对象', () => {
    expect(isModel(null)).toBe(false);
    expect(isModel({ handler: async () => ({}) })).toBe(false);
  });

  it('pipeline 可改写 ctx.args', async () => {
    const m = defineModel({
      pipelines: [
        async (ctx, next) => {
          Object.assign(ctx.args, { id: 99 });
          await next();
        },
      ],
      async main(input: { id: number }) {
        return input.id;
      },
    });
    await expect(m.handler({ id: 1 }, invocation)).resolves.toBe(99);
  });

  it('pipeline middleware 可短路并返回 ctx.state.result', async () => {
    let mainCalled = false;
    const m = defineModel({
      pipelines: [
        async (ctx) => {
          ctx.state.result = `cached-${ctx.args.id}`;
        },
      ],
      async main(input: { id: number }) {
        mainCalled = true;
        return input.id;
      },
    });

    await expect(m.handler({ id: 1 }, invocation)).resolves.toBe('cached-1');
    expect(mainCalled).toBe(false);
  });

  it('pipeline middleware 可在 main 后改写 ctx.state.result', async () => {
    const m = defineModel({
      pipelines: [
        async (ctx, next) => {
          await next();
          ctx.state.result = (ctx.state.result as number) * 2;
        },
      ],
      async main(input: { id: number }) {
        return input.id + 1;
      },
    });

    await expect(m.handler({ id: 3 }, invocation)).resolves.toBe(8);
  });

  it('pipeline middleware 短路但未写 result 时返回 undefined', async () => {
    let mainCalled = false;
    const m = defineModel({
      pipelines: [
        async () => {
          // intentionally short-circuit without result
        },
      ],
      async main(input: { id: number }) {
        mainCalled = true;
        return input.id;
      },
    });

    await expect(m.handler({ id: 1 }, invocation)).resolves.toBeUndefined();
    expect(mainCalled).toBe(false);
  });

  it('loadModel 调用 handler', async () => {
    const m = defineModel({
      services: [A],
      async main([a], input: { id: number; name: string }) {
        return { a, id: input.id, name: input.name };
      },
    });
    await expect(loadModel(m, { id: 1, name: 'test' }, invocation)).resolves.toEqual({
      a: { a: 1 },
      id: 1,
      name: 'test',
    });
  });

  it('loadModel 非 model 应 reject', async () => {
    await expect(loadModel({ handler: async () => 1 } as never, { id: 1 }, invocation)).rejects.toThrow(
      'loadModel: first argument must be a return value of defineModel',
    );
  });

  it('loadModel fails with a stable error when invocation context is missing', async () => {
    const m = defineModel(async () => true);

    await expect((loadModel as any)(m, {})).rejects.toBeInstanceOf(MissingExecutionContextError);
  });

  it('services: [] 时 main 收到空元组', async () => {
    const m = defineModel({
      services: [],
      async main(services: readonly unknown[], input: { id: number }) {
        expect(services).toEqual([]);
        return input.id;
      },
    });
    await expect(m.handler({ id: 5 }, invocation)).resolves.toBe(5);
  });
});
