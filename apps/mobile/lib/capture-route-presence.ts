


export const SHEET_DISMISS_SETTLE_MS = 700;
const CAPTURE_UNMOUNT_FALLBACK_MS = 1500;

let mountedCaptureScreens = 0;
let lastCaptureUnmountAt = 0;
let waiters: (() => void)[] = [];

const now = () => Date.now();

function flushWaiters() {
  const pending = waiters;
  waiters = [];
  pending.forEach((run) => run());
}

export function markCaptureRouteMounted(): () => void {
  mountedCaptureScreens += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedCaptureScreens = Math.max(0, mountedCaptureScreens - 1);
    lastCaptureUnmountAt = now();
    if (mountedCaptureScreens === 0) flushWaiters();
  };
}


export function runAfterCaptureRouteGone(action: () => void): () => void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    action();
  };
  const cancel = () => {
    done = true;
    if (timer) clearTimeout(timer);
    waiters = waiters.filter((waiter) => waiter !== afterUnmount);
  };
  const afterUnmount = () => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, SHEET_DISMISS_SETTLE_MS);
  };
  if (mountedCaptureScreens > 0) {
    waiters.push(afterUnmount);
    timer = setTimeout(run, CAPTURE_UNMOUNT_FALLBACK_MS);
    return cancel;
  }
  const remainingDismissalSettleMs = lastCaptureUnmountAt + SHEET_DISMISS_SETTLE_MS - now();
  if (remainingDismissalSettleMs <= 0) {
    run();
    return () => {};
  }
  timer = setTimeout(run, remainingDismissalSettleMs);
  return cancel;
}


export function resetCaptureRoutePresenceForTests(): void {
  mountedCaptureScreens = 0;
  lastCaptureUnmountAt = 0;
  waiters = [];
}
