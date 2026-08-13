import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import { InMemoryRscDeploymentCatalog } from '@hile/rsc/host';
import { attachRscDeploymentCatalog } from '@hile/rsc/transport';

export default defineService('rsc.catalog.runtime', async (shutdown) => {
  const catalog = new InMemoryRscDeploymentCatalog();
  const application = new Application({
    namespace: process.env.CATALOG_NAMESPACE ?? 'com.hile.rsc.catalog',
    registry: {
      host: process.env.REGISTRY_HOST ?? '127.0.0.1',
      port: Number(process.env.REGISTRY_PORT ?? 9876),
    },
  });
  const detach = attachRscDeploymentCatalog(catalog, application);
  const stop = await application.listen(Number(process.env.CATALOG_MICRO_PORT ?? 4102));
  shutdown(async () => {
    detach();
    await stop();
  });
  return { application, catalog };
});
