// Runs the detector over real recordings in test/fixtures/. Each recording
// `name.wav` needs a `name.json` next to it listing when the real impacts
// happen. See test/fixtures/README.md.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ImpactDetector } from '../src/audio/detector.js';
import { readWav } from './helpers/wav.js';

const dir = join(import.meta.dirname, 'fixtures');
const recordings = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.wav') && existsSync(join(dir, f.replace(/\.wav$/, '.json')))) : [];

describe.skipIf(recordings.length === 0)('real range recordings', () => {
  for (const file of recordings) {
    it(file, () => {
      const labels = JSON.parse(readFileSync(join(dir, file.replace(/\.wav$/, '.json')), 'utf8'));
      const { sampleRate, samples } = readWav(readFileSync(join(dir, file)));
      const det = new ImpactDetector(sampleRate, labels.params ?? {});
      const triggers = [];
      for (let off = 0; off < samples.length; off += 128) {
        for (const e of det.process(samples.subarray(off, off + 128), off)) {
          if (e.type === 'trigger') triggers.push(e.frame / sampleRate);
        }
      }
      const tolerance = labels.toleranceS ?? 0.05;
      const missed = labels.impacts.filter((s) => !triggers.some((t) => Math.abs(t - s) <= tolerance));
      const falseTriggers = triggers.filter((t) => !labels.impacts.some((s) => Math.abs(t - s) <= tolerance));
      expect({ missed, falseTriggers }).toEqual({ missed: [], falseTriggers: [] });
    });
  }
});
