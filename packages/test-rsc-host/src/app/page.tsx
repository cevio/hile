import DeploymentControls from './deployment-controls';
import { getDemoHostComposition } from '../services/runtime-reference';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const runtime = getDemoHostComposition();
  const snapshot = runtime.deployments.snapshot();
  return (
    <main>
      <p className="host-badge">One public HTTP endpoint · port 3200</p>
      <h1>Private Hile RSC demo suite</h1>
      <p>
        The Host owns Next, HTML, Flight decoding, browser assets and actions. Every plugin owns an independently
        compiled RSC artifact and an internal Hile microservice only.
      </p>
      <div className="host-card-grid">
        <article className="host-card">
          <h2>Capabilities v1/v2</h2>
          <p>Server Components, full client hydration, CSS, lazy chunks, actions and live build switching.</p>
          <a href="/plugins/demo.rsc.capabilities?label=from-overview&count=3">Open active build</a>
        </article>
        <article className="host-card">
          <h2>Isolation plugin</h2>
          <p>A separate identity, namespace, server graph, client graph, CSS and browser state.</p>
          <a href="/plugins/demo.rsc.isolation?marker=isolated-from-overview">Open isolated plugin</a>
        </article>
      </div>
      <DeploymentControls initial={snapshot} mode={runtime.lifecycle.mode} />
    </main>
  );
}
