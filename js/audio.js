// Tone playback on the Web Audio clock.
// Tones are rendered once into AudioBuffers and every beep of a drill is scheduled in advance
// with source.start(when), so the audio hardware places each one to the sample. Nothing on
// the JS thread (rendering, GC, a throttled timer) can shift a beep once it is scheduled.

/** Sine tone with a 2 ms linear attack and 5 ms release: a sharp onset with no click. */
export function renderTone(ctx, freq, ms) {
  const rate = ctx.sampleRate;
  const frames = Math.ceil((ms / 1000) * rate);
  let attack = Math.max(1, Math.round(rate * 0.002));
  let release = Math.max(1, Math.round(rate * 0.005));
  if (attack + release > frames) { attack = release = Math.floor(frames / 4) || 1; }
  const buf = ctx.createBuffer(1, frames, rate);
  const data = buf.getChannelData(0);
  const w = (2 * Math.PI * freq) / rate;
  for (let i = 0; i < frames; i++) {
    let env = 1;
    if (i < attack) env = i / attack;
    else if (i >= frames - release) env = (frames - 1 - i) / release;
    data[i] = 0.9 * env * Math.sin(w * i);
  }
  return buf;
}

export class TonePlayer {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.pending = new Set();
    this.onStateChange = null;
  }

  /** Must be called from a user gesture the first time (browser autoplay rules). */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.ctx.onstatechange = () => this.onStateChange && this.onStateChange(this.ctx.state);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  /** Seconds between a sample being scheduled and reaching the speaker, as far as the browser knows. */
  get latency() {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  setTone(role, freq, ms) {
    this.buffers[role] = renderTone(this.ctx, freq, ms);
  }

  setTones(tones) {
    for (const [role, t] of Object.entries(tones)) this.setTone(role, t.freq, t.ms);
  }

  /** Schedule `role` at audio-clock time `when` (seconds). */
  schedule(role, when) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[role];
    src.connect(this.ctx.destination);
    src.start(Math.max(when, this.ctx.currentTime));
    this.pending.add(src);
    src.onended = () => this.pending.delete(src);
    return src;
  }

  /** Play immediately, e.g. slider preview. */
  preview(role) {
    this.cancelAll();
    this.schedule(role, this.ctx.currentTime + 0.01);
  }

  cancelAll() {
    for (const src of this.pending) {
      try { src.stop(0); } catch (_) { /* already stopped */ }
      src.disconnect();
    }
    this.pending.clear();
  }
}

/**
 * Self-check: render the drill through an OfflineAudioContext exactly as it would be scheduled
 * live, find every tone onset in the rendered samples, and compare against the plan.
 * Returns { checked, maxErrMs, maxParErrMs, onsets } or throws on a count mismatch.
 */
export async function verifyTiming(events, tones, rate = 48000, maxSeconds = 90) {
  const evs = events.filter((e) => e.t / 1000 < maxSeconds - 1);
  const lastEv = evs[evs.length - 1];
  const seconds = (lastEv.t + tones[lastEv.tone].ms) / 1000 + 0.5;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * rate), rate);
  const bufs = {};
  for (const [role, t] of Object.entries(tones)) bufs[role] = renderTone(ctx, t.freq, t.ms);
  for (const ev of evs) {
    const src = ctx.createBufferSource();
    src.buffer = bufs[ev.tone];
    src.connect(ctx.destination);
    src.start(ev.t / 1000);
  }
  const data = (await ctx.startRendering()).getChannelData(0);

  // Onset = first sample above threshold after at least 30 ms of silence.
  const quiet = Math.round(rate * 0.03);
  const onsets = [];
  let silent = quiet;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > 0.02) {
      if (silent >= quiet) onsets.push((i / rate) * 1000);
      silent = 0;
    } else silent++;
  }
  if (onsets.length !== evs.length) {
    throw new Error(`found ${onsets.length} onsets, expected ${evs.length}`);
  }
  let maxErrMs = 0, maxParErrMs = 0;
  evs.forEach((ev, k) => {
    maxErrMs = Math.max(maxErrMs, Math.abs(onsets[k] - ev.t));
    if (ev.tone === 'stop' && evs[k - 1] && evs[k - 1].tone === 'start') {
      const want = ev.t - evs[k - 1].t;
      maxParErrMs = Math.max(maxParErrMs, Math.abs(onsets[k] - onsets[k - 1] - want));
    }
  });
  return { checked: evs.length, maxErrMs, maxParErrMs, onsets };
}
