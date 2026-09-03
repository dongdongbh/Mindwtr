import * as IntentLauncher from 'expo-intent-launcher';
import { NativeModules, Platform } from 'react-native';

import { rescheduleMobileAlarmsAsExact } from './notification-service';

// Android 12 (API 31) is where "Alarms & reminders" appears. Below it every
// alarm is already exact and there is nothing to ask for.
const EXACT_ALARM_MIN_API = 31;

type ExactAlarmNativeModule = {
  canScheduleExactAlarms?: () => Promise<boolean>;
};

// Last value `refreshExactAlarmPermission` observed. `null` means "not read
// yet" so the first read after a cold start never counts as a grant.
let lastKnownAllowed: boolean | null = null;

/** True only where the OS can withhold exact alarms from this app. */
export function isExactAlarmPermissionRelevant(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= EXACT_ALARM_MIN_API;
}

/**
 * Whether AlarmManager will honour an exact alarm right now. Anything we
 * cannot read (older native build, bridge error) resolves to `true`: the
 * notice exists to explain a real limitation, and showing it on a guess would
 * send users to a system screen that has nothing to fix.
 */
export async function canScheduleExactAlarms(): Promise<boolean> {
  if (!isExactAlarmPermissionRelevant()) return true;
  const native = NativeModules.RNAlarmNotification as ExactAlarmNativeModule | undefined;
  if (typeof native?.canScheduleExactAlarms !== 'function') return true;
  try {
    return (await native.canScheduleExactAlarms()) === true;
  } catch {
    return true;
  }
}

/**
 * Reads the current state and, when it moved from denied to allowed, rebuilds
 * the scheduled alarms so they become exact without an app restart. Callers
 * may run this concurrently from several screens: the transition is latched
 * here, so the rebuild happens once per real grant.
 */
export async function refreshExactAlarmPermission(): Promise<boolean> {
  const allowed = await canScheduleExactAlarms();
  const wasDenied = lastKnownAllowed === false;
  lastKnownAllowed = allowed;
  if (allowed && wasDenied) {
    await rescheduleMobileAlarmsAsExact();
  }
  return allowed;
}

/** Opens the system "Alarms & reminders" screen for this app. */
export async function openExactAlarmSettings(): Promise<void> {
  if (!isExactAlarmPermissionRelevant()) return;
  // expo-application resolves its native module at import time, which every
  // settings screen test would then have to mock; load it only when the user
  // actually taps Allow.
  const { applicationId: packageName } = await import('expo-application');
  await IntentLauncher.startActivityAsync(
    IntentLauncher.ActivityAction.REQUEST_SCHEDULE_EXACT_ALARM,
    packageName ? { data: `package:${packageName}` } : undefined
  );
}

export const __exactAlarmTestUtils = {
  reset: () => {
    lastKnownAllowed = null;
  },
  getLastKnownAllowed: () => lastKnownAllowed,
};
