import '../style.css';
import { installDebugLog, getLogLines, log } from '../shared/debuglog.js';
import { createWakeLock } from '../shared/wakelock.js';
import { listCameras, isBackCamera, stopStream } from '../shared/cameras.js';
import { AUDIO_CONSTRAINTS, createListener } from '../audio/listener.js';
import { createPipeline } from './pipeline.js';
import { decodeThumbnails } from './calibrate.js';
import { createVoice } from '../shared/voice.js';
import { loadSettings, saveSettings, detectorParams, DEFAULT_SETTINGS } from '../shared/settings.js';
import { saveFile } from '../shared/save.js';
import { wallNow } from '../shared/clock.js';

const $ = (id) => document.getElementById(id);
installDebugLog($('debug-log'));

const video = $('preview');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeOfDay = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Only real lenses: the "Dual", "Triple" and "Dual Wide" cameras switch lenses on their own.
const LENSES = [
  { label: 'Back Camera', name: '1× Wide' },
  { label: 'Back Ultra Wide Camera', name: '0.5× Ultra Wide' },
];
const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
const SAVE_MARGIN_MS = 400; // wait this long past the clip end for frames to be encoded

const settings = loadSettings();
const state = {
  ctx: null,
  listener: null,
  pipeline: null,
  voice: null,
  videoStream: null,
  audioTrack: null,
  fileSource: null,
  fileMode: false,
  armed: false,
  calibrating: null,
  swingCount: 0,
  clips: [],
  current: null,
  sounds: [],
  levelDb: -120,
  bgDb: -120,
  stats: null,
};

const wake = createWakeLock((event, err) => log('info', `wake lock ${event}`, err?.message ?? ''));
const keepMs = () => (settings.preS + settings.postS) * 1000 + 1500;

// ---------- banner ----------

const banners = new Map();

function showBanner(key, text, action = null) {
  banners.delete(key);
  banners.set(key, { text, action });
  renderBanner();
}

function hideBanner(key) {
  banners.delete(key);
  renderBanner();
}

function renderBanner() {
  const top = [...banners.values()].at(-1);
  $('banner').hidden = !top;
  if (!top) return;
  $('banner-text').textContent = top.text;
  const btn = $('banner-btn');
  btn.hidden = !top.action;
  if (top.action) {
    btn.textContent = top.action.label;
    btn.onclick = top.action.run;
  }
}

// ---------- start ----------

function setupAudioContext() {
  const ctx = new AudioContext();
  state.ctx = ctx;
  ctx.resume().catch(() => {});
  ctx.onstatechange = () => {
    log('info', `audio ${ctx.state}`);
    if (ctx.state === 'running') {
      hideBanner('audio');
      return;
    }
    if (document.hidden) return; // handled when the page comes back
    setTimeout(async () => {
      if (ctx.state === 'running' || document.hidden) return;
      await ctx.resume().catch(() => {});
      if (ctx.state !== 'running') {
        showBanner('audio', "The microphone is paused, so swings won't be heard.", { label: 'Resume', run: () => ctx.resume() });
      }
    }, 500);
  };
  return ctx;
}

async function initCommon(ctx) {
  state.voice = createVoice(ctx, log);
  state.voice.load();
  state.listener = await createListener(ctx, onAudioEvent);
  state.listener.setParams(detectorParams(settings));
  state.pipeline = createPipeline(onWorkerMessage);
}

function watchTrack(track, name) {
  track.addEventListener('ended', () => {
    log('warn', `${name} track ended`);
    checkTracks();
  });
  track.addEventListener('mute', () => log('warn', `${name} track muted`));
  track.addEventListener('unmute', () => log('info', `${name} track unmuted`));
}

async function showVideo(stream) {
  video.srcObject = stream;
  await video.play().catch((e) => log('warn', 'preview play', e));
}

