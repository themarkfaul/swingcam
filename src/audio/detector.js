// Impact detector. Plain code with no browser APIs, so the same logic runs in
// the AudioWorklet on the phone and in the Node tests.
//
// A club hitting a ball is a sharp "crack": it is loud in the treble, and it
// goes from background to full level within a few milliseconds. Voices and
// wind are mostly low-pitched and swell up over tens of milliseconds. So, per
// 128-sample block (2.7 ms at 48 kHz):
//   1. high-pass the signal at about 2 kHz and take the block's peak level,
//   2. track the background level, which follows quiet stretches quickly and
//      loud ones slowly, so it ignores short spikes,
//   3. trigger when the level is far enough above background, it rose fast,
//      enough of the block's energy is treble, and it's loud enough at all,
//   4. then ignore everything for the refractory period.

export const DETECTOR_DEFAULTS = {
  thresholdDb: 20, // how far above background
  riseDb: 12, // how much louder than 5–11 ms earlier
  minHfRatio: 0.1, // share of the block's energy above the high-pass
  minLevelDb: -60, // ignore anything quieter than this (dBFS)
  refractoryMs: 3000,
  highpassHz: 2000,
};

const BLOCK = 128;
const BG_FALL_S = 0.5; // background follows quieter sound within about 0.5 s
const BG_RISE_S = 4; // ...and louder sound only over about 4 s
const BG_HOLD_MS = 300; // don't let an impact's own ring-down raise the background
const RISE_FROM = 2; // "before" level = loudest of the blocks 2–4 back
const RISE_TO = 4;
const REJECT_EVERY_MS = 500; // report near-misses at most this often
const FLOOR_DB = -120;
// Digital silence: the mic hasn't started, or iOS paused audio. When sound
// comes back, the background jumps straight to the new level, and nothing
// triggers until it has had WARMUP_MS of sound to settle.
const SILENCE_DB = -100;
const WARMUP_MS = 500;

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

export class ImpactDetector {
  constructor(sampleRate, params = {}) {
    this.sampleRate = sampleRate;
    this.params = { ...DETECTOR_DEFAULTS, ...params };
    this.armed = true;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.bg = null;
    this.history = new Float32Array(RISE_TO + 1).fill(FLOOR_DB);
    this.historyPos = 0;
    this.lastTriggerFrame = -Infinity;
    this.lastRejectFrame = -Infinity;
    this.levelDb = FLOOR_DB;
    this.hfRatio = 0;
    this.soundMs = 0; // how long since the last digital silence
    this.filtered = new Float32Array(BLOCK);
    const blockS = BLOCK / sampleRate;
    this.blockMs = blockS * 1000;
    this.bgFall = 1 - Math.exp(-blockS / BG_FALL_S);
    this.bgRise = 1 - Math.exp(-blockS / BG_RISE_S);
    this.bgWarmup = 1 - Math.exp(-blockS / 0.05);
    this.setHighpass(this.params.highpassHz);
  }

  setParams(params) {
    const hpChanged = params.highpassHz != null && params.highpassHz !== this.params.highpassHz;
    Object.assign(this.params, params);
    if (hpChanged) this.setHighpass(this.params.highpassHz);
  }

  // 2nd-order Butterworth high-pass (RBJ cookbook).
  setHighpass(hz) {
    const w0 = (2 * Math.PI * hz) / this.sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  get backgroundDb() {
    return this.bg ?? FLOOR_DB;
  }

  // Processes any number of samples. `startFrame` is the sample index of
  // input[0] on the audio clock. Returns trigger and reject events.
  process(input, startFrame) {
    const events = [];
    for (let off = 0; off < input.length; off += BLOCK) {
      const n = Math.min(BLOCK, input.length - off);
      const event = this.processBlock(input, off, n, startFrame + off);
      if (event) events.push(event);
    }
    return events;
  }

  processBlock(x, off, n, frame) {
    const { b0, b1, b2, a1, a2 } = this;
    const y = this.filtered;
    let { x1, x2, y1, y2 } = this;
    let peak = 0;
    let hpEnergy = 0;
    let fullEnergy = 0;
    for (let i = 0; i < n; i++) {
      const xi = x[off + i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = yi;
      y[i] = yi;
      const a = yi < 0 ? -yi : yi;
      if (a > peak) peak = a;
      hpEnergy += yi * yi;
      fullEnergy += xi * xi;
    }
    Object.assign(this, { x1, x2, y1, y2 });

    const level = Math.max(FLOOR_DB, 20 * Math.log10(peak + 1e-12));
    const hf = fullEnergy > 0 ? hpEnergy / fullEnergy : 0;
    const len = this.history.length;
    let before = FLOOR_DB;
    for (let k = RISE_FROM; k <= RISE_TO; k++) {
      const v = this.history[(this.historyPos - k + len * 2) % len];
      if (v > before) before = v;
    }
    if (level <= SILENCE_DB) {
      this.soundMs = 0;
    } else {
      if (this.soundMs === 0 || this.bg === null) this.bg = level;
      this.soundMs += (n / BLOCK) * this.blockMs;
    }
    if (this.bg === null) this.bg = level;
    const bg = this.bg;
    const snr = level - bg;
    const rise = level - before;
    const p = this.params;
    const msSinceTrigger = ((frame - this.lastTriggerFrame) / this.sampleRate) * 1000;

    let event = null;
    if (this.armed && this.soundMs >= WARMUP_MS && snr >= p.thresholdDb) {
      let reason = null;
      if (msSinceTrigger < p.refractoryMs) reason = 'within refractory';
      else if (level < p.minLevelDb) reason = 'too quiet';
      else if (rise < p.riseDb) reason = 'slow rise';
      else if (hf < p.minHfRatio) reason = 'not sharp';
      const info = { levelDb: round1(level), bgDb: round1(bg), snrDb: round1(snr), riseDb: round1(rise), hfRatio: round2(hf) };

      if (!reason) {
        // Sample-accurate onset: first sample reaching half the block's peak.
        let onset = 0;
        const half = peak / 2;
        for (let i = 0; i < n; i++) {
          if ((y[i] < 0 ? -y[i] : y[i]) >= half) {
            onset = i;
            break;
          }
        }
        event = { type: 'trigger', frame: frame + onset, ...info };
        this.lastTriggerFrame = frame + onset;
      } else {
        const ringDown = reason === 'within refractory' && msSinceTrigger < BG_HOLD_MS;
        const msSinceReject = ((frame - this.lastRejectFrame) / this.sampleRate) * 1000;
        if (!ringDown && msSinceReject >= REJECT_EVERY_MS) {
          event = { type: 'reject', reason, frame, ...info };
          this.lastRejectFrame = frame;
        }
      }
    }

    if (this.soundMs < WARMUP_MS) {
      // Settling after silence: follow the sound quickly both ways.
      this.bg = bg + (level - bg) * this.bgWarmup;
    } else if (msSinceTrigger >= BG_HOLD_MS) {
      this.bg = bg + (level - bg) * (level < bg ? this.bgFall : this.bgRise);
    }
    this.history[this.historyPos] = level;
    this.historyPos = (this.historyPos + 1) % len;
    this.levelDb = level;
    this.hfRatio = hf;
    return event;
  }
}
