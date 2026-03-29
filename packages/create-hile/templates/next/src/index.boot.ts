import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineService('http.next', async (shutdown) => {
  const port = Number(process.env.HTTP_PORT ?? 3000);
  const httpNext = new HttpNext({
    port,
    cwd: resolve(__dirname, ".."),
    publicPath: "public",
  });

  shutdown(await httpNext.start());

  console.log(`Server is running on port https://127.0.0.1:${port}`);

  return httpNext;
});
