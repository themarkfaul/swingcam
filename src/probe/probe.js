import '../style.css';
import { installDebugLog, getLogLines, log } from '../shared/debuglog.js';
import { createWakeLock } from '../shared/wakelock.js';
import { RESOLUTIONS, listCameras, isBackCamera, openCamera, stopStream, measureFps, pickFrameTime } from './cameras.js';
import { checkCodecSupport, runEncodeTest, muxClip, runJpegTest } from './encode.js';
import { runWorkerTest } from './worker-test.js';
import { AUDIO_CONSTRAINTS, describeAudio, createLevelMonitor, toDb } from './audio.js';
import { startRecording, saveFile, pickRecorderType } from './recorder.js';
import { collectEnvironment, checkStorage } from './environment.js';

const $ = (id) => document.getElementById(id);
installDebugLog($('debug-log'));

const video = $('preview');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  probeVersion: 1,
  startedAt: new Date().toISOString(),
  env: collectEnvironment(),
  permissions: null,
  cameras: [],
  codecs: [],
  encode: null,
  clip: null,
  answers: {},
  worker: null,
  jpeg: null,
  audio: null,
  clapTests: [],
  wakeLock: null,
  recorder: { mimeType: pickRecorderType() },
  storage: null,
  backgroundEvents: [],
  errors: {},
};

const state = {
  audioTrack: null,
  videoStream: null,
  deviceId: null,
  res: '720p60',
  ctx: null,
  monitor: null,
  audioRing: [], // { t, p } for the last ~10 s
  busy: false,
  recording: null,
  recBlob: null,
};

function setStatus(id, text) {
  $(id).textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['btn-auto', 'btn-clap', 'btn-wake', 'sel-lens', 'sel-res']) $(id).disabled = busy;
  $('btn-rec').disabled = busy && !state.recording;
}

function watchTrack(track, name) {
  track.addEventListener('ended', () => log('warn', `${name} track ended`));
  track.addEventListener('mute', () => log('warn', `${name} track muted`));
  track.addEventListener('unmute', () => log('info', `${name} track unmuted`));
}

// ---------- start / preview ----------

$('btn-start').onclick = async () => {
  // Create the audio context inside the tap, before any await, or iOS keeps it suspended.
  const ctx = new AudioContext();
  state.ctx = ctx;
  ctx.resume().catch(() => {});
  ctx.onstatechange = () => log('info', `audio context ${ctx.state}`);
  $('btn-start').disabled = true;
  setStatus('start-status', 'Asking for camera and microphone…');

  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: AUDIO_CONSTRAINTS });
    state.audioTrack = s.getAudioTracks()[0];
    s.getVideoTracks().forEach((t) => t.stop());
    watchTrack(state.audioTrack, 'mic');
    report.permissions = { granted: true };
  } catch (e) {
    report.permissions = { granted: false, error: `${e.name}: ${e.message}` };
    setStatus('start-status', `Couldn't get camera/mic: ${e.name}. Check Safari's website settings (aA button → Website Settings) and reload.`);
    $('btn-start').disabled = false;
    renderSummary();
    return;
  }

  try {
    await populateLenses();
    await startPreview();
    state.monitor = await createLevelMonitor(ctx, state.audioTrack);
    state.monitor.onBlock(onAudioBlock);
    loadVoice(ctx);
    report.audio = describeAudio(state.audioTrack, ctx);
  } catch (e) {
    log('error', 'start failed', e);
    setStatus('start-status', `Something failed: ${e.message}. See the debug log.`);
  }

  $('start-card').hidden = true;
  $('preview-card').hidden = false;
  document.querySelectorAll('.needs-start').forEach((el) => (el.hidden = false));
  renderSummary();
  requestAnimationFrame(drawMeter);
};

