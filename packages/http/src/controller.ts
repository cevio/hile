import { HTTPMethod } from 'find-my-way';
import { Context, Middleware } from 'koa';
export type ControllerFunction<R> = (ctx: Context) => R | Promise<R>;
export interface ControllerRegisterProps<R> {
  id: number;
  method: HTTPMethod;
  middlewares: Middleware[];
  data: Record<string, any>;
}

let _id = 1;

/**
 * 定义路由控制器
 * @param method 请求方法
 * @param middlewares 中间件，可以是中间件数组或控制器函数
 * @param fn 控制器函数
 * @returns 路由控制器注册信息
 */
export function defineController<R>(
  method: HTTPMethod,
  middlewares: Middleware[] | ControllerFunction<R>,
  fn?: ControllerFunction<R>
): ControllerRegisterProps<R> {
  let _middlewares: Middleware[] = [];
  let _fn: ControllerFunction<R> | undefined = undefined;
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
    if (result !== undefined) {
      ctx.body = result;
    }
  });

  return {
    id,
    method,
    middlewares: _middlewares,
    data: {},
  }
}