// Decodes buffered chunks into small pictures for the clap calibration,
// keeping only frames whose wall time is within [fromT, toT].
export async function decodeThumbnails({ chunks, decoderConfig, rotation }, fromT, toT, width = 200) {
  if (!chunks.length || !decoderConfig) return [];
  const wallByTs = new Map(chunks.map((c) => [c.ts, c.t]));
  const thumbs = [];
  let error = null;
  const decoder = new VideoDecoder({
    output(frame) {
      const t = wallByTs.get(frame.timestamp);
      if (t != null && t >= fromT && t <= toT) thumbs.push({ t, canvas: drawRotated(frame, rotation, width) });
      frame.close();
    },
    error(e) {
      error = e;
    },
  });
  decoder.configure(decoderConfig);
  for (const c of chunks) decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.ts, data: c.data }));
  await decoder.flush();
  decoder.close();
  if (error) throw error;
  return thumbs.sort((a, b) => a.t - b.t);
}

function drawRotated(frame, rotation, width) {
  const sideways = rotation === 90 || rotation === 270;
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  const outH = Math.round(width * (sideways ? w / h : h / w));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = outH;
  const g = canvas.getContext('2d');
  g.translate(width / 2, outH / 2);
  g.rotate((rotation * Math.PI) / 180);
  const dw = sideways ? outH : width;
  const dh = sideways ? width : outH;
  g.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
  return canvas;
}
