import { describe, it, expect } from 'vitest';
import { SNAP, rotateSquare, bestRotation } from '../src/camera/orientation.js';

// A picture with a clear "up": bright top-left corner, a dark bar along the bottom.
function scene() {
  const g = new Float32Array(SNAP * SNAP);
  for (let y = 0; y < SNAP; y++) {
    for (let x = 0; x < SNAP; x++) {
      let v = 100 + x * 2;
      if (x < 10 && y < 10) v = 250;
      if (y > 26) v = 10;
      g[y * SNAP + x] = v;
    }
  }
  return g;
}

describe('orientation', () => {
  it('rotating four times by 90° gives back the original', () => {
    const s = scene();
    let r = s;
    for (let i = 0; i < 4; i++) r = rotateSquare(r, SNAP, 90);
    expect(Array.from(r)).toEqual(Array.from(s));
  });

  it('90° clockwise moves the top-left corner to the top-right', () => {
    const r = rotateSquare(scene(), SNAP, 90);
    expect(r[0 * SNAP + (SNAP - 1)]).toBe(250);
    expect(r[0]).not.toBe(250);
  });

  for (const sensor of [0, 90, 180, 270]) {
    it(`finds the rotation when the sensor is turned ${sensor}°`, () => {
      const upright = scene();
      // The frame is the upright picture turned back by `sensor` degrees.
      const frame = rotateSquare(upright, SNAP, (360 - sensor) % 360);
      const swapped = sensor === 90 || sensor === 270;
      const result = bestRotation(upright, frame, true, swapped ? false : true);
      expect(result.rotation).toBe(sensor);
      expect(result.confident).toBe(true);
    });
  }

  it('falls back to 90° for a featureless portrait scene', () => {
    const flat = new Float32Array(SNAP * SNAP).fill(80);
    const result = bestRotation(flat, flat, true, false);
    expect(result).toMatchObject({ rotation: 90, confident: false });
  });
});
