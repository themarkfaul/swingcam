import { describe, it, expect } from 'vitest';
import { zoneChange, peakChange } from '../src/camera/motion.js';

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
