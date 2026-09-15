import { describe, expect, it } from 'vitest';

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
  type OnDeviceClarificationDraftSnapshot,
  type OnDeviceClarificationInput,
} from './on-device-clarification';

const input: OnDeviceClarificationInput = {
  requestId: 'request-1',
  locale: 'en-US',
  title: 'Call dentist by September 18, 2026',
  description: 'Book the annual checkup.',
  candidates: [
    { kind: 'project', id: 'project-health', label: 'Health' },
    { kind: 'area', id: 'area-personal', label: 'Personal' },
    { kind: 'context', id: '@phone', label: '@phone' },
    { kind: 'tag', id: '#health', label: '#health' },
  ],
};

const snapshot: OnDeviceClarificationDraftSnapshot = {
  taskId: 'task-1',
  revision: '4:device-a:2026-09-14T12:00:00.000Z',
  title: input.title,
  description: input.description,
  projectId: null,
  areaId: null,
  contexts: [],
  tags: [],
  startDate: String(Date.parse('2026-09-18T09:00:00Z')),
  dueDate: null,
  startDateOnly: false,
  dueDateOnly: false,
  workflowChoices: ['actionable', 'no', 'defer'],
};

describe('shared on-device clarification contract', () => {
  it('bounds source text and every candidate kind before platform inference', () => {
    expect(() => validateOnDeviceClarificationInput({ ...input, title: 'x'.repeat(513) }))
      .toThrow(OnDeviceClarificationInputError);
    expect(() => validateOnDeviceClarificationInput({
      ...input,
      candidates: Array.from(
        { length: ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND + 1 },
        (_, index) => ({ kind: 'context' as const, id: `@c-${index}`, label: `@c-${index}` }),
      ),
    })).toThrow(OnDeviceClarificationInputError);
  });

  it('accepts current IDs and only date-only suggestions with explicit source evidence', () => {
    expect(validateOnDeviceClarificationSuggestion({
      cleanedTitle: 'Call the dentist',
      status: 'next',
      projectIds: ['project-health'],
      contextIds: ['@phone'],
      dueDate: '2026-09-18',
      dueDateEvidence: 'September 18, 2026',
      startDate: '2026-09-17',
      startDateEvidence: 'tomorrow',
    }, input)).toEqual({
      cleanedTitle: 'Call the dentist',
      status: 'next',
      projectId: 'project-health',
      contextIds: ['@phone'],
      tagIds: [],
      dueDate: '2026-09-18',
    });
  });

  it('rejects invented IDs and conflicting project/area homes', () => {
    expect(() => validateOnDeviceClarificationSuggestion({
      cleanedTitle: 'Call the dentist',
      projectIds: ['invented'],
    }, input)).toThrow(OnDeviceClarificationOutputError);
    expect(() => validateOnDeviceClarificationSuggestion({
      cleanedTitle: 'Call the dentist',
      projectIds: ['project-health'],
      areaIds: ['area-personal'],
    }, input)).toThrow('Project and area associations conflict');
  });

  it('invalidates the Apply lease for revision, time, date-mode, and workflow edits', () => {
    const lease = createOnDeviceClarificationLease('request-1', snapshot);
    expect(isOnDeviceClarificationLeaseCurrent(lease, snapshot)).toBe(true);
    expect(isOnDeviceClarificationLeaseCurrent(lease, { ...snapshot, revision: '5:device-b:new' })).toBe(false);
    expect(isOnDeviceClarificationLeaseCurrent(lease, {
      ...snapshot,
      startDate: String(Date.parse('2026-09-18T10:00:00Z')),
    })).toBe(false);
    expect(isOnDeviceClarificationLeaseCurrent(lease, { ...snapshot, startDateOnly: true })).toBe(false);
    expect(isOnDeviceClarificationLeaseCurrent(lease, {
      ...snapshot,
      workflowChoices: ['reference', null, null],
    })).toBe(false);
  });

  it('consumes Apply once and revalidates associations against the current store', () => {
    const lease = createOnDeviceClarificationLease('request-1', snapshot);
    const consumed = new Set<string>();
    expect(consumeOnDeviceClarificationApply(lease, snapshot, consumed)).toBe(true);
    expect(consumeOnDeviceClarificationApply(lease, snapshot, consumed)).toBe(false);

    const suggestion = validateOnDeviceClarificationSuggestion({
      cleanedTitle: 'Call the dentist',
      projectIds: ['project-health'],
    }, input);
    expect(areOnDeviceClarificationAssociationsCurrent(suggestion, {
      projectIds: new Set(['project-health']),
      areaIds: new Set(['area-personal']),
      contextIds: new Set(['@phone']),
      tagIds: new Set(['#health']),
    })).toBe(true);
    expect(areOnDeviceClarificationAssociationsCurrent(suggestion, {
      projectIds: new Set(),
      areaIds: new Set(['area-personal']),
      contextIds: new Set(['@phone']),
      tagIds: new Set(['#health']),
    })).toBe(false);
  });

  it('builds bounded relevant candidates while preserving selected associations', () => {
    const candidates = buildOnDeviceClarificationCandidates({
      title: 'Health call',
      description: '',
      projects: Array.from({ length: 30 }, (_, index) => ({
        id: `project-${index}`,
        title: index === 20 ? 'Health' : `Unrelated ${index}`,
        status: 'active' as const,
        color: '#000000',
        order: index,
        tagIds: [],
        createdAt: '',
        updatedAt: '',
      })),
      areas: [],
      contexts: ['@office'],
      tags: ['#later'],
      selectedContexts: ['@phone'],
      selectedTags: ['#health'],
    });

    expect(candidates).toContainEqual({ kind: 'project', id: 'project-20', label: 'Health' });
    expect(candidates).toContainEqual({ kind: 'context', id: '@phone', label: '@phone' });
    expect(candidates).toContainEqual({ kind: 'tag', id: '#health', label: '#health' });
    expect(candidates.filter((candidate) => candidate.kind === 'project').length)
      .toBeLessThanOrEqual(ON_DEVICE_CLARIFICATION_MAX_CANDIDATES_PER_KIND);
    expect(candidates).not.toContainEqual(expect.objectContaining({ id: 'project-0' }));
  });
});
