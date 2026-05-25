import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGES_DIR = resolve(import.meta.dirname, '..', 'packages');

function countCoverage(json) {
  let total = { statements: 0, coveredStatements: 0, branches: 0, coveredBranches: 0, functions: 0, coveredFunctions: 0, lines: 0, coveredLines: 0 };

  for (const [, data] of Object.entries(json)) {
    const s = data.s || {};
    const f = data.f || {};
    const b = data.b || {};

    const stmtKeys = Object.keys(s);
    total.statements += stmtKeys.length;
    total.coveredStatements += stmtKeys.filter(k => s[k] > 0).length;

    const fnKeys = Object.keys(f);
    total.functions += fnKeys.length;
    total.coveredFunctions += fnKeys.filter(k => f[k] > 0).length;

    for (const k of Object.keys(b)) {
      const val = b[k];
      if (Array.isArray(val)) {
        for (const hit of val) {
          total.branches++;
          if (hit > 0) total.coveredBranches++;
        }
      } else {
        total.branches++;
        if (val > 0) total.coveredBranches++;
      }
    }

    // line coverage: count unique line numbers from statementMap
    const stmtMap = data.statementMap || {};
    const lineHits = {};
    for (const id of stmtKeys) {
      const stmt = stmtMap[id];
      if (!stmt) continue;
      const line = stmt.start.line;
      if (s[id] > 0) lineHits[line] = true;
      else if (!(line in lineHits)) lineHits[line] = false;
    }
    total.lines += Object.keys(lineHits).length;
    total.coveredLines += Object.values(lineHits).filter(Boolean).length;
  }

  return total;
}

function main() {
  const packages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const coverageFiles = [];
  for (const pkg of packages) {
    const covPath = join(PACKAGES_DIR, pkg, 'coverage', 'coverage-final.json');
    if (existsSync(covPath)) coverageFiles.push(pkg);
  }

  if (coverageFiles.length === 0) {
    console.log('No coverage data found. Run pnpm test:coverage first.');
    process.exit(1);
  }

  const grand = { statements: 0, coveredStatements: 0, branches: 0, coveredBranches: 0, functions: 0, coveredFunctions: 0, lines: 0, coveredLines: 0 };

  for (const pkg of coverageFiles) {
    const covPath = join(PACKAGES_DIR, pkg, 'coverage', 'coverage-final.json');
    if (!existsSync(covPath)) continue;
    const json = JSON.parse(readFileSync(covPath, 'utf8'));
    const counts = countCoverage(json);

    grand.statements += counts.statements;
    grand.coveredStatements += counts.coveredStatements;
    grand.branches += counts.branches;
    grand.coveredBranches += counts.coveredBranches;
    grand.functions += counts.functions;
    grand.coveredFunctions += counts.coveredFunctions;
    grand.lines += counts.lines;
    grand.coveredLines += counts.coveredLines;
  }

  const pct = (num, den) => den === 0 ? '0.00' : (num / den * 100).toFixed(2);

  const stmtsPct = pct(grand.coveredStatements, grand.statements);
  const branchPct = pct(grand.coveredBranches, grand.branches);
  const funcPct = pct(grand.coveredFunctions, grand.functions);
  const linesPct = pct(grand.coveredLines, grand.lines);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Total Coverage (${coverageFiles.length} packages)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Statements:  ${stmtsPct}%  (${grand.coveredStatements}/${grand.statements})`);
  console.log(`  Branches:    ${branchPct}%  (${grand.coveredBranches}/${grand.branches})`);
  console.log(`  Functions:   ${funcPct}%  (${grand.coveredFunctions}/${grand.functions})`);
  console.log(`  Lines:       ${linesPct}%  (${grand.coveredLines}/${grand.lines})`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Generate local SVG badges
  const badgeColor = (pct) => {
    const v = parseFloat(pct);
    if (v >= 90) return '#31c754';
    if (v >= 80) return '#97ca00';
    if (v >= 70) return '#a4a61d';
    if (v >= 60) return '#dfb317';
    return '#e05d44';
  };

  function generateBadgeSvg(label, value, color) {
    const labelW = label.length * 7 + 16;
    const valueW = value.length * 7 + 16;
    const totalW = labelW + valueW;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalW}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;
  }

  const badgesDir = resolve(import.meta.dirname, '..');
  const items = [
    { label: 'statements', value: `${stmtsPct}%`, file: 'coverage-statements.svg' },
    { label: 'branches', value: `${branchPct}%`, file: 'coverage-branches.svg' },
    { label: 'functions', value: `${funcPct}%`, file: 'coverage-functions.svg' },
    { label: 'lines', value: `${linesPct}%`, file: 'coverage-lines.svg' },
  ];

  for (const { label, value, file } of items) {
    const svg = generateBadgeSvg(label, value, badgeColor(value));
    writeFileSync(join(badgesDir, file), svg, 'utf8');
  }

  // Update README to reference local badges
  const readmePath = resolve(import.meta.dirname, '..', 'README.md');
  let readme = readFileSync(readmePath, 'utf8');
  readme = readme.replace(
    /!\[Statements\]\(.*?\)/,
    '![Statements](coverage-statements.svg)',
  );
  readme = readme.replace(
    /!\[Branches\]\(.*?\)/,
    '![Branches](coverage-branches.svg)',
  );
  readme = readme.replace(
    /!\[Functions\]\(.*?\)/,
    '![Functions](coverage-functions.svg)',
  );
  readme = readme.replace(
    /!\[Lines\]\(.*?\)/,
    '![Lines](coverage-lines.svg)',
  );
  writeFileSync(readmePath, readme, 'utf8');
  console.log('Coverage badges generated and README updated.');
}

main();
