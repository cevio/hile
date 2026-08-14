import { getHttpNextRequestSignal } from '@hile/http-next';
import { decodePluginFlight } from '@hile/rsc-next';
import { RscHostRuntime } from '@hile/rsc/host/runtime';
import { notFound } from 'next/navigation';
import DemoRscClientRuntime from '../../../rsc-client-runtime';
import { getDemoHostComposition } from '../../../../services/runtime-reference';

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
  const composition = getDemoHostComposition();
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
    timeout: Number(process.env.RSC_RENDER_TIMEOUT_MS ?? 30_000),
    idleTimeout: Number(process.env.RSC_RENDER_IDLE_TIMEOUT_MS ?? 10_000),
    window: Number(process.env.RSC_RENDER_WINDOW ?? 8),
  });

  return (
    <main className="host-plugin-frame" data-rsc-host data-plugin-id={pluginId} data-build-id={active.buildId}>
      <p className="host-badge">Host frame · active {active.buildId}</p>
      <DemoRscClientRuntime assetMountPath={composition.assetMountPath}>
        {tree}
      </DemoRscClientRuntime>
    </main>
  );
}
