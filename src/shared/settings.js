// Camera settings, remembered on this phone between visits.

const KEY = 'swingcam.camera.v1';

export const DEFAULT_SETTINGS = {
  lens: 'Back Camera',
  preS: 2.0,
  postS: 1.5,
  avOffsetMs: 0, // how much later the mic hears something than the camera sees it
  thresholdDb: 20,
  minLevelDb: -60,
  riseDb: 12,
  minHfRatio: 0.1,
  refractoryS: 3,
  confirmBeep: true,
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
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
