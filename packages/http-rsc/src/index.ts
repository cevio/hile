import compose from 'koa-compose';
import { createRequire } from 'node:module';
import { defineResponsePlugin } from '@hile/http';
import { type Middleware } from 'koa';
import { createRSCPlugin } from './html-render';
import { createWebpackMiddleware } from './webpack-middleware';

declare module 'koa' {
  interface DefaultContext {
    rsc: boolean;
  }
}

export interface RSCMiddlewareOptions {
  /** RSC 请求的路径前缀，默认 '/~' */
  prefix?: string;
  /** HTML 页面标题 */
  title?: string;
  /** 额外的脚本 URL */
  scripts?: string[];
  /** 额外的样式 URL */
  styles?: string[];
  /** 额外的 link 标签 */
  links?: string[];
  /** 客户端组件目录（用于 webpack 配置） */
  clientComponentsDir?: string;
}

let rscNodeRegisterInstalled = false;

function installRSCNodeRegister() {
  if (rscNodeRegisterInstalled) return;
  const require = createRequire(import.meta.url);
  require('react-server-dom-webpack/node-register');
  rscNodeRegisterInstalled = true;
}

export function createRSCMiddleware(options: RSCMiddlewareOptions = {}): Middleware {
  const isDev = process.env.NODE_ENV === 'development';
  const prefix = options.prefix || '/~';

  // 确保 Node 端能够处理 client component 的 css/less 导入
  installRSCNodeRegister();

  // 创建响应插件
  defineResponsePlugin(createRSCPlugin({
    title: options.title || 'React Server Component',
    scripts: ['/bundle.js', ...(options.scripts || [])],
    styles: options.styles,
    links: options.links,
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
    middlewares.push(createWebpackMiddleware({
      clientComponentsDir: options.clientComponentsDir,
    }));
  }

  // 组合中间件
  return compose(middlewares);
}

export { createRSCPlugin } from './html-render';
export { createWebpackMiddleware } from './webpack-middleware';