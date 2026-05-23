import { defineModel } from "@hile/model";

export default defineModel(async (url: string) => ({
  id: 1,
  title: "Hile Http Next Demo",
  url,
  content:
    "基于 Koa + find-my-way 的 HTTP 服务框架，支持中间件、路由注册与文件系统自动路由加载。",
}));
