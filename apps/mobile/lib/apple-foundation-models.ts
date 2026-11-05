import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { Area, Project, TaskStatus } from '@mindwtr/core';

import {
  cancelNativeAppleInboxClarification,
  getNativeAppleFoundationModelsCapability,
  requestNativeAppleInboxClarification,
  type AppleFoundationModelsCapability,
  type AppleFoundationModelsNativeRequest,
  type AppleFoundationModelsNativeSuggestion,
  type AppleFoundationModelsUnavailableReason,
} from '../modules/apple-foundation-models';
import { logInfo } from './app-log';

export const APPLE_CLARIFICATION_RELEASE_CHECK = 'v1.3.1/apple-inbox-clarification';
export const APPLE_CLARIFICATION_MAX_CANDIDATES_PER_KIND = 12;
const MAX_TITLE_CHARS = 512;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_CANDIDATE_LABEL_CHARS = 200;
const MAX_REQUEST_BYTES = 16_384;
const VALID_STATUSES = new Set<AppleClarificationStatus>(['next', 'waiting', 'someday', 'reference']);

export type AppleClarificationStatus = Extract<TaskStatus, 'next' | 'waiting' | 'someday' | 'reference'>;
export type AppleClarificationCandidateKind = 'project' | 'area' | 'context' | 'tag';
export type AppleClarificationCandidate = Readonly<{
  kind: AppleClarificationCandidateKind;
  id: string;
  label: string;
}>;

export type AppleClarificationInput = Readonly<{
  requestId: string;
  locale: string;
  title: string;
  description: string;
  candidates: readonly AppleClarificationCandidate[];
}>;

export type AppleClarificationSuggestion = Readonly<{
  cleanedTitle: string;
  status?: AppleClarificationStatus;
  projectId?: string;
  areaId?: string;
  contextIds: readonly string[];
  tagIds: readonly string[];
  startDate?: string;
  dueDate?: string;
}>;

export type AppleClarificationDraftSnapshot = Readonly<{
  taskId: string;
  revision: string;
  title: string;
  description: string;
  projectId: string | null;
  areaId: string | null;
  contexts: readonly string[];
  tags: readonly string[];

  startDate: string | null;
  dueDate: string | null;
  startDateOnly: boolean;
  dueDateOnly: boolean;
  workflowChoices: readonly [string | null, string | null, string | null];
}>;

export type AppleClarificationLease = Readonly<{
  requestId: string;
  fingerprint: string;
}>;

export class AppleClarificationInputError extends Error {
  readonly code: 'input_too_large' | 'invalid_input';

  constructor(code: 'input_too_large' | 'invalid_input', message: string) {
    super(message);
    this.name = 'AppleClarificationInputError';
    this.code = code;
  }
}

export class AppleClarificationOutputError extends Error {
  readonly code: 'malformed_output' | 'invented_id';

  constructor(code: 'malformed_output' | 'invented_id', message: string) {
    super(message);
    this.name = 'AppleClarificationOutputError';
    this.code = code;
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

const normalizedArray = (value: unknown, field: string): string[] => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AppleClarificationOutputError('malformed_output', `${field} must be a string array`);
  }
  return Array.from(new Set(value.map((entry) => entry.trim()).filter(Boolean)));
};

const parseDateOnly = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return undefined;
  const normalized = value.trim();
  const [year, month, day] = normalized.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? normalized
    : undefined;
};

const EXPLICIT_DATE_EVIDENCE = /(?:\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b)/i;

const validateEvidencedDate = (
  dateValue: unknown,
  evidenceValue: unknown,
  source: string,
): string | undefined => {
  const date = parseDateOnly(dateValue);
  if (!date || typeof evidenceValue !== 'string') return undefined;
  const evidence = evidenceValue.trim();
  if (!evidence || !source.toLocaleLowerCase().includes(evidence.toLocaleLowerCase())) return undefined;
  return EXPLICIT_DATE_EVIDENCE.test(evidence) ? date : undefined;
};

