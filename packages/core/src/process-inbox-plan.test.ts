import { describe, expect, it } from 'vitest';

import {
    prepareProcessInboxDecision,
    resolveProcessInboxPlan,
    type ProcessInboxDecisionDraft,
} from './process-inbox-plan';
import type { AppData, Task } from './types';

const task: Task = {
    id: 'task-1',
    title: 'Clarify capture',
    status: 'inbox',
    projectId: 'project-old',
    areaId: undefined,
    contexts: ['@old'],
    tags: ['#old'],
    priority: 'low',
    energyLevel: 'low',
    assignedTo: 'Old owner',
    timeEstimate: '10min',
    startTime: '2026-08-27',
    dueDate: '2026-08-28',
    reviewAt: '2026-08-29',
    createdAt: '2026-08-26T10:00:00.000Z',
    updatedAt: '2026-08-26T10:00:00.000Z',
};

const fullSettings = {
    features: { priorities: true, timeEstimates: true },
    gtd: {
        inboxProcessing: {
            defaultMode: 'quick',
            twoMinuteEnabled: true,
            twoMinuteFirst: true,
            projectFirst: true,
            contextStepEnabled: true,
            scheduleEnabled: true,
        },
        taskEditor: { hidden: [] },
    },
} as AppData['settings'];

const fullDraft: ProcessInboxDecisionDraft = {
    fields: {
        projectId: 'project-new',
        areaId: 'area-ignored',
        contexts: ['@new'],
        tags: ['#new'],
        priority: 'high',
        energyLevel: 'high',
        assignedTo: '  New owner  ',
        timeEstimate: '30min',
        startTime: '2026-09-01',
        dueDate: '2026-09-02',
        reviewAt: '2026-09-03',
    },
    taskUpdates: { title: 'Refined capture', description: 'Outcome' },
};

describe('resolveProcessInboxPlan', () => {
    it('uses the same conservative defaults for every platform', () => {
        const plan = resolveProcessInboxPlan();

        expect(plan.defaultMode).toBe('guided');
        expect(plan.initialGuidedStep).toBe('actionability');
        expect(plan.visibleFields).toMatchObject({
            project: true,
            area: true,
            contexts: true,
            tags: true,
            priority: false,
            energyLevel: false,
            assignedTo: false,
            timeEstimate: false,
            startTime: false,
            dueDate: false,
            reviewAt: false,
        });
        expect(plan.showProjectStep).toBe(true);
        expect(plan.showOrganizationStep).toBe(true);
        expect(plan.showScheduleFields).toBe(false);
    });

    it('derives step order, feature flags, and every visible section once', () => {
        const plan = resolveProcessInboxPlan(fullSettings);

        expect(plan.defaultMode).toBe('quick');
        expect(plan.initialGuidedStep).toBe('two-minute');
        expect(plan.projectFirst).toBe(true);
        expect(plan.visibleScheduleFields).toEqual(['startTime', 'dueDate', 'reviewAt']);
        expect(Object.values(plan.visibleFields).every(Boolean)).toBe(true);
        expect(plan.showOrganizationStep).toBe(true);
    });

    it('applies context, schedule, feature, and editor visibility gates together', () => {
        const plan = resolveProcessInboxPlan({
            ...fullSettings,
            features: { priorities: false, timeEstimates: false },
            gtd: {
                ...fullSettings.gtd,
                inboxProcessing: {
                    ...fullSettings.gtd?.inboxProcessing,
                    contextStepEnabled: false,
                    scheduleEnabled: false,
                },
                taskEditor: { hidden: ['project', 'area', 'energyLevel', 'assignedTo'] },
            },
        } as AppData['settings']);

        expect(plan.showProjectStep).toBe(false);
        expect(plan.showOrganizationStep).toBe(false);
        expect(plan.showScheduleFields).toBe(false);
        expect(Object.values(plan.visibleFields).every((visible) => !visible)).toBe(true);
    });
});

