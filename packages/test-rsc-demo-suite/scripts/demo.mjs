import { spawn } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { loadRscBuildConfig } from '@hile/rsc-build';
import { createRscDevelopmentProject } from '@hile/rsc-development/project';

const suiteRoot = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(suiteRoot, '../..');
const mode = process.argv[2];
if (mode !== 'start' && mode !== 'test' && mode !== 'dev') {
  throw new TypeError('Usage: node scripts/demo.mjs <start|test|dev>');
}

const services = [
  { name: 'test-rsc-plugin-capabilities-v1', ports: [4211], namespace: 'demo.rsc.capabilities.v1', developmentInitial: true },
  { name: 'test-rsc-plugin-capabilities-v2', ports: [4212], namespace: 'demo.rsc.capabilities.v2', developmentInitial: false },
  { name: 'test-rsc-plugin-isolation', ports: [4213], namespace: 'demo.rsc.isolation.v1', developmentInitial: true },
  { name: 'test-rsc-host', ports: [4210, 3200] },
];
let children = [];
const developmentProjects = [];
const developmentRecords = new Map();
const developmentStateFile = path.join(suiteRoot, '.hile-rsc-development.json');
let developmentPublishQueue = Promise.resolve();

function connect(port, timeout = 500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection timeout: 127.0.0.1:${port}`));
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function assertAvailable(port) {
  try {
    await connect(port);
  } catch {
    return;
  }
  throw new Error(`RSC Demo refuses to replace an existing listener on 127.0.0.1:${port}`);
}

function prefix(stream, label, target) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) target.write(`[${label}] ${line}\n`);
  });
}

function startService(service) {
  const environment = {
    ...process.env,
    ...(mode === 'dev' ? { RSC_DEVELOPMENT_STATE: developmentStateFile } : {}),
  };
  delete environment.FORCE_COLOR;
  const child = spawn('pnpm', ['--filter', service.name, mode === 'dev' ? 'dev' : 'start'], {
    cwd: workspaceRoot,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefix(child.stdout, service.name, process.stdout);
  prefix(child.stderr, service.name, process.stderr);
  children.push(child);
  return child;
}

async function waitForService(service, child) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${service.name} exited before readiness: ${child.exitCode ?? child.signalCode}`);
    }
    const ready = await Promise.all(service.ports.map(async (port) => {
      try {
        await connect(port);
        return true;
      } catch {
        return false;
      }
    }));
    if (ready.every(Boolean)) return;
    if (Date.now() >= deadline) throw new Error(`${service.name} readiness timed out`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopAll() {
  const owned = children;
  children = [];
  for (const child of [...owned].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The process may have already exited.
    }
  }
  await Promise.all(owned.map((child) => waitForExit(child, 5_000)));
  for (const child of owned) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process may have already exited.
    }
  }
}

async function writeDevelopmentState() {
  developmentPublishQueue = developmentPublishQueue.then(async () => {
    const temporary = `${developmentStateFile}.${process.pid}.tmp`;
    await mkdir(path.dirname(developmentStateFile), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ revisions: [...developmentRecords.values()] }, null, 2)}\n`);
    await rename(temporary, developmentStateFile);
  });
  return developmentPublishQueue;
}

async function initializeDevelopmentCompilers() {
  for (const service of services.filter(({ namespace }) => namespace)) {
    const packageRoot = path.join(workspaceRoot, 'packages', service.name);
    const configFile = path.join(packageRoot, 'hile-rsc.json');
    const project = await createRscDevelopmentProject({
      configFile,
      stateFile: developmentStateFile,
      namespace: service.namespace,
      outdir: path.join(packageRoot, '.hile-rsc/development'),
      sessionId: `demo-${process.pid}`,
      loadConfig: () => loadRscBuildConfig(configFile),
      async writeRevision(record) {
        developmentRecords.set(service.name, { ...record, active: service.developmentInitial });
        await writeDevelopmentState();
      },
      onRevision(result) {
        console.log(`[${service.name}] RSC revision ${result.revision} active; contexts=${JSON.stringify(result.contexts)}`);
      },
      onError(error) {
        console.error(error instanceof Error ? error.stack : String(error));
        console.error('Development rebuild failed; waiting for the next source change.');
      },
    });
    developmentProjects.push(project);
  }
  await writeDevelopmentState();
}

async function startAll() {
  for (const service of services) {
    const child = startService(service);
    await waitForService(service, child);
  }
}

async function runPlaywright() {
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  const child = spawn('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.config.ts'], {
    cwd: suiteRoot,
    env: environment,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Playwright exited with ${code ?? signal}`));
    });
  });
}

let stopping = false;
async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  await stopAll();
  await Promise.all(developmentProjects.splice(0).map((project) => project.dispose()));
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown(130));
process.once('SIGTERM', () => void shutdown(143));

try {
  await connect(9876, 2_000);
  for (const service of services) {
    for (const port of service.ports) await assertAvailable(port);
  }
  if (mode === 'dev') await initializeDevelopmentCompilers();
  await startAll();
  console.log('RSC Demo ready: http://127.0.0.1:3200');
  console.log('Internal micro ports: 4210, 4211, 4212, 4213; registry: 9876');

  if (mode === 'test') {
    await runPlaywright();
    await shutdown(0);
  } else {
    if (mode === 'dev') {
      console.log('Development mode incrementally rebuilds only the changed plugin and refreshes after Host activation.');
    }
    await new Promise(() => {});
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  await shutdown(1);
}
