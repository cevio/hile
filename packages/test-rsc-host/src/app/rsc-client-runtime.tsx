'use client';

import { RscClientRuntimeProvider } from '@hile/rsc/client';
import { RscNextClientRuntime } from '@hile/rsc-next/client';
import type { ReactNode } from 'react';

export default function DemoRscClientRuntime({
  assetMountPath,
  children,
}: {
  assetMountPath: string;
  children: ReactNode;
}) {
  return (
    <RscNextClientRuntime serverFunctions={{ headers: { 'x-rsc-demo-token': 'demo-token' } }}>
      <RscClientRuntimeProvider
        assetMountPath={assetMountPath}
        renderLoading={({ referenceId }) => (
          <span data-demo-rsc-loading={referenceId}>Loading plugin component…</span>
        )}
        renderError={(_error, identity, retry) => (
          <section
            role="alert"
            data-demo-rsc-error={identity.referenceId}
            data-plugin-id={identity.pluginId}
            data-build-id={identity.buildId}
          >
            <p>This plugin component could not be loaded.</p>
            <button type="button" onClick={retry}>Retry</button>
          </section>
        )}
      >
        {children}
      </RscClientRuntimeProvider>
    </RscNextClientRuntime>
  );
}
