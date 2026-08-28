import UpdatePanel from './update-panel';
import { RscLink } from '@hile/rsc/client/navigation';
import type { RscRouteProps } from '@hile/rsc/plugin';

type PluginProps = RscRouteProps;

export async function CapabilitiesPage({ searchParams, rsc }: PluginProps) {
  await Promise.resolve();
  return (
    <article className="capability-v2" data-testid="plugin-capabilities" data-build="v2">
      <header className="capability-v2-header">
        <p className="capability-v2-kicker">REMOTE SERVER COMPONENT · LIVE BUILD</p>
        <h1>Capabilities plugin · build v2</h1>
        <p>
          This heading and request metadata were rendered inside the plugin service. The interactive Ant Design
          workspace below crosses into an independently compiled Client Component graph.
        </p>
        <dl className="capability-v2-metadata">
          <div><dt>Query label</dt><dd data-testid="server-query">{String(searchParams.label ?? 'default-label')}</dd></div>
          <div><dt>Resolved build</dt><dd>{rsc.buildId}</dd></div>
          <div><dt>Transport</dt><dd>React Flight stream</dd></div>
        </dl>
        <RscLink
          data-testid="remote-rsc-navigation"
          href="/plugins/demo.rsc.capabilities/details?source=remote-link"
        >
          Open remote details
        </RscLink>
      </header>
      <UpdatePanel initialValue={10} rsc={rsc} />
    </article>
  );
}

export function DetailsPage({ params, searchParams }: PluginProps) {
  return (
    <article className="capability-v2" data-testid="plugin-details" data-build="v2">
      <h1>Server-only details route · v2</h1>
      <pre>{JSON.stringify({ params, searchParams }, null, 2)}</pre>
    </article>
  );
}

export async function SlowPage() {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return <article className="capability-v2" data-testid="plugin-slow" data-build="v2">Delayed v2 render</article>;
}
