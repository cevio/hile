import { getHttpNextRequestSignal } from '@hile/http-next';
import { RscClientRuntimeProvider } from '@hile/rsc/client';
import { decodePluginFlight } from '@hile/rsc-next';
import { RscNextClientRuntime } from '@hile/rsc-next/client';
import { RscHostRuntime } from '@hile/rsc/host/runtime';
import { notFound } from 'next/navigation';
import { getDemoHostComposition } from '../../../../services/runtime-reference';

export const dynamic = 'force-dynamic';

export default async function PluginPage({
  params,
  searchParams,
}: {
  params: Promise<{ pluginId: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ pluginId, path: segments = [] }, query] = await Promise.all([params, searchParams]);
  const composition = getDemoHostComposition();
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
      params: { pluginId, path: segments },
      searchParams: Object.fromEntries(
        Object.entries(query).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined),
      ),
    },
    signal: getHttpNextRequestSignal(),
  });

  return (
    <main className="host-plugin-frame" data-rsc-host data-plugin-id={pluginId} data-build-id={active.buildId}>
      <p className="host-badge">Host frame · active {active.buildId}</p>
      <RscNextClientRuntime serverFunctions={{ headers: { 'x-rsc-demo-token': 'demo-token' } }}>
        <RscClientRuntimeProvider assetMountPath={composition.assetMountPath}>
          {tree}
        </RscClientRuntimeProvider>
      </RscNextClientRuntime>
    </main>
  );
}
