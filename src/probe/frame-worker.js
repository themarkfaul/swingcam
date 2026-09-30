// Checks whether camera frames can be read directly inside a worker
// (MediaStreamTrackProcessor), which would keep encoding off the main thread.

self.onmessage = async ({ data }) => {
  if (data.cmd === 'caps') {
    self.postMessage({
      MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor !== 'undefined',
      VideoEncoder: typeof VideoEncoder !== 'undefined',
      OffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    });
    return;
  }

  if (data.cmd === 'read') {
    try {
      const processor = new MediaStreamTrackProcessor({ track: data.track });
      const reader = processor.readable.getReader();
      const start = performance.now();
      let frames = 0;
      let first = null;
      let last = null;
      while (performance.now() - start < data.ms) {
        const { value, done } = await reader.read();
        if (done) break;
        frames++;
        first ??= value.timestamp;
        last = value.timestamp;
        value.close();
      }
      await reader.cancel();
      data.track.stop();
      const spanS = first != null ? (last - first) / 1e6 : 0;
      self.postMessage({ frames, fps: spanS > 0 ? +((frames - 1) / spanS).toFixed(1) : 0 });
    } catch (e) {
      self.postMessage({ error: `${e.name}: ${e.message}` });
    }
  }
};
