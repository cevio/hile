import { defineController } from "@hile/http";
import { loadModel } from "@hile/http-next";
import postModel from "../models/post/post.model";

export default defineController("GET", async (ctx) => loadModel(postModel, ctx.url));
