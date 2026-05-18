#!/usr/bin/env node
/**
 * 将 packages/create-hile/templates 下各模板 package.json 中的 @hile/* 依赖
 * 更新为 npm registry 上的 latest 版本（保留原有的 ^ / ~ 等范围前缀）。
 *
 * 用法:
 *   node scripts/update-template-hile-deps.mjs
 *   node scripts/update-template-hile-deps.mjs --dry-run
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATES_DIR = join(ROOT, 'packages/create-hile/templates');
const HILE_SCOPE = '@hile/';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const dryRun = process.argv.includes('--dry-run');

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
function withRangePrefix(currentRange, latestVersion) {
  if (currentRange.startsWith('workspace:')) {
    return currentRange;
  }

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
async function updateHileDeps(section) {
  if (!section) return [];

  const changes = [];

  for (const [name, currentRange] of Object.entries(section)) {
    if (!name.startsWith(HILE_SCOPE)) continue;

    const latest = await fetchLatestVersion(name);
    const nextRange = withRangePrefix(currentRange, latest);

    if (nextRange === currentRange) continue;

    section[name] = nextRange;
    changes.push({ name, from: currentRange, to: nextRange, latest });
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
      const changes = await updateHileDeps(pkg[field]);
      fileChanges.push(...changes.map((c) => ({ ...c, field })));
    }

    if (fileChanges.length === 0) {
      console.log(`✓ ${filePath.replace(ROOT + '/', '')} (已是最新)`);
      continue;
    }

    totalChanges += fileChanges.length;
    const rel = filePath.replace(ROOT + '/', '');
    console.log(`\n${rel}:`);

    for (const { field, name, from, to, latest } of fileChanges) {
      console.log(`  ${field}.${name}: ${from} → ${to}  (npm latest: ${latest})`);
    }

    if (!dryRun) {
      await writeFile(filePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }
  }

  console.log(
    dryRun
      ? `\n[dry-run] 共 ${totalChanges} 处可更新，未写入文件。`
      : `\n完成，共更新 ${totalChanges} 处 @hile/* 依赖。`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
