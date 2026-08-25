import { type ServiceRegisterProps, defineService, loadService } from '@hile/core';
import {
  createInvocationContext,
  type InvocationContext,
} from '@hile/context';
import {
  Pipeline,
  PipelineContext,
  type PipelineMiddleware,
} from './pipeline';

const modelFlag = Symbol.for('@hile/model');
const actionModelFlag = Symbol.for('@hile/model/action');

/** `defineModel` 返回值上的标记类型 */
export type ModelFlag = typeof modelFlag;
export type ActionModelFlag = typeof actionModelFlag;

/** model 可用的 pipeline 中间件列表（默认可跨 model 复用） */
export type ModelPipeline = readonly PipelineMiddleware[];

/** 从 `ServiceRegisterProps` 推断 `loadService` 后的实例类型 */
export type InferServiceResult<S> =
  S extends ServiceRegisterProps<infer R> ? R : never;

/** `services` 元组 → `main` 首参元组（顺序与 `services` 一致） */
export type InferredServices<S extends readonly ServiceRegisterProps<any>[]> = {
  readonly [K in keyof S]: InferServiceResult<S[K]>;
};

/** `defineModel` 入参；`services` 可选；业务入参为对象 `input` */
export type ModelProps<
  S extends readonly ServiceRegisterProps<any>[] | undefined = undefined,
  TInput extends object = Record<string, unknown>,
  R = unknown,
> = {
  services?: S;
  pipelines?: ModelPipeline;
  main: S extends readonly ServiceRegisterProps<any>[]
  ? (services: InferredServices<S>, input: TInput, invocation: InvocationContext) => R | Promise<R>
  : (input: TInput, invocation: InvocationContext) => R | Promise<R>;
};

/**
 * `defineModel` 的统一返回值；仅应由 {@link defineModel} 构造。
 *
 * 对外统一通过 `loadModel(model, input, invocation)` 调用。
 */
export type ModelDefinition<
  TInput extends object = Record<string, unknown>,
  R = unknown,
> = {
  readonly flag: ModelFlag;
  readonly handler: (input: TInput, invocation: InvocationContext) => Promise<R>;
};

/** A normal model explicitly marked as safe to mount through an action adapter. */
export type ActionModelDefinition<
  TInput extends object = Record<string, unknown>,
  R = unknown,
> = ModelDefinition<TInput, R> & {
  readonly actionFlag: ActionModelFlag;
};

/**
 * 使用给定参数执行 `model.handler(input, invocation)`，并以 Promise 返回其结果
 *（`handler` 内同步抛错也会变为 reject）。
 */
export function loadModel<TInput extends object, R>(
  model: ModelDefinition<TInput, R>,
  input: TInput,
  invocation: InvocationContext,
): Promise<R> {
  if (!isModel(model)) {
    return Promise.reject(
      new TypeError('loadModel: first argument must be a return value of defineModel'),
    );
  }
  try {
    return model.handler(
      input,
      createInvocationContext(invocation?.context, invocation?.signal, 'model invocation'),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

/** 判断值是否为 {@link defineModel} 的返回值 */
export function isModel(value: unknown): value is ModelDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ModelDefinition).flag === modelFlag &&
    typeof (value as ModelDefinition).handler === 'function'
  );
}

export function isActionModel(value: unknown): value is ActionModelDefinition {
  return isModel(value) && (value as ActionModelDefinition).actionFlag === actionModelFlag;
}

/**
 * Defines a model that may be discovered by action adapters.
 * It remains a regular ModelDefinition and is always executed with loadModel().
 */
export function defineActionModel<TInput extends object, R>(
  main: (input: TInput, invocation: InvocationContext) => R | Promise<R>,
): ActionModelDefinition<TInput, R>;
export function defineActionModel<
  const S extends readonly ServiceRegisterProps<any>[] | undefined = undefined,
  TInput extends object = Record<string, unknown>,
  R = unknown,
>(options: ModelProps<S, TInput, R>): ActionModelDefinition<TInput, R>;
export function defineActionModel<
  const S extends readonly ServiceRegisterProps<any>[] | undefined = undefined,
  TInput extends object = Record<string, unknown>,
  R = unknown,
>(
  optionsOrMain: ModelProps<S, TInput, R> | ((input: TInput, invocation: InvocationContext) => R | Promise<R>),
): ActionModelDefinition<TInput, R> {
  const model = typeof optionsOrMain === 'function'
    ? defineModel(optionsOrMain)
    : defineModel(optionsOrMain);
  return Object.assign(model, { actionFlag: actionModelFlag as ActionModelFlag });
}

/** 无 services / pipelines 时可直接传入 main：`defineModel(async (input, invocation) => ...)` */
export function defineModel<TInput extends object, R>(
  main: (input: TInput, invocation: InvocationContext) => R | Promise<R>,
): ModelDefinition<TInput, R>;
/** `defineModel({ services?: [A, B], pipelines?: [PA, PB], async main(services?, input, invocation) { ... } })` */
export function defineModel<
  const S extends readonly ServiceRegisterProps<any>[] | undefined = undefined,
  TInput extends object = Record<string, unknown>,
  R = unknown,
>(options: ModelProps<S, TInput, R>): ModelDefinition<TInput, R>;
export function defineModel<
  const S extends readonly ServiceRegisterProps<any>[] | undefined = undefined,
  TInput extends object = Record<string, unknown>,
  R = unknown,
>(
  optionsOrMain: ModelProps<S, TInput, R> | ((input: TInput, invocation: InvocationContext) => R | Promise<R>),
): ModelDefinition<TInput, R> {
  if (typeof optionsOrMain === 'function') {
    return defineModel<undefined, TInput, R>({ main: optionsOrMain });
  }
  const { services, pipelines, main } = optionsOrMain;

  const invokeMain = async (input: TInput, invocation: InvocationContext): Promise<R> => {
    if (services !== undefined) {
      const loaded = await Promise.all(services.map((service) => loadService(service)));
      return Promise.resolve(
        (main as (services: InferredServices<NonNullable<S>>, input: TInput, invocation: InvocationContext) => R | Promise<R>)(
          loaded as InferredServices<NonNullable<S>>,
          input,
          invocation,
        ),
      );
    }
    return Promise.resolve((main as (input: TInput, invocation: InvocationContext) => R | Promise<R>)(input, invocation));
  };

  const handler = async (input: TInput, invocation: InvocationContext): Promise<R> => {
    if (pipelines !== undefined && pipelines.length > 0) {
      const ctx = new PipelineContext<TInput>(input, invocation);
      const chain = new Pipeline<TInput>();
      for (const middleware of pipelines) {
        chain.use(middleware as PipelineMiddleware<TInput>);
      }
      chain.use(async (ctx) => {
        ctx.state.result = await invokeMain(ctx.args, ctx.invocation);
      });
      await chain.dispatch(ctx);
      return ctx.state.result as R;
    }
    return invokeMain(input, invocation);
  };

  return { flag: modelFlag, handler };
}
