// Runs on the audio thread. Reports the peak level of every 128-sample block,
// in small batches, tagged with the audio-clock frame number where the batch starts.

const BATCH = 8; // 8 blocks ≈ 21 ms at 48 kHz

class LevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peaks = new Float32Array(BATCH);
    this.count = 0;
    this.startFrame = 0;
    this.blockSize = 128;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    let peak = 0;
    if (channel) {
      this.blockSize = channel.length;
      for (let i = 0; i < channel.length; i++) {
        const v = Math.abs(channel[i]);
        if (v > peak) peak = v;
      }
    }
    if (this.count === 0) this.startFrame = currentFrame;
    this.peaks[this.count++] = peak;
    if (this.count === BATCH) {
      this.port.postMessage({
        startFrame: this.startFrame,
        blockSize: this.blockSize,
        peaks: this.peaks.slice(),
      });
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('level-processor', LevelProcessor);
