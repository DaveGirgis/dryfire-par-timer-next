// IndexedDB storage. Small promise wrapper, one database:
//   drills   {id, name, description, format, ...drill fields, created, updated}
//   sets     {id, name, members: [drillId, ...] in order}
//   history  {id, drillId, par (s), reps, at 'YYYY-MM-DD HH:mm[:ss]'}   index drillId
//   sessions {id, start, end, seconds}   practice time per run
//   meta     {key, value}

const NAME = 'par-timer';
const VERSION = 1;
const STORES = ['drills', 'sets', 'history', 'sessions', 'meta'];

let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('drills', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('sets', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('history', { keyPath: 'id', autoIncrement: true }).createIndex('drillId', 'drillId');
      db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Ask the browser not to evict this data under storage pressure (granted silently for installed PWAs).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return dbp;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Run `fn(stores)` in one transaction; resolves with fn's return value once committed. */
async function tx(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let result;
    Promise.resolve(fn(stores)).then((r) => { result = r; }, (e) => { t.abort(); reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export const getAll = (store) => tx([store], 'readonly', (s) => wrap(s[store].getAll()));
export const get = (store, key) => tx([store], 'readonly', (s) => wrap(s[store].get(key)));
export const put = (store, value) => tx([store], 'readwrite', (s) => wrap(s[store].put(value)));
export const del = (store, key) => tx([store], 'readwrite', (s) => wrap(s[store].delete(key)));

export const getMeta = async (key, fallback = null) => {
  const row = await get('meta', key);
  return row ? row.value : fallback;
};
export const setMeta = (key, value) => put('meta', { key, value });

export const historyFor = (drillId) =>
  tx(['history'], 'readonly', (s) => wrap(s.history.index('drillId').getAll(drillId)));

export async function counts() {
  return tx(STORES, 'readonly', async (s) => ({
    drills: await wrap(s.drills.count()),
    history: await wrap(s.history.count()),
    sessions: await wrap(s.sessions.count()),
    sets: await wrap(s.sets.count()),
  }));
}

/** One run finished: its per-step history rows and practice time, atomically. */
export function recordRun(drillId, steps, at, session) {
  return tx(['history', 'sessions'], 'readwrite', (s) => {
    for (const st of steps) s.history.add({ drillId, par: st.par, reps: st.reps, at });
    if (session) s.sessions.add(session);
  });
}

/** Delete a drill, its history, and its set memberships. */
export function deleteDrill(id) {
  return tx(['drills', 'history', 'sets'], 'readwrite', async (s) => {
    s.drills.delete(id);
    const keys = await wrap(s.history.index('drillId').getAllKeys(id));
    for (const k of keys) s.history.delete(k);
    const sets = await wrap(s.sets.getAll());
    for (const set of sets) {
      if (set.members.includes(id)) s.sets.put({ ...set, members: set.members.filter((m) => m !== id) });
    }
  });
}

/** Replace the whole library (import). Meta is kept except the pointers into the old data. */
export function replaceAll({ drills, sets, history, sessions }) {
  return tx(STORES, 'readwrite', (s) => {
    for (const n of ['drills', 'sets', 'history', 'sessions']) s[n].clear();
    s.meta.delete('currentDrill');
    s.meta.delete('currentSet');
    for (const d of drills) s.drills.put(d);
    for (const x of sets) s.sets.put(x);
    for (const h of history) s.history.add(h);
    for (const x of sessions) s.sessions.add(x);
  });
}

export async function exportAll() {
  return tx(STORES, 'readonly', async (s) => ({
    app: 'par-timer',
    format: 1,
    exported: new Date().toISOString(),
    drills: await wrap(s.drills.getAll()),
    sets: await wrap(s.sets.getAll()),
    history: await wrap(s.history.getAll()),
    sessions: await wrap(s.sessions.getAll()),
  }));
}

/** Apply a planMerge() result in one transaction. Returns the ids of the added drills. */
export function applyMerge(plan, when) {
  return tx(['drills', 'sets'], 'readwrite', async (s) => {
    const idByName = new Map();
    for (const d of plan.add) {
      const id = await wrap(s.drills.add({ ...d, created: when, updated: when }));
      idByName.set(d.name.toLowerCase(), id);
    }
    for (const set of plan.sets) {
      const members = set.members
        .map((m) => (typeof m === 'object' ? idByName.get(m.name.toLowerCase()) : m))
        .filter((m) => m != null);
      const rec = { name: set.name, members };
      if (set.id != null) rec.id = set.id;
      await wrap(s.sets.put(rec));
    }
    return [...idByName.values()];
  });
}
