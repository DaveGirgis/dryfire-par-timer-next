// History summaries. Pure; `rows` are history records {par, reps, at}.

const day = 86400000;

/** Local calendar-day difference between now and a 'YYYY-MM-DD…' stamp (0 = today). */
export function daysAgo(at, now = new Date()) {
  const [y, m, d] = at.slice(0, 10).split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - then) / day);
}

function agg(rows) {
  const reps = rows.reduce((n, r) => n + r.reps, 0);
  const weight = reps || rows.length;
  const avgPar = rows.length
    ? rows.reduce((s, r) => s + r.par * (reps ? r.reps : 1), 0) / weight : null;
  return { runs: rows.length, reps, avgPar };
}

/** The original app's windows: 1–7 days, 8–14, 15–30, lifetime. */
export function windows(rows, now = new Date()) {
  const within = (lo, hi) => rows.filter((r) => { const a = daysAgo(r.at, now); return a >= lo && a <= hi; });
  return [
    { label: 'Last 7 days', ...agg(within(0, 6)) },
    { label: '8–14 days', ...agg(within(7, 13)) },
    { label: '15–30 days', ...agg(within(14, 29)) },
    { label: 'Lifetime', ...agg(rows) },
  ];
}

/** Per par time: runs, reps, last date. Fastest par first. */
export function byPar(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = Math.round(r.par * 100);
    const e = m.get(k) || { par: k / 100, runs: 0, reps: 0, last: '' };
    e.runs++; e.reps += r.reps;
    if (r.at > e.last) e.last = r.at;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.par - b.par);
}

/** Local timestamp in the same shape the old app used, sortable as text. */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
