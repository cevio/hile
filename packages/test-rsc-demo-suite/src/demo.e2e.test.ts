import { expect, test } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

test.describe.serial('Registry-driven single HTTP RSC topology', () => {
  test('lets a reviewer exercise every MCP surface from the existing Host page', async ({ page }) => {
    await page.goto('/');
    const workbench = page.getByTestId('mcp-workbench');
    await expect(workbench).toBeVisible();

    await workbench.getByRole('button', { name: 'Discover capabilities' }).click();
    await expect(workbench.getByTestId('mcp-tools')).toContainText('catalog.search_products');
    await expect(workbench.getByTestId('mcp-tools')).toContainText('orders.confirm_order');

    await workbench.getByRole('button', { name: 'Search twice' }).click();
    await expect(workbench.getByTestId('mcp-instance-history')).toContainText(/4211 → 4214|4214 → 4211/);
    await expect(workbench.getByTestId('mcp-progress')).toHaveAttribute('aria-valuenow', '100');
    await expect(workbench.getByTestId('mcp-log')).toContainText('Complete');

    await workbench.getByRole('button', { name: 'Complete arguments' }).click();
    await expect(workbench.getByTestId('mcp-completions')).toContainText('p-100');
    await expect(workbench.getByTestId('mcp-completions')).toContainText('home office');

    await workbench.getByRole('button', { name: 'Subscribe & mutate' }).click();
    await expect(workbench.getByTestId('mcp-resource-update')).toContainText('demo://catalog/products/p-100');

    await workbench.getByRole('button', { name: 'Toggle live provider' }).click();
    await expect(workbench.getByTestId('mcp-tools')).toContainText('labs.ping');
    await expect(workbench.getByTestId('mcp-catalog-events')).not.toHaveText('0');
    await workbench.getByRole('button', { name: 'Toggle live provider' }).click();
    await expect(workbench.getByTestId('mcp-tools')).not.toContainText('labs.ping');

    await workbench.getByRole('button', { name: 'Inspect OAuth' }).click();
    await expect(workbench.getByTestId('mcp-oauth-proof')).toContainText('401 Bearer');
    await expect(workbench.getByTestId('mcp-oauth-proof')).toContainText('auth.demo.invalid');
    await expect(workbench.getByTestId('mcp-metadata-proof')).toContainText('private · 15000ms');

    await workbench.getByRole('button', { name: 'Read resources' }).click();
    await expect(workbench.getByTestId('mcp-output')).toContainText('Standing Desk');
    await workbench.getByRole('button', { name: 'Generate prompt' }).click();
    await expect(workbench.getByTestId('mcp-output')).toContainText('home office');
    await workbench.getByRole('button', { name: 'Create order' }).click();
    await expect(workbench.getByTestId('mcp-output')).toContainText('order-p-100-2');

    page.once('dialog', dialog => dialog.accept());
    await workbench.getByRole('button', { name: 'Confirm order' }).click();
    await expect(workbench.getByTestId('mcp-output')).toContainText('confirmed');
  });

  test('exposes distributed MCP capabilities through the existing Host', async () => {
    const client = new Client({ name: 'test-rsc-demo-suite', version: '1.0.0' }, {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { confirmed: true } }));
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3200/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer demo-mcp-token', Origin: 'http://127.0.0.1:3200' } },
    }));
    try {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
        'catalog.search_products',
        'catalog.touch_product',
        'orders.confirm_order',
        'orders.create_order',
        'orders.toggle_labs',
      ]);
      expect((await client.listResources()).resources.map(({ uri }) => uri)).toContain('demo://catalog/about');
      expect((await client.listResourceTemplates()).resourceTemplates.map(({ uriTemplate }) => uriTemplate))
        .toContain('demo://catalog/products/{id}');
      expect((await client.listPrompts()).prompts.map(({ name }) => name)).toContain('catalog.recommend_products');
      expect(await client.complete({
        ref: { type: 'ref/resource', uri: 'demo://catalog/products/{id}' },
        argument: { name: 'id', value: 'p-1' },
      })).toEqual(expect.objectContaining({ completion: { values: ['p-100', 'p-101', 'p-102'], total: 3, hasMore: false } }));
      const progress: number[] = [];
      const instances = new Set<string>();
      for (let index = 0; index < 2; index++) {
        const search = await client.callTool({
          name: 'catalog.search_products', arguments: { query: 'desk', limit: 2 },
        }, { onprogress: ({ progress: value }) => progress.push(value) });
        expect(search.structuredContent).toEqual(expect.objectContaining({ count: 2 }));
        instances.add((search.structuredContent as { instance: string }).instance);
      }
      expect(instances).toEqual(new Set(['4211', '4214']));
      expect(progress).toContain(1);
      expect(await client.callTool({ name: 'orders.confirm_order', arguments: { order_id: 'order-demo' } }))
        .toEqual(expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining('confirmed') })] }));
    } finally {
      await client.close();
    }
  });

  test('automatically discovers the selected build and hydrates its client graph', async ({ page, request }) => {
    const deployments = await request.get('/api/demo/deployments');
    expect(deployments.status()).toBe(200);
    const lifecycle = await deployments.json() as {
      snapshot: Array<{ pluginId: string; buildId: string; state: string }>;
      discovery: Array<{ pluginId: string; buildId: string; state: string }>;
    };
    expect(lifecycle.discovery).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'demo.rsc.capabilities', buildId: expect.stringMatching(/^v2(?:-|$)/), state: 'enabled' }),
      expect.objectContaining({ pluginId: 'demo.rsc.isolation', buildId: expect.stringMatching(/^isolation-v1(?:-|$)/), state: 'enabled' }),
    ]));
    expect(lifecycle.snapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'demo.rsc.capabilities', buildId: expect.stringMatching(/^v2(?:-|$)/), state: 'active' }),
      expect.objectContaining({ pluginId: 'demo.rsc.isolation', buildId: expect.stringMatching(/^isolation-v1(?:-|$)/), state: 'active' }),
    ]));

    const raw = await request.get('/plugins/demo.rsc.capabilities?label=raw-ssr');
    expect(raw.status()).toBe(200);
    expect(await raw.text()).toContain('Capabilities plugin · build v2');

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto('/plugins/demo.rsc.capabilities?label=registry-selected');
    await expect(page.getByTestId('host-application-shell')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Capability matrix' }))
      .toHaveAttribute('href', '/plugins/demo.rsc.capabilities');
    await expect(page.getByRole('link', { name: 'Isolation lab' }))
      .toHaveAttribute('href', '/plugins/demo.rsc.isolation');
    await expect(page.getByTestId('host-plugin-content')).toContainText('Capabilities plugin');
    await expect(page.getByTestId('host-application-shell')).toHaveClass(/ant-layout/);
    await expect(page.getByTestId('plugin-capabilities')).toHaveAttribute('data-build', 'v2');
    await expect(page.getByTestId('server-query')).toContainText('registry-selected');
    await expect(page.getByTestId('v2-hydration')).toHaveText('hydrated-v2');
    await page.getByTestId('invoke-v2-action').click();
    await expect(page.getByTestId('v2-action-result')).toHaveText('v2:110');
    await page.getByTestId('open-v2-modal').click();
    await expect(page.getByRole('dialog')).toContainText('Client Component modal');
    await page.getByRole('button', { name: 'Close demonstration' }).click();
    await page.getByRole('tab', { name: 'Component matrix' }).click();
    await expect(page.getByTestId('component-matrix')).toContainText('Server Component');
    expect(consoleErrors).toEqual([]);
  });

  test('navigates from a remote plugin through the Host router without replacing the document', async ({ page }) => {
    const flightRequests: Array<{
      url: string;
      headers: Record<string, string>;
    }> = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.searchParams.has('_rsc')) {
        flightRequests.push({ url: request.url(), headers: request.headers() });
      }
    });

    await page.goto('/plugins/demo.rsc.capabilities?label=navigation-source');
    const token = await page.evaluate(() => {
      const value = crypto.randomUUID();
      const browser = globalThis as typeof globalThis & {
        __hileDocumentToken?: string;
        __hileBeforeUnload?: boolean;
      };
      browser.__hileDocumentToken = value;
      browser.__hileBeforeUnload = false;
      addEventListener('beforeunload', () => { browser.__hileBeforeUnload = true; });
      return value;
    });

    flightRequests.length = 0;
    await page.getByTestId('remote-rsc-navigation').click();
    await expect(page).toHaveURL(/\/plugins\/demo\.rsc\.capabilities\/details\?source=remote-link$/);
    await expect(page.getByTestId('plugin-details')).toContainText('Server-only details route · v2');
    await expect.poll(() => flightRequests.find(({ url }) =>
      new URL(url).pathname === '/plugins/demo.rsc.capabilities/details'))
      .toEqual(expect.objectContaining({
        headers: expect.objectContaining({
          rsc: '1',
          'next-router-state-tree': expect.any(String),
        }),
      }));
    expect(await page.evaluate(() => {
      const browser = globalThis as typeof globalThis & {
        __hileDocumentToken?: string;
        __hileBeforeUnload?: boolean;
      };
      return { token: browser.__hileDocumentToken, unloaded: browser.__hileBeforeUnload };
    })).toEqual({ token, unloaded: false });
  });

  test('isolates another automatically discovered plugin under the same public origin', async ({ page }) => {
    await page.goto('/plugins/demo.rsc.isolation?marker=independent');
    await expect(page.getByTestId('plugin-isolation')).toHaveAttribute('data-build', 'isolation-v1');
    await expect(page.getByTestId('isolation-value')).toHaveText('independent');
    await page.getByLabel('Independent client state').selectText();
    await page.getByLabel('Independent client state').pressSequentially('changed-only-here');
    await expect(page.getByTestId('isolation-value')).toHaveText('changed-only-here');
    await expect(page.getByLabel('Independent client state')).toHaveClass(/ant-input/);
    const border = await page.getByTestId('plugin-isolation').evaluate((element) =>
      getComputedStyle(element).borderTopColor);
    expect(border).toBe('rgb(194, 65, 12)');
  });

  test('recovers a remote client boundary after a transient manifest failure', async ({ page }) => {
    let allowManifest = false;
    let failures = 0;
    await page.route('**/_hile/rsc/assets/demo.rsc.capabilities/*/plugin.json', async (route) => {
      if (!allowManifest) {
        failures++;
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'temporary failure' });
      } else {
        await route.continue();
      }
    });
    await page.goto('/plugins/demo.rsc.capabilities?label=retry-boundary');
    const fallbacks = page.locator('[data-demo-rsc-error]');
    await expect(fallbacks).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      await expect(fallbacks.nth(index)).toHaveAttribute('data-plugin-id', 'demo.rsc.capabilities');
      await expect(fallbacks.nth(index)).toHaveAttribute('data-demo-rsc-error', /#/);
    }
    allowManifest = true;
    await fallbacks.first().getByRole('button', { name: 'Retry' }).click();
    await expect(fallbacks).toHaveCount(1);
    await fallbacks.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('v2-hydration')).toHaveText('hydrated-v2');
    await expect(page.getByTestId('remote-rsc-navigation')).toBeVisible();
    await expect(fallbacks).toHaveCount(0);
    expect(failures).toBeGreaterThan(0);
  });

  test('removes the manual lifecycle mutation endpoint', async ({ request }) => {
    const response = await request.post('/api/demo/deployments', {
      data: { operation: 'activate', pluginId: 'demo.rsc.capabilities', buildId: 'v1' },
    });
    expect(response.status()).toBe(405);
  });

  test('never exposes server artifacts through the public asset endpoint', async ({ request }) => {
    const lifecycle = await request.get('/api/demo/deployments').then((response) => response.json()) as {
      snapshot: Array<{ pluginId: string; buildId: string }>;
    };
    const buildId = lifecycle.snapshot.find(({ pluginId }) => pluginId === 'demo.rsc.capabilities')?.buildId;
    expect(buildId).toBeTruthy();
    const manifest = await request.get(`/_hile/rsc/assets/demo.rsc.capabilities/${encodeURIComponent(buildId!)}/plugin.json`);
    expect(manifest.status()).toBe(200);
    const publicManifest = await manifest.json() as Record<string, unknown>;
    expect(publicManifest.server).toBeUndefined();
    expect(JSON.stringify(publicManifest)).not.toContain('ssrModule');
    const server = await request.get(`/_hile/rsc/assets/demo.rsc.capabilities/${encodeURIComponent(buildId!)}/file/server-rsc/index.js`);
    expect(server.status()).toBe(404);
  });
});
