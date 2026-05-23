export type PipelineMiddleware<TInput extends object = Record<string, unknown>> = (
  ctx: PipelineContext<TInput>,
  next: () => Promise<void>,
) => Promise<void>;

export class PipelineContext<TInput extends object = Record<string, unknown>> {
  public state: Record<string, unknown> = {};
  public readonly args: TInput;

  constructor(args: TInput) {
    this.args = args;
  }
}

export class Pipeline<TInput extends object = Record<string, unknown>> {
  private fns: PipelineMiddleware<TInput>[] = [];

  public use(fn: PipelineMiddleware<TInput>): void {
    this.fns.push(fn);
  }

  /** 与 Koa compose 一致：只驱动中间件链，不返回值；结果由中间件写入 `ctx.state` */
  public dispatch(ctx: PipelineContext<TInput>): Promise<void> {
    const fns = this.fns;
    if (fns.length === 0) {
      return Promise.reject(new Error("pipeline: no middleware registered"));
    }

    let index = -1;

    const run = async (i: number): Promise<void> => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      const fn = fns[i];
      if (!fn) throw new Error("pipeline: last middleware called next(), it should be terminal");
      await fn(ctx, () => run(i + 1));
    };

    return run(0);
  }
}
