// Writes the precache list and a content-hash VERSION into sw.js.
// Run after changing any app file: npm run build:sw   (tests fail if you forget)
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = (d, re) => readdirSync(join(ROOT, d)).filter((f) => re.test(f)).sort().map((f) => `${d}/${f}`);

export function assetList() {
  return [
    './', 'index.html', 'manifest.webmanifest',
    ...dir('js', /\.js$/), ...dir('packs', /\.json$/), ...dir('icons', /\.png$/),
    'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm',
  ];
}

export function computeVersion(assets = assetList()) {
  const h = createHash('sha256');
  for (const a of assets) {
    if (a === './') continue; // same bytes as index.html
    let bytes = readFileSync(join(ROOT, a));
    // Hash text as LF so the version is the same whatever line endings a checkout has.
    if (!/\.(png|wasm)$/.test(a)) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    h.update(a).update('\0').update(bytes).update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

export function render(src, assets = assetList(), version = computeVersion(assets)) {
  return src
    .replace(/^const VERSION = '.*';$/m, `const VERSION = '${version}';`)
    .replace(/^const ASSETS = \[.*\];$/m, `const ASSETS = ${JSON.stringify(assets)};`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(ROOT, 'sw.js');
  const out = render(readFileSync(file, 'utf8'));
  writeFileSync(file, out);
  console.log(`sw.js: version ${computeVersion()}, ${assetList().length} assets`);
}
