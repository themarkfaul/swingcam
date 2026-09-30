import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';
import { pickFrameTime } from './cameras.js';

const KEYFRAME_INTERVAL_MS = 500;
const MAX_QUEUE = 3; // skip frames rather than let the encoder fall behind

function candidates(width, height) {
  const portrait = height > width;
  const big = portrait ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  return [
    { label: 'H.264 High 3.2', codec: 'avc1.640020', width, height },
    { label: 'H.264 Main 3.2', codec: 'avc1.4d0020', width, height },
    { label: 'H.264 Baseline 3.2', codec: 'avc1.42e020', width, height },
    { label: 'H.264 High 4.2 (1080p60)', codec: 'avc1.64002a', ...big, fixedSize: true },
    { label: 'HEVC Main', codec: 'hvc1.1.6.L123.B0', width, height },
  ];
}

function encoderConfig(c) {
  return {
    codec: c.codec,
    width: c.width,
    height: c.height,
    framerate: 60,
    bitrate: 6_000_000,
    latencyMode: 'realtime',
    ...(c.codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}),
  };
}

export async function checkCodecSupport(width, height) {
  if (!('VideoEncoder' in window)) return [];
  const out = [];
  for (const c of candidates(width, height)) {
    try {
      const r = await VideoEncoder.isConfigSupported(encoderConfig(c));
      out.push({ ...c, supported: !!r.supported });
    } catch (e) {
      out.push({ ...c, supported: false, error: `${e.name}: ${e.message}` });
    }
  }
  return out;
}

// Encodes the live preview for `seconds`, keeping every encoded chunk.
export function runEncodeTest(video, codecChoice, seconds) {
  return new Promise((resolve) => {
    const chunks = [];
    const errors = [];
    const submitted = new Map();
    const latencies = [];
    let decoderConfig = null;
    let framesIn = 0;
    let dropped = 0;
    let maxQueue = 0;
    let lastKeyT = -Infinity;
    let firstT = null;
    let lastT = null;
    let timeSource = null;

    const encoder = new VideoEncoder({
      output(chunk, meta) {
        if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data });
        const s = submitted.get(chunk.timestamp);
        if (s != null) {
          latencies.push(performance.now() - s);
          submitted.delete(chunk.timestamp);
        }
      },
      error(e) {
        errors.push(`${e.name}: ${e.message}`);
      },
    });
    encoder.configure(encoderConfig(codecChoice));

    const end = performance.now() + seconds * 1000;
    const onFrame = async (now, meta) => {
      if (encoder.state !== 'configured') return finish();
      const ft = pickFrameTime(now, meta);
      timeSource = ft.source;
      maxQueue = Math.max(maxQueue, encoder.encodeQueueSize);
      if (encoder.encodeQueueSize > MAX_QUEUE) {
        dropped++;
      } else {
        try {
          const frame = new VideoFrame(video, { timestamp: Math.round(ft.t * 1000) });
          const keyFrame = ft.t - lastKeyT >= KEYFRAME_INTERVAL_MS;
          if (keyFrame) lastKeyT = ft.t;
          submitted.set(frame.timestamp, performance.now());
          encoder.encode(frame, { keyFrame });
          frame.close();
          framesIn++;
          firstT ??= ft.t;
          lastT = ft.t;
        } catch (e) {
          errors.push(`VideoFrame/encode: ${e.name}: ${e.message}`);
          return finish();
        }
      }
      if (performance.now() < end) video.requestVideoFrameCallback(onFrame);
      else finish();
    };

    let finished = false;
    async function finish() {
      if (finished) return;
      finished = true;
      try {
        if (encoder.state === 'configured') await encoder.flush();
      } catch (e) {
        errors.push(`flush: ${e.name}: ${e.message}`);
      }
      if (encoder.state !== 'closed') encoder.close();
      const spanS = firstT != null ? (lastT - firstT) / 1000 : 0;
      const bytes = chunks.reduce((n, c) => n + c.data.byteLength, 0);
      latencies.sort((a, b) => a - b);
      resolve({
        chunks,
        decoderConfig,
        stats: {
          codec: codecChoice.codec,
          size: `${codecChoice.width}x${codecChoice.height}`,
          seconds: +spanS.toFixed(2),
          framesIn,
          chunksOut: chunks.length,
          keyframes: chunks.filter((c) => c.type === 'key').length,
          dropped,
          encodedFps: spanS > 0 ? +((framesIn - 1) / spanS).toFixed(1) : 0,
          mbps: spanS > 0 ? +((bytes * 8) / spanS / 1e6).toFixed(2) : 0,
          avgEncodeMs: latencies.length ? +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : null,
          p95EncodeMs: latencies.length ? +latencies[Math.floor(latencies.length * 0.95)].toFixed(1) : null,
          maxQueue,
          hasDecoderDescription: !!decoderConfig?.description,
          timeSource,
          errors,
        },
      });
    }

    video.requestVideoFrameCallback(onFrame);
  });
}

// Cuts [startUs, endUs] out of the chunk list, starting at the keyframe
// just before startUs, and wraps it in an MP4.
export async function muxClip(chunks, decoderConfig, startUs, endUs) {
  let first = chunks.findLastIndex((c) => c.type === 'key' && c.timestamp <= startUs);
  if (first < 0) first = chunks.findIndex((c) => c.type === 'key');
  const selected = chunks.slice(first).filter((c) => c.timestamp <= endUs);
  const t0 = selected[0].timestamp;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source);
  await output.start();
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const next = selected[i + 1];
    const durUs = next ? next.timestamp - c.timestamp : 16_667;
    const packet = new EncodedPacket(c.data, c.type, (c.timestamp - t0) / 1e6, durUs / 1e6);
    await source.add(packet, i === 0 ? { decoderConfig } : undefined);
  }
  await output.finalize();

  return {
    blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
    frames: selected.length,
    seconds: +((selected.at(-1).timestamp - t0) / 1e6).toFixed(2),
    leadInMs: Math.round((startUs - t0) / 1000),
  };
}

// Fallback approach: how fast can the page turn frames into small JPEGs?
export function runJpegTest(video, seconds, width = 640) {
  return new Promise((resolve) => {
    const height = Math.round((width * video.videoHeight) / video.videoWidth / 2) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    let pending = 0;
    let done = 0;
    let skipped = 0;
    let bytes = 0;
    let totalMs = 0;
    const start = performance.now();
    const end = start + seconds * 1000;

    const onFrame = () => {
      if (pending > 2) {
        skipped++;
      } else {
        pending++;
        const s = performance.now();
        ctx.drawImage(video, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            pending--;
            done++;
            bytes += blob?.size ?? 0;
            totalMs += performance.now() - s;
          },
          'image/jpeg',
          0.7,
        );
      }
      if (performance.now() < end) video.requestVideoFrameCallback(onFrame);
      else waitDone();
    };

    function waitDone() {
      if (pending > 0) return setTimeout(waitDone, 50);
      const fps = done / seconds;
      const avgKB = done ? bytes / done / 1024 : 0;
      resolve({
        size: `${width}x${height}`,
        fps: +fps.toFixed(1),
        skipped,
        avgKB: +avgKB.toFixed(1),
        avgMs: done ? +(totalMs / done).toFixed(1) : null,
        bufferMBFor4s: +((avgKB * fps * 4) / 1024).toFixed(1),
      });
    }

    video.requestVideoFrameCallback(onFrame);
  });
}
