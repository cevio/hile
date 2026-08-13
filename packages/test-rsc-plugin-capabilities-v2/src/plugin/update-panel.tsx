'use client';

import { useEffect, useState } from 'react';
import './update.css';

export default function UpdatePanel({
  initialValue,
  rsc,
}: {
  initialValue: number;
  rsc: { pluginId: string; buildId: string };
}) {
  const [hydrated, setHydrated] = useState(false);
  const [result, setResult] = useState('not invoked');
  useEffect(() => setHydrated(true), []);

  async function invokeAction() {
    const response = await fetch(
      `/_hile/rsc/actions/${encodeURIComponent(rsc.pluginId)}/${encodeURIComponent(rsc.buildId)}/increment`,
      {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rsc-demo-token': 'demo-token' },
      body: JSON.stringify({ input: { value: initialValue } }),
      },
    );
    if (!response.ok) throw new Error(`Remote action failed: ${response.status}`);
    const data = await response.json() as { buildId: string; value: number };
    setResult(`${data.buildId}:${data.value}`);
  }

  return (
    <section className="update-panel" data-testid="update-client-panel">
      <p data-testid="v2-hydration">{hydrated ? 'hydrated-v2' : 'server-rendered-v2'}</p>
      <button type="button" data-testid="invoke-v2-action" onClick={invokeAction}>Invoke v2 action</button>
      <output data-testid="v2-action-result">{result}</output>
    </section>
  );
}