$('btn-start').onclick = async () => {
  // The audio context must be created inside the tap, before any await.
  const ctx = state.ctx ?? setupAudioContext();
  $('btn-start').disabled = true;
  $('start-status').textContent = 'Asking for camera and microphone…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', ...VIDEO }, audio: AUDIO_CONSTRAINTS });
    state.audioTrack = stream.getAudioTracks()[0];
    state.videoStream = new MediaStream(stream.getVideoTracks());
    watchTrack(state.audioTrack, 'mic');
    watchTrack(state.videoStream.getVideoTracks()[0], 'camera');
  } catch (e) {
    $('start-status').textContent = `Couldn't get camera/mic (${e.name}). In Safari, tap aA → Website Settings and allow both, then reload.`;
    $('btn-start').disabled = false;
    return;
  }
  try {
    await initCommon(ctx);
    state.listener.connect(ctx.createMediaStreamSource(new MediaStream([state.audioTrack])));
    await showVideo(state.videoStream);
    const options = await renderLensButtons();
    const wanted = options.find((o) => o.label === settings.lens) ?? options[0];
    const current = state.videoStream.getVideoTracks()[0].label;
    if (wanted && wanted.label !== current) await switchLens(wanted.device);
    else await attachVideoTrack();
    navigator.storage?.persist?.().catch(() => {});
  } catch (e) {
    log('error', 'start failed', e);
    $('start-status').textContent = `Something failed: ${e.message}. See the debug log.`;
  }
  enterMain();
};

$('file-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ctx = state.ctx ?? setupAudioContext();
  state.fileMode = true;
  try {
    if (!state.listener) await initCommon(ctx);
    video.srcObject = null;
    video.muted = false;
    video.loop = false;
    video.src = URL.createObjectURL(file);
    await new Promise((r) => (video.onloadeddata = r));
    if (!state.fileSource) {
      state.fileSource = ctx.createMediaElementSource(video);
      state.fileSource.connect(ctx.destination); // so you can hear it
    }
    state.listener.connect(state.fileSource);
    const capture = video.captureStream ?? video.mozCaptureStream;
    const track = capture ? capture.call(video).getVideoTracks()[0] : null;
    const how = await state.pipeline.attach(track, video);
    $('source-info').textContent = `File: ${file.name} · ${how}. Tap Arm to play it through the detector.`;
    $('lens-buttons').hidden = true;
    video.onended = () => {
      if (state.armed) setArmed(false);
      $('source-info').textContent = `File: ${file.name} · finished.`;
    };
  } catch (err) {
    log('error', 'file mode failed', err);
    $('start-status').textContent = `Couldn't use that file: ${err.message}`;
    return;
  }
  enterMain();
};

function enterMain() {
  $('start-card').hidden = true;
  $('main').hidden = false;
  renderState();
  requestAnimationFrame(drawMeter);
}

// ---------- lenses ----------

async function renderLensButtons() {
  const cams = await listCameras();
  let options = LENSES.map((l) => ({ ...l, device: cams.find((c) => c.label === l.label) })).filter((o) => o.device);
  if (!options.length) {
    // Not an iPhone: offer whatever there is, back cameras first.
    options = [...cams.filter(isBackCamera), ...cams.filter((c) => !isBackCamera(c))].map((c, i) => ({ label: c.label, name: c.label || `Camera ${i + 1}`, device: c }));
  }
  const current = state.videoStream?.getVideoTracks()[0]?.label;
  const box = $('lens-buttons');
  box.innerHTML = '';
  for (const o of options) {
    const b = document.createElement('button');
    b.className = 'small' + (o.label === current ? ' selected' : '');
    b.textContent = o.name;
    b.onclick = () => switchLens(o.device).catch((e) => log('error', 'lens switch', e));
    box.append(b);
  }
  return options;
}

async function switchLens(device) {
  stopStream(state.videoStream);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { ...(device ? { deviceId: { exact: device.deviceId } } : { facingMode: 'environment' }), ...VIDEO },
  });
  state.videoStream = stream;
  watchTrack(stream.getVideoTracks()[0], 'camera');
  await showVideo(stream);
  settings.lens = stream.getVideoTracks()[0].label;
  saveSettings(settings);
  await attachVideoTrack();
  await renderLensButtons();
}

async function attachVideoTrack() {
  const track = state.videoStream.getVideoTracks()[0];
  const how = await state.pipeline.attach(track, video);
  const s = track.getSettings();
  $('source-info').textContent = `${track.label} · ${s.width}×${s.height} at ${s.frameRate ?? '?'} fps · ${how}`;
  log('info', 'video source', $('source-info').textContent);
}

video.addEventListener('resize', () => {
  if (video.videoWidth) $('preview-wrap').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
});

