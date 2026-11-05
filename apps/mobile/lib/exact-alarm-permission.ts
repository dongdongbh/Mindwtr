import * as IntentLauncher from 'expo-intent-launcher';
import { NativeModules, Platform } from 'react-native';

import { rescheduleMobileAlarmsAsExact } from './notification-service';


const EXACT_ALARM_MIN_API = 31;

type ExactAlarmNativeModule = {
  canScheduleExactAlarms?: () => Promise<boolean>;
};


let lastKnownAllowed: boolean | null = null;


export function isExactAlarmPermissionRelevant(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= EXACT_ALARM_MIN_API;
}


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


export async function refreshExactAlarmPermission(): Promise<boolean> {
  const allowed = await canScheduleExactAlarms();
  const wasDenied = lastKnownAllowed === false;
  lastKnownAllowed = allowed;
  if (allowed && wasDenied) {
    await rescheduleMobileAlarmsAsExact();
  }
  return allowed;
}


export async function openExactAlarmSettings(): Promise<void> {
  if (!isExactAlarmPermissionRelevant()) return;


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
