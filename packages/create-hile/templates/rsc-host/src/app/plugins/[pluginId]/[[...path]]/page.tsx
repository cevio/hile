import { loadService } from '@hile/core';
import { getHttpNextRequestSignal } from '@hile/http-next';
import { RscClientRuntimeProvider } from '@hile/rsc/client';
import { RscHostRuntime } from '@hile/rsc/host/runtime';
import { decodePluginFlight } from '@hile/rsc-next';
import { notFound } from 'next/navigation';
import runtimeService from '../../../../services/runtime.boot';

export const dynamic = 'force-dynamic';

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
  });
  const tree = await runtime.render({
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
  });

  return (
    <main data-rsc-host>
      <RscClientRuntimeProvider assetMountPath={composition.assetMountPath}>
        {tree}
      </RscClientRuntimeProvider>
    </main>
  );
}
