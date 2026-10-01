// One clock for everything: milliseconds since the Unix epoch, as
// timeOrigin + performance.now(). Unlike performance.now() alone, this is
// the same in the page and in workers (each has its own timeOrigin).
export const wallNow = () => performance.timeOrigin + performance.now();

// Maps another clock (the audio clock, or camera frame timestamps) onto
// wallNow(). Each observation pairs a source time with the wall time it was
// seen. Delivery only ever adds delay, so the smallest recent offset is the
// most accurate. "Recent" matters: the audio clock stops while iOS suspends
// audio, so the offset jumps every time it resumes.
export class ClockMapper {
  constructor(windowSize = 48) {
    this.windowSize = windowSize;
    this.offsets = [];
    this.offset = null;
  }

  observe(sourceMs, wallMs) {
    this.offsets.push(wallMs - sourceMs);
    if (this.offsets.length > this.windowSize) this.offsets.shift();
    this.offset = Math.min(...this.offsets);
  }

  // Forget old observations (the source clock jumped). The last offset is
  // kept until the next observation replaces it.
  reset() {
    this.offsets.length = 0;
  }

  toWall(sourceMs) {
    return sourceMs + (this.offset ?? 0);
  }

  get ready() {
    return this.offset != null;
  }
}