async function populateLenses() {
  const cams = await listCameras();
  const sel = $('sel-lens');
  sel.innerHTML = '';
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || `Camera ${sel.length + 1}`;
    sel.append(o);
  }
  const preferred = cams.find((c) => c.label === 'Back Camera') ?? cams.find(isBackCamera) ?? cams[0];
  state.deviceId = preferred?.deviceId ?? null;
  sel.value = state.deviceId ?? '';
  log('info', 'cameras:', cams.map((c) => c.label).join(' | '));
}

async function startPreview() {
  stopStream(state.videoStream);
  state.videoStream = null;
  state.videoStream = await openCamera(video, state.deviceId, RESOLUTIONS[state.res]);
  const track = state.videoStream.getVideoTracks()[0];
  watchTrack(track, 'camera');
  const s = track.getSettings();
  setStatus('preview-info', `${track.label}: ${s.width}×${s.height}, Safari reports ${s.frameRate ?? '?'} fps`);
}

$('sel-lens').onchange = async (e) => {
  state.deviceId = e.target.value;
  await startPreview().catch((err) => log('error', 'lens switch failed', err));
};

$('sel-res').onchange = async (e) => {
  state.res = e.target.value;
  await startPreview().catch((err) => log('error', 'mode switch failed', err));
};

// Live delivered-frame-rate badge.
(function fpsBadge() {
  let count = 0;
  let windowStart = performance.now();
  const onFrame = () => {
    count++;
    const now = performance.now();
    if (now - windowStart >= 1000) {
      $('fps-badge').textContent = `${((count * 1000) / (now - windowStart)).toFixed(0)} fps`;
      count = 0;
      windowStart = now;
    }
    video.requestVideoFrameCallback(onFrame);
  };
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(onFrame);
})();

// ---------- background / recovery ----------

let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = performance.now();
    log('warn', 'page hidden');
    return;
  }
  const awayS = hiddenAt ? +((performance.now() - hiddenAt) / 1000).toFixed(1) : null;
  hiddenAt = null;
  state.ctx?.resume().catch(() => {});
  const videoLive = state.videoStream?.getVideoTracks()[0]?.readyState === 'live';
  const micLive = state.audioTrack?.readyState === 'live';
  report.backgroundEvents.push({ awayS, videoLive, micLive });
  log('info', `page visible after ${awayS}s; camera ${videoLive ? 'live' : 'stopped'}, mic ${micLive ? 'live' : 'stopped'}`);
  if (state.videoStream && (!videoLive || !micLive)) {
    $('banner-text').textContent = `Safari was in the background for ${awayS}s and the ${!videoLive ? 'camera' : 'mic'} stopped.`;
    $('banner').hidden = false;
  }
});

$('btn-restart').onclick = async () => {
  $('banner').hidden = true;
  try {
    if (state.audioTrack?.readyState !== 'live') {
      const s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      state.audioTrack = s.getAudioTracks()[0];
      watchTrack(state.audioTrack, 'mic');
      state.monitor?.setTrack(state.audioTrack);
    }
    await startPreview();
  } catch (e) {
    log('error', 'restart failed', e);
  }
};

// ---------- audio meter ----------

let meterPeak = 0;
let holdPeak = 0;

function onAudioBlock(t, p) {
  state.audioRing.push({ t, p });
  if (state.audioRing.length > 5000) state.audioRing.splice(0, 1000);
  if (p > meterPeak) meterPeak = p;
  if (p > holdPeak) holdPeak = p;
}

const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

function drawMeter() {
  const db = toDb(meterPeak);
  meterPeak = 0;
  $('meter-bar').style.width = `${dbToPct(db)}%`;
  $('meter-hold').style.left = `${dbToPct(toDb(holdPeak))}%`;
  $('meter-db').textContent = db.toFixed(0);
  $('meter-peak').textContent = toDb(holdPeak).toFixed(1);
  requestAnimationFrame(drawMeter);
}

$('btn-peak-reset').onclick = () => (holdPeak = 0);

// ---------- automatic checks ----------

