import { describe, it, expect } from 'vitest';
import { ChunkRing } from '../src/camera/ringbuffer.js';

// 60 fps, keyframe every 30 frames (0.5 s).
function fill(ring, seconds, t0 = 1000) {
  for (let i = 0; i < seconds * 60; i++) {
    const t = t0 + (i * 1000) / 60;
    ring.push({ type: i % 30 === 0 ? 'key' : 'delta', ts: Math.round(t * 1000), t, data: new Uint8Array(10) });
  }
}

describe('chunk ring buffer', () => {
  it('keeps about keepMs of video, always starting on a keyframe', () => {
    const ring = new ChunkRing(2000);
    fill(ring, 10);
    expect(ring.items[0].type).toBe('key');
    expect(ring.spanMs).toBeGreaterThanOrEqual(2000);
    expect(ring.spanMs).toBeLessThan(2000 + 500 + 17);
  });

  it('cuts from the keyframe at or before the start', () => {
    const ring = new ChunkRing(5000);
    fill(ring, 6);
    const clip = ring.cut(3200, 4700);
    expect(clip[0].type).toBe('key');
    expect(clip[0].t).toBeLessThanOrEqual(3200);
    expect(3200 - clip[0].t).toBeLessThan(500);
    expect(clip.at(-1).t).toBeLessThanOrEqual(4700);
    expect(4700 - clip.at(-1).t).toBeLessThan(17);
  });

  it('starts at the oldest keyframe when asked for more than it holds', () => {
    const ring = new ChunkRing(1000);
    fill(ring, 4);
    const clip = ring.cut(0, 99999);
    expect(clip[0]).toBe(ring.items[0]);
    expect(clip).toHaveLength(ring.items.length);
  });

  it('returns nothing when empty or without a keyframe', () => {
    const ring = new ChunkRing(1000);
    expect(ring.cut(0, 1)).toEqual([]);
    ring.push({ type: 'delta', ts: 0, t: 0, data: new Uint8Array(1) });
    expect(ring.cut(0, 1)).toEqual([]);
  });
});
