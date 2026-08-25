import { randomUUID } from 'node:crypto';
import { createExecutionContext } from '@hile/context';
import { defineController } from "@hile/http";
import { loadModel } from "@hile/model";
import postModel from "../models/post/post.model";

export default defineController("GET", async (ctx) => loadModel(postModel, { url: ctx.url }, {
  context: createExecutionContext({ requestId: randomUUID() }),
  signal: new AbortController().signal,
}));
