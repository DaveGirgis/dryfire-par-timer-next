// Drill model: validation, the rep plan, and the tone timeline.
// Pure functions, all times in integer milliseconds, no DOM or audio, so it runs under Node.

export const MIN_DELAY_MS = 300;       // no delay may go below this, random offset included
export const STEP_TONE_CLEARANCE = 150; // quiet time between the step tone and the next start tone
export const TONE_GAP_EXTRA = 60;       // step/finish tone starts this long after the stop tone ends

export const DEFAULT_TONES = {
  start:  { freq: 800,  ms: 250 },
  stop:   { freq: 1000, ms: 250 },
  step:   { freq: 900,  ms: 200 },
  finish: { freq: 1100, ms: 700 },
};

export const DEFAULT_DRILL = {
  format: 'basic',
  // basic
  par: 1.5,
  delay: 3,
  reps: 10,
  // advanced
  parStart: 2.0,
  parFinal: 1.0,
  parIncr: 0.25,
  delayFirst: 5,
  delayOther: 3,
  randomize: true,
  randomMax: 0.5,
  repCount: 5,
  repIncr: 0,
};

const ms = (seconds) => Math.round(Number(seconds) * 1000);
const isInt = (n) => Number.isInteger(Number(n));

/** Returns a list of human-readable problems; empty means the drill can run. */
export function validate(d) {
  const e = [];
  if (d.format === 'basic') {
    if (!(ms(d.par) >= 400)) e.push('Par time must be at least 0.4 s.');
    if (!(ms(d.delay) >= 500)) e.push('Delay must be at least 0.5 s.');
    if (!(isInt(d.reps) && d.reps > 0)) e.push('Reps must be a whole number above zero.');
    if (d.reps > 500) e.push('Reps must be 500 or fewer.');
  } else {
    if (!(ms(d.parStart) >= 400)) e.push('Par start must be at least 0.4 s.');
    if (!(ms(d.parFinal) >= 400)) e.push('Par final must be at least 0.4 s.');
    // Final == start is a single-step drill (advanced used just for its random delay).
    if (!(ms(d.parFinal) <= ms(d.parStart))) e.push('Par final cannot be more than par start.');
    if (ms(d.parFinal) < ms(d.parStart) && !(ms(d.parIncr) >= 100)) e.push('Reduce-by must be at least 0.1 s.');
    if (!(ms(d.delayFirst) >= 500)) e.push('First delay must be at least 0.5 s.');
    if (!(ms(d.delayOther) >= 500)) e.push('Other delay must be at least 0.5 s.');
    if (d.randomize) {
      if (!(ms(d.randomMax) >= 0)) e.push('Random amount cannot be negative.');
      if (!(ms(d.randomMax) < ms(d.delayOther))) e.push('Random amount must be less than the other delay.');
    }
    if (!(isInt(d.repCount) && d.repCount > 0)) e.push('Rep count must be a whole number above zero.');
    if (!(isInt(d.repIncr) && d.repIncr >= 0)) e.push('Rep increment must be a whole number, zero or more.');
    if (e.length === 0 && planSize(d) > 1000) e.push('Drill has more than 1000 reps; shorten it.');
  }
  return e;
}

/** Steps as [{par, count}], par in ms. */
export function steps(d) {
  if (d.format === 'basic') return [{ par: ms(d.par), count: Number(d.reps) }];
  const out = [];
  const start = ms(d.parStart), final = ms(d.parFinal), incr = ms(d.parIncr);
  if (final >= start || incr <= 0) return [{ par: start, count: Number(d.repCount) }];
  for (let k = 0, p = start; p >= final && k < 200; k++, p -= incr) {
    out.push({ par: p, count: Number(d.repCount) + k * Number(d.repIncr) });
  }
  return out;
}

function planSize(d) {
  return steps(d).reduce((n, s) => n + s.count, 0);
}

/**
 * Flat list of reps with their delay fixed up front, so a pause/resume keeps the same random
 * offsets. `rng` returns [0, 1) and is injectable for tests.
 */
export function buildPlan(d, rng = Math.random) {
  const list = steps(d);
  const first = ms(d.format === 'basic' ? d.delay : d.delayFirst);
  const other = ms(d.format === 'basic' ? d.delay : d.delayOther);
  const rand = d.format === 'advanced' && d.randomize ? ms(d.randomMax) : 0;
  const reps = [];
  list.forEach((s, si) => {
    for (let ri = 0; ri < s.count; ri++) {
      let delay = si === 0 && ri === 0 ? first : other;
      if (rand > 0 && !(si === 0 && ri === 0)) delay += Math.round((rng() * 2 - 1) * rand);
      reps.push({
        step: si, rep: ri, stepCount: list.length, repsInStep: s.count,
        par: s.par, delay: Math.max(delay, MIN_DELAY_MS),
      });
    }
  });
  return { steps: list, reps, firstDelay: first };
}

/**
 * Tone timeline starting at rep `from`, relative to t = 0 (the scheduling origin).
 * `resumeDelay` replaces the first rep's delay (used after a pause).
 * Returns { events: [{t, tone, idx}], reps: [{idx, delayAt, startAt, stopAt}], end }.
 */
export function timeline(plan, tones = DEFAULT_TONES, from = 0, resumeDelay = null) {
  const gap = tones.stop.ms + TONE_GAP_EXTRA;
  const events = [];
  const reps = [];
  let t = 0;
  for (let i = from; i < plan.reps.length; i++) {
    const r = plan.reps[i];
    let delay = i === from && resumeDelay != null ? resumeDelay : r.delay;
    // A step tone sounds during this delay; keep the start tone clear of it.
    if (i !== from && r.rep === 0) delay = Math.max(delay, gap + tones.step.ms + STEP_TONE_CLEARANCE);
    const delayAt = t;
    const startAt = t + delay;
    const stopAt = startAt + r.par;
    events.push({ t: startAt, tone: 'start', idx: i });
    events.push({ t: stopAt, tone: 'stop', idx: i });
    reps.push({ idx: i, delayAt, startAt, stopAt });
    t = stopAt;
    const last = i === plan.reps.length - 1;
    if (last) {
      events.push({ t: stopAt + gap, tone: 'finish', idx: i });
    } else if (plan.reps[i + 1].rep === 0) {
      events.push({ t: stopAt + gap, tone: 'step', idx: i });
    }
  }
  const lastEv = events[events.length - 1];
  const end = lastEv ? lastEv.t + tones[lastEv.tone].ms : 0;
  return { events, reps, end };
}

/** Estimated drill length in ms (random offsets as planned). */
export function planLength(plan, tones = DEFAULT_TONES) {
  return timeline(plan, tones).end;
}

/** Settings summary shown next to a drill's name, e.g. "15 × 2.00s" or "5 × 1.30→1.00s". */
export function drillLabel(d) {
  const s = (x) => Number(x || 0).toFixed(2);
  if (d.format === 'advanced') {
    const reps = Number(d.repIncr) > 0 ? `${d.repCount}+${d.repIncr}` : `${d.repCount}`;
    return `${reps} × ${s(d.parStart)}→${s(d.parFinal)}s`;
  }
  return `${d.reps} × ${s(d.par)}s`;
}

/** Reps completed per step, for history: [{par (s), reps}] from the first `completed` reps. */
export function completedBySteps(plan, completed) {
  const out = [];
  for (const r of plan.reps.slice(0, completed)) {
    const last = out[out.length - 1];
    if (last && last.step === r.step) last.reps++;
    else out.push({ step: r.step, par: r.par / 1000, reps: 1 });
  }
  return out.map(({ par, reps }) => ({ par, reps }));
}
