import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink, Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource } from 'mediabunny';

// Makes a slow-motion copy of a clip without re-encoding: every frame is kept
// and its timing stretched by `factor` (2 = half speed, 4 = quarter speed).
// A 60 fps clip at quarter speed plays back at 15 fps.
export async function retimeMp4(blob, factor) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const decoderConfig = await track.getDecoderConfig();
  const rotation = await track.getRotation();

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source, { rotation });
  await output.start();
  let first = true;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    const slowed = packet.clone({ timestamp: packet.timestamp * factor, duration: packet.duration * factor });
    await source.add(slowed, first ? { decoderConfig } : undefined);
    first = false;
  }
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
