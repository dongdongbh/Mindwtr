import type { Area, Project, TaskStatus } from '@mindwtr/core';

export const ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND = 12;
const MAX_TITLE_CHARS = 512;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_CANDIDATE_LABEL_CHARS = 200;
const MAX_REQUEST_BYTES = 16_384;

export type OnDeviceClarificationBackend = 'configured' | 'on-device';

export type OnDeviceClarificationStatus = Extract<
  TaskStatus,
  'next' | 'waiting' | 'someday' | 'reference'
>;
export type OnDeviceClarificationCandidateKind = 'project' | 'area' | 'context' | 'tag';
export type OnDeviceClarificationCandidate = Readonly<{
  kind: OnDeviceClarificationCandidateKind;
  id: string;
  label: string;
}>;

export type OnDeviceClarificationInput = Readonly<{
  requestId: string;
  locale: string;
  title: string;
  description: string;
  candidates: readonly OnDeviceClarificationCandidate[];
}>;

export type OnDeviceClarificationNativeSuggestion = Readonly<{
  cleanedTitle?: unknown;
  status?: unknown;
  projectIds?: unknown;
  areaIds?: unknown;
  contextIds?: unknown;
  tagIds?: unknown;
  startDate?: unknown;
  startDateEvidence?: unknown;
  dueDate?: unknown;
  dueDateEvidence?: unknown;
}>;

export type OnDeviceClarificationSuggestion = Readonly<{
  cleanedTitle: string;
  status?: OnDeviceClarificationStatus;
  projectId?: string;
  areaId?: string;
  contextIds: readonly string[];
  tagIds: readonly string[];
  startDate?: string;
  dueDate?: string;
}>;

export type OnDeviceClarificationDraftSnapshot = Readonly<{
  taskId: string;
  revision: string;
  title: string;
  description: string;
  projectId: string | null;
  areaId: string | null;
  contexts: readonly string[];
  tags: readonly string[];
  // Full timestamp identity, not the date-only text sent to a model.
  startDate: string | null;
  dueDate: string | null;
  startDateOnly: boolean;
  dueDateOnly: boolean;
  workflowChoices: readonly [string | null, string | null, string | null];
}>;

export type OnDeviceClarificationLease = Readonly<{
  requestId: string;
  fingerprint: string;
}>;

export class OnDeviceClarificationInputError extends Error {
  readonly code: 'input_too_large' | 'invalid_input';

  constructor(code: 'input_too_large' | 'invalid_input', message: string) {
    super(message);
    this.name = 'OnDeviceClarificationInputError';
    this.code = code;
  }
}

export class OnDeviceClarificationOutputError extends Error {
  readonly code: 'malformed_output' | 'invented_id';

  constructor(code: 'malformed_output' | 'invented_id', message: string) {
    super(message);
    this.name = 'OnDeviceClarificationOutputError';
    this.code = code;
  }
}

const VALID_STATUSES = new Set<OnDeviceClarificationStatus>([
  'next',
  'waiting',
  'someday',
  'reference',
]);

const normalizedArray = (value: unknown, field: string): string[] => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new OnDeviceClarificationOutputError('malformed_output', `${field} must be a string array`);
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

