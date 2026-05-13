import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import { Server } from 'node:http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const __messages = resolve(__dirname, '../messages');

export default defineService('micro.app', async (shutdown) => {
  const port = process.env.HTTP_PORT
    ? parseInt(process.env.HTTP_PORT)
    : 3000;
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

  app.setPort(port);
  shutdown(await app.listen());
  shutdown(await app.load(__messages));

  return {
    app,
    attachServer: (server: Server) => {
      server.on('upgrade', (req, socket, head) => {
        // 排除 Next.js 的 WebSocket 路径（如 HMR: /_next/webpack-hmr），
        // 让 Next.js 自己处理这些连接
        if (req.url?.startsWith('/_next')) {
          return;
        }
        app.handleUpgrade(req, socket, head);
      });
    }
  }
})