import { expect, test } from '@playwright/test';

test.describe.serial('Registry-driven single HTTP RSC topology', () => {
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
    const fallback = page.locator('[data-demo-rsc-error]');
    await expect(fallback).toHaveAttribute('data-plugin-id', 'demo.rsc.capabilities');
    await expect(fallback).toHaveAttribute('data-demo-rsc-error', /#/);
    allowManifest = true;
    await fallback.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('v2-hydration')).toHaveText('hydrated-v2');
    await expect(fallback).toHaveCount(0);
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
