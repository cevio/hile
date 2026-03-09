import NextServer from "next";
import ServerStatic from "koa-static";
import { Http } from "@hile/http";
import { RequestHandler } from "next/dist/server/next";
import type { HttpProps } from "@hile/http";
import type { Middleware } from "koa";
import { resolve } from "node:path";

export type HttpNextProps = HttpProps & {
  cwd?: string; // 绑定项目根目录
  publicPath?: string; // 绑定项目静态资源目录
};

export class HttpNext {
  private readonly http: Http;
  public readonly isDevelopment: boolean;
  // next 请求处理函数
  public nextRequestHandler?: RequestHandler;
  public readonly cwd: string;
  constructor(options: HttpNextProps) {
    const { cwd, publicPath, ...httpOptions } = options;
    this.isDevelopment = process.env.NODE_ENV === "development";
    // 创建 http 服务
    this.http = new Http(httpOptions);
    // 绑定项目根目录
    this.cwd = cwd || process.cwd();
    // 绑定项目静态资源目录
    if (publicPath) {
      // 绑定项目静态资源目录到 http 服务
      this.http.use(ServerStatic(resolve(this.cwd, publicPath)));
    }
  }

  private createForwardToNextMiddleware(): Middleware {
    return async (ctx) => {
      // 如果 next 请求处理函数不存在，则返回 503 错误
      if (!this.nextRequestHandler) {
        return ctx.throw(503, "Next.js not ready");
      }
      // 设置 ctx.respond 为 false，表示不响应
      ctx.respond = false;
      // 设置 ctx.status 为 200
      // 原因是 koa 默认状态为 404，而 next 会处理 404 错误
      ctx.status = 200;
      // 调用 next 请求处理函数
      await this.nextRequestHandler(ctx.req, ctx.res);
    };
  }

  public async start() {
    // 绑定项目静态资源目录到 http 服务
    this.http.use(ServerStatic(resolve(this.cwd, ".next", "static")));
    // 启动 http 服务
    const stop = await this.http.listen(async (server) => {
      // 创建 next 应用
      const app = NextServer({
        dev: this.isDevelopment,
        webpack: this.isDevelopment,
        httpServer: server,
      });
      // 准备 next 应用
      await app.prepare();
      // 设置 next 请求处理函数
      this.nextRequestHandler = app.getRequestHandler();
      // 使用 forwardToNextMiddleware 中间件
      this.http.use(this.createForwardToNextMiddleware());
    });
    // 加载项目路由
    await this.http.load(
      resolve(this.cwd, this.isDevelopment ? "src" : "dist", "app"),
      {
        suffix: "controller",
        defaultSuffix: "/index",
        prefix: "/-", // 基于项目规范，这里hile-http的路由必须强制为/-, 避免与next的路由冲突
        conflict: "warn",
        onConflict: (ctx) => {
          console.warn(
            `[hile/http-next] route conflict: ${ctx.routeKey}, keeping existing route`,
          );
        },
      },
    );
    return stop;
  }
}

export default HttpNext;