async function runCameraSweep(progress) {
  const cams = await listCameras();
  const back = cams.filter(isBackCamera);
  const rows = [];
  for (const cam of back.length ? back : cams) {
    for (const key of Object.keys(RESOLUTIONS)) {
      progress(`${cam.label}, ${key}`);
      const row = { label: cam.label, requested: key };
      let stream = null;
      try {
        stopStream(state.videoStream);
        state.videoStream = null;
        stream = await openCamera(video, cam.deviceId, RESOLUTIONS[key]);
        const track = stream.getVideoTracks()[0];
        const s = track.getSettings();
        const caps = track.getCapabilities?.();
        await sleep(600);
        row.got = `${video.videoWidth}x${video.videoHeight}`;
        row.safariFps = s.frameRate ?? null;
        row.maxFps = caps?.frameRate?.max ?? null;
        row.maxSize = caps?.width ? `${caps.width.max}x${caps.height.max}` : null;
        row.measured = await measureFps(video, 2500);
      } catch (e) {
        row.error = `${e.name}: ${e.message}`;
      }
      stopStream(stream);
      rows.push(row);
      log('info', 'camera', row);
    }
  }
  report.cameras = rows;
  await startPreview();
}

async function runEncodeAndClip() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  report.codecs = await checkCodecSupport(w, h);
  if (!report.codecs.length) {
    report.encode = { skipped: 'VideoEncoder not available' };
    return;
  }
  const choice = report.codecs.find((c) => c.supported && c.codec.startsWith('avc1') && !c.fixedSize);
  if (!choice) {
    report.encode = { skipped: 'no supported H.264 setting' };
    return;
  }
  const { chunks, decoderConfig, stats } = await runEncodeTest(video, choice, 6);
  report.encode = { lens: state.videoStream.getVideoTracks()[0].label, ...stats };
  if (!chunks.length) return;

  const last = chunks.at(-1).timestamp;
  const clip = await muxClip(chunks, decoderConfig, last - 3_500_000, last);
  state.clipBlob = clip.blob;
  report.clip = { frames: clip.frames, seconds: clip.seconds, leadInMs: clip.leadInMs, sizeMB: +(clip.blob.size / 1e6).toFixed(2) };
  const clipVideo = $('clip');
  clipVideo.src = URL.createObjectURL(clip.blob);
  clipVideo.onloadedmetadata = () => {
    report.clip.playerDuration = +clipVideo.duration.toFixed(2);
    report.clip.playerSize = `${clipVideo.videoWidth}x${clipVideo.videoHeight}`;
    renderSummary();
  };
  clipVideo.onerror = () => {
    report.clip.playerError = clipVideo.error?.message || `code ${clipVideo.error?.code}`;
    renderSummary();
  };
  $('clip-box').hidden = false;
}

$('btn-auto').onclick = async () => {
  if (state.busy) return;
  setBusy(true);
  const steps = [
    ['Storage', async () => (report.storage = await checkStorage())],
    ['Cameras and frame rates', () => runCameraSweep((what) => setStatus('auto-status', `Cameras: ${what}…`))],
    ['Video encoder (6 s)', runEncodeAndClip],
    ['Frames in a worker', async () => (report.worker = await runWorkerTest(state.videoStream.getVideoTracks()[0]))],
    ['JPEG fallback (3 s)', async () => (report.jpeg = await runJpegTest(video, 3))],
  ];
  for (const [name, fn] of steps) {
    setStatus('auto-status', `${name}…`);
    try {
      await fn();
      delete report.errors[name];
    } catch (e) {
      report.errors[name] = `${e.name}: ${e.message}`;
      log('error', name, e);
    }
    renderSummary();
  }
  report.env = collectEnvironment();
  if (state.audioTrack && state.ctx) report.audio = describeAudio(state.audioTrack, state.ctx);
  setStatus('auto-status', 'Done. Results are in section 7.');
  renderSummary();
  setBusy(false);
};

