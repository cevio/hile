import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExecutionContext } from '@hile/context';
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
const metadataResolverStartedKey = Symbol.for('hile.rsc.test.metadata-resolver-started');

afterEach(async () => {
  renderToPipeableStream.mockClear();
  delete (globalThis as unknown as Record<symbol, unknown>)[metadataResolverStartedKey];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'org.example.capabilities',
    buildId: 'v1-dev-session-r2',
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server.mjs', integrity: 'sha256-fixture' },
    serverFunctions: [],
    clients: [],
    styles: [],
    routes: [{ path: '/', entry: 'Page' }],
  };
}

describe('official RSC renderer', () => {
  it('prepares the immutable server module and validates every route before rendering', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-renderer-'));
    roots.push(root);
    await writeFile(path.join(root, 'server.mjs'), 'export function Page() { return null; }\n');
    const renderer = createOfficialRscRenderer(root);
    const value = manifest();
    value.routes.push({ path: '/missing', entry: 'MissingPage' });

    await expect(renderer.prepare({
      manifest: value,
      signal: new AbortController().signal,
    })).rejects.toThrow('MissingPage');
    expect(renderToPipeableStream).not.toHaveBeenCalled();
  });

  it('validates and invokes route metadata exports as data outside the React tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-renderer-'));
    roots.push(root);
    await writeFile(path.join(root, 'server.mjs'), `
      export function Page() { return null; }
      export function PageMetadata(props) {
        return { title: props.params.slug, buildId: props.rsc.buildId };
      }
    `);
    const renderer = createOfficialRscRenderer(root);
    const value = manifest();
    value.routes[0].metadataEntry = 'PageMetadata';

    await expect(renderer.documentMetadata!({
      manifest: value,
      metadataEntry: 'PageMetadata',
      request: {
        buildId: 'v1-dev-session-r2',
        path: '/',
        params: { slug: 'fixture' },
      },
      signal: new AbortController().signal,
      context: createExecutionContext({ requestId: 'metadata-test' }),
    })).resolves.toEqual({ title: 'fixture', buildId: 'v1-dev-session-r2' });
    expect(renderToPipeableStream).not.toHaveBeenCalled();
  });

  it('does not return document metadata that finishes after cancellation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-renderer-'));
    roots.push(root);
    await writeFile(path.join(root, 'server.mjs'), `
      export function Page() { return null; }
      export async function PageMetadata(_props, { signal }) {
        globalThis[Symbol.for('hile.rsc.test.metadata-resolver-started')] = true;
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        }
        return { title: 'stale' };
      }
    `);
    const renderer = createOfficialRscRenderer(root);
    const value = manifest();
    value.routes[0].metadataEntry = 'PageMetadata';
    const controller = new AbortController();
    await renderer.prepare({ manifest: value, signal: controller.signal });
    const pending = renderer.documentMetadata!({
      manifest: value,
      metadataEntry: 'PageMetadata',
      request: { buildId: 'v1-dev-session-r2', path: '/' },
      signal: controller.signal,
      context: createExecutionContext({ requestId: 'metadata-cancellation-test' }),
    });

    await vi.waitFor(() => expect(
      (globalThis as unknown as Record<symbol, unknown>)[metadataResolverStartedKey],
    ).toBe(true));
    controller.abort(new Error('metadata cancelled'));

    await expect(pending).rejects.toThrow('metadata cancelled');
    expect(renderToPipeableStream).not.toHaveBeenCalled();
  });

  it('shares preparation work across concurrent readiness checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-renderer-'));
    roots.push(root);
    await writeFile(path.join(root, 'server.mjs'), 'export function Page() { return null; }\n');
    const renderer = createOfficialRscRenderer(root);
    const value = manifest();

    await Promise.all([
      renderer.prepare({ manifest: value, signal: new AbortController().signal }),
      renderer.prepare({ manifest: value, signal: new AbortController().signal }),
    ]);

    expect(renderToPipeableStream).not.toHaveBeenCalled();
  });

  it('retains one readiness result for repeated checks of the immutable renderer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-renderer-'));
    roots.push(root);
    await writeFile(path.join(root, 'server.mjs'), 'export function Page() { return null; }\n');
    const renderer = createOfficialRscRenderer(root);
    const value = manifest();
    const routes = value.routes;
    let routeReads = 0;
    Object.defineProperty(value, 'routes', {
      get() {
        routeReads++;
        return routes;
      },
    });

    await renderer.prepare({ manifest: value, signal: new AbortController().signal });
    await renderer.prepare({ manifest: value, signal: new AbortController().signal });

    expect(routeReads).toBe(1);
  });

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
