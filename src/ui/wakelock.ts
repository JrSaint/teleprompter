/** Screen Wake Lock, held during prompting/calibration and re-acquired
    when the page becomes visible again (Safari drops it on blur). */

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      sentinel = await navigator.wakeLock.request('screen');
    }
  } catch {
    /* not fatal — setup checklist tells the user to disable auto-lock */
  }
}

export function holdWakeLock(): void {
  wanted = true;
  void acquire();
}

export function releaseWakeLock(): void {
  wanted = false;
  try {
    void sentinel?.release();
  } catch {
    /* already released */
  }
  sentinel = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted) void acquire();
});
