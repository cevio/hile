/**
 * 根据 scripts/package-table.manifest.json 与各 packages 子目录下的 package.json
 * 生成根 README 与 docs/introduction.mdx 中的「包一览」表格（仅替换标记之间的内容）。
 *
 * 运行：pnpm run docs:package-table
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(__dirname, 'package-table.manifest.json');

const MARKERS = {
  markdown: {
    start: '<!-- package-table:auto -->',
    end: '<!-- /package-table:auto -->',
  },
  mdx: {
    start: '{/* package-table:auto */}',
    end: '{/* /package-table:auto */}',
  },
};

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function replaceBlock(filePath, markers, newInner) {
  const raw = readFileSync(filePath, 'utf8');
  const start = raw.indexOf(markers.start);
  const end = raw.indexOf(markers.end);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Missing markers in ${filePath}: ${markers.start} ... ${markers.end}`);
  }
  const before = raw.slice(0, start + markers.start.length);
  const after = raw.slice(end);
  const next = `${before}\n${newInner}\n${after}`;
  writeFileSync(filePath, next, 'utf8');
}

function main() {
  const manifest = loadJson(MANIFEST_PATH);
  const rows = [];

  for (const entry of manifest.packages) {
    const pkgPath = join(ROOT, 'packages', entry.directory, 'package.json');
    const pkg = loadJson(pkgPath);
    const { name, version } = pkg;
    if (!name || !version) {
      throw new Error(`Invalid package.json for ${entry.directory}: need name and version`);
    }
    rows.push({
      name,
      version,
      directory: entry.directory,
      readmeBlurb: entry.readmeBlurb,
      introductionBlurb: entry.introductionBlurb,
    });
  }

  const readmeHeader = '| 包名 | 说明 | 版本 |\n|------|------|------|';
  const readmeBody = rows
    .map(
      (r) =>
        `| [\`${r.name}\`](./packages/${r.directory}) | ${r.readmeBlurb} | ${r.version} |`,
    )
    .join('\n');
  const readmeTable = `${readmeHeader}\n${readmeBody}`;

  const introHeader = '| 包名 | 说明 | 版本 | 安装 |\n|------|------|------|------|';
  const introBody = rows
    .map((r) => {
      const install =
        r.name === 'create-hile' ? '`npx create-hile`' : `\`pnpm add ${r.name}\``;
      return `| \`${r.name}\` | ${r.introductionBlurb} | ${r.version} | ${install} |`;
    })
    .join('\n');
  const introTable = `${introHeader}\n${introBody}`;

  replaceBlock(join(ROOT, 'README.md'), MARKERS.markdown, readmeTable);
  replaceBlock(join(ROOT, 'docs', 'introduction.mdx'), MARKERS.mdx, introTable);

  console.log('Updated package tables in README.md and docs/introduction.mdx');
}

main();
