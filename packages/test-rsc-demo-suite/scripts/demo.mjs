import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { loadRscBuildConfig } from '@hile/rsc-build';
import { createRscDevelopmentProject } from '@hile/rsc-development/project';

const suiteRoot = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(suiteRoot, '../..');
const mode = process.argv[2];
if (mode !== 'start' && mode !== 'test' && mode !== 'dev' && mode !== 'test-dev') {
  throw new TypeError('Usage: node scripts/demo.mjs <start|test|dev|test-dev>');
}
const developmentMode = mode === 'dev' || mode === 'test-dev';

const services = [
  { name: 'test-rsc-plugin-capabilities-v1', ports: [4211], namespace: 'demo.rsc.capabilities.v1' },
  { name: 'test-rsc-plugin-capabilities-v2', ports: [4212], namespace: 'demo.rsc.capabilities.v2' },
  { name: 'test-rsc-plugin-isolation', ports: [4213], namespace: 'demo.rsc.isolation.v1' },
  { name: 'test-rsc-host', ports: [4210, 3200] },
];
let children = [];
let ownedRegistry;
const developmentProjects = [];
const developmentRecords = new Map();
const developmentStateFile = path.join(suiteRoot, `.hile-rsc-development-${process.pid}.json`);
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
    ...(developmentMode ? { RSC_DEVELOPMENT_STATE: developmentStateFile } : {}),
  };
  delete environment.FORCE_COLOR;
  const child = spawn('pnpm', ['--filter', service.name, developmentMode ? 'dev' : 'start'], {
    cwd: workspaceRoot,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefix(child.stdout, service.name, process.stdout);
  prefix(child.stderr, service.name, process.stderr);
  children.push(child);
  child.once('exit', () => {
    if (!stopping) void shutdown(1);
  });
  return child;
}

async function startRegistryIfNeeded() {
  try {
    await connect(9876, 500);
    console.log('Using existing Registry on 127.0.0.1:9876');
    return;
  } catch {
    // The demo owns only the Registry process it starts here.
  }
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  const child = spawn('pnpm', [
    '--filter', '@hile/cli', 'exec', 'hile', 'registry', '--port', '9876', '--host', '127.0.0.1', '--pretty',
  ], {
    cwd: workspaceRoot,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefix(child.stdout, 'registry', process.stdout);
  prefix(child.stderr, 'registry', process.stderr);
  children.push(child);
  ownedRegistry = child;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Registry exited before readiness: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      await connect(9876);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Registry readiness timed out');
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
  const services = owned.filter((child) => child !== ownedRegistry);
  for (const child of [...services].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The process may have already exited.
    }
  }
  await Promise.all(services.map((child) => waitForExit(child, 5_000)));
  for (const child of services) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process may have already exited.
    }
  }
  if (ownedRegistry && ownedRegistry.exitCode === null && ownedRegistry.signalCode === null) {
    try {
      process.kill(-ownedRegistry.pid, 'SIGTERM');
    } catch {
      // The Registry may have already exited.
    }
    await waitForExit(ownedRegistry, 5_000);
    if (ownedRegistry.exitCode === null && ownedRegistry.signalCode === null) {
      try { process.kill(-ownedRegistry.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
  ownedRegistry = undefined;
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
        developmentRecords.set(service.name, record);
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

async function runPlaywright(development = false) {
  const environment = { ...process.env, ...(development ? { RSC_DEV_E2E: '1' } : {}) };
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
  if (developmentMode) await rm(developmentStateFile, { force: true });
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown(130));
process.once('SIGTERM', () => void shutdown(143));

try {
  for (const service of services) {
    for (const port of service.ports) await assertAvailable(port);
  }
  await startRegistryIfNeeded();
  if (developmentMode) await initializeDevelopmentCompilers();
  await startAll();
  console.log('RSC Demo ready: http://127.0.0.1:3200');
  console.log('Internal micro ports: 4210, 4211, 4212, 4213; registry: 9876');

  if (mode === 'test') {
    await runPlaywright();
    await shutdown(0);
  } else if (mode === 'test-dev') {
    await runPlaywright(true);
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
