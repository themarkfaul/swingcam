// Records camera + mic with MediaRecorder, to collect range samples for
// testing the impact detector at home.

const TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function pickRecorderType() {
  if (!('MediaRecorder' in window)) return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

export function startRecording(stream, { maxMs, onTick }) {
  const type = pickRecorderType();
  const recorder = new MediaRecorder(stream, {
    ...(type ? { mimeType: type } : {}),
    videoBitsPerSecond: 5_000_000,
  });
  const parts = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) parts.push(e.data);
  };
  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(parts, { type: recorder.mimeType || type || 'video/mp4' }));
  });
  recorder.start(1000);

  const started = performance.now();
  const timer = setInterval(() => {
    const elapsed = performance.now() - started;
    onTick?.(elapsed, parts.reduce((n, p) => n + p.size, 0));
    if (elapsed >= maxMs) stop();
  }, 500);

  function stop() {
    clearInterval(timer);
    if (recorder.state !== 'inactive') recorder.stop();
    return done;
  }
  return { stop, mimeType: recorder.mimeType || type };
}

// Must be called straight from a tap. Uses the share sheet (Save Video / Save to Files)
// when available, otherwise a normal download.
export async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