document.querySelectorAll('.answer').forEach((btn) => {
  btn.onclick = () => {
    const q = btn.dataset.q;
    report.answers[q] = btn.dataset.a;
    document.querySelectorAll(`.answer[data-q="${q}"]`).forEach((b) => b.classList.toggle('selected', b === btn));
    if (q === 'wakeLock') finishWakeTest();
    renderSummary();
  };
});

// ---------- clap test ----------

const THUMB_W = 200;
const COUNTDOWN_S = 10;
const SPOKEN_FROM = 5;
const GO_BEEP_MS = 250;

// Spoken prompts are recorded sound files played through Web Audio:
// iOS silences speechSynthesis while the mic is in use.
const VOICE_CLIPS = ['5', '4', '3', '2', '1', 'start', 'got-it', 'try-again'];
const voice = new Map();

async function loadVoice(ctx) {
  await Promise.all(
    VOICE_CLIPS.map(async (name) => {
      try {
        const res = await fetch(`./sounds/${name}.wav`);
        voice.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (e) {
        log('warn', `voice clip ${name} failed`, e);
      }
    }),
  );
  log('info', `voice clips loaded: ${voice.size}/${VOICE_CLIPS.length}`);
}

function say(name) {
  const buffer = voice.get(name);
  if (!buffer || !state.ctx) return false;
  const src = state.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(state.ctx.destination);
  src.start();
  return true;
}

function beep(freq, ms) {
  const ctx = state.ctx;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.8, t + 0.01);
  gain.gain.setValueAtTime(0.8, t + ms / 1000 - 0.02);
  gain.gain.linearRampToValueAtTime(0, t + ms / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.05);
}

// The camera faces away from the screen, so the countdown is spoken:
// silent for the first seconds (time to walk out), then "5, 4, 3, 2, 1", then a beep.
async function audibleCountdown() {
  for (let s = COUNTDOWN_S; s >= 1; s--) {
    setStatus('clap-status', s > SPOKEN_FROM ? `Walk out… ${s}` : `${s}`);
    if (s <= SPOKEN_FROM && !say(String(s))) beep(660, 100);
    await sleep(1000);
  }
  setStatus('clap-status', 'CLAP!');
  beep(1320, GO_BEEP_MS);
  // Start listening only after the beep, so the phone's own sound isn't taken for the clap.
  await sleep(GO_BEEP_MS + 50);
}

