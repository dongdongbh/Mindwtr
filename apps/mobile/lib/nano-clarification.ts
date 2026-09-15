import Constants from 'expo-constants';
import { Platform } from 'react-native';

import {
  cancelNativeNanoClarificationRequest,
  downloadNativeNanoClarificationModel,
  getNativeNanoClarificationCapability,
  requestNativeNanoInboxClarification,
  type NanoClarificationCapability,
  type NanoClarificationNativeRequest,
} from '../modules/nano-clarification';
import { logInfo } from './app-log';
import {
  OnDeviceClarificationOutputError,
  validateOnDeviceClarificationInput,
  validateOnDeviceClarificationSuggestion,
  type OnDeviceClarificationInput,
  type OnDeviceClarificationNativeSuggestion,
  type OnDeviceClarificationSuggestion,
} from './on-device-clarification';

export const NANO_CLARIFICATION_RELEASE_CHECK = 'v1.3.1/nano-inbox-clarification';

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

export class NanoClarificationCancelledError extends Error {
  constructor() {
    super('Nano clarification was cancelled');
    this.name = 'NanoClarificationCancelledError';
  }
}

export class NanoClarificationError extends Error {
  readonly code: Exclude<NanoClarificationUnavailableReason, 'available'>;

  constructor(code: Exclude<NanoClarificationUnavailableReason, 'available'>) {
    super(describeNanoClarificationUnavailableReason(code));
    this.name = 'NanoClarificationError';
    this.code = code;
  }
}

type MobileExtraConfig = {
  isFossBuild?: boolean | string;
  nanoClarificationPrototypeEnabled?: boolean | string;
};

const isTrue = (value: boolean | string | undefined): boolean => value === true || value === 'true';

export function isNanoClarificationPrototypeEnabled(): boolean {
  const extra = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
  return Platform.OS === 'android'
    && !isTrue(extra?.isFossBuild)
    && isTrue(extra?.nanoClarificationPrototypeEnabled);
}

const unavailableCapability = (reason: NanoClarificationUnavailableReason): NanoClarificationCapability => ({
  available: false,
  reason,
  supportedOperations: [],
});

export async function getNanoClarificationCapability(
  locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en',
): Promise<NanoClarificationCapability> {
  if (Platform.OS !== 'android') return unavailableCapability('unsupported_platform');
  if (!isNanoClarificationPrototypeEnabled()) return unavailableCapability('build_disabled');
  try {
    return await getNativeNanoClarificationCapability(locale);
  } catch {
    return unavailableCapability('unavailable');
  }
}

const NATIVE_FAILURE_REASONS = new Set<Exclude<NanoClarificationUnavailableReason, 'available'>>([
  'unsupported_platform',
  'native_module_missing',
  'build_disabled',
  'unsupported_os',
  'unavailable',
  'downloadable',
  'downloading',
  'download_failed',
  'busy',
  'quota_exceeded',
  'background_blocked',
  'locale_not_supported',
  'unknown',
]);

const nativeFailureReason = (
  error: unknown,
): Exclude<NanoClarificationUnavailableReason, 'available'> | 'cancelled' => {
  const classify = (
    value: string,
  ): Exclude<NanoClarificationUnavailableReason, 'available'> | 'cancelled' | null => {
    const normalized = value.trim().toLocaleLowerCase();
    if (normalized.includes('cancel')) return 'cancelled';
    for (const reason of NATIVE_FAILURE_REASONS) {
      if (normalized === reason || normalized.endsWith(`_${reason}`)) return reason;
    }
    return null;
  };
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : '';
  const codeReason = classify(code);
  if (codeReason) return codeReason;
  // Native bridge failures are contractually sanitized to a code. Accept an
  // exact reason-only message for test/dev bridges, but never propagate a body.
  const message = error instanceof Error ? error.message : '';
  const messageReason = classify(message);
  if (messageReason) return messageReason;
  return 'unknown';
};

const normalizeNativeFailure = (error: unknown): NanoClarificationCancelledError | NanoClarificationError => {
  const reason = nativeFailureReason(error);
  return reason === 'cancelled'
    ? new NanoClarificationCancelledError()
    : new NanoClarificationError(reason);
};

