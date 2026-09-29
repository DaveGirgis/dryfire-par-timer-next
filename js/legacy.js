// Import from the original Android app's backup: the raw SQLite file it writes as DryFire_*.db.
// readLegacyTables() needs sql.js; mapLegacy() is pure and does the translation.

import { DEFAULT_DRILL } from './drill.js';

const PRACTICE_TIME_ID = -99; // the old app keeps per-run practice time as history rows with this id
const PLACEHOLDER_DESC = 'Exercise Description';

const r2 = (x) => Math.round(Number(x || 0) * 100) / 100; // strips float32 noise: 0.699999988 → 0.7

export function isSqlite(bytes) {
  const head = new TextDecoder().decode(bytes.slice(0, 15));
  return head === 'SQLite format 3';
}

/** Rows of the four tables as plain objects. `SQL` is an initialised sql.js module. */
export function readLegacyTables(SQL, bytes) {
  const db = new SQL.Database(bytes);
  try {
    const has = (t) => db.exec(`select 1 from sqlite_master where type='table' and name='${t}'`).length > 0;
    if (!has('dry_fire_event')) throw new Error('Not a Dry Fire Par Timer backup (no dry_fire_event table).');
    const rows = (sql) => {
      const res = db.exec(sql);
      if (!res.length) return [];
      const { columns, values } = res[0];
      return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
    };
    return {
      events: rows('select * from dry_fire_event'),
      history: has('dry_fire_history') ? rows('select * from dry_fire_history order by _id') : [],
      sets: has('drill_set') ? rows('select * from drill_set') : [],
      members: has('drill_set_mbr') ? rows('select * from drill_set_mbr order by seq, _id') : [],
    };
  } finally {
    db.close();
  }
}

/** Translate legacy rows to this app's records. Drill ids are kept so history links stay valid. */
export function mapLegacy({ events, history, sets, members }) {
  const drills = events.map((e) => {
    const advanced = Number(e.event_format) === 1;
    const par = r2(e.default_par_time);
    const delay = r2(e.default_delay_time);
    const reps = Number(e.default_rep_count) || 0;
    const desc = (e.event_description || '').trim();
    return {
      ...DEFAULT_DRILL,
      id: Number(e._id),
      name: (e.event_name || '').trim(),
      description: desc === PLACEHOLDER_DESC ? '' : desc,
      format: advanced ? 'advanced' : 'basic',
      // basic fields; for an advanced drill they mirror its first step so switching format is sane
      par, delay, reps,
      // advanced fields; for a basic drill they start from the basic values
      parStart: par,
      parFinal: advanced ? r2(e.default_par_time_final) : DEFAULT_DRILL.parFinal,
      parIncr: advanced ? r2(e.default_par_time_incr) : DEFAULT_DRILL.parIncr,
      delayFirst: r2(e.default_delay_time_first) || delay,
      delayOther: delay,
      randomize: Number(e.default_randomize) === 1,
      randomMax: r2(e.default_randomize_time) || DEFAULT_DRILL.randomMax,
      repCount: reps,
      repIncr: Number(e.rep_count_incr) || 0,
      created: e.date_add || null,
      updated: e.date_chg || null,
    };
  });

  const known = new Set(drills.map((d) => d.id));
  const runs = [];
  const sessions = [];
  let orphans = 0;
  for (const h of history) {
    const fk = Number(h.fk_event_id);
    if (fk === PRACTICE_TIME_ID) {
      sessions.push({ start: h.date_add, end: h.date_chg || null, seconds: r2(h.par_time) });
    } else if (known.has(fk)) {
      runs.push({ drillId: fk, par: r2(h.par_time), reps: Number(h.rep_count) || 0, at: h.date_add });
    } else {
      orphans++;
    }
  }

  const outSets = sets.map((s) => ({
    id: Number(s._id),
    name: (s.set_name || '').trim(),
    members: members
      .filter((m) => Number(m.id_drill_set) === Number(s._id) && known.has(Number(m.id_dry_fire_event_id)))
      .map((m) => Number(m.id_dry_fire_event_id)),
  }));

  return { drills, sets: outSets, history: runs, sessions, orphans };
}

/** Browser-only: load the vendored sql.js on demand (it is ~700 KB, so only when importing). */
export async function loadSqlJs() {
  if (!window.initSqlJs) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/sql-wasm.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the SQLite reader.'));
      document.head.appendChild(s);
    });
  }
  return window.initSqlJs({ locateFile: (f) => `vendor/${f}` });
}