$('btn-clap').onclick = async () => {
  if (state.busy || !state.monitor) return;
  setBusy(true);
  $('clap-frames').innerHTML = '';
  state.ctx.resume().catch(() => {});
  say('start');
  await audibleCountdown();

  const thumbH = Math.round((THUMB_W * video.videoHeight) / video.videoWidth);
  const frames = [];
  const start = performance.now();
  const end = start + 3000;
  await new Promise((resolve) => {
    const onFrame = (now, meta) => {
      const c = document.createElement('canvas');
      c.width = THUMB_W;
      c.height = thumbH;
      c.getContext('2d').drawImage(video, 0, 0, THUMB_W, thumbH);
      frames.push({ t: pickFrameTime(now, meta).t, canvas: c });
      if (performance.now() < end) video.requestVideoFrameCallback(onFrame);
      else resolve();
    };
    video.requestVideoFrameCallback(onFrame);
  });
  await sleep(250); // let the last audio batches arrive
  setBusy(false);

  const blocks = state.audioRing.filter((b) => b.t >= start && b.t <= end + 100);
  const ring = state.audioRing;
  log('info', 'clap window', {
    blocks: blocks.length,
    ringSize: ring.length,
    lastBlockAgoMs: ring.length ? Math.round(performance.now() - ring.at(-1).t) : null,
    ctxState: state.ctx.state,
    clockOffsetMs: Math.round(state.monitor.clockOffsetMs),
    frames: frames.length,
  });
  if (!blocks.length) {
    setStatus('clap-status', 'No audio arrived. Check the mic meter, and send the debug log.');
    say('try-again');
    return;
  }
  const loudest = blocks.reduce((a, b) => (b.p > a.p ? b : a));
  const sorted = blocks.map((b) => b.p).sort((a, b) => a - b);
  const background = sorted[Math.floor(sorted.length / 2)];
  const peakDb = toDb(loudest.p);
  const snrDb = peakDb - toDb(background);
  if (snrDb < 15) {
    setStatus('clap-status', `Didn't hear a clear clap (only ${snrDb.toFixed(0)} dB above background). Try again, louder.`);
    say('try-again');
    return;
  }
  // Onset: first block within 30 ms before the loudest that reaches half its level.
  const onset = blocks.find((b) => b.t >= loudest.t - 30 && b.p >= loudest.p * 0.5) ?? loudest;
  const tAudio = onset.t;

  const shown = frames.filter((f) => f.t >= tAudio - 300 && f.t <= tAudio + 150);
  if (!shown.length) {
    setStatus('clap-status', 'The clap was outside the recorded frames. Try again.');
    say('try-again');
    return;
  }
  setStatus('clap-status', 'Tap the first picture where your hands touch.');
  say('got-it');
  for (const f of shown) {
    const b = document.createElement('button');
    b.append(f.canvas);
    const label = document.createElement('span');
    const rel = Math.round(f.t - tAudio);
    label.textContent = `${rel > 0 ? '+' : ''}${rel} ms`;
    b.append(label);
    b.onclick = () => {
      const lagMs = Math.round(tAudio - f.t);
      report.clapTests.push({ lagMs, peakDb: +peakDb.toFixed(1), snrDb: +snrDb.toFixed(1), frames: frames.length });
      $('clap-frames').innerHTML = '';
      setStatus('clap-status', `Audio lag: ${lagMs} ms`);
      showClapResults();
      renderSummary();
    };
    $('clap-frames').append(b);
  }
};

function showClapResults() {
  const lags = report.clapTests.map((c) => c.lagMs);
  const avg = lags.reduce((a, b) => a + b, 0) / lags.length;
  setStatus('clap-results', `Trials: ${lags.join(', ')} ms · average ${avg.toFixed(0)} ms${lags.length < 3 ? ` · ${3 - lags.length} more to go` : ''}`);
}

// ---------- wake lock test ----------

let wakeTimer = null;
let wakeStart = 0;
const wake = createWakeLock((event, err) => {
  log('info', `wake lock ${event}`, err?.message ?? '');
  report.wakeLock?.events.push({ event, atS: +((performance.now() - wakeStart) / 1000).toFixed(1) });
});

$('btn-wake').onclick = async () => {
  report.wakeLock = { supported: wake.supported, events: [] };
  wakeStart = performance.now();
  try {
    await wake.start();
    report.wakeLock.acquired = true;
  } catch (e) {
    report.wakeLock.acquired = false;
    report.wakeLock.error = `${e.name}: ${e.message}`;
  }
  $('wake-answer').hidden = false;
  clearInterval(wakeTimer);
  wakeTimer = setInterval(() => {
    const s = Math.floor((performance.now() - wakeStart) / 1000);
    const lockText = report.wakeLock.acquired ? (wake.held ? 'lock held' : 'lock lost') : 'lock failed';
    setStatus('wake-status', s >= 120 ? `2 minutes done (${lockText}). Did it stay on?` : `${s}s / 120s · ${lockText}`);
  }, 500);
  renderSummary();
};

function finishWakeTest() {
  clearInterval(wakeTimer);
  if (report.wakeLock) report.wakeLock.durationS = Math.round((performance.now() - wakeStart) / 1000);
  if (!state.recording) wake.stop();
}

// ---------- range recorder ----------

