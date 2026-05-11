import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import detectPort from 'detect-port';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const __messages = resolve(__dirname, '../messages');

export default defineService('micro.app', async (shutdown) => {
  const port = await detectPort();
  const app = new Application({
    namespace: process.env.MICRO_NAMESPACE!,
    registry: {
      host: process.env.REGISTRY_HOST!,
      port: Number(process.env.REGISTRY_PORT!),
    }
  });

  shutdown(await app.listen(port));
  shutdown(await app.load(__messages));

  console.log('Microservice is running on port', port);

  return app;
})