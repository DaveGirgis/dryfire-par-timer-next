import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { assetList, render } from '../tools/build-sw.mjs';

const root = new URL('../', import.meta.url);

test('sw.js precache list and version are current (run `npm run build:sw` if this fails)', () => {
  const src = readFileSync(new URL('sw.js', root), 'utf8');
  assert.equal(src, render(src));
});

test('every precached asset exists, and the manifest icons are among them', () => {
  const assets = assetList();
  for (const a of assets) if (a !== './') assert.ok(existsSync(new URL(a, root)), a);
  const m = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  for (const i of m.icons) assert.ok(assets.includes(i.src), i.src);
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
});

test('manifest has no hard-coded id, so the app works at any address', () => {
  // Without "id" the app's identity is its start_url resolved against the manifest:
  // https://davegirgis.github.io/dryfire-par-timer-next/ on Pages (the same id as before) and
  // https://partimernext.x98c.info/ on the VPS. "./" as an id would collapse to the bare origin.
  const m = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(m.id, undefined);
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
});
