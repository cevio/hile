#!/usr/bin/env node
import enquirer from 'enquirer';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PACKAGES_DIR = resolve(ROOT, 'packages');

const styles = {
  red: '\x1b[31m', green: '\x1b[32m', blue: '\x1b[34m', cyan: '\x1b[36m', reset: '\x1b[0m',
};
function info(msg) { console.log(`${styles.blue}info${styles.reset} ${msg}`); }
function ok(msg)   { console.log(`${styles.green}ok${styles.reset} ${msg}`); }
function error(msg){ console.error(`${styles.red}error${styles.reset} ${msg}`); }

// ============================================================
// 获取包名
// ============================================================
let packageName = process.argv[2];
if (!packageName) {
  const response = await enquirer.prompt({
    type: 'input', name: 'name', message: '包名称',
  });
  packageName = response.name.trim();
  if (!packageName) { error('包名称不能为空'); process.exit(1); }
}

const targetDir = resolve(PACKAGES_DIR, packageName);
if (existsSync(targetDir)) {
  error(`目标目录已存在: ${targetDir}`);
  process.exit(1);
}

// ============================================================
// 选择创建类型
// ============================================================
console.log('');
const { type } = await enquirer.prompt({
  type: 'select',
  name: 'type',
  message: '创建类型:',
  choices: [
    { name: 'module', message: '模块  — 创建 monorepo 子包（直接生成基本结构）' },
    { name: 'project', message: '项目  — 从 create-hile 模板创建并适配 monorepo' },
  ],
});

// ============================================================
// 模块模式：直接生成基本包结构
// ============================================================
if (type === 'module') {
  info(`Step 1/4: 创建模块包 ${packageName} ...`);

  mkdirSync(resolve(targetDir, 'src'), { recursive: true });

  // package.json
  const pkg = {
    name: `@router-brain/${packageName}`,
    version: '0.1.0',
    private: true,
    description: '',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: {
      build: 'tsc',
      clean: 'rm -rf dist node_modules',
    },
    license: 'MIT',
  };
  writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  ok('package.json 已创建');

  // tsconfig.json
  const tsconfig = {
    extends: '../../tsconfig.json',
    compilerOptions: {
      outDir: './dist',
      rootDir: './src',
    },
    include: ['src'],
  };
  writeFileSync(resolve(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
  ok('tsconfig.json 已创建');

  // src/index.ts
  writeFileSync(resolve(targetDir, 'src/index.ts'), `\
/**
 * @router-brain/${packageName}
 */

export {};
`);
  ok('src/index.ts 已创建');

  // 安装依赖
  info('Step 2/4: 安装依赖 ...');
  execSync(`pnpm install --filter "@router-brain/${packageName}"`, { cwd: ROOT, stdio: 'inherit' });

  console.log('');
  ok(`模块包 ${packageName} 创建成功！`);
  console.log(`  ${styles.cyan}位置:${styles.reset}     packages/${packageName}`);
  console.log('');
  process.exit(0);
}

// 项目模式：包名自动追加 -server
if (!packageName.endsWith('-server')) {
  packageName += '-server';
  info(`项目包名自动追加 -server: ${packageName}`);
}
const projectTargetDir = resolve(PACKAGES_DIR, packageName);
if (existsSync(projectTargetDir)) {
  error(`目标目录已存在: ${projectTargetDir}`);
  process.exit(1);
}

// ============================================================
// 项目模式：走 npx create-hile create
// ============================================================
info('Step 1/6: 运行 create-hile create（请交互选择模板）...');

const tempDir = resolve(tmpdir(), `create-hile-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });

const result = spawnSync('npx', ['--yes', 'create-hile', 'create', packageName, '--skip-install'], {
  cwd: tempDir, stdio: 'inherit', shell: true,
});

if (result.status !== 0) {
  error('create-hile 创建失败');
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

const projectDir = resolve(tempDir, packageName);
if (!existsSync(projectDir)) {
  error('create-hile 创建失败，未找到目标目录');
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

// Step 2: 移动
info(`Step 2/6: 移动到 packages/${packageName} ...`);
mkdirSync(PACKAGES_DIR, { recursive: true });
renameSync(projectDir, projectTargetDir);
rmSync(tempDir, { recursive: true, force: true });

const nmDir = resolve(projectTargetDir, 'node_modules');
if (existsSync(nmDir)) rmSync(nmDir, { recursive: true, force: true });

// Step 3: 调整 package.json
info('Step 3/6: 调整 package.json ...');
const pkgPath = resolve(projectTargetDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkg.name = `@router-brain/${packageName}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`  name -> ${pkg.name}`);

// Step 4: 删除 .gitignore
info('Step 4/6: 检查 .gitignore ...');
const gitignorePath = resolve(projectTargetDir, '.gitignore');
if (existsSync(gitignorePath)) {
  rmSync(gitignorePath);
  ok('已删除 .gitignore（由根目录统一管理）');
}

// Step 5: 调整 tsconfig.json
info('Step 5/6: 调整 tsconfig.json ...');
const tsconfigPath = resolve(projectTargetDir, 'tsconfig.json');
if (existsSync(tsconfigPath)) {
  const ts = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
  ts.extends = '../../tsconfig.json';
  const keys = Object.keys(ts).sort((a, b) => {
    if (a === 'extends') return -1;
    if (b === 'extends') return 1;
    return a.localeCompare(b);
  });
  const ordered = {};
  for (const k of keys) ordered[k] = ts[k];
  writeFileSync(tsconfigPath, JSON.stringify(ordered, null, 2) + '\n');
  ok('tsconfig.json 已添加 extends');
}

// Step 6: 安装依赖
info('Step 6/6: 安装依赖 ...');
execSync(`pnpm install --filter "@router-brain/${packageName}"`, { cwd: ROOT, stdio: 'inherit' });

console.log('');
ok(`项目包 ${packageName} 创建成功！`);
console.log(`  ${styles.cyan}位置:${styles.reset}     packages/${packageName}`);
console.log('');
console.log('可用命令:');
console.log(`  pnpm lerna run build --scope=@router-brain/${packageName}`);
console.log(`  pnpm lerna run dev   --scope=@router-brain/${packageName}`);
console.log('');
