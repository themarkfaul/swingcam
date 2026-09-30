// Keeps the screen awake. Safari drops the lock whenever the page is hidden,
// so it is re-acquired when the page becomes visible again.

export function createWakeLock(onChange = () => {}) {
  let sentinel = null;
  let wanted = false;
  const supported = 'wakeLock' in navigator;

  async function acquire() {
    if (!supported) throw new Error('Wake Lock API not available');
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
      onChange('released');
    });
    onChange('held');
  }

  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible' && !sentinel) {
      acquire().catch((e) => onChange('error', e));
    }
  });

  return {
    supported,
    async start() {
      wanted = true;
      if (!sentinel) await acquire();
    },
    async stop() {
      wanted = false;
      await sentinel?.release();
      sentinel = null;
    },
    get held() {
      return !!sentinel && !sentinel.released;
    },
  };
}
