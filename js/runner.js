// Drill runner: schedules a plan on the TonePlayer and reports where the drill is.
// Position is read from the audio clock minus output latency, i.e. what the shooter is
// hearing right now, so the display follows the beeps rather than running ahead of them.

import { timeline } from './drill.js';

const LEAD_S = 0.15; // scheduling headroom before the first event

export class DrillRunner {
  constructor(player) {
    this.player = player;
    this.state = 'idle'; // idle | running | paused | finished | stopped
    this.plan = null;
    this.tones = null;
    this.tl = null;
    this.origin = 0;
    this.pausedIdx = 0;
    this.onEnd = null; // (state, completedReps) => void
  }

  start(plan, tones) {
    this.plan = plan;
    this.tones = tones;
    this._run(0, null);
  }

  _run(from, resumeDelay) {
    this.player.cancelAll();
    this.tl = timeline(this.plan, this.tones, from, resumeDelay);
    this.origin = this.player.now + LEAD_S;
    for (const ev of this.tl.events) this.player.schedule(ev.tone, this.origin + ev.t / 1000);
    this.state = 'running';
  }

  /** Drill time (ms since origin) the listener is hearing now. */
  _heardMs() {
    return (this.player.now - this.player.latency - this.origin) * 1000;
  }

  _completedAt(t) {
    let n = this.tl.reps.length ? this.tl.reps[0].idx : 0;
    for (const r of this.tl.reps) if (r.stopAt <= t) n = r.idx + 1;
    return n;
  }

  /** Snapshot for the UI. Also detects the natural end of the drill. */
  status() {
    const plan = this.plan;
    if (this.state !== 'running') {
      const idx = this.state === 'paused' ? this.pausedIdx : 0;
      return { state: this.state, rep: plan && plan.reps[idx], idx, total: plan ? plan.reps.length : 0 };
    }
    const t = Math.max(0, this._heardMs());
    if (t >= this.tl.end) {
      this.state = 'finished';
      this.onEnd && this.onEnd('finished', plan.reps.length);
      return this.status();
    }
    const cur = this.tl.reps.find((r) => t < r.stopAt);
    const total = plan.reps.length;
    if (!cur) {
      return { state: 'running', phase: 'finishing', idx: total - 1, rep: plan.reps[total - 1],
        total, remainingMs: this.tl.end - t };
    }
    const phase = t < cur.startAt ? 'delay' : 'par';
    return {
      state: 'running', phase, idx: cur.idx, rep: plan.reps[cur.idx], total,
      parLeftMs: phase === 'par' ? cur.stopAt - t : plan.reps[cur.idx].par,
      remainingMs: this.tl.end - t,
    };
  }

  /** Cancels pending beeps. Resume repeats the rep that was in progress. */
  pause() {
    if (this.state !== 'running') return;
    const t = this._heardMs();
    if (t >= this.tl.reps[this.tl.reps.length - 1].stopAt) return; // only the finish tone is left
    this.player.cancelAll();
    this.pausedIdx = this._completedAt(t);
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    this._run(this.pausedIdx, this.plan.firstDelay);
  }

  stop() {
    if (this.state !== 'running' && this.state !== 'paused') return;
    const done = this.state === 'paused' ? this.pausedIdx : this._completedAt(this._heardMs());
    this.player.cancelAll();
    this.state = 'stopped';
    this.onEnd && this.onEnd('stopped', done);
  }
}
