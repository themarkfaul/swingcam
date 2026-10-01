export const RESOLUTIONS = {
  '720p60': { width: 1280, height: 720, fps: 60 },
  '1080p60': { width: 1920, height: 1080, fps: 60 },
};

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

export function isBackCamera(device) {
  return /back|rear|environment/i.test(device.label);
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function openCamera(video, deviceId, { width, height, fps }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps },
    },
  });
  video.srcObject = stream;
  await video.play();
  await waitForFrame(video, 3000);
  return stream;
}

function waitForFrame(video, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    video.requestVideoFrameCallback(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// The best timestamp for a frame: when it was captured, if Safari says,
// otherwise when the callback ran.
export function pickFrameTime(now, meta) {
  const c = meta.captureTime;
  if (typeof c === 'number' && c > 0 && Math.abs(c - now) < 1000) return { t: c, source: 'captureTime' };
  return { t: now, source: 'callback' };
}

// Counts frames delivered to the page over `ms` milliseconds.
export function measureFps(video, ms) {
  return new Promise((resolve) => {
    const times = [];
    let firstPresented = null;
    let lastPresented = null;
    let source = 'callback';
    const end = performance.now() + ms;

    const onFrame = (now, meta) => {
      const ft = pickFrameTime(now, meta);
      source = ft.source;
      times.push(ft.t);
      firstPresented ??= meta.presentedFrames;
      lastPresented = meta.presentedFrames;
      if (performance.now() < end) {
        video.requestVideoFrameCallback(onFrame);
        return;
      }
      const spanS = (times.at(-1) - times[0]) / 1000;
      const intervals = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)] ?? 0;
      resolve({
        fps: spanS > 0 ? +((times.length - 1) / spanS).toFixed(1) : 0,
        presentedFps: spanS > 0 ? +((lastPresented - firstPresented) / spanS).toFixed(1) : 0,
        medianIntervalMs: +median.toFixed(1),
        longGaps: intervals.filter((d) => d > median * 1.5).length,
        frames: times.length,
        timeSource: source,
      });
    };
    video.requestVideoFrameCallback(onFrame);
  });
}
