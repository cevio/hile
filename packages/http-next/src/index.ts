import NextServer from "next";
import ServerStatic from "koa-static";
import { Http } from "@hile/http";
import { RequestHandler } from "next/dist/server/next";
import type { HttpProps } from "@hile/http";
import type { Middleware } from "koa";
import { resolve } from "node:path";
import type { Server } from "http";

export { defineModel, loadModel, type ModelDefinition } from "./model";

export type HttpNextProps = HttpProps & {
  cwd?: string; // 绑定项目根目录
  publicPath?: string; // 绑定项目静态资源目录
  controllerDirectory?: string; // 控制器目录名称，基于 src 或者 dist 目录 默认 `controllers` 目录
  controllerPrefix?: string; // 控制器前缀 默认 `/-`
  controllerSuffix?: string; // 控制器后缀 默认 `controller`
};

export class HttpNext {
  private readonly http: Http;
  private readonly isDevelopment: boolean;
  private readonly cwd: string;
  private readonly controllerDirectory: string;
  private readonly controllerPrefix: string;
  private readonly controllerSuffix: string;
  constructor(options: HttpNextProps) {
    const { cwd, publicPath, controllerDirectory, controllerPrefix, controllerSuffix, ...httpOptions } = options;
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
    // 绑定项目控制器目录
    this.controllerDirectory = resolve(
      this.cwd,
      this.isDevelopment ? "src" : "dist",
      controllerDirectory || "controllers"
    );
    // 绑定项目控制器前缀
    this.controllerPrefix = controllerPrefix || "/-";
    // 绑定项目控制器后缀
    this.controllerSuffix = controllerSuffix || "controller";
  }

  private createForwardToNextMiddleware(handler: RequestHandler): Middleware {
    return async (ctx) => {
      // 设置 ctx.respond 为 false，表示不响应
      ctx.respond = false;
      // 设置 ctx.status 为 200
      // 原因是 koa 默认状态为 404，而 next 会处理 404 错误
      ctx.status = 200;
      // 调用 next 请求处理函数
      await handler(ctx.req, ctx.res);
    };
  }

  /**
   * 注册中间件
   * @param middleware - 中间件函数
   * @returns - 当前实例
   */
  public use(middleware: Middleware) {
    this.http.use(middleware);
    return this;
  }

  public async start(onListen?: (server: Server) => void | Promise<void>) {
    // 绑定项目静态资源目录到 http 服务
    this.http.use(ServerStatic(resolve(this.cwd, ".next", "static")));
    // 加载项目路由
    await this.http.load(this.controllerDirectory, {
      suffix: this.controllerSuffix,
      defaultSuffix: "/index",
      prefix: this.controllerPrefix,
      conflict: "error",
    });
    // 启动 http 服务
    const stop = await this.http.listen(async (server) => {
      if (onListen) await onListen(server);
      // 创建 next 应用
      const app = NextServer({
        dev: this.isDevelopment,
        webpack: this.isDevelopment,
        httpServer: server,
      });
      // 准备 next 应用
      await app.prepare();
      // 设置 next 请求处理函数
      const handler = app.getRequestHandler();
      // 使用 forwardToNextMiddleware 中间件
      this.http.use(this.createForwardToNextMiddleware(handler));
    });
    return stop;
  }
}

export default HttpNext;