describe('prepareProcessInboxDecision', () => {
    const plan = resolveProcessInboxPlan(fullSettings);

    it.each(['someday', 'reference', 'complete'] as const)(
        'limits %s to selection fields',
        (type) => {
            const prepared = prepareProcessInboxDecision({ task, draft: fullDraft, decision: { type }, plan });

            expect(prepared).toMatchObject({
                ok: true,
                event: {
                    type,
                    fields: {
                        projectId: 'project-new',
                        areaId: undefined,
                        contexts: ['@new'],
                        tags: ['#new'],
                    },
                },
                taskUpdates: { title: 'Refined capture', description: 'Outcome' },
            });
            if (prepared.ok) {
                expect(prepared.event.type === 'discard' ? null : prepared.event.fields).not.toHaveProperty('priority');
            }
        },
    );

    it('keeps an explicit Someday section through the shared decision policy', () => {
        expect(prepareProcessInboxDecision({
            task,
            draft: {
                ...fullDraft,
                fields: { ...fullDraft.fields, viewSectionIds: { someday: 'ideas' } },
            },
            decision: { type: 'someday' },
            plan,
        })).toMatchObject({
            ok: true,
            event: {
                type: 'someday',
                fields: { viewSectionIds: { someday: 'ideas' } },
            },
        });
    });

    it('requires a Later date so undated work stays a Someday decision', () => {
        const draft = { ...fullDraft, fields: { ...fullDraft.fields, startTime: undefined } };

        expect(prepareProcessInboxDecision({
            task,
            draft,
            decision: { type: 'later' },
            plan,
        })).toEqual({ ok: false, reason: 'later-start-required' });
    });

    it('prepares the same complete next-action event for either platform', () => {
        const prepared = prepareProcessInboxDecision({
            task,
            draft: fullDraft,
            decision: { type: 'next' },
            plan,
        });

        expect(prepared).toEqual({
            ok: true,
            event: {
                type: 'next',
                fields: {
                    projectId: 'project-new',
                    areaId: undefined,
                    contexts: ['@new'],
                    tags: ['#new'],
                    priority: 'high',
                    energyLevel: 'high',
                    assignedTo: '  New owner  ',
                    timeEstimate: '30min',
                    startTime: '2026-09-01',
                    dueDate: '2026-09-02',
                    reviewAt: '2026-09-03',
                },
            },
            taskUpdates: { title: 'Refined capture', description: 'Outcome' },
            resetFields: ['startTime', 'dueDate', 'reviewAt', 'projectConversion'],
        });
    });

    it('omits hidden metadata instead of overwriting it with a stale draft', () => {
        const hiddenPlan = resolveProcessInboxPlan({
            ...fullSettings,
            gtd: {
                ...fullSettings.gtd,
                taskEditor: { hidden: ['contexts', 'tags', 'priority', 'assignedTo', 'dueDate'] },
            },
        } as AppData['settings']);
        const prepared = prepareProcessInboxDecision({
            task,
            draft: fullDraft,
            decision: { type: 'next' },
            plan: hiddenPlan,
        });

        expect(prepared.ok).toBe(true);
        if (!prepared.ok || prepared.event.type !== 'next') return;
        expect(prepared.event.fields).not.toHaveProperty('contexts');
        expect(prepared.event.fields).not.toHaveProperty('tags');
        expect(prepared.event.fields).not.toHaveProperty('priority');
        expect(prepared.event.fields).not.toHaveProperty('assignedTo');
        expect(prepared.event.fields).not.toHaveProperty('dueDate');
    });

    it.each(['next', 'complete'] as const)(
        'keeps explicit title date commands for %s when scheduling fields are hidden',
        (type) => {
            const prepared = prepareProcessInboxDecision({
                task,
                draft: {
                    fields: { contexts: [], tags: [] },
                    explicitDateFields: { dueDate: '2026-09-12' },
                    taskUpdates: { title: 'Call Sam' },
                },
                decision: { type },
                plan: resolveProcessInboxPlan(),
            });

            expect(prepared).toMatchObject({
                ok: true,
                event: { type, fields: { dueDate: '2026-09-12' } },
            });
        },
    );

    it('applies dirty visible date controls after title commands, including explicit clears', () => {
        const prepared = prepareProcessInboxDecision({
            task,
            draft: {
                ...fullDraft,
                explicitDateFields: {
                    startTime: '2026-09-10',
                    dueDate: '2026-09-11',
                    reviewAt: '2026-09-12',
                },
                dateControlFields: {
                    startTime: '2026-09-20',
                    dueDate: undefined,
                    reviewAt: '2026-09-22',
                },
            },
            decision: { type: 'next' },
            plan,
        });

        expect(prepared).toMatchObject({
            ok: true,
            event: {
                type: 'next',
                fields: {
                    startTime: '2026-09-20',
                    dueDate: undefined,
                    reviewAt: '2026-09-22',
                },
            },
        });
    });

    it('keeps parsed due and review dates when Later overrides only the start date', () => {
        const prepared = prepareProcessInboxDecision({
            task,
            draft: {
                fields: { contexts: [], tags: [] },
                explicitDateFields: {
                    startTime: '2026-09-10',
                    dueDate: '2026-09-11',
                    reviewAt: '2026-09-12',
                },
                dateControlFields: { startTime: '2026-09-20' },
            },
            decision: { type: 'later' },
            plan: resolveProcessInboxPlan(),
        });

        expect(prepared).toMatchObject({
            ok: true,
            event: {
                type: 'later',
                fields: {
                    startTime: '2026-09-20',
                    dueDate: '2026-09-11',
                    reviewAt: '2026-09-12',
                },
            },
        });
    });

    it('prepares Waiting follow-up and reset policy together', () => {
        const prepared = prepareProcessInboxDecision({
            task,
            draft: fullDraft,
            decision: { type: 'waiting', followUpAt: '2026-09-04' },
            plan,
        });

        expect(prepared).toMatchObject({
            ok: true,
            event: { type: 'waiting', followUpAt: '2026-09-04' },
            resetFields: ['delegate'],
        });
    });

    it('never carries task edits into a discard', () => {
        expect(prepareProcessInboxDecision({
            task,
            draft: fullDraft,
            decision: { type: 'discard' },
            plan,
        })).toEqual({
            ok: true,
            event: { type: 'discard' },
            taskUpdates: undefined,
            resetFields: [],
        });
    });

    it('prepares a skip without changing the task status', () => {
        const prepared = prepareProcessInboxDecision({
            task,
            draft: fullDraft,
            decision: { type: 'skip' },
            plan,
        });

        expect(prepared).toMatchObject({
            ok: true,
            event: { type: 'skip', fields: { projectId: 'project-new', contexts: ['@new'] } },
            taskUpdates: { title: 'Refined capture' },
        });
        if (!prepared.ok || prepared.event.type !== 'skip') return;
        expect(prepared.event.fields).not.toHaveProperty('status');
    });
});
