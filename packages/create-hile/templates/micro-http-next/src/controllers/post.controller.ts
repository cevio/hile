import { defineController } from "@hile/http";
import { loadModel } from "@hile/model";
import postModel from "../models/post/post.model";
import { loadService } from "@hile/core";
import appService from "../services/app.boot";

export default defineController("GET", async (ctx) => {
  const app = await loadService(appService);
  const data = await app.call(process.env.MICRO_NAMESPACE ?? 'com.zlooks.micro-next', 'ping', {});
  const x = await loadModel(postModel, { url: ctx.url });
  return {
    ...x,
    ping: data,
  }
});
