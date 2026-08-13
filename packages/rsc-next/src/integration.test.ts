import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { get } from 'node:http';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('../fixtures/host', import.meta.url));
const children = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
});

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startHost(port = 0, nodeEnv: 'development' | 'production' = 'development') {
  const child = spawn(process.execPath, [
    '--conditions=react-server',
    'server.mjs',
  ], {
    cwd: fixture,
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      HILE_RSC_PHASE_ZERO_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  let listeningPort = port;
  child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `Phase-zero host startup timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )), 30_000);
    const inspect = () => {
      const ready = stdout.match(/HILE_RSC_PHASE_ZERO_READY:(\d+)/);
      if (ready) {
        listeningPort = Number(ready[1]);
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout!.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `Phase-zero host exited before ready (${code ?? signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ));
    });
  });
  return { child, port: listeningPort, output: () => ({ stdout, stderr }) };
}

function buildProductionHost(): Promise<void> {
  const nextBin = path.resolve(import.meta.dirname, '../node_modules/.bin/next');
  return new Promise((resolve, reject) => {
    execFile(nextBin, ['build'], {
      cwd: fixture,
      env: { ...process.env, NODE_ENV: 'production' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Production Next build failed\n${stdout}\n${stderr}`));
      else resolve();
    });
  });
}

function listeningSockets(pid: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], (error, stdout) => {
      if (error && !stdout) return reject(error);
      resolve(stdout.trim().split('\n').filter((line) => line.includes('(LISTEN)')));
    });
  });
}

describe('single HTTP Next host phase zero', () => {
  it('cleans generated plugin artifacts when the public listener cannot start', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('Failed to occupy test port');
    const before = (await readdir(fixture)).filter((entry) => entry.startsWith('.phase-zero-')).sort();

    try {
      await expect(startHost(address.port)).rejects.toThrow(/EADDRINUSE/);
      await expect.poll(async () =>
        (await readdir(fixture)).filter((entry) => entry.startsWith('.phase-zero-')).sort(),
      ).toEqual(before);
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it('SSR-renders and hydrates a remotely built use client component through plugin Flight', async () => {
    const host = await startHost();
    const { port } = host;
    const url = `http://127.0.0.1:${port}`;

    const response = await fetch(url);
    const html = await response.text();
    expect(response.status, host.output().stderr).toBe(200);
    expect(html).toContain('Hile host shell');
    expect(html).toContain('Plugin server page');
    expect(html).toContain('transitive-client-helper:1');

    const sockets = await listeningSockets(host.child.pid!);
    expect(sockets, sockets.join('\n')).toHaveLength(1);
    expect(sockets[0]).toContain(`:${port}`);

    const disconnected = get(`${url}/?waitForAbort=1`);
    disconnected.on('error', () => undefined);
    await expect.poll(() => host.output().stdout).toContain('HILE_RSC_PHASE_ZERO_RENDER_STARTED');
    disconnected.destroy();
    await expect.poll(() => host.output().stdout).toContain('HILE_RSC_PHASE_ZERO_RENDER_ABORTED');

    const browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const requestedUrls: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
      page.on('request', (request) => requestedUrls.push(request.url()));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });

      await page.goto(url, { waitUntil: 'networkidle' });
      const button = page.getByRole('button', { name: 'transitive-client-helper:1' });
      await playwrightExpect(button).toBeVisible();
      expect(await button.evaluate((element) => getComputedStyle(element).color))
        .toBe('rgb(102, 51, 153)');

      await button.click();
      await playwrightExpect(page.getByRole('button', { name: 'transitive-client-helper:2' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('counter'))).toBe('2');
      await expect.poll(() => page.evaluate(() => localStorage.getItem('lazy-module')))
        .toBe('lazy-client-chunk');

      expect(requestedUrls.some((requested) => requested.includes('/fixture-rsc-assets/'))).toBe(true);
      expect(requestedUrls.some((requested) => requested.includes('/_hile/rsc/assets/'))).toBe(false);
      expect(requestedUrls.some((requested) => /lazy/i.test(requested))).toBe(true);

      expect(pageErrors, host.output().stderr).toEqual([]);
      expect(consoleErrors.filter((message) => /hydration|uncaught|failed/i.test(message)), host.output().stderr)
        .toEqual([]);
    } finally {
      await browser.close();
    }

    const oldRender = fetch(`${url}/?waitForUpgrade=1`);
    await expect.poll(() => host.output().stdout)
      .toContain('HILE_RSC_PHASE_ZERO_OLD_RENDER_STARTED');
    host.child.kill('SIGUSR2');
    await expect.poll(() => host.output().stdout, { timeout: 15_000 })
      .toContain('HILE_RSC_PHASE_ZERO_UPGRADED:phase-one');
    const oldResponse = await oldRender;
    const oldHtml = await oldResponse.text();
    expect(oldResponse.status, host.output().stderr).toBe(200);
    expect(oldHtml).toContain('phase-zero');
    await expect.poll(() => host.output().stdout)
      .toContain('HILE_RSC_PHASE_ZERO_OLD_DRAINED:phase-zero');

    const upgradedResponse = await fetch(url);
    const upgradedHtml = await upgradedResponse.text();
    expect(upgradedResponse.status, host.output().stderr).toBe(200);
    expect(upgradedHtml).toContain('phase-one');

    host.child.kill('SIGUSR1');
    await expect.poll(() => host.output().stdout)
      .toContain('HILE_RSC_PHASE_ZERO_DEACTIVATED:phase-one');
    const inactiveResponse = await fetch(url);
    expect(inactiveResponse.status, host.output().stderr).toBe(404);
  }, 60_000);

  it('builds and starts the same architecture in production with real hydration', async () => {
    await buildProductionHost();
    const host = await startHost(0, 'production');
    const { port } = host;
    const url = `http://127.0.0.1:${port}`;

    const response = await fetch(url);
    const html = await response.text();
    expect(response.status, host.output().stderr).toBe(200);
    expect(html).toContain('Plugin server page');
    expect(html).toContain('transitive-client-helper:1');
    expect(await listeningSockets(host.child.pid!)).toHaveLength(1);

    const browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'transitive-client-helper:1' }).click();
      await playwrightExpect(page.getByRole('button', { name: 'transitive-client-helper:2' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('lazy-module')))
        .toBe('lazy-client-chunk');
      expect(errors, host.output().stderr).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
