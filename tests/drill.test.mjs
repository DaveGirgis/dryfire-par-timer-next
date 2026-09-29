import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DRILL, DEFAULT_TONES, MIN_DELAY_MS, TONE_GAP_EXTRA, STEP_TONE_CLEARANCE,
  validate, steps, buildPlan, timeline,
} from '../js/drill.js';

const basic = (o = {}) => ({ ...DEFAULT_DRILL, format: 'basic', par: 1, delay: 2, reps: 10, ...o });
const adv = (o = {}) => ({ ...DEFAULT_DRILL, format: 'advanced', ...o });
const gap = DEFAULT_TONES.stop.ms + TONE_GAP_EXTRA;

test('basic drill: start-to-stop equals par and delay is measured from the previous stop', () => {
  const plan = buildPlan(basic());
  const tl = timeline(plan);
  assert.equal(tl.reps.length, 10);
  tl.reps.forEach((r, i) => {
    assert.equal(r.stopAt - r.startAt, 1000);
    assert.equal(r.startAt - r.delayAt, 2000);
    if (i > 0) assert.equal(r.delayAt, tl.reps[i - 1].stopAt);
  });
  // 10 × (2 s + 1 s), no accumulated drift, then the finish tone.
  assert.equal(tl.reps[9].stopAt, 30000);
  const fin = tl.events.at(-1);
  assert.deepEqual([fin.tone, fin.t], ['finish', 30000 + gap]);
  assert.equal(tl.events.filter((e) => e.tone === 'step').length, 0);
});

test('float inputs do not accumulate error', () => {
  const tl = timeline(buildPlan(basic({ par: 0.1 * 3 + 0.1 + 0.05, delay: 0.7, reps: 300 })));
  tl.reps.forEach((r) => assert.equal(r.stopAt - r.startAt, 450));
  assert.equal(tl.reps.at(-1).stopAt, 300 * (700 + 450));
});

test('advanced steps: par start down to final, extra reps per step', () => {
  const s = steps(adv({ parStart: 2, parFinal: 1, parIncr: 0.25, repCount: 3, repIncr: 1 }));
  assert.deepEqual(s, [
    { par: 2000, count: 3 }, { par: 1750, count: 4 }, { par: 1500, count: 5 },
    { par: 1250, count: 6 }, { par: 1000, count: 7 },
  ]);
  // Final not on the increment grid: last step stays above final, as the original help describes.
  assert.deepEqual(steps(adv({ parStart: 2, parFinal: 1.2, parIncr: 0.3 })).map((x) => x.par), [2000, 1700, 1400]);
});

test('advanced: first delay only on the very first rep; step and finish tones in place', () => {
  const plan = buildPlan(adv({ parStart: 1.5, parFinal: 1, parIncr: 0.5, repCount: 2, delayFirst: 5,
    delayOther: 2, randomize: false }));
  const tl = timeline(plan);
  assert.deepEqual(tl.reps.map((r) => r.startAt - r.delayAt), [5000, 2000, 2000, 2000]);
  assert.deepEqual(tl.events.map((e) => e.tone),
    ['start', 'stop', 'start', 'stop', 'step', 'start', 'stop', 'start', 'stop', 'finish']);
  const stepEv = tl.events.find((e) => e.tone === 'step');
  assert.equal(stepEv.t, tl.reps[1].stopAt + gap);
});

test('random offsets stay within ± max, never on the first rep, never under the floor', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const d = adv({ parStart: 1, parFinal: 0.5, parIncr: 0.5, repCount: 200, delayFirst: 4, delayOther: 1,
    randomize: true, randomMax: 0.9 });
  const plan = buildPlan(d, rng);
  assert.equal(plan.reps[0].delay, 4000);
  const others = plan.reps.slice(1).map((r) => r.delay);
  others.forEach((x) => assert.ok(x >= MIN_DELAY_MS && x <= 1900, `delay ${x}`));
  assert.ok(Math.min(...others) === MIN_DELAY_MS, 'floor should be hit with a 0.9 s offset on 1 s');
  assert.ok(new Set(others).size > 50, 'offsets should vary continuously');
});

test('start tone never collides with a step tone', () => {
  const plan = buildPlan(adv({ parStart: 1, parFinal: 0.5, parIncr: 0.5, repCount: 2, delayFirst: 0.5,
    delayOther: 0.5, randomize: false }));
  const tl = timeline(plan);
  const stepEv = tl.events.find((e) => e.tone === 'step');
  const nextStart = tl.events.find((e) => e.tone === 'start' && e.t > stepEv.t);
  assert.ok(nextStart.t >= stepEv.t + DEFAULT_TONES.step.ms + STEP_TONE_CLEARANCE);
});

test('resume replays from the given rep with the resume delay', () => {
  const plan = buildPlan(basic({ reps: 5 }));
  const tl = timeline(plan, DEFAULT_TONES, 3, 4000);
  assert.deepEqual(tl.reps.map((r) => r.idx), [3, 4]);
  assert.equal(tl.reps[0].startAt, 4000);
  assert.equal(tl.reps[1].startAt, 4000 + 1000 + 2000);
});

test('validation mirrors the original rules', () => {
  assert.deepEqual(validate(basic()), []);
  assert.deepEqual(validate(adv()), []);
  assert.ok(validate(basic({ par: 0.3 })).length);
  assert.ok(validate(basic({ delay: 0.4 })).length);
  assert.ok(validate(basic({ reps: 2.5 })).length);
  assert.ok(validate(adv({ parFinal: 2.5 })).length);
  assert.deepEqual(validate(adv({ parIncr: 0.1 })), []);   // E3 Draw uses 0.1
  assert.ok(validate(adv({ parIncr: 0.05 })).length);
  // Fast Draw: advanced, start == final, no reduce-by → one step
  const single = adv({ parStart: 1.3, parFinal: 1.3, parIncr: 0, repCount: 10 });
  assert.deepEqual(validate(single), []);
  assert.deepEqual(steps(single), [{ par: 1300, count: 10 }]);
  assert.ok(validate(adv({ randomMax: 3 })).length);
  assert.deepEqual(validate(adv({ randomize: false, randomMax: 99 })), []);
});
