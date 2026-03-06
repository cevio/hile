import { defineService } from '@hile/core';
import { Http } from '@hile/http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRSCMiddleware } from '@hile/http-rsc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const controllers = resolve(__dirname, 'controllers');

export default defineService(async (shutdown) => {
  const port = Number(process.env.PORT || 3000);
  const http = new Http({ port });
  http.use(createRSCMiddleware());
  const close = await http.listen();
  await http.load(controllers, { conflict: 'warn', suffix: 'controller' });

  console.log(`http://127.0.0.1:${http.port}`);
  shutdown(close);
});
