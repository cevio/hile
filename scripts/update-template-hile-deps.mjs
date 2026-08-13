#!/usr/bin/env node
/**
 * 将 packages/create-hile/templates 下各模板 package.json 中的全部依赖
 * 更新为 npm registry 上的 latest 版本，并执行兼容性锁定策略。
 *
 * 用法:
 *   node scripts/update-template-hile-deps.mjs
 *   node scripts/update-template-hile-deps.mjs --dry-run
 *   node scripts/update-template-hile-deps.mjs --check
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATES_DIR = join(ROOT, 'packages/create-hile/templates');
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const EXACT_PINS = new Set([
  'next',
  'react',
  'react-dom',
  'react-server-dom-webpack',
  'eslint-config-next',
]);
// Next 16.3.0 currently brings typescript-eslint 8.x and ESLint plugins whose
// declared peers stop below TypeScript 6.1 and ESLint 10 respectively.
const NEXT_TOOLCHAIN_COMPATIBILITY = new Map([
  ['typescript', '6.0.3'],
  ['eslint', '9.39.5'],
]);

const dryRun = process.argv.includes('--dry-run');
const check = process.argv.includes('--check');

/** @type {Map<string, string>} */
const latestCache = new Map();

/**
 * @param {string} pkgName 例如 @hile/core
 */
async function fetchLatestVersion(pkgName) {
  if (latestCache.has(pkgName)) {
    return latestCache.get(pkgName);
  }

  const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`npm registry ${pkgName}: HTTP ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  if (typeof body.version !== 'string' || !body.version) {
    throw new Error(`npm registry ${pkgName}: 响应缺少 version 字段`);
  }

  latestCache.set(pkgName, body.version);
  return body.version;
}

/**
 * @param {string} currentRange
 * @param {string} latestVersion
 */
function rangeFor(name, currentRange, latestVersion) {
  if (currentRange.startsWith('workspace:')) {
    return currentRange;
  }
  if (EXACT_PINS.has(name)) return latestVersion;

  const match = currentRange.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/);
  if (!match) {
    return `^${latestVersion}`;
  }

  const [, prefix = ''] = match;
  if (!prefix) {
    return `^${latestVersion}`;
  }

  return `${prefix}${latestVersion}`;
}

/**
 * @param {Record<string, string> | undefined} section
 */
async function updateDependencies(section, packageJson) {
  if (!section) return [];

  const changes = [];

  for (const [name, currentRange] of Object.entries(section)) {
    const registryLatest = await fetchLatestVersion(name);
    const target = packageJson.devDependencies?.['eslint-config-next']
      ? (NEXT_TOOLCHAIN_COMPATIBILITY.get(name) ?? registryLatest)
      : registryLatest;
    const nextRange = rangeFor(name, currentRange, target);

    if (nextRange === currentRange) continue;

    section[name] = nextRange;
    changes.push({ name, from: currentRange, to: nextRange, target, registryLatest });
  }

  return changes;
}

async function collectTemplatePackageJsonPaths() {
  const entries = await readdir(TEMPLATES_DIR, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    paths.push(join(TEMPLATES_DIR, entry.name, 'package.json'));
  }

  return paths.sort();
}

async function main() {
  const paths = await collectTemplatePackageJsonPaths();
  let totalChanges = 0;

  for (const filePath of paths) {
    const raw = await readFile(filePath, 'utf8');
    const pkg = JSON.parse(raw);
    const fileChanges = [];

    for (const field of DEP_FIELDS) {
      const changes = await updateDependencies(pkg[field], pkg);
      fileChanges.push(...changes.map((c) => ({ ...c, field })));
    }

    if (fileChanges.length === 0) {
      console.log(`✓ ${filePath.replace(ROOT + '/', '')} (已是最新)`);
      continue;
    }

    totalChanges += fileChanges.length;
    const rel = filePath.replace(ROOT + '/', '');
    console.log(`\n${rel}:`);

    for (const { field, name, from, to, target, registryLatest } of fileChanges) {
      const reason = target === registryLatest ? 'npm latest' : `兼容上限，npm latest ${registryLatest}`;
      console.log(`  ${field}.${name}: ${from} → ${to}  (${reason})`);
    }

    if (!dryRun && !check) {
      await writeFile(filePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }
  }

  if (check) {
    if (totalChanges > 0) {
      console.error(`\n发现 ${totalChanges} 处模板依赖不是 npm latest。`);
      process.exitCode = 1;
    } else {
      console.log('\n全部模板依赖均为 npm latest 或上游兼容上限。');
    }
    return;
  }
  console.log(dryRun
    ? `\n[dry-run] 共 ${totalChanges} 处可更新，未写入文件。`
    : `\n完成，共更新 ${totalChanges} 处模板依赖。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
