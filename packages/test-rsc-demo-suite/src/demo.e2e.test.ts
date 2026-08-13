import { expect, test } from '@playwright/test';

test.describe.serial('single HTTP RSC plugin topology', () => {
  test('renders and hydrates a complete remote client graph', async ({ page, request }) => {
    const raw = await request.get('/plugins/demo.rsc.capabilities?label=raw-ssr&count=3');
    expect(raw.status()).toBe(200);
    expect(await raw.text()).toContain('Capabilities plugin · build v1');

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto('/plugins/demo.rsc.capabilities?label=browser-query&count=3');
    await expect(page.getByTestId('plugin-capabilities')).toHaveAttribute('data-build', 'v1');
    await expect(page.getByTestId('server-query')).toContainText('browser-query');
    await expect(page.getByTestId('hydration-state')).toHaveText('hydrated');
    await expect(page.getByTestId('counter-value')).toHaveText('3');
    await page.getByTestId('increment-client').click();
    await expect(page.getByTestId('counter-value')).toHaveText('4');

    const border = await page.getByTestId('plugin-capabilities').evaluate((element) =>
      getComputedStyle(element).borderTopColor);
    expect(border).toBe('rgb(124, 58, 237)');

    await page.getByTestId('load-lazy').click();
    await expect(page.getByTestId('lazy-inspector')).toContainText('v1');
    await page.getByTestId('invoke-action').click();
    await expect(page.getByTestId('action-result')).toHaveText('v1:4:call-1');
    expect(consoleErrors).toEqual([]);
  });

  test('isolates a second plugin under the same public origin', async ({ page }) => {
    await page.goto('/plugins/demo.rsc.isolation?marker=independent');
    await expect(page.getByTestId('plugin-isolation')).toHaveAttribute('data-build', 'isolation-v1');
    await expect(page.getByTestId('isolation-value')).toHaveText('independent');
    await page.getByLabel('Independent client state').fill('changed-only-here');
    await expect(page.getByTestId('isolation-value')).toHaveText('changed-only-here');
    const border = await page.getByTestId('plugin-isolation').evaluate((element) =>
      getComputedStyle(element).borderTopColor);
    expect(border).toBe('rgb(194, 65, 12)');
  });

  test('installs and activates v2 without rebuilding or restarting the Host', async ({ page, request }) => {
    const before = await request.get('/api/demo/deployments');
    const beforeBody = await before.json() as { snapshot: Array<{ buildId: string }> };
    expect(beforeBody.snapshot.some(({ buildId }) => buildId === 'v2')).toBe(false);

    await page.goto('/');
    await page.getByTestId('install-v2').click();
    await expect(page.getByTestId('deployment-snapshot')).toContainText('"buildId": "v2"');
    await page.getByTestId('activate-v2').click();
    await expect(page.getByTestId('deployment-snapshot')).toContainText('"state": "active"');

    await page.goto('/plugins/demo.rsc.capabilities?label=after-upgrade');
    await expect(page.getByTestId('plugin-capabilities')).toHaveAttribute('data-build', 'v2');
    await expect(page.getByTestId('v2-hydration')).toHaveText('hydrated-v2');
    await page.getByTestId('invoke-v2-action').click();
    await expect(page.getByTestId('v2-action-result')).toHaveText('v2:110');

    const snapshot = await request.get('/api/demo/deployments');
    const body = await snapshot.json() as {
      snapshot: Array<{ buildId: string; state: string }>;
    };
    expect(body.snapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ buildId: 'v1', state: 'draining' }),
      expect.objectContaining({ buildId: 'v2', state: 'active' }),
      expect.objectContaining({ buildId: 'isolation-v1', state: 'active' }),
    ]));
  });

  test('supports deactivation, host 404 mapping and reactivation', async ({ page, request }) => {
    const deactivate = await request.post('/api/demo/deployments', {
      data: { operation: 'deactivate', pluginId: 'demo.rsc.capabilities', buildId: 'v2' },
    });
    expect(deactivate.status()).toBe(200);
    const missing = await request.get('/plugins/demo.rsc.capabilities');
    expect(missing.status()).toBe(404);

    const activate = await request.post('/api/demo/deployments', {
      data: { operation: 'activate', pluginId: 'demo.rsc.capabilities', buildId: 'v1' },
    });
    expect(activate.status()).toBe(200);
    await page.goto('/plugins/demo.rsc.capabilities');
    await expect(page.getByTestId('plugin-capabilities')).toHaveAttribute('data-build', 'v1');
  });

  test('never exposes server or SSR artifacts through the public asset endpoint', async ({ request }) => {
    const manifest = await request.get('/_hile/rsc/assets/demo.rsc.capabilities/v1/plugin.json');
    expect(manifest.status()).toBe(200);
    const publicManifest = await manifest.json() as Record<string, unknown>;
    expect(publicManifest.server).toBeUndefined();
    expect(JSON.stringify(publicManifest)).not.toContain('ssrModule');

    const server = await request.get('/_hile/rsc/assets/demo.rsc.capabilities/v1/file/server-rsc/index.js');
    expect(server.status()).toBe(404);
  });
});
