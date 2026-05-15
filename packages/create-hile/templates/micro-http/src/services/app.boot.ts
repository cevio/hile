import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import { Server } from 'node:http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { detect } from 'detect-port';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const __messages = resolve(__dirname, '../messages');

export default defineService(process.env.MICRO_NAMESPACE!, async (shutdown) => {
  const app = new Application({
    namespace: process.env.MICRO_NAMESPACE!,
    registry: {
      host: process.env.REGISTRY_HOST!,
      port: Number(process.env.REGISTRY_PORT!),
    },
    ...(process.env.HILE_ADVERTISE_HOST
      ? { advertiseHost: process.env.HILE_ADVERTISE_HOST }
      : {}),
  });

  const micro_port = await detect();
  shutdown(await app.listen(micro_port));
  shutdown(await app.load(__messages));

  console.log(`+ micro://127.0.0.1:${micro_port}`);

  return app;
})