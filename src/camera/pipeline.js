import { pickFrameTime } from '../shared/cameras.js';

// Page-side handle on the encoder worker. Gets camera frames to the worker
// by the best route this browser has:
//   1. hand the camera track itself to the worker (iPhone Safari),
//   2. read frames here and hand the frame stream over (desktop Chrome),
//   3. copy frames from the <video> element (anything else; drops frames).
export function createPipeline(onMessage) {
  const worker = new Worker(new URL('./encoder-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  let stopCopying = null;
  let pageClone = null; // route 2's copy of the track, stopped on the next attach

  worker.onmessage = ({ data }) => {
    if (data.id != null && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
      return;
    }
    onMessage(data);
  };
  worker.onerror = (e) => onMessage({ type: 'error', message: `worker: ${e.message}` });

  function request(msg, transfer = []) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async function attach(track, video) {
    stopCopying?.();
    stopCopying = null;
    pageClone?.stop();
    pageClone = null;

    if (track) {
      const clone = track.clone();
      try {
        const reply = await request({ cmd: 'track', track: clone }, [clone]);
        if (reply.ok) return 'worker reads the camera';
      } catch {
        clone.stop();
      }
      if ('MediaStreamTrackProcessor' in window) {
        try {
          pageClone = track.clone();
          const { readable } = new MediaStreamTrackProcessor({ track: pageClone });
          await request({ cmd: 'readable', readable }, [readable]);
          return 'page reads the camera';
        } catch {
          // fall through
        }
      }
    }

    let stopped = false;
    const onFrame = (now, meta) => {
      if (stopped) return;
      try {
        const frame = new VideoFrame(video, { timestamp: Math.round(pickFrameTime(now, meta).t * 1000) });
        worker.postMessage({ cmd: 'frame', frame }, [frame]);
      } catch {
        // the element has no frame yet
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    stopCopying = () => (stopped = true);
    return 'copied from preview (may drop frames)';
  }

  return {
    attach,
    setEncoding(on, keepMs) {
      worker.postMessage({ cmd: 'encode', on, keepMs });
    },
    cut: (o) => request({ cmd: 'cut', ...o }),
    chunks: (o) => request({ cmd: 'chunks', ...o }),
    snapshot: () => request({ cmd: 'snapshot' }),
    setRotation(rotation) {
      worker.postMessage({ cmd: 'rotation', rotation });
    },
  };
}
