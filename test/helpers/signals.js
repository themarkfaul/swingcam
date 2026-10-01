// Synthetic test sounds at 48 kHz, until real range recordings exist.

export const SR = 48000;

// Small seeded random generator, so tests are repeatable.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

// Background noise with roughly the given RMS. `lowpassHz` makes it duller.
export function noise(seconds, rms, { seed = 1, lowpassHz = null } = {}) {
  const out = silence(seconds);
  const rand = rng(seed);
  const a = lowpassHz ? 1 - Math.exp((-2 * Math.PI * lowpassHz) / SR) : 1;
  let y = 0;
  let sumSq = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    y += a * (w - y);
    out[i] = y;
    sumSq += y * y;
  }
  const scale = rms / Math.sqrt(sumSq / out.length);
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}

// A club-on-ball "crack": a burst of broadband noise with a 0.3 ms attack
// and a 4 ms decay. Peak amplitude `peak`.
export function impact(peak, { seed = 7 } = {}) {
  const out = silence(0.06);
  const rand = rng(seed);
  const attack = 0.0003 * SR;
  for (let i = 0; i < out.length; i++) {
    const env = i < attack ? i / attack : Math.exp(-(i - attack) / (0.004 * SR));
    out[i] = peak * env * (rand() * 2 - 1);
  }
  return out;
}

// A voice-like vowel: 140 Hz with 25 harmonics, swelling in over 50 ms.
export function voice(peak, seconds = 0.5, { seed = 3 } = {}) {
  const out = silence(seconds);
  const rand = rng(seed);
  const phases = Array.from({ length: 25 }, () => rand() * 2 * Math.PI);
  let max = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 1; k <= 25; k++) v += Math.sin(2 * Math.PI * 140 * k * t + phases[k - 1]) / k;
    const env = Math.min(1, t / 0.05, (seconds - t) / 0.05);
    out[i] = v * env;
    max = Math.max(max, Math.abs(out[i]));
  }
  for (let i = 0; i < out.length; i++) out[i] *= peak / max;
  return out;
}

// A wind gust: low rumble swelling over 0.8 s.
export function wind(rms, seconds = 2, { seed = 5 } = {}) {
  const out = noise(seconds, rms, { seed, lowpassHz: 150 });
  for (let i = 0; i < out.length; i++) out[i] *= Math.min(1, i / SR / 0.8);
  return out;
}

// Adds `sound` into `track` starting at `atSeconds`.
export function mixAt(track, sound, atSeconds) {
  const start = Math.round(atSeconds * SR);
  for (let i = 0; i < sound.length && start + i < track.length; i++) track[start + i] += sound[i];
  return track;
}
