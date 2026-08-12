import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineService("http.next", async (shutdown) => {
  const port = Number(process.env.HTTP_PORT ?? 3000);
  const httpNext = new HttpNext({
    port,
    // 项目根（含 package.json / next.config），相对本文件在 src/services/
    cwd: resolve(__dirname, "../.."),
  });

  shutdown(await httpNext.start());

  console.log(`+ http://127.0.0.1:${port}`);

  return httpNext;
});