const withNativeCancellation = async <T>(
  requestId: string,
  signal: AbortSignal | undefined,
  request: () => Promise<T>,
): Promise<T> => {
  if (signal?.aborted) throw new NanoClarificationCancelledError();
  const abort = () => { void cancelNativeNanoClarificationRequest(requestId); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await request();
    if (signal?.aborted) throw new NanoClarificationCancelledError();
    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof NanoClarificationCancelledError) {
      throw new NanoClarificationCancelledError();
    }
    throw normalizeNativeFailure(error);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
};

const assertNanoPrototypeCallable = (): void => {
  if (Platform.OS !== 'android') throw new NanoClarificationError('unsupported_platform');
  if (!isNanoClarificationPrototypeEnabled()) throw new NanoClarificationError('build_disabled');
};

export async function downloadNanoClarificationModel(
  requestId: string,
  locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en',
  options: { signal?: AbortSignal } = {},
): Promise<NanoClarificationCapability> {
  assertNanoPrototypeCallable();
  if (!requestId.trim() || !locale.trim()) throw new NanoClarificationError('unknown');
  return withNativeCancellation(
    requestId,
    options.signal,
    () => downloadNativeNanoClarificationModel(requestId, locale),
  );
}

const parseNativeSuggestion = (raw: string): OnDeviceClarificationNativeSuggestion => {
  try {
    // Nano v3 can add one Markdown fence despite the JSON-only instruction.
    // Unwrap only an entire fenced response; never extract JSON from prose.
    const text = raw.trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
    const parsed: unknown = JSON.parse(fenced ? fenced[1] : text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as OnDeviceClarificationNativeSuggestion;
  } catch {
    throw new OnDeviceClarificationOutputError('malformed_output', 'The on-device suggestion is malformed');
  }
};

export async function requestNanoInboxClarification(
  input: OnDeviceClarificationInput,
  options: { signal?: AbortSignal } = {},
): Promise<OnDeviceClarificationSuggestion> {
  assertNanoPrototypeCallable();
  const request = validateOnDeviceClarificationInput(input) as NanoClarificationNativeRequest;
  const raw = await withNativeCancellation(
    request.requestId,
    options.signal,
    () => requestNativeNanoInboxClarification(request),
  );
  return validateOnDeviceClarificationSuggestion(parseNativeSuggestion(raw), input);
}

export function describeNanoClarificationUnavailableReason(
  reason: string | undefined,
): string {
  switch (reason) {
    case 'unsupported_platform': return 'Nano on-device clarification is available only on supported Android devices.';
    case 'native_module_missing': return 'Install the Nano-enabled Mindwtr development build to use on-device clarification.';
    case 'build_disabled': return 'This build does not include the Nano clarification prototype.';
    case 'unsupported_os': return 'This Android version does not support the Nano clarification prototype.';
    case 'downloadable': return 'The on-device model must be downloaded before Nano clarification can run.';
    case 'downloading': return 'The on-device model is downloading. Keep Mindwtr open until it finishes.';
    case 'download_failed': return 'The on-device model download failed. Try the download again.';
    case 'busy': return 'The on-device model is busy. Try again in a moment.';
    case 'quota_exceeded': return 'The on-device inference limit was reached. Try again later.';
    case 'background_blocked': return 'Keep Mindwtr open in the foreground, then try again.';
    case 'locale_not_supported': return 'The current language or region is not supported by the on-device model.';
    case 'unavailable': return 'Nano on-device clarification is unavailable on this device.';
    default: return 'Nano on-device clarification is not available right now.';
  }
}

export function reportNanoClarificationOutcome(
  outcome: 'unavailable' | 'stale_ignored' | 'suggestion_ready' | 'applied_to_draft',
  details: Readonly<{
    reason?: string;
    statusIncluded?: boolean;
    associationCount?: number;
    dateCount?: number;
  }> = {},
): Promise<string | null> {
  return logInfo('Nano Inbox clarification path completed', {
    scope: 'inbox',
    extra: {
      releaseCheck: NANO_CLARIFICATION_RELEASE_CHECK,
      backend: 'nano_on_device',
      outcome,
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.statusIncluded === undefined ? {} : { statusIncluded: details.statusIncluded }),
      ...(details.associationCount === undefined ? {} : { associationCount: details.associationCount }),
      ...(details.dateCount === undefined ? {} : { dateCount: details.dateCount }),
    },
  });
}
