// Drill packs: shareable drill definitions (and optional sets), never history.
// Pure functions; the UI does the file handling and storage.

import { DEFAULT_DRILL, validate } from './drill.js';

export const PACK_KIND = 'drill-pack';

// The fields a drill definition carries in a pack. ids, dates and anything else stay home.
const FIELDS = ['name', 'description', 'format', 'par', 'delay', 'reps', 'parStart', 'parFinal', 'parIncr',
  'delayFirst', 'delayOther', 'randomize', 'randomMax', 'repCount', 'repIncr'];

const pick = (d) => Object.fromEntries(FIELDS.map((k) => [k, d[k] ?? DEFAULT_DRILL[k] ?? '']));
const key = (name) => String(name || '').trim().toLowerCase();

/** Build a pack from drill records. `sets` are {name, members: [drillId]} and are kept only for chosen drills. */
export function makePack({ name, description = '', drills, sets = [] }) {
  const chosen = new Map(drills.map((d) => [d.id, d]));
  return {
    app: 'par-timer',
    kind: PACK_KIND,
    format: 1,
    name,
    description,
    drills: drills.map(pick),
    sets: sets
      .map((s) => ({ name: s.name, drills: s.members.filter((id) => chosen.has(id)).map((id) => chosen.get(id).name) }))
      .filter((s) => s.drills.length),
  };
}

/** Throws with a readable message if `p` is not a usable pack. */
export function checkPack(p) {
  if (!p || p.app !== 'par-timer' || p.kind !== PACK_KIND || !Array.isArray(p.drills)) {
    throw new Error('Not a Par Timer drill pack.');
  }
  if (!p.drills.length) throw new Error('The pack has no drills.');
  p.drills.forEach((d, i) => {
    if (!String(d.name || '').trim()) throw new Error(`Drill ${i + 1} in the pack has no name.`);
    if (d.format !== 'basic' && d.format !== 'advanced') throw new Error(`"${d.name}" has an unknown format.`);
  });
  return p;
}

/**
 * Plan merging a pack into a library without touching anything already there:
 * a pack drill whose name matches an existing drill is skipped (your settings and history win),
 * and pack sets are created or topped up, pointing at the existing drill where names matched.
 * Returns { add: [drill], sets: [{name, id?, members: [id | {name}]}], skipped: [name], invalid: [name] }.
 */
export function planMerge(pack, drills, sets) {
  const byName = new Map(drills.map((d) => [key(d.name), d]));
  const add = [];
  const skipped = [];
  const invalid = [];
  for (const raw of pack.drills) {
    const d = { ...DEFAULT_DRILL, ...pick(raw), name: String(raw.name).trim() };
    if (byName.has(key(d.name))) { skipped.push(d.name); continue; }
    if (validate(d).length) invalid.push(d.name); // still added; the editor shows what to fix
    byName.set(key(d.name), d);
    add.push(d);
  }
  const setPlan = (pack.sets || []).map((ps) => {
    const existing = sets.find((s) => key(s.name) === key(ps.name));
    const members = existing ? [...existing.members] : [];
    let changed = !existing;
    for (const n of ps.drills) {
      const d = byName.get(key(n));
      if (!d) continue;
      const ref = d.id != null ? d.id : { name: d.name }; // new drills get ids once stored
      if (d.id != null && members.includes(d.id)) continue;
      members.push(ref);
      changed = true;
    }
    return changed && members.length
      ? { name: existing ? existing.name : ps.name, id: existing ? existing.id : undefined, members } : null;
  }).filter(Boolean);
  return { add, sets: setPlan, skipped, invalid };
}
