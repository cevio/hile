import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = (name: string) => fileURLToPath(
  new URL(`../../fixtures/official-runtime/${name}`, import.meta.url),
);

function runNode(
  args: string[],
  input?: Buffer,
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
      code,
    }));
    child.stdin.end(input);
  });
}

describe('official React 19.2.8 RSC runtime compatibility', () => {
  it('renders Flight with react-server condition and decodes it in a normal Node SSR process', async () => {
    const server = await runNode([
      '--conditions=react-server',
      fixture('render-flight.mjs'),
    ]);

    expect(server.code, server.stderr).toBe(0);
    expect(server.stdout.length).toBeGreaterThan(0);
    expect(server.stdout.toString('utf8')).toContain('plugin-counter-browser');

    const client = await runNode([fixture('decode-and-ssr.mjs')], server.stdout);

    expect(client.code, client.stderr).toBe(0);
    expect(client.stdout.toString('utf8')).toContain('<h1>Official RSC probe</h1>');
    expect(client.stdout.toString('utf8')).toContain('<button>count: 7</button>');
  });

  it('fails explicitly without the react-server export condition', async () => {
    const server = await runNode([fixture('render-flight.mjs')]);

    expect(server.code).not.toBe(0);
    expect(server.stderr).toContain('react-server');
  });

  it('fails decoding when the client reference is absent from the consumer manifest', async () => {
    const server = await runNode([
      '--conditions=react-server',
      fixture('render-flight.mjs'),
    ]);
    expect(server.code, server.stderr).toBe(0);

    const client = await runNode([
      fixture('decode-and-ssr.mjs'),
      '--missing-client-reference',
    ], server.stdout);

    expect(client.code).not.toBe(0);
    expect(client.stderr).toContain('React Server Consumer Manifest');
  });
});
