import { randomUUID } from 'node:crypto';
import { createExecutionContext } from '@hile/context';
import { loadService } from '@hile/core';
import { getHttpNextRequestSignal } from '@hile/http-next';
import { RscHostRuntime } from '@hile/rsc/host/runtime';
import { decodePluginFlight } from '@hile/rsc-next';
import { notFound } from 'next/navigation';
import RscHostClientRuntime from '../../../rsc-client-runtime';
import runtimeService from '../../../../services/runtime.boot';

export const dynamic = 'force-dynamic';
const manifestVerificationCache = new Map<string, Promise<void>>();

export default async function PluginPage({
  params,
  searchParams,
}: {
  params: Promise<{ pluginId: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ pluginId, path: segments = [] }, query] = await Promise.all([params, searchParams]);
  const composition = await loadService(runtimeService);
  const active = composition.deployments.getActive(pluginId);
  if (!active) notFound();

  const runtime = new RscHostRuntime({
    locator: composition.locator,
    decoder: { decode: (flight) => decodePluginFlight(flight) },
    verificationCache: manifestVerificationCache,
    observe: (event) => console.info('RSC host render', {
      pluginId: event.pluginId,
      buildId: event.buildId,
      outcome: event.outcome,
      durationMs: Math.round(event.durationMs),
      bytes: event.bytes,
    }),
  });
  const tree = await runtime.render({
    context: createExecutionContext({ requestId: randomUUID() }),
    pluginId,
    request: {
      buildId: active.buildId,
      path: `/${segments.join('/')}`,
      searchParams: Object.fromEntries(
        Object.entries(query).filter((entry): entry is [string, string | string[]] =>
          entry[1] !== undefined),
      ),
    },
    signal: getHttpNextRequestSignal(),
    timeout: Number(process.env.RSC_RENDER_TIMEOUT_MS ?? 30_000),
    idleTimeout: Number(process.env.RSC_RENDER_IDLE_TIMEOUT_MS ?? 10_000),
    window: Number(process.env.RSC_RENDER_WINDOW ?? 8),
  });

  return (
    <RscHostClientRuntime
      assetMountPath={composition.assetMountPath}
      csrfToken={process.env.RSC_CSRF_TOKEN ?? ''}
    >
      {tree}
    </RscHostClientRuntime>
  );
}
