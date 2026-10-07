import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  generateUUID,
  getMobileAnalyticsChannel,
  getMobileDeviceClass,
  getMobileOsMajor,
  isMobileAnalyticsHeartbeatConfigured,
  resetHeartbeatOptOutMarker,
  resolveMobileAnalyticsVersion,
  sendMobileAnalyticsOptOut as sendCoreMobileAnalyticsOptOut,
  sendMobileDailyHeartbeat as sendCoreMobileDailyHeartbeat,
  type AppSettings,
  type MobileAnalyticsHeartbeatConfig,
  type MobileHeartbeatDevice,
} from '@mindwtr/core';

// Core's (analytics-heartbeat.ts), shared with the native hosts.
export { isMobileAnalyticsHeartbeatConfigured, resolveMobileAnalyticsVersion, type MobileAnalyticsHeartbeatConfig };

type PlatformExtras = typeof Platform & {
  isPad?: boolean;
  constants?: {
    Release?: string;
  };
};

const platformExtras = Platform as PlatformExtras;

export function getDeviceLocale(): string {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
  } catch {
    return '';
  }
}

/** This device for core's heartbeat: RN's Platform, AsyncStorage and fetch. */
function mobileHeartbeatDevice(): MobileHeartbeatDevice {
  return {
    platform: Platform.OS,
    platformVersion: Platform.Version,
    osRelease: platformExtras.constants?.Release,
    isPad: platformExtras.isPad,
    locale: getDeviceLocale(),
    isDev: __DEV__,
    storage: AsyncStorage,
    fetcher: fetch,
    generateId: generateUUID,
  };
}

export async function getMobileStartupAnalyticsContext(
  isFossBuild: boolean,
  analyticsHeartbeatChannel?: string | null
) {
  return {
    channel: getMobileAnalyticsChannel(Platform.OS, isFossBuild, analyticsHeartbeatChannel),
    deviceClass: getMobileDeviceClass(Platform.OS, platformExtras.isPad),
    locale: getDeviceLocale(),
    osMajor: getMobileOsMajor(Platform.OS, Platform.Version, platformExtras.constants?.Release),
    platform: Platform.OS,
  };
}

export async function sendMobileAnalyticsOptOut(config: MobileAnalyticsHeartbeatConfig): Promise<boolean> {
  return sendCoreMobileAnalyticsOptOut(config, mobileHeartbeatDevice());
}

export async function resetMobileAnalyticsOptOutMarker(): Promise<void> {
  await resetHeartbeatOptOutMarker(AsyncStorage);
}

export async function sendMobileDailyHeartbeat(
  config: MobileAnalyticsHeartbeatConfig,
  settings: AppSettings
): Promise<boolean> {
  return sendCoreMobileDailyHeartbeat(config, settings, mobileHeartbeatDevice());
}
