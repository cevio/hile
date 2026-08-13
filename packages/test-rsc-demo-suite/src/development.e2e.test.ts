import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';

const source = path.resolve(import.meta.dirname, '../../test-rsc-plugin-isolation/src/plugin/page.tsx');

async function activeBuild(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/demo/deployments');
  expect(response.status()).toBe(200);
  const body = await response.json() as { snapshot: Array<{ pluginId: string; buildId: string; state: string }> };
  return body.snapshot.find(({ pluginId, state }) => pluginId === 'demo.rsc.isolation' && state === 'active')?.buildId ?? '';
}

test('incremental development keeps the last good build and publishes the recovered revision end to end', async ({ page, request }) => {
  const original = await readFile(source, 'utf8');
  const before = await activeBuild(request);
  expect(before).toMatch(/^isolation-v1-dev-/);
  try {
    await writeFile(source, `${original}\nconst __hileBroken = ;\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await activeBuild(request)).toBe(before);
    const stillHealthy = await request.get('/plugins/demo.rsc.isolation?marker=last-good');
    expect(stillHealthy.status()).toBe(200);
    expect(await stillHealthy.text()).toContain('Independent plugin namespace');

    const marker = `HOT_RELOAD_${Date.now()}`;
    await writeFile(source, original.replace(
      'Independent plugin namespace',
      `Independent plugin namespace ${marker}`,
    ));
    await expect.poll(() => activeBuild(request), { timeout: 30_000 }).not.toBe(before);

    await page.goto('/plugins/demo.rsc.isolation?marker=recovered');
    await expect(page.getByRole('heading', { name: new RegExp(marker) })).toBeVisible();
    await expect(page.getByTestId('isolation-value')).toHaveText('recovered');
  } finally {
    await writeFile(source, original);
  }
});
