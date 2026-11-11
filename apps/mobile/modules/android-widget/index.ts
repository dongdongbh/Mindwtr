import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type AndroidWidgetModule = {
  setPayload(json: string): void;
  updateWidgets(): WidgetRefreshResult | number | undefined;
  getWidgetListSelections(): string[];
  getCaptureIntentConfig(): Promise<CaptureIntentConfig>;
  setCaptureIntentEnabled(enabled: boolean): Promise<CaptureIntentConfig>;
  getWidgetLaunchState?(): unknown;
  completeWidgetLaunch?(token: number): Promise<boolean>;
};

type WidgetRefreshResult = {
  legacyWidgetCount: number;
  compactWidgetCount: number;
  hiddenCheckoffCount?: number;
  serializedCheckoffCount?: number;
  heldCheckoffCount?: number;
  directCollectionCount?: number;
  renderedTaskCount?: number;
  eligibleTaskCount?: number;
  collectionBytes?: number;
};

export type CaptureIntentConfig = {
  enabled: boolean;
  token: string | null;
};

export type WidgetLaunchState = {
  token: number;
  path: string;
  url: string;
  stage: 'pending' | 'acknowledged' | 'fallback' | 'cancelled';
};


export function getWidgetLaunchState(): WidgetLaunchState | null {
  try {
    const value = nativeModule?.getWidgetLaunchState?.();
    if (!value || typeof value !== 'object' || !('token' in value) || !('path' in value) || !('url' in value) || !('stage' in value)) return null;
    if (typeof value.token !== 'number' || !Number.isSafeInteger(value.token) || value.token < 1
      || typeof value.path !== 'string' || !value.path.startsWith('/')
      || typeof value.url !== 'string'
      || (value.stage !== 'pending' && value.stage !== 'acknowledged' && value.stage !== 'fallback' && value.stage !== 'cancelled')) return null;
    return { token: value.token, path: value.path, url: value.url, stage: value.stage };
  } catch { return null; }
}

export async function completeWidgetLaunch(token: number): Promise<boolean> {
  try { return await nativeModule?.completeWidgetLaunch?.(token) ?? false; } catch { return false; }
}


const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<AndroidWidgetModule>('MindwtrAndroidWidget')
  : null;

export function isSupported(): boolean {
  return nativeModule !== null;
}


export function setPayload(json: string): void {
  nativeModule?.setPayload(json);
}


export function updateWidgets(): WidgetRefreshResult | number | undefined {
  return nativeModule?.updateWidgets();
}


export function getWidgetListSelections(): string[] {
  return nativeModule?.getWidgetListSelections() ?? [];
}


export async function getCaptureIntentConfig(): Promise<CaptureIntentConfig> {
  if (!nativeModule) throw new Error('Android capture intent is not supported');
  return nativeModule.getCaptureIntentConfig();
}


export async function setCaptureIntentEnabled(enabled: boolean): Promise<CaptureIntentConfig> {
  if (!nativeModule) throw new Error('Android capture intent is not supported');
  return nativeModule.setCaptureIntentEnabled(enabled);
}
