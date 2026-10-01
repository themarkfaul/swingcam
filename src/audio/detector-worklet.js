// Runs on the audio thread: feeds every 128-sample block to the impact
// detector, posts its events, and posts levels in batches for the meter.
import { ImpactDetector } from './detector.js';

const LEVEL_BATCH = 8; // ≈ 21 ms at 48 kHz

class DetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.detector = new ImpactDetector(sampleRate);
    this.detector.armed = false;
    this.levels = [];
    this.batchStart = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'params') this.detector.setParams(data.params);
      if (data.type === 'arm') this.detector.armed = data.armed;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    const frame = currentFrame;
    if (channel) {
      for (const event of this.detector.process(channel, frame)) this.port.postMessage(event);
    }
    if (this.levels.length === 0) this.batchStart = frame;
    this.levels.push(channel ? this.detector.levelDb : -120);
    if (this.levels.length === LEVEL_BATCH) {
      this.port.postMessage({ type: 'levels', frame: this.batchStart, levels: this.levels, bgDb: this.detector.backgroundDb });
      this.levels = [];
    }
    return true;
  }
}

registerProcessor('impact-detector', DetectorProcessor);
