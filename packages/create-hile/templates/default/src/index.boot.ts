import { defineService } from "@hile/core";
import { Http } from "@hile/http";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const __controllers = resolve(__dirname, 'controllers')

export default defineService(async (shutdown) => {
  const http = new Http({
    port: process.env.HTTP_PORT
      ? parseInt(process.env.HTTP_PORT)
      : 3000
  });
  const close = await http.listen()

  shutdown(close)

  await http.load(__controllers, {
    suffix: 'controller',
    conflict: 'warn',
  })

  console.log(`Server is running on port http://localhost:${process.env.HTTP_PORT}`);

  return http
});