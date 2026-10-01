// Minimal WAV reader for test fixtures: 16-bit or 24-bit PCM, or 32-bit
// float, any channel count (mixed down to mono).

export function readWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tag = (o) => String.fromCharCode(...buffer.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');

  let fmt = null;
  let data = null;
  for (let o = 12; o + 8 <= buffer.length; ) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(o + 8, true),
        channels: view.getUint16(o + 10, true),
        sampleRate: view.getUint32(o + 12, true),
        bits: view.getUint16(o + 22, true),
      };
    } else if (id === 'data') {
      data = { offset: o + 8, size: Math.min(size, buffer.length - o - 8) };
    }
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV is missing fmt or data');

  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.size / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  const isFloat = fmt.format === 3 || (fmt.format === 0xfffe && fmt.bits === 32);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const p = data.offset + (i * fmt.channels + c) * bytes;
      if (isFloat) sum += view.getFloat32(p, true);
      else if (fmt.bits === 16) sum += view.getInt16(p, true) / 32768;
      else if (fmt.bits === 24) sum += ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 8388608);
      else throw new Error(`unsupported WAV: ${fmt.bits}-bit`);
    }
    out[i] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples: out };
}
