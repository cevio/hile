import { HTTPMethod } from 'find-my-way';
import { Context, Middleware } from 'koa';
export type ControllerFunction = (ctx: Context) => unknown | Promise<unknown>;
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

/**
 * 定义路由控制器
 * @param method 请求方法
 * @param middlewares 中间件，可以是中间件数组或控制器函数
 * @param fn 控制器函数
 * @returns 路由控制器注册信息
 */
export function defineController(
  method: HTTPMethod,
  middlewares: Middleware[] | ControllerFunction,
  fn?: ControllerFunction
): ControllerRegisterProps {
  let _middlewares: Middleware[] = [];
  let _fn: ControllerFunction | undefined = undefined;
  if (typeof middlewares === 'function' && !fn) {
    _fn = middlewares;
    _middlewares = [];
  } else {
    _middlewares = middlewares as Middleware[];
    _fn = fn;
  }
  if (!Array.isArray(_middlewares)) throw new Error('Middlewares must be an array');
  if (!_fn) throw new Error('Controller function is required');

  const id = _id++;

  _middlewares.push(async (ctx) => {
    const result = await _fn(ctx);
    await composeResponsePlugin(ctx, result, async r => {
      if (r !== undefined) {
        ctx.body = result;
      }
    })
  });

  return {
    id,
    method,
    middlewares: _middlewares,
    data: {},
  }
}