// Warn if the picture is dark, or one side is much darker (e.g. the mount covers the lens).
const lensCanvas = document.createElement('canvas');
lensCanvas.width = lensCanvas.height = 16;
const lensCtx = lensCanvas.getContext('2d', { willReadFrequently: true });
setInterval(() => {
  if (!video.videoWidth || state.fileMode || $('main').hidden) return;
  lensCtx.drawImage(video, 0, 0, 16, 16);
  const d = lensCtx.getImageData(0, 0, 16, 16).data;
  const halves = { left: 0, right: 0, top: 0, bottom: 0 };
  let all = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      all += l;
      halves[x < 8 ? 'left' : 'right'] += l;
      halves[y < 8 ? 'top' : 'bottom'] += l;
    }
  }
  const mean = all / 256;
  const ratio = (a, b) => Math.min(a, b) / Math.max(a, b, 1);
  const lopsided = ratio(halves.left, halves.right) < 0.25 || ratio(halves.top, halves.bottom) < 0.25;
  $('lens-warning').hidden = !(mean < 12 || (lopsided && Math.min(...Object.values(halves)) / 128 < 20));
}, 2000);

// ---------- arm ----------

function setArmed(on) {
  state.armed = on;
  state.listener.arm(on);
  state.pipeline.setEncoding(on || !!state.calibrating, keepMs());
  if (on) {
    state.ctx.resume().catch(() => {});
    wake.start().catch((e) => showBanner('wake', `The screen may turn off (${e.message}). Set Auto-Lock to Never.`, { label: 'OK', run: () => hideBanner('wake') }));
    if (state.fileMode) video.play();
  } else {
    if (!state.calibrating) wake.stop();
    if (state.fileMode) video.pause();
  }
  renderState();
}

$('btn-arm').onclick = () => setArmed(!state.armed);

function renderState() {
  $('btn-arm').textContent = state.armed ? 'Armed · tap to stop' : 'Arm';
  $('btn-arm').classList.toggle('armed', state.armed);
  $('pill-state').textContent = state.armed ? 'Armed' : 'Ready';
  $('pill-state').className = 'pill' + (state.armed ? ' on' : '');
  $('pill-clips').textContent = `${state.clips.length} swing${state.clips.length === 1 ? '' : 's'}`;
}

// ---------- worker ----------

let stalledSince = null;

function onWorkerMessage(msg) {
  if (msg.type === 'stats') {
    state.stats = msg;
    $('pill-fps').textContent = `${msg.fps} fps`;
    $('pill-fps').className = 'pill' + (msg.fps < 50 ? ' warn' : '');
    $('pill-buffer').textContent = msg.encoding ? `buffer ${msg.bufferS} s` : 'buffer off';
    const stalled = state.armed && !document.hidden && msg.fps === 0;
    stalledSince = stalled ? (stalledSince ?? wallNow()) : null;
    if (stalledSince && wallNow() - stalledSince > 3000) {
      showBanner('stalled', 'The camera stopped sending video.', { label: 'Restart', run: restartCapture });
    } else if (!stalled) {
      hideBanner('stalled');
    }
  } else if (msg.type === 'info') {
    log('info', 'worker:', msg.message);
  } else if (msg.type === 'error') {
    log('error', 'worker:', msg.message);
  }
}

// ---------- sound events ----------

function onAudioEvent(ev) {
  if (ev.type === 'levels') {
    state.levelDb = Math.max(...ev.levels);
    state.bgDb = ev.bgDb;
  } else if (ev.type === 'trigger') {
    if (state.calibrating) state.calibrating.resolve(ev);
    else if (state.armed) captureSwing(ev);
  } else if (ev.type === 'reject' && !state.calibrating) {
    addSound({ ...ev, result: `ignored: ${ev.reason}` });
  }
}