export function validateOnDeviceClarificationSuggestion(
  raw: OnDeviceClarificationNativeSuggestion,
  input: OnDeviceClarificationInput,
): OnDeviceClarificationSuggestion {
  if (!raw || typeof raw !== 'object' || typeof raw.cleanedTitle !== 'string') {
    throw new OnDeviceClarificationOutputError('malformed_output', 'A cleaned title is required');
  }
  const cleanedTitle = raw.cleanedTitle.trim();
  if (!cleanedTitle || cleanedTitle.length > MAX_TITLE_CHARS) {
    throw new OnDeviceClarificationOutputError('malformed_output', 'The cleaned title is invalid');
  }

  const candidateIds = new Map<OnDeviceClarificationCandidateKind, Set<string>>();
  for (const kind of ['project', 'area', 'context', 'tag'] as const) {
    candidateIds.set(
      kind,
      new Set(input.candidates.filter((item) => item.kind === kind).map((item) => item.id)),
    );
  }
  const validateIds = (
    value: unknown,
    kind: OnDeviceClarificationCandidateKind,
    field: string,
  ): string[] => {
    const ids = normalizedArray(value, field);
    if (ids.length > ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND) {
      throw new OnDeviceClarificationOutputError('malformed_output', `${field} exceeds its bound`);
    }
    if (ids.some((id) => !candidateIds.get(kind)?.has(id))) {
      throw new OnDeviceClarificationOutputError('invented_id', `${field} contains an unknown ID`);
    }
    return ids;
  };

  const projectIds = validateIds(raw.projectIds, 'project', 'projectIds');
  const areaIds = validateIds(raw.areaIds, 'area', 'areaIds');
  const contextIds = validateIds(raw.contextIds, 'context', 'contextIds');
  const tagIds = validateIds(raw.tagIds, 'tag', 'tagIds');
  if (projectIds.length > 1 || areaIds.length > 1 || (projectIds.length > 0 && areaIds.length > 0)) {
    throw new OnDeviceClarificationOutputError('malformed_output', 'Project and area associations conflict');
  }

  const normalizedStatus = typeof raw.status === 'string' ? raw.status.trim() : '';
  const status = VALID_STATUSES.has(normalizedStatus as OnDeviceClarificationStatus)
    ? normalizedStatus as OnDeviceClarificationStatus
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

export function validateOnDeviceClarificationInput(
  input: OnDeviceClarificationInput,
): OnDeviceClarificationInput {
  if (!input.requestId.trim() || !input.locale.trim() || !input.title.trim()) {
    throw new OnDeviceClarificationInputError('invalid_input', 'The selected Inbox item needs a title');
  }
  if (input.title.length > MAX_TITLE_CHARS || input.description.length > MAX_DESCRIPTION_CHARS) {
    throw new OnDeviceClarificationInputError(
      'input_too_large',
      'This Inbox item is too large for on-device clarification',
    );
  }
  const counts = new Map<OnDeviceClarificationCandidateKind, number>();
  for (const candidate of input.candidates) {
    if (!candidate.id.trim() || !candidate.label.trim() || candidate.label.length > MAX_CANDIDATE_LABEL_CHARS) {
      throw new OnDeviceClarificationInputError('invalid_input', 'Clarification candidates are invalid');
    }
    const count = (counts.get(candidate.kind) ?? 0) + 1;
    counts.set(candidate.kind, count);
    if (count > ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND) {
      throw new OnDeviceClarificationInputError('input_too_large', 'Clarification candidate context is too large');
    }
  }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (serializedBytes > MAX_REQUEST_BYTES) {
    throw new OnDeviceClarificationInputError('input_too_large', 'Clarification context is too large');
  }
  return input;
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
  .slice(0, ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND)
  .map((entry) => entry.value);

export function buildOnDeviceClarificationCandidates(options: {
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
}): OnDeviceClarificationCandidate[] {
  const queryTerms = terms(`${options.title} ${options.description}`);
  const activeProjects = options.projects.filter((project) => !project.deletedAt && project.status === 'active');
  const activeAreas = options.areas.filter((area) => !area.deletedAt);
  const selectedProjects = new Set(options.selectedProjectId ? [options.selectedProjectId] : []);
  const selectedAreas = new Set(options.selectedAreaId ? [options.selectedAreaId] : []);
  const selectedContexts = new Set(options.selectedContexts ?? []);
  const selectedTags = new Set(options.selectedTags ?? []);
  if (
    selectedContexts.size > ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND
    || selectedTags.size > ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND
  ) {
    throw new OnDeviceClarificationInputError(
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

export function createOnDeviceClarificationLease(
  requestId: string,
  snapshot: OnDeviceClarificationDraftSnapshot,
): OnDeviceClarificationLease {
  return {
    requestId,
    fingerprint: JSON.stringify({
      ...snapshot,
      contexts: stableStrings(snapshot.contexts),
      tags: stableStrings(snapshot.tags),
    }),
  };
}

export function isOnDeviceClarificationLeaseCurrent(
  lease: OnDeviceClarificationLease,
  snapshot: OnDeviceClarificationDraftSnapshot,
): boolean {
  return lease.fingerprint === createOnDeviceClarificationLease(lease.requestId, snapshot).fingerprint;
}

export function consumeOnDeviceClarificationApply(
  lease: OnDeviceClarificationLease,
  snapshot: OnDeviceClarificationDraftSnapshot,
  consumedRequestIds: Set<string>,
): boolean {
  if (
    consumedRequestIds.has(lease.requestId)
    || !isOnDeviceClarificationLeaseCurrent(lease, snapshot)
  ) return false;
  consumedRequestIds.add(lease.requestId);
  return true;
}

export function areOnDeviceClarificationAssociationsCurrent(
  suggestion: OnDeviceClarificationSuggestion,
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
