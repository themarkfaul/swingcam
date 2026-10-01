// Video side of the camera, off the main thread. Reads camera frames, encodes
// them to H.264 while armed, keeps the last few seconds in a ring buffer, and
// cuts MP4 clips out of it on request.
import { ChunkRing } from './ringbuffer.js';
import { ClockMapper, wallNow } from '../shared/clock.js';
import { muxH264 } from '../media/mux.js';

const KEYFRAME_MS = 500;
const MAX_QUEUE = 3; // skip frames rather than let the encoder fall behind
const BITRATE = 6_000_000;

const ring = new ChunkRing(5000);
const clock = new ClockMapper(60);
let reader = null;
let activeTrack = null;
let encoder = null;
let encoderSize = '';
let decoderConfig = null;
let encoding = false;
let needKey = true;
let lastKeyT = -Infinity;
let rotation = 0;
let loggedFirstFrame = false;
const counts = { frames: 0, encoded: 0, dropped: 0 };

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

function restartBuffer(why) {
  ring.clear();
  needKey = true;
  post({ type: 'info', message: `buffer restarted: ${why}` });
}

function ensureEncoder(width, height) {
  const size = `${width}x${height}`;
  if (encoder && encoder.state === 'configured' && encoderSize === size) return;
  if (encoder && encoder.state !== 'closed') encoder.close();
  if (encoderSize) restartBuffer(`size ${encoderSize} → ${size}`);
  encoderSize = size;
  decoderConfig = null;
  needKey = true;
  encoder = new VideoEncoder({
    output(chunk, meta) {
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      counts.encoded++;
      ring.push({ type: chunk.type, ts: chunk.timestamp, t: clock.toWall(chunk.timestamp / 1000), data });
    },
    error(e) {
      post({ type: 'error', message: `encoder: ${e.message}` });
    },
  });
  encoder.configure({
    // Level 3.2 covers 720p60; 4.2 for anything bigger.
    codec: width * height > 1280 * 720 ? 'avc1.64002a' : 'avc1.640020',
    width,
    height,
    framerate: 60,
    bitrate: BITRATE,
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  });
  post({ type: 'info', message: `encoder ready ${size}` });
}

function handleFrame(frame) {
  counts.frames++;
  clock.observe(frame.timestamp / 1000, wallNow());
  const width = frame.visibleRect?.width ?? frame.codedWidth;
  const height = frame.visibleRect?.height ?? frame.codedHeight;
  if (!loggedFirstFrame) {
    loggedFirstFrame = true;
    post({ type: 'info', message: `first frame ${width}x${height}, display ${frame.displayWidth}x${frame.displayHeight}, rotation ${frame.rotation ?? 'n/a'}` });
  }
  const r = frame.rotation ?? 0;
  if (r !== rotation) {
    rotation = r;
    restartBuffer(`rotation ${r}`);
  }
  try {
    if (!encoding) return;
    ensureEncoder(width, height);
    if (encoder.encodeQueueSize > MAX_QUEUE) {
      counts.dropped++;
      return;
    }
    const t = frame.timestamp / 1000;
    const keyFrame = needKey || t - lastKeyT >= KEYFRAME_MS;
    if (keyFrame) {
      lastKeyT = t;
      needKey = false;
    }
    encoder.encode(frame, { keyFrame });
  } catch (e) {
    post({ type: 'error', message: `encode: ${e.message}` });
  } finally {
    frame.close();
  }
}

async function readFrom(readable) {
  if (reader) reader.cancel().catch(() => {});
  const r = readable.getReader();
  reader = r;
  loggedFirstFrame = false;
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      if (reader !== r) {
        value.close();
        break;
      }
      handleFrame(value);
    }
  } catch (e) {
    if (reader === r) post({ type: 'error', message: `camera frames: ${e.message}` });
  }
}

async function cut({ id, startT, endT, impactT }) {
  const chunks = ring.cut(startT, endT);
  if (!chunks.length || !decoderConfig) {
    post({ type: 'clip', id, error: 'no video in the buffer yet' });
    return;
  }
  try {
    const buffer = await muxH264(chunks, decoderConfig, { rotation });
    const firstT = chunks[0].t;
    const lastT = chunks.at(-1).t;
    post(
      {
        type: 'clip',
        id,
        buffer,
        frames: chunks.length,
        durationS: (lastT - firstT) / 1000,
        impactOffsetS: (impactT - firstT) / 1000,
        missingStartMs: Math.max(0, Math.round(firstT - startT)),
        missingEndMs: Math.max(0, Math.round(endT - lastT - 20)),
      },
      [buffer],
    );
  } catch (e) {
    post({ type: 'clip', id, error: `making MP4: ${e.message}` });
  }
}

function sendChunks({ id, startT, endT }) {
  const chunks = ring.cut(startT, endT).map((c) => ({ type: c.type, ts: c.ts, t: c.t, data: c.data.slice() }));
  post({ type: 'chunks', id, chunks, decoderConfig, rotation }, chunks.map((c) => c.data.buffer));
}

self.onmessage = ({ data }) => {
  switch (data.cmd) {
    case 'track':
      activeTrack?.stop(); // the previous lens
      activeTrack = data.track;
      try {
        const processor = new MediaStreamTrackProcessor({ track: data.track });
        post({ type: 'attached', id: data.id, ok: true });
        readFrom(processor.readable);
      } catch (e) {
        data.track.stop();
        post({ type: 'attached', id: data.id, ok: false, error: e.message });
      }
      break;
    case 'readable':
      activeTrack?.stop();
      activeTrack = null;
      post({ type: 'attached', id: data.id, ok: true });
      readFrom(data.readable);
      break;
    case 'frame':
      handleFrame(data.frame);
      break;
    case 'encode':
      encoding = data.on;
      ring.keepMs = data.keepMs;
      if (encoding) needKey = true;
      break;
    case 'cut':
      cut(data);
      break;
    case 'chunks':
      sendChunks(data);
      break;
  }
};

let lastCounts = { ...counts };
setInterval(() => {
  post({
    type: 'stats',
    fps: counts.frames - lastCounts.frames,
    encodedFps: counts.encoded - lastCounts.encoded,
    dropped: counts.dropped,
    bufferS: +(ring.spanMs / 1000).toFixed(1),
    bufferMB: +(ring.bytes / 1e6).toFixed(1),
    queue: encoder?.encodeQueueSize ?? 0,
    size: encoderSize,
    encoding,
  });
  lastCounts = { ...counts };
}, 1000);