export function validateAppleClarificationSuggestion(
  raw: AppleFoundationModelsNativeSuggestion,
  input: AppleClarificationInput,
): AppleClarificationSuggestion {
  if (!raw || typeof raw !== 'object' || typeof raw.cleanedTitle !== 'string') {
    throw new AppleClarificationOutputError('malformed_output', 'A cleaned title is required');
  }
  const cleanedTitle = raw.cleanedTitle.trim();
  if (!cleanedTitle || cleanedTitle.length > MAX_TITLE_CHARS) {
    throw new AppleClarificationOutputError('malformed_output', 'The cleaned title is invalid');
  }

  const candidateIds = new Map<AppleClarificationCandidateKind, Set<string>>();
  for (const kind of ['project', 'area', 'context', 'tag'] as const) {
    candidateIds.set(kind, new Set(input.candidates.filter((item) => item.kind === kind).map((item) => item.id)));
  }
  const validateIds = (value: unknown, kind: AppleClarificationCandidateKind, field: string): string[] => {
    const ids = normalizedArray(value, field);
    if (ids.length > APPLE_CLARIFICATION_MAX_CANDIDATES_PER_KIND) {
      throw new AppleClarificationOutputError('malformed_output', `${field} exceeds its bound`);
    }
    if (ids.some((id) => !candidateIds.get(kind)?.has(id))) {
      throw new AppleClarificationOutputError('invented_id', `${field} contains an unknown ID`);
    }
    return ids;
  };

  const projectIds = validateIds(raw.projectIds, 'project', 'projectIds');
  const areaIds = validateIds(raw.areaIds, 'area', 'areaIds');
  const contextIds = validateIds(raw.contextIds, 'context', 'contextIds');
  const tagIds = validateIds(raw.tagIds, 'tag', 'tagIds');
  if (projectIds.length > 1 || areaIds.length > 1 || (projectIds.length > 0 && areaIds.length > 0)) {
    throw new AppleClarificationOutputError('malformed_output', 'Project and area associations conflict');
  }

  const normalizedStatus = typeof raw.status === 'string' ? raw.status.trim() : '';
  const status = VALID_STATUSES.has(normalizedStatus as AppleClarificationStatus)
    ? normalizedStatus as AppleClarificationStatus
    : undefined;
  const source = `${input.title}\n${input.description}`;
  const startDate = validateEvidencedDate(raw.startDate, raw.startDateEvidence, source);
  const dueDate = validateEvidencedDate(raw.dueDate, raw.dueDateEvidence, source);

  return {
    cleanedTitle,
    ...(status ? { status } : {}),
    ...(projectIds[0] ? { projectId: projectIds[0] } : {}),
    ...(areaIds[0] ? { areaId: areaIds[0] } : {}),
    contextIds,
    tagIds,
    ...(startDate ? { startDate } : {}),
    ...(dueDate ? { dueDate } : {}),
  };
}

