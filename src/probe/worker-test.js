function ask(worker, message, transfer = [], timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timed out')), timeoutMs);
    worker.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    worker.postMessage(message, transfer);
  });
}

export async function runWorkerTest(videoTrack) {
  const result = { mainThreadTrackProcessor: 'MediaStreamTrackProcessor' in window };
  const worker = new Worker(new URL('./frame-worker.js', import.meta.url), { type: 'module' });
  try {
    result.worker = await ask(worker, { cmd: 'caps' });
    if (!result.worker.MediaStreamTrackProcessor) {
      result.workerRead = { skipped: 'no MediaStreamTrackProcessor in worker' };
    } else {
      const clone = videoTrack.clone();
      try {
        result.workerRead = await ask(worker, { cmd: 'read', track: clone, ms: 2000 }, [clone]);
      } catch (e) {
        clone.stop();
        result.workerRead = { error: `${e.name}: ${e.message}` };
      }
    }
  } finally {
    worker.terminate();
  }
  return result;
}
