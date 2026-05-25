import { defineService } from '@hile/core';
import { Http } from '@hile/http';

export default defineService('http', async (shutdown) => {
  const http = new Http({ port: 4000 });

  http.use(async (ctx, next) => {
    const start = Date.now();
    try {
      await next();
    } finally {
      const ms = Date.now() - start;
      console.log(`${ctx.method} ${ctx.url} ${ms}ms`);
    }
  });

  await http.load('./src/controllers', {
    suffix: 'controller',
    defaultSuffix: '/index',
  });

  const close = await http.listen();
  shutdown(() => close());
});
