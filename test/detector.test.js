import { describe, it, expect } from 'vitest';
import { ImpactDetector } from '../src/audio/detector.js';
import { SR, noise, impact, voice, wind, mixAt, silence } from './helpers/signals.js';

// Feeds the track in 128-sample blocks, like the AudioWorklet does.
function run(track, params = {}) {
  const det = new ImpactDetector(SR, params);
  const events = [];
  for (let off = 0; off < track.length; off += 128) {
    events.push(...det.process(track.subarray(off, off + 128), off));
  }
  return {
    triggers: events.filter((e) => e.type === 'trigger').map((e) => ({ ...e, s: e.frame / SR })),
    rejects: events.filter((e) => e.type === 'reject'),
  };
}

const quiet = (seconds) => noise(seconds, 0.002, { seed: 11 }); // about −54 dBFS RMS

describe('impact detector', () => {
  it('finds a single impact, to within a millisecond', () => {
    const track = mixAt(quiet(3), impact(0.5), 1.5);
    const { triggers } = run(track);
    expect(triggers).toHaveLength(1);
    expect(Math.abs(triggers[0].s - 1.5)).toBeLessThan(0.001);
  });

  it('ignores a second impact within the refractory period', () => {
    const track = mixAt(mixAt(quiet(4), impact(0.5), 1.0), impact(0.5, { seed: 8 }), 2.0);
    expect(run(track).triggers).toHaveLength(1);
  });

  it('catches impacts that are more than the refractory period apart', () => {
    const track = mixAt(mixAt(quiet(6), impact(0.5), 1.0), impact(0.5, { seed: 8 }), 4.5);
    const { triggers } = run(track);
    expect(triggers.map((t) => Math.round(t.s * 10) / 10)).toEqual([1.0, 4.5]);
  });

  it('respects a custom refractory period', () => {
    const track = mixAt(mixAt(quiet(4), impact(0.5), 1.0), impact(0.5, { seed: 8 }), 2.0);
    expect(run(track, { refractoryMs: 800 }).triggers).toHaveLength(2);
  });

  it('does not trigger on a loud voice', () => {
    const track = mixAt(quiet(3), voice(0.6), 1.0);
    expect(run(track).triggers).toHaveLength(0);
  });

  it('does not trigger on a wind gust', () => {
    const track = mixAt(quiet(4), wind(0.2), 0.5);
    expect(run(track).triggers).toHaveLength(0);
  });

  it('does not trigger when sound starts after silence, and catches an impact soon after', () => {
    // Like the mic starting, or iOS resuming audio after a pause.
    const track = silence(4);
    track.set(quiet(3), Math.round(0.5 * SR));
    mixAt(track, impact(0.5), 1.5);
    const { triggers } = run(track);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].s).toBeCloseTo(1.5, 2);
  });

  it('settles on the real background even if sound fades in after silence', () => {
    const track = silence(3);
    const bg = quiet(2.5);
    for (let i = 0; i < 0.05 * SR; i++) bg[i] *= i / (0.05 * SR); // 50 ms fade-in
    track.set(bg, Math.round(0.5 * SR));
    const det = new ImpactDetector(SR);
    det.process(track, 0);
    const settled = new ImpactDetector(SR);
    settled.process(quiet(2.5), 0);
    expect(Math.abs(det.backgroundDb - settled.backgroundDb)).toBeLessThan(3);
  });

  it('does not trigger on silence or steady noise', () => {
    expect(run(silence(2)).triggers).toHaveLength(0);
    expect(run(noise(5, 0.05, { seed: 2 })).triggers).toHaveLength(0);
  });

  it('works over a busy background, but not for impacts barely above it', () => {
    const busy = () => noise(4, 0.01, { seed: 4 });
    expect(run(mixAt(busy(), impact(0.5), 2.0)).triggers).toHaveLength(1);
    expect(run(mixAt(busy(), impact(0.06), 2.0)).triggers).toHaveLength(0);
  });

  it('sensitivity setting decides whether a quieter impact counts', () => {
    const track = mixAt(quiet(3), impact(0.02), 1.5);
    expect(run(track, { thresholdDb: 30 }).triggers).toHaveLength(0);
    expect(run(track, { thresholdDb: 12 }).triggers).toHaveLength(1);
  });

  it("minimum loudness can tune out a neighbour's quieter impact", () => {
    const track = mixAt(mixAt(quiet(8), impact(0.5), 1.0), impact(0.05, { seed: 9 }), 5.0);
    expect(run(track).triggers).toHaveLength(2);
    const tuned = run(track, { minLevelDb: -20 });
    expect(tuned.triggers).toHaveLength(1);
    expect(tuned.triggers[0].s).toBeCloseTo(1.0, 2);
    expect(tuned.rejects.map((r) => r.reason)).toContain('too quiet');
  });

  it('reports why a loud sound was ignored', () => {
    const track = mixAt(quiet(3), voice(0.6), 1.0);
    const { rejects } = run(track);
    expect(rejects.length).toBeGreaterThan(0);
    expect(['slow rise', 'not sharp']).toContain(rejects[0].reason);
  });

  it('stays quiet while disarmed, then works once armed', () => {
    const track = mixAt(mixAt(quiet(6), impact(0.5), 1.0), impact(0.5, { seed: 8 }), 4.5);
    const det = new ImpactDetector(SR);
    det.armed = false;
    const events = [];
    for (let off = 0; off < track.length; off += 128) {
      if (off >= 3 * SR) det.armed = true;
      events.push(...det.process(track.subarray(off, off + 128), off));
    }
    const triggers = events.filter((e) => e.type === 'trigger');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].frame / SR).toBeCloseTo(4.5, 2);
  });

  it('reports trigger details for the log', () => {
    const [t] = run(mixAt(quiet(3), impact(0.5), 1.5)).triggers;
    expect(t.snrDb).toBeGreaterThan(20);
    expect(t.riseDb).toBeGreaterThan(12);
    expect(t.hfRatio).toBeGreaterThan(0.1);
    expect(t.levelDb).toBeLessThan(0);
  });
});
