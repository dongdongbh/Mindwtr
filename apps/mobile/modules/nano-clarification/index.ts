import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type NanoClarificationUnavailableReason =
  | 'available'
  | 'unsupported_platform'
  | 'native_module_missing'
  | 'build_disabled'
  | 'unsupported_os'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'download_failed'
  | 'busy'
  | 'quota_exceeded'
  | 'background_blocked'
  | 'locale_not_supported'
  | 'unknown';

export type NanoClarificationCapability = Readonly<{
  available: boolean;
  reason: NanoClarificationUnavailableReason;
  supportedOperations: readonly ('inbox_clarification')[];
  modelName?: string;
}>;

export type NanoClarificationNativeRequest = Readonly<{
  requestId: string;
  locale: string;
  title: string;
  description: string;
  candidates: readonly Readonly<{
    kind: 'project' | 'area' | 'context' | 'tag';
    id: string;
    label: string;
  }>[];
}>;

interface NanoClarificationNativeModule extends NativeModule {
  getCapability?: (locale: string) => Promise<NanoClarificationCapability>;
  downloadModel?: (requestId: string, locale: string) => Promise<NanoClarificationCapability>;
  clarifyInbox?: (request: NanoClarificationNativeRequest) => Promise<string>;
  cancelRequest?: (requestId: string) => Promise<void>;
}

let cachedNativeModule: NanoClarificationNativeModule | null | undefined;

const unsupportedCapability = (
  reason: NanoClarificationUnavailableReason,
): NanoClarificationCapability => ({
  available: false,
  reason,
  supportedOperations: [],
});

function getNativeModule(): NanoClarificationNativeModule | null {
  if (Platform.OS !== 'android') return null;
  if (cachedNativeModule !== undefined) return cachedNativeModule;
  try {
    cachedNativeModule = requireOptionalNativeModule<NanoClarificationNativeModule>(
      'MindwtrNanoClarification',
    ) ?? null;
  } catch {
    cachedNativeModule = null;
  }
  return cachedNativeModule;
}

export async function getNativeNanoClarificationCapability(
  locale: string,
): Promise<NanoClarificationCapability> {
  if (Platform.OS !== 'android') return unsupportedCapability('unsupported_platform');
  const getCapability = getNativeModule()?.getCapability;
  if (typeof getCapability !== 'function') return unsupportedCapability('native_module_missing');
  try {
    return await getCapability.call(getNativeModule(), locale);
  } catch {
    return unsupportedCapability('unknown');
  }
}

export async function downloadNativeNanoClarificationModel(
  requestId: string,
  locale: string,
): Promise<NanoClarificationCapability> {
  if (Platform.OS !== 'android') throw new Error('ERR_NANO_UNSUPPORTED_PLATFORM');
  const nativeModule = getNativeModule();
  const downloadModel = nativeModule?.downloadModel;
  if (typeof downloadModel !== 'function') throw new Error('ERR_NANO_NATIVE_MODULE_MISSING');
  return downloadModel.call(nativeModule, requestId, locale);
}

export async function requestNativeNanoInboxClarification(
  request: NanoClarificationNativeRequest,
): Promise<string> {
  if (Platform.OS !== 'android') throw new Error('ERR_NANO_UNSUPPORTED_PLATFORM');
  const nativeModule = getNativeModule();
  const clarifyInbox = nativeModule?.clarifyInbox;
  if (typeof clarifyInbox !== 'function') throw new Error('ERR_NANO_NATIVE_MODULE_MISSING');
  return clarifyInbox.call(nativeModule, request);
}

export async function cancelNativeNanoClarificationRequest(requestId: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  const nativeModule = getNativeModule();
  const cancelRequest = nativeModule?.cancelRequest;
  if (typeof cancelRequest !== 'function') return;
  await cancelRequest.call(nativeModule, requestId);
}
