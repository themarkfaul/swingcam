// Compares the two movement rules on saved clips. Each clip is decoded to
// small upright 32×32 pictures (the same size and zone the camera uses), its
// movement measured, and both rules scored around the impact.
import '../style.css';
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';
import { SNAP, grayFromImageData } from '../camera/orientation.js';
import { zoneChange, swingScores, looksLikeSwing } from '../camera/motion.js';

const $ = (id) => document.getElementById(id);
const THRESHOLDS = Array.from({ length: 20 }, (_, i) => (i + 1) / 2); // 0.5 … 10 %
const RULES = {
  window: 'Current: any movement in the 1.2 s before',
  swing: 'Proposed: movement before AND after',
};

export async function measureClip(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const first = await track.getFirstTimestamp();
  const sink = new CanvasSink(track, { width: SNAP, height: SNAP, fit: 'fill' });
  const recent = [];
  const samples = [];
  for await (const { canvas, timestamp } of sink.canvases()) {
    const gray = grayFromImageData(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, SNAP, SNAP).data);
    recent.push(gray);
    if (recent.length > 3) recent.shift();
    if (recent.length === 3) samples.push({ t: (timestamp - first) * 1000, change: zoneChange(recent[0], gray, SNAP) });
  }
  return { samples, rotation: await track.getRotation() };
}

// Swing number → { impactOffsetS, levelDb } from a Share-log JSON.
export function readLog(log) {
  const bySwing = new Map();
  for (const s of log.swings ?? []) bySwing.set(s.n, { impactOffsetS: s.impactOffsetS, levelDb: s.levelDb ?? null });
  for (const s of log.sounds ?? []) {
    const m = /^swing (\d+)/.exec(s.result ?? '');
    if (m && bySwing.has(+m[1])) bySwing.get(+m[1]).levelDb = s.levelDb;
  }
  return bySwing;
}

// rows: [{ own, scores }]. For each rule and threshold: how many of your
// swings are kept, and how many from other bays are rejected.
export function compare(rows) {
  const own = rows.filter((r) => r.own);
  const other = rows.filter((r) => !r.own);
  const byRule = {};
  for (const rule of Object.keys(RULES)) {
    byRule[rule] = THRESHOLDS.map((pct) => ({
      pct,
      ownKept: own.filter((r) => looksLikeSwing(r.scores, rule, pct / 100)).length,
      otherRejected: other.filter((r) => !looksLikeSwing(r.scores, rule, pct / 100)).length,
    }));
  }
  return { own: own.length, other: other.length, byRule };
}

// Best threshold: keeps as many of your swings as possible, then rejects as many others as possible.
export function best(list) {
  return [...list].sort((a, b) => b.ownKept - a.ownKept || b.otherRejected - a.otherRejected || a.pct - b.pct)[0];
}

export async function run(files, log, ownDb, onProgress = () => {}) {
  const bySwing = readLog(log);
  const rows = [];
  for (const [i, file] of files.entries()) {
    const n = Number(/swing-(\d+)/.exec(file.name)?.[1]);
    const info = bySwing.get(n);
    if (!info) {
      onProgress(`Skipping ${file.name}: not in the log`);
      continue;
    }
    onProgress(`Measuring ${file.name} (${i + 1}/${files.length})…`);
    const { samples } = await measureClip(file);
    rows.push({
      n,
      levelDb: info.levelDb,
      own: info.levelDb != null && info.levelDb >= ownDb,
      scores: swingScores(samples, info.impactOffsetS * 1000),
    });
  }
  return rows.sort((a, b) => a.n - b.n);
}

function render(rows) {
  const { own, other, byRule } = compare(rows);
  let html = `<p>${own} of your swings and ${other} from other bays.</p>`;
  html += '<table class="log-table"><tr><th>Rule</th><th>At 2% (current setting)</th><th>Best setting</th></tr>';
  for (const [rule, label] of Object.entries(RULES)) {
    const at2 = byRule[rule].find((x) => x.pct === 2);
    const b = best(byRule[rule]);
    html += `<tr><td>${label}</td><td>keeps ${at2.ownKept}/${own} yours · rejects ${at2.otherRejected}/${other} others</td>`;
    html += `<td>${b.pct}%: keeps ${b.ownKept}/${own} · rejects ${b.otherRejected}/${other}</td></tr>`;
  }
  $('summary').innerHTML = html + '</table>';
  $('summary-card').hidden = false;

  const pct = (v) => (v * 100).toFixed(1);
  const table = $('clip-table');
  table.innerHTML = '<tr><th>Swing</th><th>Level</th><th>Yours?</th><th>1.2 s before</th><th>Downswing</th><th>Follow-through</th></tr>';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.n}</td><td>${r.levelDb ?? '?'}</td><td></td><td>${pct(r.scores.window)}</td><td>${pct(r.scores.downswing)}</td><td>${pct(r.scores.follow)}</td>`;
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="1">yours</option><option value="0">other bay</option>';
    sel.value = r.own ? '1' : '0';
    sel.onchange = () => {
      r.own = sel.value === '1';
      render(rows);
    };
    tr.children[2].append(sel);
    table.append(tr);
  }
  $('clips-card').hidden = false;
}

$('run').onclick = async () => {
  const files = [...$('clips').files];
  let log;
  try {
    log = JSON.parse($('log').value);
  } catch {
    $('status').textContent = "The sound log isn't valid JSON. Paste the whole Share log text.";
    return;
  }
  if (!files.length) {
    $('status').textContent = 'Choose some clips first.';
    return;
  }
  const rows = await run(files, log, Number($('own-db').value), (msg) => ($('status').textContent = msg));
  $('status').textContent = `Measured ${rows.length} clips.`;
  render(rows);
};
