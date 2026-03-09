import { defineController } from "@hile/http";
export default defineController("GET", async (ctx) => {
  return {
    id: 1,
    title: "Hile Http Next Demo",
    url: ctx.url,
    content:
      "基于 Koa + find-my-way 的 HTTP 服务框架，支持中间件、路由注册与文件系统自动路由加载。",
  };
});
