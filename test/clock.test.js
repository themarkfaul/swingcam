import { describe, it, expect } from 'vitest';
import { ClockMapper } from '../src/shared/clock.js';

describe('clock mapper', () => {
  it('uses the smallest offset, which has the least delivery delay', () => {
    const c = new ClockMapper(10);
    c.observe(100, 1000 + 100 + 7);
    c.observe(200, 1000 + 200 + 2);
    c.observe(300, 1000 + 300 + 9);
    expect(c.toWall(400)).toBe(1000 + 400 + 2);
  });

  it('follows a jump in the source clock once the window has passed', () => {
    const c = new ClockMapper(5);
    for (let i = 0; i < 5; i++) c.observe(i * 20, 1000 + i * 20);
    // Audio pauses for 3 s: the source clock stops while wall time goes on.
    for (let i = 5; i < 10; i++) c.observe(i * 20, 4000 + i * 20);
    expect(c.toWall(200)).toBe(4200);
  });

  it('after reset, the next observation takes over', () => {
    const c = new ClockMapper(48);
    c.observe(0, 1000);
    c.reset();
    expect(c.toWall(10)).toBe(1010); // keeps the old offset until new data
    c.observe(0, 5000);
    expect(c.toWall(10)).toBe(5010);
  });
});
