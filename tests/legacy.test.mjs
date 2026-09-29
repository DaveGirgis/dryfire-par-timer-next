import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { isSqlite, readLegacyTables, mapLegacy } from '../js/legacy.js';
import { validate, drillLabel, buildPlan, completedBySteps } from '../js/drill.js';

const BACKUP = process.env.DRYFIRE_DB; // path to a real DryFire_*.db backup, optional

test('mapLegacy: basic and advanced drills, placeholders, float noise, practice rows', () => {
  const out = mapLegacy({
    events: [
      { _id: 13, event_name: 'E2 Trigger control at speed ', event_description: 'press', default_par_time: 1.5,
        default_par_time_final: 0, default_par_time_incr: 0, default_delay_time: 6, default_delay_time_first: 0,
        default_randomize: 0, default_randomize_time: 0, default_rep_count: 15, rep_count_incr: 1, event_format: 0 },
      { _id: 6, event_name: 'E3 Draw', event_description: 'Exercise Description', default_par_time: 1.3,
        default_par_time_final: 1.0, default_par_time_incr: 0.1, default_delay_time: 7, default_delay_time_first: 8,
        default_randomize: 1, default_randomize_time: 2, default_rep_count: 5, rep_count_incr: 0, event_format: 1 },
    ],
    history: [
      { fk_event_id: 13, par_time: 0.699999988079071, rep_count: 7, date_add: '2019-02-03 19:08' },
      { fk_event_id: -99, par_time: 105.30000305175781, rep_count: 0, date_add: '2026-06-17 17:39:53', date_chg: '2026-06-17 17:41:38' },
      { fk_event_id: 999, par_time: 1, rep_count: 1, date_add: 'x' },
    ],
    sets: [{ _id: 3, set_name: 'Warmup' }],
    members: [{ id_drill_set: 3, id_dry_fire_event_id: 13, seq: 9 }, { id_drill_set: 3, id_dry_fire_event_id: 999, seq: 10 }],
  });
  const [e2, e3] = out.drills;
  assert.equal(e2.name, 'E2 Trigger control at speed');
  assert.equal(drillLabel(e2), '15 × 1.50s');
  assert.deepEqual(validate(e2), []);
  assert.equal(e3.description, '');
  assert.equal(drillLabel(e3), '5 × 1.30→1.00s');
  assert.deepEqual([e3.delayFirst, e3.delayOther, e3.randomize, e3.randomMax], [8, 7, true, 2]);
  assert.deepEqual(out.history, [{ drillId: 13, par: 0.7, reps: 7, at: '2019-02-03 19:08' }]);
  assert.deepEqual(out.sessions, [{ start: '2026-06-17 17:39:53', end: '2026-06-17 17:41:38', seconds: 105.3 }]);
  assert.equal(out.orphans, 1);
  assert.deepEqual(out.sets, [{ id: 3, name: 'Warmup', members: [13] }]);
});

test('completedBySteps groups a partial advanced run per par', () => {
  const plan = buildPlan({ format: 'advanced', parStart: 1.3, parFinal: 1.0, parIncr: 0.1, repCount: 5, repIncr: 0,
    delayFirst: 8, delayOther: 7, randomize: false, randomMax: 0 });
  assert.deepEqual(completedBySteps(plan, 12), [{ par: 1.3, reps: 5 }, { par: 1.2, reps: 5 }, { par: 1.1, reps: 2 }]);
  assert.deepEqual(completedBySteps(plan, 0), []);
});

test('real backup imports completely', { skip: !(BACKUP && existsSync(BACKUP)) && 'set DRYFIRE_DB to a backup file to run' }, async () => {
  const bytes = new Uint8Array(readFileSync(BACKUP));
  assert.ok(isSqlite(bytes));
  const SQL = await initSqlJs();
  const tables = readLegacyTables(SQL, bytes);
  const out = mapLegacy(tables);
  assert.equal(out.drills.length, tables.events.length);
  assert.equal(out.history.length + out.sessions.length + out.orphans, tables.history.length);
  assert.equal(out.orphans, 0);

  const e2 = out.drills.find((d) => d.name === 'E2 Trigger control at speed');
  assert.ok(e2, 'E2 Trigger control at speed present');
  assert.equal(drillLabel(e2), '15 × 1.50s');
  const e2runs = out.history.filter((h) => h.drillId === e2.id);
  assert.ok(e2runs.length > 700);
  // No float32 noise survives.
  for (const h of out.history) assert.equal(h.par, Math.round(h.par * 100) / 100);
  // Every drill except the blank "New Exercise" placeholder is runnable as imported.
  const broken = out.drills.filter((d) => validate(d).length).map((d) => d.name);
  assert.ok(broken.every((n) => n.startsWith('New Exercise')), `unexpected invalid drills: ${broken}`);
  console.log(`# imported ${out.drills.length} drills, ${out.history.length} runs, ${out.sessions.length} sessions, ${out.sets.length} sets`);
});
