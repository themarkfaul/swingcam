import { describe, it, expect } from 'vitest';
import { zoneChange, peakChange, swingScores, looksLikeSwing } from '../src/camera/motion.js';

const S = 32;
const flat = (v) => new Float32Array(S * S).fill(v);

// A block of 6×10 cells, brighter than the background, at (x, y).
function withBlock(base, x, y, v = 200) {
  const g = Float32Array.from(base);
  for (let j = y; j < y + 10; j++) for (let i = x; i < x + 6; i++) g[j * S + i] = v;
  return g;
}

describe('movement in the zone', () => {
  it('nothing changed: no movement', () => {
    expect(zoneChange(flat(90), flat(90), S)).toBe(0);
  });

  it('ignores the whole picture getting brighter or darker', () => {
    expect(zoneChange(flat(90), flat(130), S)).toBe(0);
  });

  it('ignores small sensor noise', () => {
    const noisy = Float32Array.from(flat(90), (v, i) => v + ((i * 7919) % 11) - 5);
    expect(zoneChange(flat(90), noisy, S)).toBe(0);
  });

  it('sees something moving in the zone', () => {
    const before = withBlock(flat(60), 10, 10);
    const after = withBlock(flat(60), 14, 12);
    expect(zoneChange(before, after, S)).toBeGreaterThan(0.05);
  });

  it('ignores movement outside the zone (the edges, where the next bays are)', () => {
    const before = withBlock(flat(60), 0, 10);
    const after = withBlock(flat(60), 0, 20);
    expect(zoneChange(before, after, S)).toBe(0);
  });

  it('finds the peak within a time window', () => {
    const samples = [
      { t: 100, change: 0.5 },
      { t: 200, change: 0.02 },
      { t: 300, change: 0.09 },
      { t: 400, change: 0.01 },
    ];
    expect(peakChange(samples, 150, 450)).toEqual({ peak: 0.09, samples: 3 });
    expect(peakChange(samples, 500, 600)).toEqual({ peak: 0, samples: 0 });
  });
});

describe('swing rule', () => {
  // 60 fps samples from -1.5 s to +1 s around an impact at t = 10000 ms.
  function timeline(shape) {
    const out = [];
    for (let ms = -1500; ms <= 1000; ms += 1000 / 60) out.push({ t: 10000 + ms, change: shape(ms) });
    return out;
  }
  const swing = (ms) => (ms > -1100 && ms < -400 ? 0.04 : ms >= -400 && ms < 0 ? 0.12 : ms >= 0 && ms < 700 ? 0.1 : 0.002);
  const waggle = (ms) => (ms > -1200 && ms < -100 ? 0.05 : 0.003);
  const still = () => 0.002;

  it('a real swing passes both rules', () => {
    const s = swingScores(timeline(swing), 10000);
    expect(looksLikeSwing(s, 'window', 0.02)).toBe(true);
    expect(looksLikeSwing(s, 'swing', 0.02)).toBe(true);
  });

  it("a waggle while a neighbour hits fools the first rule, not the swing rule", () => {
    const s = swingScores(timeline(waggle), 10000);
    expect(looksLikeSwing(s, 'window', 0.02)).toBe(true);
    expect(looksLikeSwing(s, 'swing', 0.02)).toBe(false);
  });

  it('nobody moving fails both', () => {
    const s = swingScores(timeline(still), 10000);
    expect(looksLikeSwing(s, 'window', 0.02)).toBe(false);
    expect(looksLikeSwing(s, 'swing', 0.02)).toBe(false);
  });

  it('counts the samples it had', () => {
    expect(swingScores(timeline(still), 10000).samples).toBeGreaterThan(100);
    expect(swingScores([], 10000).samples).toBe(0);
  });
});
