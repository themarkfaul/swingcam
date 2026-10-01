import workletUrl from './detector-worklet.js?worker&url';
import { ClockMapper, wallNow } from '../shared/clock.js';

// Ask Safari to leave the mic signal alone. Only echoCancellation is
// honored on iOS (see NOTES.md); the others are harmless to ask for.
export const AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

// Runs the impact detector on whatever source is connected (mic or a video
// file) and reports its events with `t` on the wallNow() clock.
export async function createListener(ctx, onEvent) {
  await ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(ctx, 'impact-detector', {
    channelCount: 1,
    channelCountMode: 'explicit', // mix stereo files down to mono
  });
  // The worklet only runs if it is connected to the output, so route it through silence.
  const silence = ctx.createGain();
  silence.gain.value = 0;
  node.connect(silence).connect(ctx.destination);

  const clock = new ClockMapper(48);
  ctx.addEventListener('statechange', () => clock.reset());

  node.port.onmessage = ({ data }) => {
    clock.observe(ctx.currentTime * 1000, wallNow());
    const t = clock.toWall((data.frame / ctx.sampleRate) * 1000);
    onEvent({ ...data, t });
  };

  let source = null;
  return {
    connect(src) {
      source?.disconnect(node);
      source = src;
      src.connect(node);
    },
    setParams(params) {
      node.port.postMessage({ type: 'params', params });
    },
    arm(armed) {
      node.port.postMessage({ type: 'arm', armed });
    },
  };
}
