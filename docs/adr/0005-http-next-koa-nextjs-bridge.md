# ADR-0005: `@hile/http-next` Koa ↔ Next.js 桥接架构

## 背景

`@hile/http` 提供了基于 Koa + find-my-way 的 HTTP 服务框架，具有中间件、文件系统路由等能力。当项目需要 SSR/RSC 渲染时，需要引入 Next.js。此时面临两个选择：独立运行两个服务，或将 Next.js 嵌入现有 Koa 服务。

独立运行的问题：

- 需要两个端口（或额外反向代理），部署与开发体验均变差
- API 路由与页面路由在不同进程，无法共享中间件和上下文
- 端口管理和进程编排增加运维成本

## 决策

创建 `@hile/http-next` 作为桥接层，将 Next.js 作为渲染引擎嵌入 Koa 服务，共享同一 HTTP Server。核心设计如下：

### 1. 共享 httpServer

通过 `NextServer({ httpServer: server })` 将 Koa 创建的 HTTP Server 传递给 Next.js，使两者监听同一端口。

### 2. 请求分流策略

采用"Koa 路由优先、Next.js 兜底"的分流模型：

```
Request → koa-static(public) → koa-static(.next/static) → hile-http 路由(/-*) → Next.js handler
```

- `koa-static`：优先命中静态资源
- `hile-http` 控制器路由：匹配 `/-` 前缀的 API 请求
- Next.js handler：作为最后一个中间件，处理所有未匹配的请求（页面渲染、404 等）

### 3. 控制器路由强制 `/-` 前缀

所有 `*.controller.ts` 文件系统路由统一挂载到 `/-` 前缀下，从路径层面彻底避免与 Next.js App Router 文件路由冲突。

### 4. Next.js 转发中间件

当请求落入 Next.js handler 时：
- 设置 `ctx.respond = false`，Koa 不再写响应
- 设置 `ctx.status = 200`，覆盖 Koa 默认 404
- 调用 `nextRequestHandler(ctx.req, ctx.res)`，由 Next.js 直接操作原生 `req/res`

### 5. 启动时序

```
constructor → 注册 public 静态资源
start()     → 注册 .next/static → http.listen() → NextServer.prepare() → 挂载 Next handler → load controllers
```

控制器在 Next.js prepare 之后加载，确保 Next.js handler 已就绪（503 保护机制）。

### 6. 脚手架 `create-hile-http-next`

提供 `npx create-hile-http-next create <name>` 命令，从内置模板复制项目结构并替换 `package.json` 的 `name` 字段，降低新项目的搭建门槛。

## 影响

正向：

- 单端口、单进程，开发与部署体验统一
- API 路由与页面路由可共享 Koa 中间件（日志、鉴权等）
- `/-` 前缀从路径层面隔离冲突，无需运行时判断
- 脚手架使新项目创建降到一条命令

代价：

- Next.js 与 Koa 共享进程，一方异常可能影响另一方
- `ctx.respond = false` 绕过了 Koa 响应处理，Next.js 渲染的请求无法使用 Koa 响应中间件（如响应时间头）
- `/-` 前缀是硬约束，API 路径不如独立服务灵活
- 开发模式下 Next.js HMR WebSocket 与 Koa 共用 server，需确保无端口冲突

## 约束与实践规则

1. 控制器文件必须使用 `*.controller.ts` 后缀，放在 `src/app/` 目录下。
2. 控制器路由前缀固定为 `/-`，禁止修改。
3. Next.js 页面文件（`page.tsx`、`layout.tsx` 等）与控制器文件在同一目录下共存，互不影响。
4. 项目需维护两份 tsconfig：`tsconfig.json`（Node.js 编译）与 `tsconfig.next.json`（Next.js 编译），通过 `next.config` 的 `typescript.tsconfigPath` 指定。
5. `start()` 只应调用一次。

## 备选方案

1. **Koa 与 Next.js 独立部署，通过反向代理分流**
   - 优点：进程隔离，互不影响。
   - 缺点：需要额外反向代理配置，双端口管理，无法共享中间件。

2. **放弃 Koa，全部使用 Next.js Route Handlers**
   - 优点：技术栈统一，无需桥接。
   - 缺点：失去 `@hile/http` 的文件系统路由、中间件体系与响应插件能力。

3. **使用 Next.js Custom Server（Express/Koa）官方模式**
   - 优点：官方支持。
   - 缺点：官方建议仅在"无法使用内置路由"时采用，且需自行处理路由分流。当前方案本质与此一致，但增加了 `/-` 前缀隔离与自动控制器加载。
