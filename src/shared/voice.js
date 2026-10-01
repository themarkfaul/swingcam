// Spoken prompts and beeps. iOS silences speechSynthesis while the mic is in
// use, so prompts are recorded WAV clips (public/sounds) played through Web Audio.

const CLIPS = ['5', '4', '3', '2', '1', 'start', 'got-it', 'try-again'];
const COUNTDOWN_S = 10;
const SPOKEN_FROM = 5;
const GO_BEEP_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createVoice(ctx, log = () => {}) {
  const buffers = new Map();

  async function load() {
    await Promise.all(
      CLIPS.map(async (name) => {
        try {
          const res = await fetch(`./sounds/${name}.wav`);
          buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (e) {
          log('warn', `voice clip ${name} failed`, e);
        }
      }),
    );
  }

  function say(name) {
    const buffer = buffers.get(name);
    if (!buffer) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    return true;
  }

  function beep(freq, ms, volume = 0.8) {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.setValueAtTime(volume, t + ms / 1000 - 0.02);
    gain.gain.linearRampToValueAtTime(0, t + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.05);
  }

  // Silent seconds to walk out, then "5, 4, 3, 2, 1", then a beep. Resolves
  // once the beep has finished, so the phone's own sound isn't heard as a clap.
  async function countdown(onTick = () => {}) {
    for (let s = COUNTDOWN_S; s >= 1; s--) {
      onTick(s);
      if (s <= SPOKEN_FROM && !say(String(s))) beep(660, 100);
      await sleep(1000);
    }
    onTick(0);
    beep(1320, GO_BEEP_MS);
    await sleep(GO_BEEP_MS + 50);
  }

  return { load, say, beep, countdown };
}
