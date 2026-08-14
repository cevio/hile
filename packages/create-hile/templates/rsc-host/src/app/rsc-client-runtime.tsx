'use client';

import { RscClientRuntimeProvider } from '@hile/rsc/client';
import { RscNextClientRuntime } from '@hile/rsc-next/client';
import type { ReactNode } from 'react';

export default function RscHostClientRuntime({
  assetMountPath,
  csrfToken,
  children,
}: {
  assetMountPath: string;
  csrfToken: string;
  children: ReactNode;
}) {
  return (
    <RscNextClientRuntime serverFunctions={{ headers: { 'x-rsc-csrf-token': csrfToken } }}>
      <RscClientRuntimeProvider
        assetMountPath={assetMountPath}
        renderLoading={({ referenceId }) => (
          <span data-hile-rsc-loading={referenceId}>Loading plugin component…</span>
        )}
        renderError={(_error, identity, retry) => (
          <section role="alert" data-hile-rsc-error={identity.referenceId}>
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
