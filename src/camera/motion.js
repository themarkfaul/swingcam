// How much moved in the golfer zone between two small grayscale pictures.
// Used to confirm that a sound came with a swing in our own frame, since the
// impacts from the next bays sound much the same as ours.

// The zone, as fractions of the upright picture. camera.html draws the same box.
export const MOTION_ZONE = { x0: 0.2, x1: 0.8, y0: 0.05, y1: 0.95 };

// How much a cell must change (0–255 gray) to count as movement.
const CELL_CHANGE = 12;

// prev, cur: size×size grayscale, upright. Returns the share of zone cells
// that changed (0–1). An overall brightness shift (auto-exposure, a cloud)
// is taken out first, so it doesn't count as movement.
export function zoneChange(prev, cur, size, zone = MOTION_ZONE) {
  const xs = Math.floor(zone.x0 * size);
  const xe = Math.ceil(zone.x1 * size);
  const ys = Math.floor(zone.y0 * size);
  const ye = Math.ceil(zone.y1 * size);
  let sum = 0;
  let n = 0;
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      sum += cur[y * size + x] - prev[y * size + x];
      n++;
    }
  }
  const shift = sum / n;
  let changed = 0;
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const d = cur[y * size + x] - prev[y * size + x] - shift;
      if (d > CELL_CHANGE || d < -CELL_CHANGE) changed++;
    }
  }
  return changed / n;
}

// samples: [{ t, change }]. Peak change within [fromT, toT].
export function peakChange(samples, fromT, toT) {
  let peak = 0;
  let count = 0;
  for (const s of samples) {
    if (s.t < fromT || s.t > toT) continue;
    count++;
    if (s.change > peak) peak = s.change;
  }
  return { peak, samples: count };
}
