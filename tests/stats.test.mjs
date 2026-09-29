import test from 'node:test';
import assert from 'node:assert/strict';
import { daysAgo, windows, byPar, stamp } from '../js/stats.js';

const now = new Date(2026, 6, 10, 9, 0); // 2026-07-10 local
const rows = [
  { par: 2.0, reps: 15, at: '2026-07-10 08:00' },   // today
  { par: 1.5, reps: 5, at: '2026-07-04 17:00:00' }, // 6 days → last 7
  { par: 1.5, reps: 7, at: '2026-07-03 17:00' },    // 7 days → 8–14
  { par: 0.4, reps: 10, at: '2019-02-04 19:01' },
];

test('daysAgo uses local calendar days', () => {
  assert.equal(daysAgo('2026-07-10 23:59', now), 0);
  assert.equal(daysAgo('2026-07-09 00:01', now), 1);
});

test('windows: counts, reps and rep-weighted average par', () => {
  const w = windows(rows, now);
  assert.deepEqual(w.map((x) => [x.label, x.runs, x.reps]),
    [['Last 7 days', 2, 20], ['8–14 days', 1, 7], ['15–30 days', 0, 0], ['Lifetime', 4, 37]]);
  assert.equal(w[0].avgPar, (2.0 * 15 + 1.5 * 5) / 20);
  assert.equal(w[2].avgPar, null);
});

test('byPar groups by par, fastest first, with last date', () => {
  assert.deepEqual(byPar(rows), [
    { par: 0.4, runs: 1, reps: 10, last: '2019-02-04 19:01' },
    { par: 1.5, runs: 2, reps: 12, last: '2026-07-04 17:00:00' },
    { par: 2.0, runs: 1, reps: 15, last: '2026-07-10 08:00' },
  ]);
});

test('stamp is sortable local time', () => {
  assert.equal(stamp(new Date(2026, 0, 5, 7, 3, 9)), '2026-01-05 07:03:09');
});
