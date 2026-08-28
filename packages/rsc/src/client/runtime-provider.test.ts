import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RscClientRuntimeProvider,
  type RscClientRuntimeProviderProps,
  useRscClientRuntime,
} from './runtime-provider';

interface ExtendedRuntimeProviderProps extends RscClientRuntimeProviderProps {
  testMarker?: string;
}

const hostOwnedProps: React.ComponentProps<typeof RscClientRuntimeProvider> = {
  suspensePolicy: 'host',
  children: null,
};
const remoteOwnedProps: React.ComponentProps<typeof RscClientRuntimeProvider> = {
  renderLoading: () => null,
  children: null,
};
const extendedProps: ExtendedRuntimeProviderProps = {
  testMarker: 'compatible',
  children: null,
};
void hostOwnedProps;
void remoteOwnedProps;
void extendedProps;

function RuntimeProbe() {
  const runtime = useRscClientRuntime();
  return React.createElement('span', null, runtime.suspensePolicy);
}

describe('RscClientRuntimeProvider Suspense ownership', () => {
  it('keeps remote boundaries as the backward-compatible default owner', () => {
    const html = renderToStaticMarkup(React.createElement(
      RscClientRuntimeProvider,
      { children: React.createElement(RuntimeProbe) },
    ));

    expect(html).toContain('remote');
  });

  it('lets a Host own the loading boundary', () => {
    const html = renderToStaticMarkup(React.createElement(
      RscClientRuntimeProvider,
      { suspensePolicy: 'host', children: React.createElement(RuntimeProbe) },
    ));

    expect(html).toContain('host');
  });

  it('rejects a local loading renderer when the Host owns Suspense', () => {
    expect(() => renderToStaticMarkup(React.createElement(
      RscClientRuntimeProvider,
      {
        suspensePolicy: 'host',
        renderLoading: () => null,
        children: React.createElement(RuntimeProbe),
      },
    ))).toThrow('renderLoading');
  });

  it('rejects an unknown Suspense policy from untyped consumers', () => {
    expect(() => renderToStaticMarkup(React.createElement(
      RscClientRuntimeProvider,
      {
        suspensePolicy: 'retain',
        children: React.createElement(RuntimeProbe),
      } as unknown as React.ComponentProps<typeof RscClientRuntimeProvider>,
    ))).toThrow('suspensePolicy');
  });
});
