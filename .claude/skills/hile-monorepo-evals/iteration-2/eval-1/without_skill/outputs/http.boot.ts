import { defineService } from '@hile/core';
import { Http } from '@hile/http';

export default defineService('http', async (shutdown) => {
  const http = new Http({ port: 4000 });

  await http.load('./src/controllers', {
    suffix: 'controller',
    defaultSuffix: '/index',
  });

  const close = await http.listen();
  shutdown(close);

  console.log(`+ http://127.0.0.1:${http.port}`);

  return http;
});
