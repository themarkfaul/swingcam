// Works out how the encoder's frames must be rotated to look like the
// preview. On iOS the preview is shown upright, but the frames a worker reads
// stay in the sensor's orientation and carry no rotation information.
//
// Both pictures are shrunk to the same small square (stretched). Stretching to
// a square and then rotating gives the same result as rotating and then
// stretching, so we can simply try the four rotations of the frame's square
// and see which matches the preview's.

export const SNAP = 32; // side of the comparison square

export function rotateSquare(gray, size, rotation) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sx = x;
      let sy = y;
      // Pixel (x, y) of the output comes from (sx, sy) of the input, for a clockwise rotation.
      if (rotation === 90) [sx, sy] = [y, size - 1 - x];
      else if (rotation === 180) [sx, sy] = [size - 1 - x, size - 1 - y];
      else if (rotation === 270) [sx, sy] = [size - 1 - y, x];
      out[y * size + x] = gray[sy * size + sx];
    }
  }
  return out;
}

function normalize(a) {
  let mean = 0;
  for (const v of a) mean += v;
  mean /= a.length;
  let sd = 0;
  for (const v of a) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / a.length) || 1;
  return Float32Array.from(a, (v) => (v - mean) / sd);
}

function difference(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// preview, frame: SNAP×SNAP grayscale arrays. previewPortrait/framePortrait:
// whether each picture is taller than wide. Returns { rotation, confident, scores }.
export function bestRotation(preview, frame, previewPortrait, framePortrait) {
  // Only rotations that give the frame the preview's shape are possible.
  const candidates = previewPortrait === framePortrait ? [0, 180] : [90, 270];
  const p = normalize(preview);
  const scores = {};
  for (const r of candidates) scores[r] = difference(p, normalize(rotateSquare(frame, SNAP, r)));
  const [best, other] = [...candidates].sort((a, b) => scores[a] - scores[b]);
  // A featureless scene (blank wall, dark room) can't tell the two apart;
  // then fall back to the usual case (0° for the same shape, 90° for portrait).
  const confident = scores[other] - scores[best] > 0.15;
  return { rotation: confident ? best : candidates[0], confident, scores };
}

export function grayFromImageData(data) {
  const out = new Float32Array(data.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  return out;
}
