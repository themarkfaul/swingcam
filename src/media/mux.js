import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';

const ROTATIONS = [0, 90, 180, 270];

// Wraps H.264 chunks (starting with a keyframe) in an MP4. Chunks are
// { type, ts (µs), data }. Returns the file as an ArrayBuffer.
export async function muxH264(chunks, decoderConfig, { rotation = 0 } = {}) {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const source = new EncodedVideoPacketSource('avc');
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  output.addVideoTrack(source, { rotation: ROTATIONS.includes(r) ? r : 0 });
  await output.start();
  const t0 = chunks[0].ts;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    const durUs = next ? next.ts - c.ts : 16_667;
    const packet = new EncodedPacket(c.data, c.type, (c.ts - t0) / 1e6, durUs / 1e6);
    await source.add(packet, i === 0 ? { decoderConfig } : undefined);
  }
  await output.finalize();
  return output.target.buffer;
}
