import { describe, it, expect } from 'vitest';
import { learnSwing, findSwings } from '../src/camera/learn.js';

const S = 32;
const FRAME_MS = 1000 / 60;

// cells changed inside a rectangle of the 32×32 grid
function cellsIn(x0, y0, x1, y1, share = 1, seed = 1) {
  const c = new Uint8Array(S * S);
  let r = seed;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      r = (r * 1103515245 + 12345) % 2147483648;
      if (r / 2147483648 < share) c[y * S + x] = 1;
    }
  }
  return c;
}

// 3 s still, then swings at the given start times. Each swing: 0.9 s backswing
// (light movement), 0.3 s downswing (heavy), 0.6 s follow-through, all inside
// the golfer's area.
function session({ area = [2, 4, 12, 30], swingStarts = [5000, 11000, 17000], endMs = 22000, noise = 0 } = {}) {
  const frames = [];
  const [x0, y0, x1, y1] = area;
  for (let t = 0; t < endMs; t += FRAME_MS) {
    let cells = noise ? cellsIn(0, 0, S, S, noise, Math.round(t)) : new Uint8Array(S * S);
    for (const s of swingStarts) {
      const d = t - s;
      if (d >= 0 && d < 450) cells = cellsIn(x0, y0, x1, y1, 0.015, Math.round(t)); // slow takeaway: hardly moves
      else if (d >= 450 && d < 900) cells = cellsIn(x0, y0, x1, y1, 0.08, Math.round(t));
      else if (d >= 900 && d < 1200) cells = cellsIn(x0, y0, x1, y1, 0.35, Math.round(t));
      else if (d >= 1200 && d < 1800) cells = cellsIn(x0, y0, x1, y1, 0.25, Math.round(t));
    }
    frames.push({ t, cells });
  }
  return frames;
}

describe('learn my swing', () => {
  it('finds each practice swing', () => {
    const frames = session();
    expect(findSwings(frames.filter((f) => f.t > 3000), 0)).toHaveLength(3);
  });

  it('puts the box around the golfer, even at the edge of the picture', () => {
    const r = learnSwing(session({ area: [0, 4, 10, 30] }), 3000);
    expect(r.ok).toBe(true);
    expect(r.zone.x0).toBe(0);
    expect(r.zone.x1).toBe(12 / 32); // the swing area plus a 2-cell margin
    expect(r.zone.y0).toBeLessThanOrEqual(4 / 32);
    expect(r.zone.y1).toBeGreaterThanOrEqual(30 / 32);
  });

  it("sets movement needed to a share of the golfer's own swing", () => {
    const r = learnSwing(session(), 3000);
    expect(Math.min(...r.peaks)).toBeGreaterThan(0.15);
    expect(r.minMotion).toBeCloseTo(Math.min(...r.peaks) * 0.3, 5);
  });

  it('measures the tempo and fits the address window to it', () => {
    const r = learnSwing(session(), 3000);
    expect(r.backswingMs).toBeGreaterThan(850);
    expect(r.backswingMs).toBeLessThan(1250);
    expect(r.addressWindow[1]).toBeLessThanOrEqual(-r.backswingMs - 300);
  });

  it('copes with a scene that moves a little on its own', () => {
    const r = learnSwing(session({ noise: 0.004 }), 3000);
    expect(r.ok).toBe(true);
    expect(r.swings).toBe(3);
    expect(r.addressStill).toBeGreaterThanOrEqual(0.01);
  });

  it('says so when it saw no swings', () => {
    expect(learnSwing(session({ swingStarts: [] }), 3000)).toMatchObject({ ok: false });
  });
});