export function validateAppleClarificationInput(
  input: AppleClarificationInput,
): AppleFoundationModelsNativeRequest {
  if (!input.requestId.trim() || !input.locale.trim() || !input.title.trim()) {
    throw new AppleClarificationInputError('invalid_input', 'The selected Inbox item needs a title');
  }
  if (input.title.length > MAX_TITLE_CHARS || input.description.length > MAX_DESCRIPTION_CHARS) {
    throw new AppleClarificationInputError('input_too_large', 'This Inbox item is too large for on-device clarification');
  }
  const counts = new Map<AppleClarificationCandidateKind, number>();
  for (const candidate of input.candidates) {
    if (!candidate.id.trim() || !candidate.label.trim() || candidate.label.length > MAX_CANDIDATE_LABEL_CHARS) {
      throw new AppleClarificationInputError('invalid_input', 'Clarification candidates are invalid');
    }
    const count = (counts.get(candidate.kind) ?? 0) + 1;
    counts.set(candidate.kind, count);
    if (count > APPLE_CLARIFICATION_MAX_CANDIDATES_PER_KIND) {
      throw new AppleClarificationInputError('input_too_large', 'Clarification candidate context is too large');
    }
  }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (serializedBytes > MAX_REQUEST_BYTES) {
    throw new AppleClarificationInputError('input_too_large', 'Clarification context is too large');
  }
  return input;
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
    if (options.signal?.aborted || (error as { code?: string })?.code === 'ERR_APPLE_CLARIFICATION_CANCELLED') {
      throw new AppleClarificationCancelledError();
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

const terms = (value: string): Set<string> => new Set(
  value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2),
);

const rank = <T>(
  values: readonly T[],
  label: (value: T) => string,
  id: (value: T) => string,
  selectedIds: ReadonlySet<string>,
  queryTerms: ReadonlySet<string>,
): T[] => values
  .map((value, index) => {
    const valueTerms = terms(label(value));
    const overlap = Array.from(valueTerms).filter((term) => queryTerms.has(term)).length;
    return { value, index, score: selectedIds.has(id(value)) ? 10_000 : overlap * 100 - index };
  })
  .filter((entry) => entry.score > 0 || selectedIds.has(id(entry.value)))
  .sort((a, b) => b.score - a.score)
  .slice(0, APPLE_CLARIFICATION_MAX_CANDIDATES_PER_KIND)
  .map((entry) => entry.value);

export function buildAppleClarificationCandidates(options: {
  title: string;
  description: string;
  projects: readonly Project[];
  areas: readonly Area[];
  contexts: readonly string[];
  tags: readonly string[];
  selectedProjectId?: string | null;
  selectedAreaId?: string | null;
  selectedContexts?: readonly string[];
  selectedTags?: readonly string[];
}): AppleClarificationCandidate[] {
  const queryTerms = terms(`${options.title} ${options.description}`);
  const activeProjects = options.projects.filter((project) => !project.deletedAt && project.status === 'active');
  const activeAreas = options.areas.filter((area) => !area.deletedAt);
  const selectedProjects = new Set(options.selectedProjectId ? [options.selectedProjectId] : []);
  const selectedAreas = new Set(options.selectedAreaId ? [options.selectedAreaId] : []);
  const selectedContexts = new Set(options.selectedContexts ?? []);
  const selectedTags = new Set(options.selectedTags ?? []);
  if (selectedContexts.size > APPLE_CLARIFICATION_MAX_CANDIDATES_PER_KIND
    || selectedTags.size > APPLE_CLARIFICATION_MAX_CANDIDATES_PER_KIND) {
    throw new AppleClarificationInputError(
      'input_too_large',
      'The selected Inbox item has too many associations for on-device clarification',
    );
  }
  const contextCandidates = Array.from(new Set([...selectedContexts, ...options.contexts]));
  const tagCandidates = Array.from(new Set([...selectedTags, ...options.tags]));
  return [
    ...rank(activeProjects, (project) => project.title, (project) => project.id, selectedProjects, queryTerms)
      .map((project) => ({ kind: 'project' as const, id: project.id, label: project.title })),
    ...rank(activeAreas, (area) => area.name, (area) => area.id, selectedAreas, queryTerms)
      .map((area) => ({ kind: 'area' as const, id: area.id, label: area.name })),
    ...rank(contextCandidates, (context) => context, (context) => context, selectedContexts, queryTerms)
      .map((context) => ({ kind: 'context' as const, id: context, label: context })),
    ...rank(tagCandidates, (tag) => tag, (tag) => tag, selectedTags, queryTerms)
      .map((tag) => ({ kind: 'tag' as const, id: tag, label: tag })),
  ];
}

const stableStrings = (values: readonly string[]): string[] => Array.from(new Set(values)).sort();

export function createAppleClarificationLease(
  requestId: string,
  snapshot: AppleClarificationDraftSnapshot,
): AppleClarificationLease {
  return { requestId, fingerprint: JSON.stringify({ ...snapshot, contexts: stableStrings(snapshot.contexts), tags: stableStrings(snapshot.tags) }) };
}

export function isAppleClarificationLeaseCurrent(
  lease: AppleClarificationLease,
  snapshot: AppleClarificationDraftSnapshot,
): boolean {
  return lease.fingerprint === createAppleClarificationLease(lease.requestId, snapshot).fingerprint;
}

export function consumeAppleClarificationApply(
  lease: AppleClarificationLease,
  snapshot: AppleClarificationDraftSnapshot,
  consumedRequestIds: Set<string>,
): boolean {
  if (consumedRequestIds.has(lease.requestId) || !isAppleClarificationLeaseCurrent(lease, snapshot)) return false;
  consumedRequestIds.add(lease.requestId);
  return true;
}

export function areAppleClarificationAssociationsCurrent(
  suggestion: AppleClarificationSuggestion,
  available: Readonly<{
    projectIds: ReadonlySet<string>;
    areaIds: ReadonlySet<string>;
    contextIds: ReadonlySet<string>;
    tagIds: ReadonlySet<string>;
  }>,
): boolean {
  return (!suggestion.projectId || available.projectIds.has(suggestion.projectId))
    && (!suggestion.areaId || available.areaIds.has(suggestion.areaId))
    && suggestion.contextIds.every((id) => available.contextIds.has(id))
    && suggestion.tagIds.every((id) => available.tagIds.has(id));
}

export function describeAppleClarificationUnavailableReason(
  reason: AppleFoundationModelsUnavailableReason | undefined,
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
      releaseCheck: 'v1.3.1/apple-inbox-clarification',
      backend: 'apple_on_device',
      outcome,
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.statusIncluded === undefined ? {} : { statusIncluded: details.statusIncluded }),
      ...(details.associationCount === undefined ? {} : { associationCount: details.associationCount }),
      ...(details.dateCount === undefined ? {} : { dateCount: details.dateCount }),
    },
  });
}
