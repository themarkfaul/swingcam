// Time-stamped ring of encoded video chunks. Each item is
// { type: 'key' | 'delta', ts (encoder µs), t (wall ms), data }.
// A clip can only start on a keyframe, so trimming always keeps the
// keyframe at or before the oldest moment we still need.

export class ChunkRing {
  constructor(keepMs) {
    this.keepMs = keepMs;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this.trim(item.t);
  }

  trim(nowT) {
    const cutoff = nowT - this.keepMs;
    let keepFrom = 0;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.t > cutoff) break;
      if (it.type === 'key') keepFrom = i;
    }
    if (keepFrom > 0) this.items.splice(0, keepFrom);
  }

  // Items from the keyframe at or before startT through endT. If the buffer
  // doesn't reach back to startT, starts at its first keyframe.
  cut(startT, endT) {
    let first = -1;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.t > startT) break;
      if (it.type === 'key') first = i;
    }
    if (first < 0) first = this.items.findIndex((it) => it.type === 'key');
    if (first < 0) return [];
    const out = [];
    for (let i = first; i < this.items.length && this.items[i].t <= endT; i++) out.push(this.items[i]);
    return out;
  }

  clear() {
    this.items.length = 0;
  }

  get spanMs() {
    return this.items.length ? this.items.at(-1).t - this.items[0].t : 0;
  }

  get bytes() {
    return this.items.reduce((n, it) => n + it.data.byteLength, 0);
  }
}
