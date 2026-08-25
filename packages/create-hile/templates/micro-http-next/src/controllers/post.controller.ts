import { randomUUID } from 'node:crypto';
import { createExecutionContext } from '@hile/context';
import { defineController } from "@hile/http";
import { loadModel } from "@hile/model";
import postModel from "../models/post/post.model";
import { loadService } from "@hile/core";
import appService from "../services/app.boot";

export default defineController("GET", async (ctx) => {
  const context = createExecutionContext({ requestId: randomUUID() });
  const invocation = { context, signal: new AbortController().signal };
  const app = await loadService(appService);
  const data = await app.call(
    process.env.MICRO_NAMESPACE ?? 'com.zlooks.micro-next',
    'ping',
    {},
    { context },
  );
  const x = await loadModel(postModel, { url: ctx.url }, invocation);
  return {
    ...x,
    ping: data,
  }
});
