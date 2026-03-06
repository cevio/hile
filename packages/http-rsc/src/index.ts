import compose from 'koa-compose';
import { defineResponsePlugin } from '@hile/http';
import { type Middleware } from 'koa';
import { createRSCPlugin } from './html-render';
import { createWebpackMiddleware } from './webpack-middleware';

declare module 'koa' {
  interface DefaultContext {
    rsc: boolean;
  }
}

export function createRSCMiddleware(options: {
  prefix?: string;
} = {}): Middleware {
  const isDev = process.env.NODE_ENV === 'development';
  const prefix = options.prefix || '/~';

  // 创建响应插件
  defineResponsePlugin(createRSCPlugin({
    title: 'React Server Component',
    scripts: [
      '/bundle.js'
    ]
  }));

  const FlightMiddleware: Middleware = async (ctx, next) => {
    // 过滤非请求路径或非 GET/HEAD 请求
    if (!ctx.path.startsWith(prefix) || !(['GET', 'HEAD'].includes(ctx.method))) {
      return await next();
    }
    const url = new URL(`${ctx.protocol}://${ctx.host}${ctx.url.substring(prefix.length)}`);
    ctx.url = url.pathname + url.search + url.hash;
    ctx.rsc = true;
    await next();
  }

  // 创建中间件
  const middlewares: Middleware[] = [FlightMiddleware];

  // 开发环境才启用 webpack 中间件
  if (isDev) {
    middlewares.push(createWebpackMiddleware());
  }

  // 组合中间件
  return compose(middlewares);
}