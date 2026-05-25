// Worker-driven sleep that bypasses browser background-tab throttling.
//
// Browsers (Chrome / Edge / Firefox) clamp setTimeout / setInterval to a
// minimum interval of ~1 s once a tab is hidden, and further throttle after
// 5 min in background. The WebHID exchange poll loop ticks every 5-20 ms,
// so a backgrounded DFU transfer crawls (~50-200x slowdown).
//
// Dedicated Web Workers are NOT throttled when the page is hidden — their
// event loop keeps running at full speed. We spin up a tiny worker that
// emits a periodic tick (postMessage), and resolve queued sleeps when their
// deadline lands. The main-thread message handler IS pumped at full speed
// in response to worker messages even when the tab is hidden.
//
// Usage:
//   import { unthrottledSleep } from './unthrottledSleep.js';
//   await unthrottledSleep(5);
//
// The worker is created lazily on first call and torn down when no sleepers
// are queued, so there's no overhead for non-DFU paths that never call it.

const WORKER_SRC = `
  let intervalId = null;
  const TICK_MS = 2;
  self.onmessage = (e) => {
    if (e.data === 'start') {
      if (intervalId === null) {
        intervalId = setInterval(() => self.postMessage(1), TICK_MS);
      }
    } else if (e.data === 'stop') {
      if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
    }
  };
`;

let worker = null;
const waiters = []; // { wakeAt: number, resolve: () => void }

function ensureWorker() {
  if (worker) return worker;
  const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
  worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = () => {
    if (waiters.length === 0) {
      worker.postMessage('stop');
      return;
    }
    const now = performance.now();
    // Iterate from end so splice indexes stay valid.
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].wakeAt <= now) {
        const w = waiters[i];
        waiters.splice(i, 1);
        w.resolve();
      }
    }
    if (waiters.length === 0) worker.postMessage('stop');
  };
  return worker;
}

export function unthrottledSleep(ms) {
  return new Promise((resolve) => {
    const wakeAt = performance.now() + ms;
    waiters.push({ wakeAt, resolve });
    const w = ensureWorker();
    if (waiters.length === 1) w.postMessage('start');
  });
}
