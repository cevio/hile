import { HTTPMethod } from 'find-my-way';
import { Context, Middleware, type Next } from 'koa';
import { ParsedUrlQuery } from 'node:querystring';
import { z, ZodObject, ZodType } from 'zod';

export type ControllerContext<A extends ZodObject, B extends ZodObject, C extends ZodType> = Context & {
  query: z.infer<A>,
  params: z.infer<B>,
  request: Context['request'] & {
    body: z.infer<C>
  }
}
export type ControllerFunction<A extends ZodObject, B extends ZodObject, C extends ZodType> =
  (ctx: ControllerContext<A, B, C>) => unknown | Promise<unknown>;
export interface ControllerRegisterProps {
  id: number;
  method: HTTPMethod;
  middlewares: Middleware[];
  data: Record<string, any>;
}

let _id = 1;
const plugins: ResponsePluginFunction[] = [];

/**
 * 插件构造函数
 * @example
 * const _fn = async (res: any) => 'dhshdfa';
 * const _newResponse: ResponsePluginFunction = async (ctx, res, next) => {
 *  if (res && typeof res.$$typeof === 'symbol' && ctx.url.endsWith('.rsc')) {
 *    const html = await _fn(res);
 *    return await next(html)
 *  }
 *  return await next(res);
 * }
 */
export type ResponsePluginFunction = (ctx: Context, result: any, next: (r: any) => Promise<void>) => Promise<any>;

/**
 * 加入最终结果处理插件
 * @param fn 
 * @returns 
 * @example `defineResponsePlugin(_newResponse);`
 */
export const defineResponsePlugin = (fn: ResponsePluginFunction) => plugins.push(fn);

/**
 * 插件化最终结果处理
 * 使得 HTTP 路由处理完成的结果可以被插件修改
 * @param ctx 
 * @param res 
 * @param last
 * @returns 
 */
function composeResponsePlugin(ctx: Context, res: any, last: (result: any) => Promise<any>) {
  const dispatch = async (i: number, current: any): Promise<any> => {
    if (i === plugins.length) return await last(current);
    const fn = plugins[i];
    if (!fn) return await last(current);
    return await fn(ctx, current, _res => dispatch(i + 1, _res));
  };

  return dispatch(0, res);
}

/** 旧版 `defineController(method, …)` 无 Zod 时的占位 schema（`safeParse` 恒成功） */
const legacyEmptyObject = z.object({});

/**
 * 定义路由控制器
 * @overload 仅 method + handler（无 Zod）
 * @overload method + 前置中间件 + handler
 * @overload 由 `createControllerMetadata` 提供 method / middlewares / schema
 */
export function defineController(
  method: HTTPMethod,
  fn: ControllerFunction<typeof legacyEmptyObject, typeof legacyEmptyObject, typeof legacyEmptyObject>,
): ControllerRegisterProps;
export function defineController(
  method: HTTPMethod,
  middlewares: Middleware[],
  fn: ControllerFunction<typeof legacyEmptyObject, typeof legacyEmptyObject, typeof legacyEmptyObject>,
): ControllerRegisterProps;
export function defineController<A extends ZodObject, B extends ZodObject, C extends ZodType>(
  metadata: ReturnType<typeof createControllerMetadata<A, B, C>>,
  fn: ControllerFunction<A, B, C>,
): ControllerRegisterProps;
export function defineController(
  arg0: HTTPMethod | ReturnType<typeof createControllerMetadata<ZodObject, ZodObject, ZodType>>,
  arg1?: unknown,
  arg2?: unknown,
): ControllerRegisterProps {
  if (typeof arg0 === 'string') {
    const method = arg0;
    if (typeof arg1 === 'function' && arg2 === undefined) {
      return defineControllerWithMetadata(
        createControllerMetadata({
          method,
          middlewares: [],
          schema: {
            query: legacyEmptyObject,
            params: legacyEmptyObject,
            body: legacyEmptyObject,
          },
        }),
        arg1 as ControllerFunction<typeof legacyEmptyObject, typeof legacyEmptyObject, typeof legacyEmptyObject>,
      );
    }
    if (Array.isArray(arg1)) {
      if (typeof arg2 !== 'function') throw new Error('Controller function is required');
      return defineControllerWithMetadata(
        createControllerMetadata({
          method,
          middlewares: arg1,
          schema: {
            query: legacyEmptyObject,
            params: legacyEmptyObject,
            body: legacyEmptyObject,
          },
        }),
        arg2 as ControllerFunction<typeof legacyEmptyObject, typeof legacyEmptyObject, typeof legacyEmptyObject>,
      );
    }
    throw new Error('Middlewares must be an array');
  }
  return defineControllerWithMetadata(
    arg0 as ReturnType<typeof createControllerMetadata<ZodObject, ZodObject, ZodType>>,
    arg1 as ControllerFunction<ZodObject, ZodObject, ZodType>,
  );
}

function defineControllerWithMetadata<A extends ZodObject, B extends ZodObject, C extends ZodType>(
  metadata: ReturnType<typeof createControllerMetadata<A, B, C>>,
  fn: ControllerFunction<A, B, C>,
): ControllerRegisterProps {
  const method = metadata.method;
  const middlewares = (metadata.middlewares || []).slice();
  if (!Array.isArray(middlewares)) throw new Error('Middlewares must be an array');

  const id = _id++;

  middlewares.push(async (ctx: Context, _next: Next) => {
    const schema = metadata.schema;
    /** `z.object({})` 对 `undefined` 会失败；旧版两参/三参 API 用同一套占位 schema，此处跳过校验 */
    const skipZod =
      (schema?.query as unknown) === legacyEmptyObject &&
      (schema?.params as unknown) === legacyEmptyObject &&
      (schema?.body as unknown) === legacyEmptyObject;

    if (!skipZod && schema?.query) {
      const query = schema.query.safeParse(ctx.query);
      if (!query.success) {
        ctx.throw(400, query.error.message);
        return;
      }
      ctx.query = query.data as ParsedUrlQuery;
    }

    if (!skipZod && schema?.params) {
      const params = schema.params.safeParse((ctx as Context & { params?: unknown }).params);
      if (!params.success) {
        ctx.throw(400, params.error.message);
        return;
      }
      (ctx as Context & { params: z.infer<B> }).params = params.data;
    }

    if (!skipZod && schema?.body) {
      const rawBody = (ctx.request as Context['request'] & { body?: unknown }).body;
      const body = schema.body.safeParse(rawBody);
      if (!body.success) {
        ctx.throw(400, body.error.message);
        return;
      }
      (ctx.request as Context['request'] & { body: z.infer<C> }).body = body.data;
    }

    const result = await fn(ctx as ControllerContext<A, B, C>);
    await composeResponsePlugin(ctx, result, async r => {
      if (r !== undefined) {
        ctx.body = r;
      }
    });
  });

  return {
    id,
    method,
    middlewares,
    data: {},
  };
}

export function createControllerMetadata<A extends ZodObject, B extends ZodObject, C extends ZodType>(options: {
  method: HTTPMethod;
  middlewares: Middleware[];
  schema: {
    query?: A;
    params?: B;
    body?: C;
  };
}) {
  return options;
}