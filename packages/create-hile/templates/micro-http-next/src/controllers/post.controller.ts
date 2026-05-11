import { defineController } from "@hile/http";
import { loadModel } from "@hile/http-next";
import postModel from "../models/post/post.model";
import { loadService } from "@hile/core";
import appService from "../services/app.service";

export default defineController("GET", async (ctx) => {
  const { app } = await loadService(appService);
  const micro = await app.get('com.zlooks.micro');
  const { response } = micro.request('/ping', {});
  const data = await response();
  const x = await loadModel(postModel, ctx.url);
  return {
    ...x,
    ping: data,
  }
});
