import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type AppleFoundationModelsUnavailableReason =
  | 'unsupported_platform'
  | 'native_module_missing'
  | 'unsupported_os'
  | 'apple_intelligence_disabled'
  | 'device_not_eligible'
  | 'model_not_ready'
  | 'locale_not_supported'
  | 'unknown';

export type AppleFoundationModelsCapability = Readonly<{
  available: boolean;
  reason?: AppleFoundationModelsUnavailableReason;
  supportedOperations: readonly ('inbox_clarification')[];
  contextSize?: number;
}>;

export type AppleFoundationModelsNativeRequest = Readonly<{
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

export type AppleFoundationModelsNativeSuggestion = Readonly<{
  cleanedTitle: string;
  status?: string | null;
  projectIds?: readonly string[];
  areaIds?: readonly string[];
  contextIds?: readonly string[];
  tagIds?: readonly string[];
  startDate?: string | null;
  startDateEvidence?: string | null;
  dueDate?: string | null;
  dueDateEvidence?: string | null;
}>;

export type ApplePccEvaluationBackend = 'on_device' | 'private_cloud_compute';
export type ApplePccEvaluationFixtureId = 'smoke' | 'project_planning';
export type ApplePccEvaluationUnavailableReason =
  | 'evaluation_disabled'
  | 'unsupported_platform'
  | 'native_module_missing'
  | 'unsupported_sdk'
  | 'unsupported_os'
  | 'unsupported_device'
  | 'system_not_ready'
  | 'locale_unsupported'
  | 'quota_exhausted'
  | 'network_failure'
  | 'service_unavailable'
  | 'timeout'
  | 'unknown';

export type ApplePccEvaluationFixture = Readonly<{
  fixtureId: ApplePccEvaluationFixtureId;
  text: string;
}>;

export type ApplePccEvaluationCapability = Readonly<{
  available: boolean;
  backend: ApplePccEvaluationBackend;
  reason?: ApplePccEvaluationUnavailableReason;
  contextSize?: number;
}>;

export type ApplePccEvaluationNativeRequest = Readonly<{
  requestId: string;
  backend: ApplePccEvaluationBackend;
  fixtureId: ApplePccEvaluationFixtureId;
  consent: boolean;
}>;

export type ApplePccEvaluationNativeOutcome =
  | 'completed'
  | 'evaluation_disabled'
  | 'invalid_request'
  | 'consent_required'
  | 'duplicate_request'
  | 'cancelled'
  | 'timeout'
  | 'unsupported_sdk'
  | 'unsupported_os'
  | 'unsupported_device'
  | 'system_not_ready'
  | 'locale_unsupported'
  | 'quota_exhausted'
  | 'network_failure'
  | 'service_unavailable'
  | 'refused'
  | 'malformed_output'
  | 'unknown';

export type ApplePccEvaluationNativeResult = Readonly<{
  outcome: ApplePccEvaluationNativeOutcome;
  summary?: string;
  nextActions?: readonly string[];
  contextSize?: number;
}>;

interface AppleFoundationModelsNativeModule extends NativeModule {
  getCapability?: (locale: string) => Promise<AppleFoundationModelsCapability>;
  clarifyInbox?: (request: AppleFoundationModelsNativeRequest) => Promise<AppleFoundationModelsNativeSuggestion>;
  cancel?: (requestId: string) => Promise<void>;
  getPccEvaluationFixtures?: () => Promise<readonly ApplePccEvaluationFixture[]>;
  getPccEvaluationCapability?: (
    backend: ApplePccEvaluationBackend,
  ) => Promise<ApplePccEvaluationCapability>;
  runPccEvaluation?: (
    request: ApplePccEvaluationNativeRequest,
  ) => Promise<ApplePccEvaluationNativeResult>;
  cancelPccEvaluation?: (requestId: string) => Promise<void>;
}

const nativeModule = Platform.OS === 'ios'
  ? requireOptionalNativeModule<AppleFoundationModelsNativeModule>('MindwtrAppleFoundationModels')
  : null;

const unsupportedCapability = (
  reason: AppleFoundationModelsUnavailableReason,
): AppleFoundationModelsCapability => ({
  available: false,
  reason,
  supportedOperations: [],
});

export async function getNativeAppleFoundationModelsCapability(
  locale: string,
): Promise<AppleFoundationModelsCapability> {
  if (Platform.OS !== 'ios') return unsupportedCapability('unsupported_platform');
  const getCapability = nativeModule?.getCapability;
  if (typeof getCapability !== 'function') return unsupportedCapability('native_module_missing');
  try {
    return await getCapability.call(nativeModule, locale);
  } catch {
    return unsupportedCapability('unknown');
  }
}

export async function requestNativeAppleInboxClarification(
  request: AppleFoundationModelsNativeRequest,
): Promise<AppleFoundationModelsNativeSuggestion> {
  if (Platform.OS !== 'ios') throw new Error('Apple on-device clarification requires iOS');
  const clarify = nativeModule?.clarifyInbox;
  if (typeof clarify !== 'function') throw new Error('Apple Foundation Models native module is unavailable');
  return clarify.call(nativeModule, request);
}

export async function cancelNativeAppleInboxClarification(requestId: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const cancel = nativeModule?.cancel;
  if (typeof cancel !== 'function') return;
  await cancel.call(nativeModule, requestId);
}

export async function getNativeApplePccEvaluationFixtures(): Promise<readonly ApplePccEvaluationFixture[]> {
  if (Platform.OS !== 'ios') return [];
  const getFixtures = nativeModule?.getPccEvaluationFixtures;
  if (typeof getFixtures !== 'function') return [];
  try {
    return await getFixtures.call(nativeModule);
  } catch {
    return [];
  }
}

export async function getNativeApplePccEvaluationCapability(
  backend: ApplePccEvaluationBackend,
): Promise<ApplePccEvaluationCapability> {
  if (Platform.OS !== 'ios') return { available: false, backend, reason: 'unsupported_platform' };
  const getCapability = nativeModule?.getPccEvaluationCapability;
  if (typeof getCapability !== 'function') {
    return { available: false, backend, reason: 'native_module_missing' };
  }
  try {
    return await getCapability.call(nativeModule, backend);
  } catch {
    return { available: false, backend, reason: 'unknown' };
  }
}

export async function requestNativeApplePccEvaluation(
  request: ApplePccEvaluationNativeRequest,
): Promise<ApplePccEvaluationNativeResult> {
  if (Platform.OS !== 'ios') return { outcome: 'unsupported_os' };
  const run = nativeModule?.runPccEvaluation;
  if (typeof run !== 'function') return { outcome: 'unsupported_sdk' };
  try {
    return await run.call(nativeModule, request);
  } catch {
    return { outcome: 'unknown' };
  }
}

export async function cancelNativeApplePccEvaluation(requestId: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const cancel = nativeModule?.cancelPccEvaluation;
  if (typeof cancel !== 'function') return;
  try {
    await cancel.call(nativeModule, requestId);
  } catch {

  }
}
