import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineService(async (shutdown) => {
  const httpNext = new HttpNext({
    port: 3000,
    cwd: resolve(__dirname, "..", ".."),
    publicPath: "public",
  });

  shutdown(await httpNext.start());

  return httpNext;
});
