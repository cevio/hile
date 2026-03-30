import { defineModel } from "@hile/http-next";

export const homeModel = defineModel(async () => ({
  heading: "Hile + Next.js",
  tagline:
    "Koa 文件系统路由与 Next 同端口；业务数据只在 src/models 内 defineModel，页面与控制器直接 loadModel。",
}));
