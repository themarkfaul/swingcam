// "Learn my swing": works out the golfer's box, how much their swing moves the
// picture, and their tempo, from a few seconds of standing still at address
// followed by a few practice swings.
//
// Input frames: [{ t (ms), cells }], where cells is a SNAP×SNAP Uint8Array
// with 1 for each cell that changed against the frame two back (upright, with
// any overall brightness shift taken out: see changedCells in motion.js).

import { SNAP } from './orientation.js';

const GRID = SNAP * SNAP;
const MIN_SWING_MS = 400; // a burst of movement shorter than this isn't a swing
const SWING_GAP_MS = 800; // bursts closer than this are one swing
const BOX_MARGIN = 2; // cells added around the swing area
const MIN_BOX = 8; // cells, smallest box side
const MOTION_SHARE = 0.3; // "movement needed" = this share of the smallest learned swing
const TOP_PAUSE_MS = 250; // a pause this long (the top of the backswing) doesn't end the swing

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fraction = (cells) => cells.reduce((n, c) => n + c, 0) / GRID;

function zoneFraction(cells, box) {
  let n = 0;
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) n += cells[y * SNAP + x];
  return n / ((box.x1 - box.x0) * (box.y1 - box.y0));
}

// Groups the frames into bursts of movement well above the still level.
export function findSwings(frames, stillLevel) {
  const level = Math.max(stillLevel * 2, 0.01);
  const bursts = [];
  let current = null;
  for (const f of frames) {
    if (fraction(f.cells) > level) {
      if (current && f.t - current.end <= SWING_GAP_MS) {
        current.end = f.t;
        current.frames.push(f);
      } else {
        current = { start: f.t, end: f.t, frames: [f] };
        bursts.push(current);
      }
    } else if (current && f.t - current.end <= SWING_GAP_MS) {
      current.frames.push(f); // quiet moments inside a swing (the top) still belong to it
    }
  }
  return bursts.filter((b) => b.end - b.start >= MIN_SWING_MS);
}

export function learnSwing(frames, stillEndT) {
  const still = frames.filter((f) => f.t <= stillEndT);
  const rest = frames.filter((f) => f.t > stillEndT);
  const stillLevel = still.length ? Math.max(...still.map((f) => fraction(f.cells))) : 0;
  const swings = findSwings(rest, stillLevel).slice(0, 5);
  if (swings.length === 0) return { ok: false, reason: 'no practice swings seen', stillLevel };

  // Cells that moved in most swings make up the swing area.
  const perSwing = swings.map((s) => {
    const count = new Uint16Array(GRID);
    for (const f of s.frames) for (let i = 0; i < GRID; i++) count[i] += f.cells[i];
    return count;
  });
  const need = swings.length >= 3 ? 2 : 1;
  let x0 = SNAP, y0 = SNAP, x1 = 0, y1 = 0;
  for (let i = 0; i < GRID; i++) {
    const hits = perSwing.filter((c) => c[i] >= 3).length;
    if (hits >= need) {
      const x = i % SNAP;
      const y = Math.floor(i / SNAP);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  if (x1 <= x0) return { ok: false, reason: 'the swings moved different parts of the picture', stillLevel };

  // Grow the box a little, and to a sensible minimum size.
  const grow = (a, b) => {
    a = Math.max(0, a - BOX_MARGIN);
    b = Math.min(SNAP, b + BOX_MARGIN);
    const short = MIN_BOX - (b - a);
    if (short > 0) {
      a -= Math.ceil(short / 2);
      b += Math.floor(short / 2);
    }
    const shift = a < 0 ? -a : b > SNAP ? SNAP - b : 0;
    return [clamp(a + shift, 0, SNAP), clamp(b + shift, 0, SNAP)];
  };
  [x0, x1] = grow(x0, x1);
  [y0, y1] = grow(y0, y1);
  const box = { x0, y0, x1, y1 };

  // How much each swing moved the box, and its tempo: from the takeaway to
  // the busiest moment (around impact). The start of the backswing is slow and
  // moves little, so the takeaway is found inside the box, walking back from
  // the peak while anything at all is moving there.
  const stillInBox = still.length ? Math.max(...still.map((f) => zoneFraction(f.cells, box))) : 0;
  const moving = Math.max(stillInBox * 2, 0.003);
  const details = swings.map((s) => {
    const zf = rest.map((f) => ({ t: f.t, z: zoneFraction(f.cells, box) }));
    let peakIdx = -1;
    for (let i = 0; i < zf.length; i++) {
      if (zf[i].t < s.start || zf[i].t > s.end) continue;
      if (peakIdx < 0 || zf[i].z > zf[peakIdx].z) peakIdx = i;
    }
    let takeaway = zf[peakIdx].t;
    let lastMoving = takeaway;
    for (let i = peakIdx; i >= 0 && lastMoving - zf[i].t <= TOP_PAUSE_MS; i--) {
      if (zf[i].z > moving) {
        lastMoving = zf[i].t;
        takeaway = zf[i].t;
      }
    }
    return { peak: zf[peakIdx].z, backswingMs: zf[peakIdx].t - takeaway };
  });
  const smallest = Math.min(...details.map((d) => d.peak));
  const backswingMs = [...details.map((d) => d.backswingMs)].sort((a, b) => a - b)[Math.floor(details.length / 2)];
  const bs = clamp(backswingMs, 800, 2000);

  return {
    ok: true,
    swings: details.length,
    zone: { x0: box.x0 / SNAP, x1: box.x1 / SNAP, y0: box.y0 / SNAP, y1: box.y1 / SNAP },
    peaks: details.map((d) => d.peak),
    minMotion: clamp(smallest * MOTION_SHARE, 0.005, 0.1),
    addressStill: clamp(stillInBox * 2 + 0.005, 0.01, 0.03),
    // Still at address: a 0.7 s window ending 0.3 s before the takeaway.
    addressWindow: [-(bs + 1000), -(bs + 300)],
    backswingMs: Math.round(backswingMs),
    stillLevel,
  };
}
