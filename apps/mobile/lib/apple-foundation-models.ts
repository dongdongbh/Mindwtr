import Constants from 'expo-constants';
import { Platform } from 'react-native';

import {
  cancelNativeAppleInboxClarification,
  getNativeAppleFoundationModelsCapability,
  requestNativeAppleInboxClarification,
  type AppleFoundationModelsCapability,
  type AppleFoundationModelsNativeRequest,
  type AppleFoundationModelsNativeSuggestion,
} from '../modules/apple-foundation-models';
import { logInfo } from './app-log';
import {
  ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND,
  OnDeviceClarificationInputError,
  OnDeviceClarificationOutputError,
  areOnDeviceClarificationAssociationsCurrent,
  buildOnDeviceClarificationCandidates,
  consumeOnDeviceClarificationApply,
  createOnDeviceClarificationLease,
  isOnDeviceClarificationLeaseCurrent,
  validateOnDeviceClarificationInput,
  validateOnDeviceClarificationSuggestion,
  type OnDeviceClarificationCandidate,
  type OnDeviceClarificationCandidateKind,
  type OnDeviceClarificationDraftSnapshot,
  type OnDeviceClarificationInput,
  type OnDeviceClarificationLease,
  type OnDeviceClarificationStatus,
  type OnDeviceClarificationSuggestion,
} from './on-device-clarification';

export const APPLE_CLARIFICATION_RELEASE_CHECK = 'v1.3.1/apple-inbox-clarification';
export const APPLE_CLARIFICATION_MAX_CANDIDATES_PER_KIND = ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND;

export type AppleClarificationStatus = OnDeviceClarificationStatus;
export type AppleClarificationCandidateKind = OnDeviceClarificationCandidateKind;
export type AppleClarificationCandidate = OnDeviceClarificationCandidate;
export type AppleClarificationInput = OnDeviceClarificationInput;
export type AppleClarificationSuggestion = OnDeviceClarificationSuggestion;
export type AppleClarificationDraftSnapshot = OnDeviceClarificationDraftSnapshot;
export type AppleClarificationLease = OnDeviceClarificationLease;

export class AppleClarificationInputError extends OnDeviceClarificationInputError {
  constructor(code: 'input_too_large' | 'invalid_input', message: string) {
    super(code, message);
    this.name = 'AppleClarificationInputError';
  }
}

export class AppleClarificationOutputError extends OnDeviceClarificationOutputError {
  constructor(code: 'malformed_output' | 'invented_id', message: string) {
    super(code, message);
    this.name = 'AppleClarificationOutputError';
  }
}

export class AppleClarificationCancelledError extends Error {
  constructor() {
    super('Apple clarification was cancelled');
    this.name = 'AppleClarificationCancelledError';
  }
}

type MobileExtraConfig = { appleClarificationPrototypeEnabled?: boolean | string };

export function isAppleClarificationPrototypeEnabled(): boolean {
  const extra = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
  const enabled = extra?.appleClarificationPrototypeEnabled;
  return enabled === true || enabled === 'true';
}

export async function getAppleClarificationCapability(
  locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en',
): Promise<AppleFoundationModelsCapability> {
  if (!isAppleClarificationPrototypeEnabled()) {
    return { available: false, reason: 'unknown', supportedOperations: [] };
  }
  if (Platform.OS !== 'ios') {
    return { available: false, reason: 'unsupported_platform', supportedOperations: [] };
  }
  return getNativeAppleFoundationModelsCapability(locale);
}

export function validateAppleClarificationSuggestion(
  raw: AppleFoundationModelsNativeSuggestion,
  input: AppleClarificationInput,
): AppleClarificationSuggestion {
  try {
    return validateOnDeviceClarificationSuggestion(raw, input);
  } catch (error) {
    if (error instanceof OnDeviceClarificationOutputError) {
      throw new AppleClarificationOutputError(error.code, error.message);
    }
    throw error;
  }
}

export function validateAppleClarificationInput(
  input: AppleClarificationInput,
): AppleFoundationModelsNativeRequest {
  try {
    return validateOnDeviceClarificationInput(input) as AppleFoundationModelsNativeRequest;
  } catch (error) {
    if (error instanceof OnDeviceClarificationInputError) {
      throw new AppleClarificationInputError(error.code, error.message);
    }
    throw error;
  }
}

export async function requestAppleInboxClarification(
  input: AppleClarificationInput,
  options: { signal?: AbortSignal } = {},
): Promise<AppleClarificationSuggestion> {
  const request = validateAppleClarificationInput(input);
  if (options.signal?.aborted) throw new AppleClarificationCancelledError();
  const abort = () => { void cancelNativeAppleInboxClarification(request.requestId); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const raw = await requestNativeAppleInboxClarification(request);
    if (options.signal?.aborted) throw new AppleClarificationCancelledError();
    return validateAppleClarificationSuggestion(raw, input);
  } catch (error) {
    if (
      options.signal?.aborted
      || (error as { code?: string })?.code === 'ERR_APPLE_CLARIFICATION_CANCELLED'
    ) {
      throw new AppleClarificationCancelledError();
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

export function buildAppleClarificationCandidates(
  options: Parameters<typeof buildOnDeviceClarificationCandidates>[0],
): AppleClarificationCandidate[] {
  try {
    return buildOnDeviceClarificationCandidates(options);
  } catch (error) {
    if (error instanceof OnDeviceClarificationInputError) {
      throw new AppleClarificationInputError(error.code, error.message);
    }
    throw error;
  }
}
export const createAppleClarificationLease = createOnDeviceClarificationLease;
export const isAppleClarificationLeaseCurrent = isOnDeviceClarificationLeaseCurrent;
export const consumeAppleClarificationApply = consumeOnDeviceClarificationApply;
export const areAppleClarificationAssociationsCurrent = areOnDeviceClarificationAssociationsCurrent;

export function describeAppleClarificationUnavailableReason(
  reason: string | undefined,
): string {
  switch (reason) {
    case 'unsupported_platform': return 'On-device clarification is available only on supported Apple devices.';
    case 'native_module_missing': return 'Install a current Mindwtr development build to use on-device clarification.';
    case 'unsupported_os': return 'Update iOS or iPadOS to use Apple on-device clarification.';
    case 'apple_intelligence_disabled': return 'Turn on Apple Intelligence in System Settings to use on-device clarification.';
    case 'device_not_eligible': return 'This device does not support Apple Intelligence.';
    case 'model_not_ready': return 'Apple Intelligence is still preparing its on-device model. Try again later.';
    case 'locale_not_supported': return 'The current language or region is not supported by the on-device model.';
    default: return 'Apple on-device clarification is not available right now.';
  }
}

export function reportAppleClarificationOutcome(
  outcome: 'unavailable' | 'stale_ignored' | 'suggestion_ready' | 'applied_to_draft',
  details: Readonly<{
    reason?: string;
    statusIncluded?: boolean;
    associationCount?: number;
    dateCount?: number;
  }> = {},
): Promise<string | null> {
  return logInfo('Apple Inbox clarification path completed', {
    scope: 'inbox',
    extra: {
      releaseCheck: APPLE_CLARIFICATION_RELEASE_CHECK,
      backend: 'apple_on_device',
      outcome,
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.statusIncluded === undefined ? {} : { statusIncluded: details.statusIncluded }),
      ...(details.associationCount === undefined ? {} : { associationCount: details.associationCount }),
      ...(details.dateCount === undefined ? {} : { dateCount: details.dateCount }),
    },
  });
}
