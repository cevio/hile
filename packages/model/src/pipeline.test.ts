import { describe, it, expect } from "vitest";
import { Pipeline, PipelineContext } from "./pipeline";

describe("Pipeline", () => {
  it("executes middleware in order", async () => {
    const order: number[] = [];
    const p = new Pipeline<{ value: number }>();

    p.use(async (ctx, next) => {
      order.push(1);
      await next();
      order.push(4);
    });
    p.use(async (ctx, next) => {
      order.push(2);
      await next();
      order.push(3);
    });
    p.use(async (ctx) => {
      order.push(5);
      ctx.state.result = ctx.args.value;
    });

    const ctx = new PipelineContext({ value: 42 });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe(42);
    expect(order).toEqual([1, 2, 5, 3, 4]);
  });

  it("passes context through the chain", async () => {
    const p = new Pipeline<{ msg: string }>();

    p.use(async (ctx, next) => {
      ctx.args.msg += " > middleware1";
      await next();
    });
    p.use(async (ctx, next) => {
      ctx.args.msg += " > middleware2";
      await next();
    });
    p.use(async (ctx) => {
      ctx.state.result = ctx.args.msg;
    });

    const ctx = new PipelineContext({ msg: "start" });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe("start > middleware1 > middleware2");
  });

  it("allows middleware to short-circuit", async () => {
    const p = new Pipeline<{ value: string }>();
    let executed = false;

    p.use(async (ctx, _next) => {
      ctx.state.result = "short-circuited";
    });
    p.use(async (ctx, _next) => {
      executed = true;
      ctx.state.result = "should not reach";
    });

    const ctx = new PipelineContext({ value: "input" });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe("short-circuited");
    expect(executed).toBe(false);
  });

  it("rejects if next() is called multiple times", async () => {
    const p = new Pipeline<{ value: string }>();

    p.use(async (ctx, next) => {
      await next();
      await expect(next()).rejects.toThrow("next() called multiple times");
      ctx.state.result = "done";
    });
    p.use(async (ctx) => {
      ctx.state.result = ctx.args.value;
    });

    const ctx = new PipelineContext({ value: "ok" });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe("done");
  });

  it("rejects if the last middleware calls next()", async () => {
    const p = new Pipeline<{ value: string }>();

    p.use(async (_ctx, next) => next());

    const ctx = new PipelineContext({ value: "x" });
    await expect(p.dispatch(ctx)).rejects.toThrow("last middleware called next");
  });

  it("rejects if no middleware registered", async () => {
    const p = new Pipeline<{ value: string }>();

    const ctx = new PipelineContext({ value: "x" });
    await expect(p.dispatch(ctx)).rejects.toThrow("no middleware registered");
  });

  it("rejects on sync throw in middleware", async () => {
    const p = new Pipeline<{ value: string }>();

    p.use(() => {
      throw new Error("sync error");
    });

    const ctx = new PipelineContext({ value: "x" });
    await expect(p.dispatch(ctx)).rejects.toThrow("sync error");
  });

  it("rejects on async throw in middleware", async () => {
    const p = new Pipeline<{ value: string }>();

    p.use(async () => {
      throw new Error("async error");
    });

    const ctx = new PipelineContext({ value: "x" });
    await expect(p.dispatch(ctx)).rejects.toThrow("async error");
  });

  it("supports concurrent dispatch calls", async () => {
    const p = new Pipeline<{ id: number }>();

    p.use(async (_ctx, next) => next());
    p.use(async (ctx) => {
      ctx.state.result = ctx.args.id;
    });

    const ctx1 = new PipelineContext({ id: 1 });
    const ctx2 = new PipelineContext({ id: 2 });
    const ctx3 = new PipelineContext({ id: 3 });
    await Promise.all([p.dispatch(ctx1), p.dispatch(ctx2), p.dispatch(ctx3)]);
    expect(ctx1.state.result).toBe(1);
    expect(ctx2.state.result).toBe(2);
    expect(ctx3.state.result).toBe(3);
  });

  it("allows middleware to modify result from downstream", async () => {
    const p = new Pipeline<{ n: number }>();

    p.use(async (ctx, next) => {
      await next();
      ctx.state.result = (ctx.state.result as number) * 2;
    });
    p.use(async (ctx) => {
      ctx.state.result = ctx.args.n + 1;
    });

    const ctx = new PipelineContext({ n: 3 });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe(8);
  });

  it("works with single terminal middleware", async () => {
    const p = new Pipeline<{ value: string }>();

    p.use(async (ctx) => {
      ctx.state.result = ctx.args.value;
    });

    const ctx = new PipelineContext({ value: "ok" });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe("ok");
  });

  it("composes multiple middleware correctly", async () => {
    const log: string[] = [];
    const p = new Pipeline<{ n: number }>();

    p.use(async (_ctx, next) => {
      log.push("A:enter");
      await next();
      log.push("A:exit");
    });
    p.use(async (_ctx, next) => {
      log.push("B:enter");
      await next();
      log.push("B:exit");
    });
    p.use(async (ctx) => {
      log.push("terminal");
      ctx.state.result = ctx.args.n * 10;
    });

    const ctx = new PipelineContext({ n: 3 });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe(30);
    expect(log).toEqual(["A:enter", "B:enter", "terminal", "B:exit", "A:exit"]);
  });

  it("downstream layers can read ctx.state.result after next()", async () => {
    const p = new Pipeline<{ id: number }>();

    p.use(async (ctx, next) => {
      await next();
      expect(ctx.state.result).toBe(2);
      ctx.state.result = (ctx.state.result as number) + 10;
    });
    p.use(async (ctx) => {
      ctx.state.result = ctx.args.id + 1;
    });

    const ctx = new PipelineContext({ id: 1 });
    await p.dispatch(ctx);
    expect(ctx.state.result).toBe(12);
  });
});
