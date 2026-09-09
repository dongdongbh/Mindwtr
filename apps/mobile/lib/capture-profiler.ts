import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type CaptureProfiler = {
  beginCaptureProfile(): number;
  endCaptureProfileAsync(token: number): Promise<boolean>;
};

// Diagnostic-only build, not a setting. Native code independently checks both
// its build flag and the Benchmark package. Never send task fields to a profiler.
const enabled = process.env.EXPO_PUBLIC_CAPTURE_PROFILING === '1' && Platform.OS === 'android';
let active: { native: CaptureProfiler; token: number } | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let limitTimer: ReturnType<typeof setTimeout> | undefined;

function stop(): void {
  clearTimeout(closeTimer);
  clearTimeout(limitTimer);
  closeTimer = limitTimer = undefined;
  const session = active;
  active = null;
  if (!session) return;
  try { void session.native.endCaptureProfileAsync(session.token).catch(() => undefined); }
  catch { /* Optional instrumentation cannot break capture. */ }
}

export function beginCaptureProfile(): void {
  if (!enabled) return;
  clearTimeout(closeTimer);
  closeTimer = undefined;
  if (active) return;
  try {
    const native = requireOptionalNativeModule<CaptureProfiler>('MindwtrStartupMetrics');
    const token = native?.beginCaptureProfile();
    if (!native || !token) return;
    active = { native, token };
    limitTimer = setTimeout(stop, 30_000);
  } catch { /* Expo Go and older clients have no sampling capability. */ }
}

export function endCaptureProfile(): void {
  if (!active) return;
  clearTimeout(closeTimer);
  // Include the React unmount commit without doing profile serialization in the
  // capture-close callback. Reopening within this window retains one session.
  closeTimer = setTimeout(stop, 200);
}
