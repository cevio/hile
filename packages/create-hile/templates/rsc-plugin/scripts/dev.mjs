import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev:rsc'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev:service'], { stdio: 'inherit' }),
];
let stopping = false;
async function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
  await Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', resolve))));
}
for (const child of children) {
  child.once('exit', (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      void stop();
    }
  });
}
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
await new Promise(() => {});
