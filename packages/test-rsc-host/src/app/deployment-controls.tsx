'use client';

import { useState } from 'react';

type Snapshot = {
  pluginId: string;
  buildId: string;
  namespace: string;
  state: string;
  references: number;
};

export default function DeploymentControls({
  initial,
  mode,
}: {
  initial: Snapshot[];
  mode: 'production' | 'development';
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState('');

  async function operate(operation: string, buildId: string) {
    setError('');
    const response = await fetch('/api/demo/deployments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, pluginId: 'demo.rsc.capabilities', buildId }),
    });
    const body = await response.json() as { snapshot?: Snapshot[]; error?: string };
    if (!response.ok || !body.snapshot) {
      setError(body.error ?? `Lifecycle operation failed: ${response.status}`);
      return;
    }
    setSnapshot(body.snapshot);
  }

  return (
    <section className="host-card" data-testid="deployment-controls">
      <h2>Runtime lifecycle</h2>
      <p>{mode === 'development'
        ? 'Stable controls resolve to each service’s latest development revision while hot reload is active.'
        : 'These operations mutate the deployment catalog without rebuilding or restarting Next.'}</p>
      <div className="host-controls">
        <button type="button" data-testid="install-v2" onClick={() => operate('install', 'v2')}>Install v2</button>
        <button type="button" data-testid="activate-v2" onClick={() => operate('activate', 'v2')}>Activate v2</button>
        <button type="button" data-testid="activate-v1" onClick={() => operate('activate', 'v1')}>Reactivate v1</button>
        <button type="button" data-testid="deactivate-v2" onClick={() => operate('deactivate', 'v2')}>Deactivate v2</button>
        <button type="button" data-testid="remove-v2" onClick={() => operate('remove', 'v2')}>Remove v2</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <pre data-testid="deployment-snapshot">{JSON.stringify(snapshot, null, 2)}</pre>
    </section>
  );
}
