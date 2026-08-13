import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest } from '../protocol';
import { createOfficialRscRenderer } from './official-renderer';

const renderToPipeableStream = vi.hoisted(() => vi.fn((element: { props: unknown }) => ({
  abort: vi.fn(),
  pipe(output: NodeJS.WritableStream) {
    output.end('flight');
  },
})));

vi.mock('react-server-dom-webpack/server.node', () => ({ renderToPipeableStream }));

const roots: string[] = [];

afterEach(async () => {
  renderToPipeableStream.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'org.example.capabilities',
    buildId: 'v1-dev-session-r2',
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server.mjs', integrity: 'sha256-fixture' },
    clients: [],
    styles: [],
    routes: [{ path: '/', entry: 'Page' }],
  };
}

describe('official RSC renderer', () => {
  it('injects the immutable deployment identity into every route component', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-renderer-'));
    roots.push(root);
    await writeFile(path.join(root, 'server.mjs'), 'export function Page() { return null; }\n');
    const renderer = createOfficialRscRenderer(root);
    const controller = new AbortController();
    const output = await renderer({
      manifest: manifest(),
      routeEntry: 'Page',
      request: {
        buildId: 'v1-dev-session-r2',
        path: '/',
        params: { slug: 'fixture' },
        searchParams: { count: '3' },
      },
      signal: controller.signal,
    });

    for await (const _chunk of output) {
      // Consume the stream so renderer cleanup follows the production path.
    }

    expect(renderToPipeableStream).toHaveBeenCalledOnce();
    expect(renderToPipeableStream.mock.calls[0]?.[0].props).toEqual({
      params: { slug: 'fixture' },
      searchParams: { count: '3' },
      rsc: {
        pluginId: 'org.example.capabilities',
        buildId: 'v1-dev-session-r2',
      },
    });
  });
});
