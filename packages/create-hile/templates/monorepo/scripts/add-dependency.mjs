#!/usr/bin/env node
import enquirer from 'enquirer';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PACKAGES_DIR = resolve(ROOT, 'packages');

const { red, green, blue, reset } = { red: '\x1b[31m', green: '\x1b[32m', blue: '\x1b[34m', reset: '\x1b[0m' };

function info(msg) { console.log(`${blue}info${reset} ${msg}`); }
function ok(msg)   { console.log(`${green}ok${reset} ${msg}`); }
function error(msg){ console.error(`${red}error${reset} ${msg}`); }

// --- 收集所有子包 ---
const packages = [];
for (const dir of readdirSync(PACKAGES_DIR)) {
  const pkgJsonPath = resolve(PACKAGES_DIR, dir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  if (pkg.name) packages.push({ name: pkg.name, dir });
}

if (packages.length === 0) {
  error('packages/ 目录下没有找到子包');
  process.exit(1);
}

// ============================================================
// Step 1: 选择目标包
// ============================================================
const { target } = await enquirer.prompt({
  type: 'select',
  name: 'target',
  message: '选择目标包:',
  choices: packages.map(p => ({ name: p.name, message: `${p.name}  (${p.dir}/)` })),
});
info(`目标包: ${target}`);

// ============================================================
// Step 2: 选择依赖来源
// ============================================================
console.log('');
const { source } = await enquirer.prompt({
  type: 'select',
  name: 'source',
  message: '依赖来源:',
  choices: [
    { name: 'local', message: '本地包（monorepo 内 @router-brain/*）' },
    { name: 'manual', message: '手动输入 npm 包名' },
  ],
});

let deps = [];

if (source === 'local') {
  const localChoices = packages
    .filter(p => p.name !== target)
    .map(p => ({ name: p.name, message: `${p.name}  (${p.dir}/)` }));

  if (localChoices.length === 0) {
    error('没有其他本地包可供安装');
    process.exit(1);
  }

  const { localPkg } = await enquirer.prompt({
    type: 'select',
    name: 'localPkg',
    message: '选择要安装的本地包:',
    choices: localChoices,
  });
  deps = [localPkg];

} else {
  const { packages } = await enquirer.prompt({
    type: 'input',
    name: 'packages',
    message: '输入 npm 包名（多个用空格分隔）:',
  });
  deps = packages.trim().split(/\s+/).filter(Boolean);
  if (deps.length === 0) {
    error('包名不能为空');
    process.exit(1);
  }
}

// ============================================================
// Step 3: 是否安装为 devDependencies
// ============================================================
console.log('');
const { isDev } = await enquirer.prompt({
  type: 'confirm',
  name: 'isDev',
  message: '安装为 devDependencies?',
  initial: false,
});
const devFlag = isDev ? '-D' : '';

// ============================================================
// Step 4: 执行安装
// ============================================================
console.log('');
info('执行安装...');
console.log(`  target:  ${target}`);
console.log(`  add:     ${deps.join(' ')}`);
console.log(`  type:    ${isDev ? 'devDependencies' : 'dependencies'}`);
if (source === 'local') console.log('  proto:   workspace:^');

const workspaceFlag = source === 'local' ? '--workspace' : '';
execSync(
  `pnpm add ${devFlag} ${workspaceFlag} --filter "${target}" ${deps.map(d => `"${d}"`).join(' ')}`,
  { cwd: ROOT, stdio: 'inherit' },
);

console.log('');
ok('安装完成！');