$('btn-rec').onclick = async () => {
  if (state.recording) {
    $('btn-rec').disabled = true;
    const rec = state.recording;
    state.recording = null;
    const blob = await rec.stop();
    state.recBlob = blob;
    const seconds = Math.round((performance.now() - rec.startedAt) / 1000);
    report.recorder = { mimeType: rec.mimeType, seconds, sizeMB: +(blob.size / 1e6).toFixed(1) };
    setStatus('rec-status', `Recorded ${seconds}s, ${(blob.size / 1e6).toFixed(0)} MB. Tap Save and choose "Save Video" or "Save to Files".`);
    $('btn-rec').textContent = 'Start recording';
    $('btn-rec').disabled = false;
    $('btn-rec-save').hidden = false;
    $('sel-lens').disabled = $('sel-res').disabled = false;
    if (!report.wakeLock || report.answers.wakeLock) wake.stop();
    renderSummary();
    return;
  }
  const tracks = [...(state.videoStream?.getVideoTracks() ?? []), state.audioTrack].filter(Boolean);
  try {
    const rec = startRecording(new MediaStream(tracks), {
      maxMs: 10 * 60_000,
      onTick: (ms, bytes) => {
        setStatus('rec-status', `Recording ${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')} · ${(bytes / 1e6).toFixed(0)} MB`);
        if (ms >= 10 * 60_000 && state.recording) $('btn-rec').click();
      },
    });
    rec.startedAt = performance.now();
    state.recording = rec;
    wake.start().catch(() => {});
    $('btn-rec').textContent = 'Stop recording';
    $('btn-rec-save').hidden = true;
    $('sel-lens').disabled = $('sel-res').disabled = true;
  } catch (e) {
    setStatus('rec-status', `Recording failed: ${e.message}`);
    log('error', 'recorder', e);
  }
};

$('btn-rec-save').onclick = async () => {
  if (!state.recBlob) return;
  const ext = state.recBlob.type.includes('webm') ? 'webm' : 'mp4';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const how = await saveFile(state.recBlob, `range-${stamp}.${ext}`);
  log('info', `recording ${how}`);
};

// ---------- report ----------

function reportText() {
  return JSON.stringify({ ...report, log: getLogLines().slice(-80) }, null, 1);
}

$('btn-share').onclick = async () => {
  try {
    await navigator.share({ title: 'SwingCam phone check', text: reportText() });
    setStatus('report-status', 'Shared.');
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('report-status', `Share failed (${e.name}). Try Copy.`);
  }
};

$('btn-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(reportText());
    setStatus('report-status', 'Copied. Paste it into Mail or Notes.');
  } catch (e) {
    setStatus('report-status', `Copy failed (${e.name}). Try Download.`);
  }
};

$('btn-download').onclick = () => {
  saveFile(new Blob([reportText()], { type: 'application/json' }), 'swingcam-phone-check.json');
};