async function captureSwing(ev) {
  const n = ++state.swingCount;
  const entry = addSound({ ...ev, result: `swing ${n}: saving…` });
  $('last-trigger').textContent = `Swing ${n} heard at ${timeOfDay(new Date())} (+${ev.snrDb} dB over background)`;
  const impactT = ev.t - settings.avOffsetMs;
  const preMs = settings.preS * 1000;
  const postMs = settings.postS * 1000;
  await sleep(Math.max(0, impactT + postMs + SAVE_MARGIN_MS - wallNow()));

  const res = await state.pipeline.cut({ startT: impactT - preMs, endT: impactT + postMs, impactT });
  if (res.error) {
    entry.result = `swing ${n}: failed (${res.error})`;
    renderSounds();
    log('error', `swing ${n}`, res.error);
    return;
  }
  const clip = {
    n,
    at: new Date(),
    blob: new Blob([res.buffer], { type: 'video/mp4' }),
    durationS: res.durationS,
    impactOffsetS: res.impactOffsetS,
    frames: res.frames,
    snrDb: ev.snrDb,
  };
  state.clips.unshift(clip);
  entry.result = `swing ${n}` + (res.missingStartMs > 100 ? ` (missing ${(res.missingStartMs / 1000).toFixed(1)} s at start)` : '');
  renderSounds();
  renderClips();
  renderState();
  if (settings.confirmBeep) state.voice.beep(500, 120, 0.4);
  log('info', `swing ${n} saved`, {
    frames: res.frames,
    durationS: +res.durationS.toFixed(2),
    impactOffsetS: +res.impactOffsetS.toFixed(2),
    missingStartMs: res.missingStartMs,
    missingEndMs: res.missingEndMs,
    savedAfterMs: Math.round(wallNow() - ev.t),
  });
}

function addSound(entry) {
  state.sounds.unshift({ time: new Date(), ...entry });
  if (state.sounds.length > 300) state.sounds.pop();
  renderSounds();
  return state.sounds[0];
}

function renderSounds() {
  $('log-count').textContent = state.sounds.length;
  const body = $('log-body');
  body.innerHTML = '';
  for (const s of state.sounds.slice(0, 100)) {
    const tr = document.createElement('tr');
    tr.className = s.type === 'trigger' ? 'hit' : '';
    for (const v of [timeOfDay(s.time), s.result, s.levelDb, `+${s.snrDb}`, s.riseDb, `${Math.round(s.hfRatio * 100)}%`]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    body.append(tr);
  }
}

$('btn-share-log').onclick = async () => {
  const text = JSON.stringify(
    {
      settings,
      stats: state.stats,
      swings: state.clips.map(({ blob, url, ...c }) => ({ ...c, sizeMB: +(blob.size / 1e6).toFixed(2) })),
      sounds: state.sounds,
      log: getLogLines().slice(-100),
    },
    null,
    1,
  );
  try {
    await navigator.share({ title: 'SwingCam sound log', text });
  } catch (e) {
    if (e.name !== 'AbortError') await navigator.clipboard?.writeText(text).catch(() => {});
  }
};

// ---------- meter ----------

const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));

function drawMeter() {
  const trig = state.bgDb + settings.thresholdDb;
  $('meter-bar').style.width = `${dbToPct(state.levelDb)}%`;
  $('meter-bar').classList.toggle('over', state.levelDb >= trig);
  $('meter-bg').style.left = `${dbToPct(state.bgDb)}%`;
  $('meter-trigger').style.left = `${dbToPct(trig)}%`;
  $('lvl-now').textContent = state.levelDb.toFixed(0);
  $('lvl-bg').textContent = state.bgDb.toFixed(0);
  $('lvl-trig').textContent = trig.toFixed(0);
  requestAnimationFrame(drawMeter);
}

// ---------- clips ----------

let playbackRate = 1;

function renderClips() {
  $('no-clips').hidden = state.clips.length > 0;
  const list = $('clip-list');
  list.innerHTML = '';
  for (const clip of state.clips) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'clip-btn' + (clip === state.current ? ' selected' : '');
    b.innerHTML = `<b>Swing ${clip.n}</b><span>${timeOfDay(clip.at)} · ${clip.durationS.toFixed(1)} s · +${clip.snrDb} dB</span>`;
    b.onclick = () => openClip(clip);
    li.append(b);
    list.append(li);
  }
}

function openClip(clip) {
  state.current = clip;
  clip.url ??= URL.createObjectURL(clip.blob);
  const p = $('player');
  p.src = clip.url;
  p.onloadedmetadata = () => {
    p.playbackRate = p.defaultPlaybackRate = playbackRate;
    $('tl-impact').style.left = `${(clip.impactOffsetS / p.duration) * 100}%`;
  };
  $('player-box').hidden = false;
  $('player-info').textContent = `Swing ${clip.n} · ${clip.durationS.toFixed(1)} s · ${clip.frames} frames · impact at ${clip.impactOffsetS.toFixed(2)} s · ${(clip.blob.size / 1e6).toFixed(1)} MB`;
  renderClips();
}

