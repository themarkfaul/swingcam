import levelWorkletUrl from '../audio/level-worklet.js?worker&url';

// Ask Safari to leave the mic signal alone: its voice processing flattens
// the sharp "crack" of impact.
export const AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export function describeAudio(track, ctx) {
  const s = track.getSettings();
  const supported = navigator.mediaDevices.getSupportedConstraints();
  return {
    label: track.label,
    settings: {
      echoCancellation: s.echoCancellation ?? null,
      noiseSuppression: s.noiseSuppression ?? null,
      autoGainControl: s.autoGainControl ?? null,
      sampleRate: s.sampleRate ?? null,
      channelCount: s.channelCount ?? null,
    },
    supportedConstraints: {
      echoCancellation: !!supported.echoCancellation,
      noiseSuppression: !!supported.noiseSuppression,
      autoGainControl: !!supported.autoGainControl,
    },
    context: {
      sampleRate: ctx.sampleRate,
      baseLatencyMs: ctx.baseLatency != null ? +(ctx.baseLatency * 1000).toFixed(1) : null,
      outputLatencyMs: ctx.outputLatency != null ? +(ctx.outputLatency * 1000).toFixed(1) : null,
      state: ctx.state,
    },
  };
}

// Feeds mic blocks to listeners as (timeMs, peak), with timeMs on the
// performance.now() clock so it can be compared with video frame times.
export async function createLevelMonitor(ctx, track) {
  await ctx.audioWorklet.addModule(levelWorkletUrl);
  const node = new AudioWorkletNode(ctx, 'level-processor');
  // The worklet only runs if it is connected to the output, so route it through silence.
  const silence = ctx.createGain();
  silence.gain.value = 0;
  node.connect(silence).connect(ctx.destination);

  let source = null;
  function setTrack(t) {
    source?.disconnect();
    source = ctx.createMediaStreamSource(new MediaStream([t]));
    source.connect(node);
  }
  setTrack(track);

  // Offset between the audio clock and performance.now(). Message delivery
  // only ever adds delay, so the smallest recent offset is the most accurate.
  // "Recent" matters: the audio clock stops while iOS suspends or interrupts
  // the context, so the offset jumps every time audio resumes.
  const OFFSET_WINDOW = 48; // ≈ 1 s of messages
  const recentOffsets = [];
  let clockOffsetMs = 0;
  const listeners = new Set();

  ctx.addEventListener('statechange', () => {
    recentOffsets.length = 0;
  });

  node.port.onmessage = ({ data }) => {
    recentOffsets.push(performance.now() - ctx.currentTime * 1000);
    if (recentOffsets.length > OFFSET_WINDOW) recentOffsets.shift();
    clockOffsetMs = Math.min(...recentOffsets);
    const sr = ctx.sampleRate;
    for (let i = 0; i < data.peaks.length; i++) {
      const frame = data.startFrame + i * data.blockSize;
      const t = (frame / sr) * 1000 + clockOffsetMs;
      for (const fn of listeners) fn(t, data.peaks[i]);
    }
  };

  return {
    setTrack,
    onBlock(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get clockOffsetMs() {
      return clockOffsetMs;
    },
  };
}

export function toDb(peak) {
  return peak > 0 ? 20 * Math.log10(peak) : -120;
}
