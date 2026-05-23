#!/usr/bin/env node
import enquirer from 'enquirer';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PACKAGES_DIR = resolve(ROOT, 'packages');

const styles = {
  red: '\x1b[31m', green: '\x1b[32m', blue: '\x1b[34m', cyan: '\x1b[36m', reset: '\x1b[0m',
};
function info(msg) { console.log(`${styles.blue}info${styles.reset} ${msg}`); }
function error(msg){ console.error(`${styles.red}error${styles.reset} ${msg}`); }

// 收集所有 -server 结尾的子包
const servers = [];
for (const dir of readdirSync(PACKAGES_DIR)) {
  if (!dir.endsWith('-server')) continue;
  const pkgJsonPath = resolve(PACKAGES_DIR, dir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  if (pkg.name && pkg.scripts?.dev) servers.push({ name: pkg.name, dir, devScript: pkg.scripts.dev });
}

if (servers.length === 0) {
  error('没有找到 -server 结尾的服务包');
  process.exit(1);
}

// 选择要启动的服务
const { target } = await enquirer.prompt({
  type: 'select',
  name: 'target',
  message: '选择要启动的服务:',
  choices: servers.map(s => ({
    name: s.name,
    message: `${s.name}  (${s.dir}/)`,
  })),
});

console.log('');
info(`启动服务: ${target}`);
const dir = servers.find(s => s.name === target).dir;
spawn('npm', ['run', 'dev'], {
  cwd: resolve(PACKAGES_DIR, dir),
  stdio: 'inherit',
});