function summarize() {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const e = report.env;

  add(e.secureContext ? 'ok' : 'bad', e.secureContext ? 'Secure (HTTPS) page' : 'Not a secure page: camera will not work');
  if (report.permissions) {
    add(report.permissions.granted ? 'ok' : 'bad', report.permissions.granted ? 'Camera and mic allowed' : `Camera/mic refused: ${report.permissions.error}`);
  }

  for (const c of report.cameras) {
    if (c.error) {
      add('bad', `${c.label} ${c.requested}: ${c.error}`);
      continue;
    }
    const fps = c.measured?.fps ?? 0;
    add(fps >= 55 ? 'ok' : fps >= 28 ? 'warn' : 'bad', `${c.label} ${c.requested}: got ${c.got} at ${fps} fps (Safari says ${c.safariFps ?? '?'}, max ${c.maxFps ?? '?'})`);
  }

  if (report.codecs.length) {
    const yes = report.codecs.filter((c) => c.supported).map((c) => c.label);
    add(yes.length ? 'ok' : 'bad', `Encoder supports: ${yes.join(', ') || 'nothing tested'}`);
  } else if (report.encode?.skipped) {
    add('bad', `Encoder: ${report.encode.skipped}`);
  }

  const enc = report.encode;
  if (enc && !enc.skipped) {
    const good = !enc.errors.length && enc.encodedFps >= 55 && enc.dropped <= enc.framesIn * 0.02;
    add(good ? 'ok' : enc.errors.length ? 'bad' : 'warn', `Encoded ${enc.framesIn} frames at ${enc.encodedFps} fps, ${enc.dropped} skipped, ${enc.mbps} Mbps, ${enc.avgEncodeMs} ms avg per frame${enc.errors.length ? ` · errors: ${enc.errors.join('; ')}` : ''}`);
  }
  if (report.clip) {
    const c = report.clip;
    add(c.playerError ? 'bad' : 'ok', `Clip: ${c.seconds}s, ${c.frames} frames, ${c.sizeMB} MB${c.playerError ? ` · won't play: ${c.playerError}` : c.playerDuration ? ` · plays (${c.playerSize})` : ''}`);
  }
  if (report.answers.clipPlayback) add(report.answers.clipPlayback === 'smooth' ? 'ok' : 'bad', `You said the clip: ${report.answers.clipPlayback}`);

  if (report.worker) {
    const r = report.worker.workerRead;
    add(r?.fps ? 'ok' : 'info', `Frames in a worker: ${r?.fps ? `${r.fps} fps` : r?.error || r?.skipped || 'no'}`);
  }
  if (report.jpeg) add('info', `JPEG fallback: ${report.jpeg.fps} fps at ${report.jpeg.size}, ${report.jpeg.avgKB} KB each → ${report.jpeg.bufferMBFor4s} MB for 4 s`);

  if (report.audio) {
    const s = report.audio.settings;
    const off = s.echoCancellation === false && s.noiseSuppression === false && s.autoGainControl === false;
    add(off ? 'ok' : 'warn', `Mic processing ${off ? 'off' : 'not fully off'} (echo ${s.echoCancellation}, noise ${s.noiseSuppression}, gain ${s.autoGainControl}) · ${report.audio.context.sampleRate} Hz`);
  }
  if (report.clapTests.length) {
    const lags = report.clapTests.map((c) => c.lagMs);
    add(lags.length >= 3 ? 'ok' : 'warn', `Audio lag: ${lags.join(', ')} ms (${lags.length}/3 trials)`);
  }

  if (report.wakeLock) {
    const w = report.wakeLock;
    const ans = report.answers.wakeLock;
    add(ans === 'stayed-on' ? 'ok' : ans === 'turned-off' || !w.acquired ? 'bad' : 'warn', `Wake lock: ${w.acquired ? 'acquired' : `failed (${w.error})`}${ans ? ` · you said: ${ans}` : ' · waiting for your answer'}`);
  }

  add(e.features.batteryApi ? 'ok' : 'info', e.features.batteryApi ? 'Battery level available' : 'Battery level not available in Safari (expected)');
  if (report.storage) {
    const idb = report.storage.indexedDbBlob;
    add(idb?.ok ? 'ok' : 'bad', `Storage: ${report.storage.quotaMB ?? '?'} MB allowed · saving a 5 MB clip ${idb?.ok ? `works (${idb.ms} ms)` : `failed: ${idb?.error}`}`);
  }
  add(report.recorder.mimeType ? 'ok' : 'warn', `Range recorder format: ${report.recorder.mimeType || 'none'}`);
  for (const [step, err] of Object.entries(report.errors)) add('bad', `${step} failed: ${err}`);

  if (enc && !enc.skipped) {
    const webcodecsOk = !enc.errors.length && enc.encodedFps >= 28 && report.clip && !report.clip.playerError;
    add('info', `Suggested buffer approach: ${webcodecsOk ? 'WebCodecs (preferred)' : 'JPEG fallback'}`);
  }
  return out;
}

function renderSummary() {
  const ul = $('summary');
  ul.innerHTML = '';
  for (const { level, text } of summarize()) {
    const li = document.createElement('li');
    li.className = level;
    li.textContent = text;
    ul.append(li);
  }
}

renderSummary();
log('info', 'probe loaded', navigator.userAgent);
