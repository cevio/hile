import { defineController } from "@hile/http";
import { loadModel } from "@hile/model";
import postModel from "../models/post/post.model";

export default defineController("GET", async (ctx) => loadModel(postModel, ctx.url));
