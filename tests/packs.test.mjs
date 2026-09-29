import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePack, checkPack, planMerge } from '../js/packs.js';
import { DEFAULT_DRILL, validate } from '../js/drill.js';

const lib = [
  { ...DEFAULT_DRILL, id: 13, name: 'E2 Trigger control at speed', par: 2, reps: 15, created: 'x', updated: 'y', secret: 1 },
  { ...DEFAULT_DRILL, id: 7, name: 'S1 Bill drill', par: 2.5 },
];

test('makePack keeps definitions only and sets limited to chosen drills', () => {
  const p = makePack({ name: 'Mine', drills: [lib[0]], sets: [{ name: 'Warmup', members: [13, 40] }, { name: 'Other', members: [7] }] });
  assert.equal(p.kind, 'drill-pack');
  assert.deepEqual(Object.keys(p.drills[0]).includes('id'), false);
  assert.equal(p.drills[0].created, undefined);
  assert.equal(p.drills[0].secret, undefined);
  assert.deepEqual(p.sets, [{ name: 'Warmup', drills: ['E2 Trigger control at speed'] }]);
  assert.doesNotThrow(() => checkPack(p));
});

test('checkPack rejects backups and junk', () => {
  assert.throws(() => checkPack({ app: 'par-timer', drills: [] }), /Not a Par Timer drill pack/);
  assert.throws(() => checkPack({ app: 'par-timer', kind: 'drill-pack', drills: [] }), /no drills/);
  assert.throws(() => checkPack({ app: 'par-timer', kind: 'drill-pack', drills: [{ name: ' ', format: 'basic' }] }), /no name/);
});

test('planMerge never overwrites an existing drill and wires sets to it', () => {
  const pack = {
    drills: [
      { name: 'e2 trigger control at speed ', format: 'basic', par: 0.5, reps: 5 },
      { name: 'S3 El Presidente', format: 'basic', par: 6, delay: 8, reps: 3 },
    ],
    sets: [{ name: 'Fundamentals', drills: ['E2 Trigger control at speed', 'S3 El Presidente'] }],
  };
  const plan = planMerge(pack, lib, [{ id: 3, name: 'Warmup', members: [13] }]);
  assert.deepEqual(plan.skipped, ['e2 trigger control at speed']);
  assert.deepEqual(plan.add.map((d) => d.name), ['S3 El Presidente']);
  assert.deepEqual(plan.sets, [{ name: 'Fundamentals', id: undefined, members: [13, { name: 'S3 El Presidente' }] }]);
});

test('planMerge tops up an existing set without duplicates', () => {
  const pack = { drills: [{ name: 'S1 Bill drill', format: 'basic' }], sets: [{ name: 'warmup', drills: ['S1 Bill drill', 'Nope'] }] };
  assert.deepEqual(planMerge(pack, lib, [{ id: 3, name: 'Warmup', members: [13] }]).sets,
    [{ name: 'Warmup', id: 3, members: [13, 7] }]);
  // Already a member: nothing to change, so no set in the plan.
  assert.deepEqual(planMerge(pack, lib, [{ id: 3, name: 'Warmup', members: [13, 7] }]).sets, []);
});

test('re-importing a pack you already have plans nothing', () => {
  const pack = makePack({ name: 'Mine', drills: lib, sets: [{ name: 'Warmup', members: [13, 7] }] });
  const plan = planMerge(pack, lib, [{ id: 3, name: 'Warmup', members: [13, 7] }]);
  assert.deepEqual([plan.add, plan.sets, plan.skipped.length], [[], [], 2]);
});

test('bundled starter pack is valid and every drill runs', () => {
  const p = checkPack(JSON.parse(readFileSync(new URL('../packs/starter.json', import.meta.url))));
  for (const d of p.drills) assert.deepEqual(validate({ ...DEFAULT_DRILL, ...d }), [], d.name);
  const names = new Set(p.drills.map((d) => d.name));
  assert.equal(names.size, p.drills.length, 'duplicate names');
  for (const s of p.sets) for (const n of s.drills) assert.ok(names.has(n), `set ${s.name} refers to missing ${n}`);
  // Personal notes from the source library ("Ben par time = 1.6", "maybe 2.5 for me") must not ship.
  for (const d of p.drills) assert.ok(!/\bBen\b|for me/i.test(d.description), `personal note in ${d.name}`);
  assert.match(p.credits, /Ben Stoeger/);
  assert.match(p.credits, /CSL1911A1/);
});