$('player').ontimeupdate = () => {
  const p = $('player');
  if (p.duration) $('tl-head').style.left = `${(p.currentTime / p.duration) * 100}%`;
};

document.querySelectorAll('.speed').forEach((b) => {
  b.onclick = () => {
    playbackRate = Number(b.dataset.rate);
    const p = $('player');
    p.playbackRate = p.defaultPlaybackRate = playbackRate;
    document.querySelectorAll('.speed').forEach((x) => x.classList.toggle('selected', x === b));
  };
});
document.querySelector('.speed[data-rate="1"]').classList.add('selected');

$('btn-impact').onclick = () => {
  const p = $('player');
  p.pause();
  if (state.current) p.currentTime = state.current.impactOffsetS;
};

$('btn-save-clip').onclick = () => {
  if (state.current) saveFile(state.current.blob, `swing-${state.current.n}.mp4`).then((how) => log('info', `swing ${state.current.n} ${how}`));
};

$('btn-delete-clip').onclick = () => {
  const clip = state.current;
  if (!clip) return;
  state.clips = state.clips.filter((c) => c !== clip);
  if (clip.url) URL.revokeObjectURL(clip.url);
  state.current = null;
  $('player').removeAttribute('src');
  $('player-box').hidden = true;
  renderClips();
  renderState();
};

// ---------- settings ----------

const SLIDERS = [
  ['sl-pre', 'preS', 'v-pre', (v) => `${v.toFixed(1)} s`],
  ['sl-post', 'postS', 'v-post', (v) => `${v.toFixed(2)} s`],
  ['sl-av', 'avOffsetMs', 'v-av', (v) => `${v} ms`],
  ['sl-refr', 'refractoryS', 'v-refr', (v) => `${v} s`],
  ['sl-min', 'minLevelDb', 'v-min', (v) => `${v} dB`],
  ['sl-rise', 'riseDb', 'v-rise', (v) => `${v} dB`],
  ['sl-hf', 'minHfRatio', 'v-hf', (v) => `${Math.round(v * 100)}%`],
];

function applySettings() {
  saveSettings(settings);
  state.listener?.setParams(detectorParams(settings));
  if (state.pipeline && (state.armed || state.calibrating)) state.pipeline.setEncoding(true, keepMs());
}

function showSettings() {
  for (const [id, key, labelId, fmt] of SLIDERS) {
    $(id).value = settings[key];
    $(labelId).textContent = fmt(settings[key]);
  }
  $('sl-sens').value = 48 - settings.thresholdDb;
  $('sens-label').textContent = `(triggers at +${settings.thresholdDb} dB over background)`;
  $('cb-beep').checked = settings.confirmBeep;
}

for (const [id, key, labelId, fmt] of SLIDERS) {
  $(id).oninput = () => {
    settings[key] = Number($(id).value);
    $(labelId).textContent = fmt(settings[key]);
    applySettings();
  };
}
$('sl-sens').oninput = () => {
  settings.thresholdDb = 48 - Number($('sl-sens').value);
  $('sens-label').textContent = `(triggers at +${settings.thresholdDb} dB over background)`;
  applySettings();
};
$('cb-beep').onchange = () => {
  settings.confirmBeep = $('cb-beep').checked;
  applySettings();
};
$('btn-reset-settings').onclick = () => {
  Object.assign(settings, DEFAULT_SETTINGS, { lens: settings.lens });
  showSettings();
  applySettings();
};
showSettings();

// ---------- clap test ----------

const trials = [];
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

