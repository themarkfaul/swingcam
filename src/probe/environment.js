export function collectEnvironment() {
  return {
    userAgent: navigator.userAgent,
    screen: `${screen.width}x${screen.height} @${devicePixelRatio}x`,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    secureContext: isSecureContext,
    homeScreenApp: navigator.standalone ?? null,
    features: {
      getUserMedia: !!navigator.mediaDevices?.getUserMedia,
      requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      VideoEncoder: 'VideoEncoder' in window,
      VideoFrame: 'VideoFrame' in window,
      AudioWorklet: 'AudioWorkletNode' in window,
      wakeLock: 'wakeLock' in navigator,
      batteryApi: 'getBattery' in navigator,
      MediaRecorder: 'MediaRecorder' in window,
      RTCPeerConnection: 'RTCPeerConnection' in window,
      indexedDB: 'indexedDB' in window,
      OffscreenCanvas: 'OffscreenCanvas' in window,
      shareSheet: 'share' in navigator,
    },
  };
}

function idb(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Clips will wait in IndexedDB until the viewer confirms them (M2),
// so check that a clip-sized Blob survives a round trip.
async function testIndexedDbBlob() {
  const size = 5 * 1024 * 1024;
  const start = performance.now();
  const open = indexedDB.open('swingcam-probe', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('t');
  const db = await idb(open);
  try {
    const put = db.transaction('t', 'readwrite').objectStore('t').put(new Blob([new Uint8Array(size)], { type: 'video/mp4' }), 'clip');
    await idb(put);
    const blob = await idb(db.transaction('t').objectStore('t').get('clip'));
    const readBack = (await blob.arrayBuffer()).byteLength;
    return { ok: readBack === size, readBackBytes: readBack, ms: Math.round(performance.now() - start) };
  } finally {
    db.close();
    indexedDB.deleteDatabase('swingcam-probe');
  }
}

export async function checkStorage() {
  const out = {};
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      out.quotaMB = Math.round(e.quota / 1e6);
      out.usageMB = +(e.usage / 1e6).toFixed(1);
    }
    out.persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch (e) {
    out.estimateError = String(e);
  }
  try {
    out.indexedDbBlob = await testIndexedDbBlob();
  } catch (e) {
    out.indexedDbBlob = { ok: false, error: String(e) };
  }
  return out;
}
