// Camera settings, remembered on this phone between visits.

const KEY = 'swingcam.camera.v1';

export const DEFAULT_SETTINGS = {
  lens: 'Back Camera',
  preS: 2.0,
  postS: 1.5,
  avOffsetMs: 0, // how much later the mic hears something than the camera sees it
  thresholdDb: 20,
  minLevelDb: -30, // at the range, neighbours' impacts were −25 to −38 dB, ours −23 to 0
  riseDb: 12,
  minHfRatio: 0.1,
  refractoryS: 3,
  confirmBeep: true,
  motionCheck: true, // only save when something moved in the golfer zone
  minMotionPct: 2,
  motionRule: 'swing', // 'swing': downswing and follow-through; 'window': any movement from the backswing on
  view: 'behind', // 'behind' (down the line) or 'facing' (face on)
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // −60 was the first default and let every neighbour's impact through.
    if (saved.minLevelDb === -60) delete saved.minLevelDb;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // private browsing: settings just won't be remembered
  }
}

export function detectorParams(s) {
  return {
    thresholdDb: s.thresholdDb,
    minLevelDb: s.minLevelDb,
    riseDb: s.riseDb,
    minHfRatio: s.minHfRatio,
    refractoryMs: s.refractoryS * 1000,
  };
}
