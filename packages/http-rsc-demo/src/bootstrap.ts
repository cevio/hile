import { loadService, container } from '@hile/core';

async function main() {

  // loader 注册完成后再加载 service，确保 controller import client 组件时可被正确代理。
  const { default: service } = await import('./index.boot.js');
  await loadService(service);

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