$('btn-calib').onclick = async () => {
  if (state.calibrating || !state.listener) return;
  if (state.fileMode) {
    $('calib-status').textContent = 'The clap test needs the live camera.';
    return;
  }
  const wasArmed = state.armed;
  if (wasArmed) setArmed(false);
  $('btn-calib').disabled = true;
  $('calib-frames').innerHTML = '';
  let resolveTrigger;
  const triggered = new Promise((r) => (resolveTrigger = r));
  state.calibrating = { resolve: resolveTrigger };
  state.pipeline.setEncoding(true, keepMs());
  wake.start().catch(() => {});
  state.ctx.resume().catch(() => {});
  state.voice.say('start');
  const say = (text) => ($('calib-status').textContent = text);

  try {
    await state.voice.countdown((s) => say(s === 0 ? 'CLAP!' : s > 5 ? `Walk out… ${s}` : String(s)));
    state.listener.arm(true);
    const ev = await Promise.race([triggered, sleep(4000).then(() => null)]);
    state.listener.arm(false);
    if (!ev) {
      say("Didn't hear a clap. Try again, a bit louder.");
      state.voice.say('try-again');
      return;
    }
    await sleep(600); // let the frames after the clap reach the buffer
    const msg = await state.pipeline.chunks({ startT: ev.t - 400, endT: ev.t + 300 });
    const thumbs = await decodeThumbnails(msg, ev.t - 300, ev.t + 200);
    log('info', 'clap heard', { snrDb: ev.snrDb, levelDb: ev.levelDb, chunks: msg.chunks.length, thumbs: thumbs.length, rotation: msg.rotation });
    if (!thumbs.length) {
      say('Heard the clap, but there was no video around it. Try again.');
      state.voice.say('try-again');
      return;
    }
    state.voice.say('got-it');
    say('Tap the first picture where your hands touch.');
    for (const th of thumbs) {
      const b = document.createElement('button');
      const label = document.createElement('span');
      const rel = Math.round(th.t - ev.t);
      label.textContent = `${rel > 0 ? '+' : ''}${rel} ms`;
      b.append(th.canvas, label);
      b.onclick = () => {
        trials.push(Math.round(ev.t - th.t));
        $('calib-frames').innerHTML = '';
        say(`Audio lag: ${trials.at(-1)} ms`);
        showTrials();
      };
      $('calib-frames').append(b);
    }
  } catch (e) {
    log('error', 'clap test', e);
    say(`Clap test failed: ${e.message}`);
  } finally {
    state.calibrating = null;
    $('btn-calib').disabled = false;
    if (wasArmed) setArmed(true);
    else {
      state.pipeline.setEncoding(false, keepMs());
      wake.stop();
    }
  }
};

function showTrials() {
  const m = median(trials);
  $('calib-results').textContent = `Trials: ${trials.join(', ')} ms · middle value ${m} ms${trials.length < 3 ? ` · ${3 - trials.length} more is better` : ''}`;
  $('btn-calib-use').hidden = false;
  $('btn-calib-use').textContent = `Use ${m} ms`;
}

$('btn-calib-use').onclick = () => {
  settings.avOffsetMs = median(trials);
  showSettings();
  applySettings();
  $('calib-results').textContent += ' · saved';
};

// ---------- background / recovery ----------

let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = wallNow();
    if (state.armed) log('warn', 'Safari hidden while armed: nothing is recorded until it comes back');
    return;
  }
  const awayS = hiddenAt ? (wallNow() - hiddenAt) / 1000 : 0;
  hiddenAt = null;
  log('info', `page visible after ${awayS.toFixed(1)} s`);
  state.ctx?.resume().catch(() => {});
  if (state.armed && awayS > 1) {
    showBanner('background', `Safari was in the background for ${Math.round(awayS)} s. Swings during that time weren't recorded.`, { label: 'OK', run: () => hideBanner('background') });
  }
  checkTracks();
});

function checkTracks() {
  if (state.fileMode || !state.videoStream) return;
  const videoEnded = state.videoStream.getVideoTracks()[0]?.readyState === 'ended';
  const micEnded = state.audioTrack?.readyState === 'ended';
  if (videoEnded || micEnded) {
    showBanner('tracks', `The ${videoEnded && micEnded ? 'camera and microphone' : videoEnded ? 'camera' : 'microphone'} stopped.`, { label: 'Restart', run: restartCapture });
  }
}

async function restartCapture() {
  hideBanner('tracks');
  hideBanner('stalled');
  try {
    if (state.audioTrack?.readyState !== 'live') {
      const s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      state.audioTrack = s.getAudioTracks()[0];
      watchTrack(state.audioTrack, 'mic');
      state.listener.connect(state.ctx.createMediaStreamSource(new MediaStream([state.audioTrack])));
    }
    const device = (await listCameras()).find((c) => c.label === settings.lens) ?? null;
    await switchLens(device);
    await state.ctx.resume();
  } catch (e) {
    log('error', 'restart failed', e);
    showBanner('tracks', `Couldn't restart: ${e.message}`, { label: 'Retry', run: restartCapture });
  }
}

log('info', 'camera page loaded', navigator.userAgent);
