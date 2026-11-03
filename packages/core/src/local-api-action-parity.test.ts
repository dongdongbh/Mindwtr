import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { applyTaskUpdates, normalizeTaskUpdate } from './store-helpers';
import { nextRevision } from './sync-revision';
import { sanitizeRestoredTaskContainerReferences } from './store-tasks';
import type { Area, Project, Section, Task, TaskStatus } from './types';
import type { TaskStore } from './store-types';


type ActionParityCase = {
    kind: 'action';
    name: string;
    action: 'complete' | 'archive' | 'restore';
    previousStatus: TaskStatus;
    now: string;
    deviceId: string;
    task: Task;
    containers?: {
        projects?: Array<Pick<Project, 'id' | 'deletedAt' | 'purgedAt'>>;
        sections?: Array<Pick<Section, 'id' | 'projectId' | 'deletedAt'>>;
        areas?: Array<Pick<Area, 'id' | 'deletedAt'>>;
    };
    expectedTask?: Record<string, unknown>;
    expectedFollowUp?: Record<string, unknown> | null;
    expectRefusal?: boolean;
};

const allCases = JSON.parse(
    readFileSync(new URL('./recurrence-local-api-parity.fixtures.json', import.meta.url), 'utf8')
) as Array<{ kind?: string } & Record<string, unknown>>;

const actionCases = allCases.filter((testCase): testCase is ActionParityCase => testCase.kind === 'action');


const PINNED_ACTION_CASE_NAMES = [
    'complete a non-recurring task',
    'complete a recurring task creates a follow-up with rev/revBy stamped',
    'completing an archived task is a correction, not a new completion',
    'archive a task',
    'restore drops a dangling projectId and sectionId but keeps a live areaId',
    'complete refuses recurrence the local API engine cannot compute (409)',
    'completing an already-done task is a full no-op',
    "complete refuses recurrence with a relativeStartOffset the local API can't recompute (409)",
    'restore: section adopts its project and clears area',
    'restore: section dropped when it belongs to another project',
    'restore: area dropped when project set',
].sort();

const isNoOpStatusResend = (testCase: ActionParityCase): boolean => (
    (testCase.action === 'complete' && testCase.previousStatus === 'done')
    || (testCase.action === 'archive' && testCase.previousStatus === 'archived')
);

describe('local API write-action parity fixture (kind: action)', () => {
    it('covers exactly the pinned action-kind case roster', () => {
        expect(actionCases.map((testCase) => testCase.name).sort()).toEqual(PINNED_ACTION_CASE_NAMES);
    });

    it.each(actionCases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
        if (testCase.expectRefusal) {


            return;
        }

        if (isNoOpStatusResend(testCase)) {


            expect(testCase.task).toEqual(testCase.expectedTask);
            expect(testCase.expectedFollowUp ?? null).toBeNull();
            return;
        }

        let updatedTask: Task;
        let nextRecurringTask: Task | null = null;

        if (testCase.action === 'restore') {
            const containers = testCase.containers ?? {};
            const state = {
                _allProjects: containers.projects ?? [],
                _allSections: containers.sections ?? [],
                _allAreas: containers.areas ?? [],
            } as unknown as TaskStore;
            const sanitized = sanitizeRestoredTaskContainerReferences(testCase.task, state);
            updatedTask = {
                ...testCase.task,
                deletedAt: undefined,
                ...sanitized,
                updatedAt: testCase.now,
                rev: nextRevision(testCase.task.rev),
                revBy: testCase.deviceId,
            };
        } else {


            const status: TaskStatus = testCase.action === 'complete' ? 'done' : 'archived';
            const normalized = normalizeTaskUpdate(testCase.task, { status });
            const result = applyTaskUpdates(
                testCase.task,
                { ...normalized, rev: nextRevision(testCase.task.rev), revBy: testCase.deviceId },
                testCase.now
            );
            updatedTask = result.updatedTask;
            nextRecurringTask = result.nextRecurringTask
                ? { ...result.nextRecurringTask, rev: nextRevision(undefined), revBy: testCase.deviceId }
                : null;
        }


        expect(JSON.parse(JSON.stringify(updatedTask))).toEqual(testCase.expectedTask);

        if (nextRecurringTask) {


            const { id: _followUpId, ...followUpRest } = nextRecurringTask;
            expect(JSON.parse(JSON.stringify(followUpRest))).toEqual(testCase.expectedFollowUp);
        } else {
            expect(testCase.expectedFollowUp ?? null).toBeNull();
        }
    });
});
