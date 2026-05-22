import { defineController } from "@hile/http";
import { loadModel } from "@hile/http-next";
import postModel from "../models/post/post.model";
import { loadService } from "@hile/core";
import appService from "../services/app.boot";

export default defineController("GET", async (ctx) => {
  const { app } = await loadService(appService);
  const data = await app.call('com.zlooks.micro', 'ping', {});
  const x = await loadModel(postModel, ctx.url);
  return {
    ...x,
    ping: data,
  }
});
