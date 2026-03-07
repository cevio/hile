import { loadService, container } from '@hile/core';
import Service from './index.boot.js';

async function main() {
  await loadService(Service);

  const shutdown = async () => {
    await container.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('[hile/http-rsc-demo] bootstrap failed', error);
  process.exit(1);
});
