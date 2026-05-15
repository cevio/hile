import { defineService } from "@hile/core";
import { Http } from "@hile/http";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const __controllers = resolve(__dirname, '../controllers')

export default defineService('http', async (shutdown) => {
  const http = new Http({
    port: process.env.HTTP_PORT
      ? parseInt(process.env.HTTP_PORT)
      : 3000
  });
  shutdown(await http.listen());

  await http.load(__controllers, {
    suffix: 'controller',
    conflict: 'warn',
  })

  console.log(`+ http://127.0.0.1:${http.port}`);

  return http
});
