import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createTaskDraft, DEFAULT_TASK_EDITOR_ORDER, type Task, type TaskDraft } from '@mindwtr/core';

import { useTaskItemFieldLayout } from './useTaskItemFieldLayout';

const baseTask: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-18T00:00:00.000Z',
    updatedAt: '2026-03-18T00:00:00.000Z',
};

type LayoutParams = Parameters<typeof useTaskItemFieldLayout>[0];

const buildParams = (
    overrides: Partial<Omit<LayoutParams, 'draft'>> & { draft?: Partial<TaskDraft> } = {},
): LayoutParams => {
    const task = overrides.task ?? {
        ...baseTask,
        dueDate: '2026-03-20',
        checklist: [{ id: 'item-1', title: 'Checklist item', isCompleted: false }],
    };
    return {
        settings: overrides.settings ?? {},
        task,
        draft: {
            ...createTaskDraft(task),
            status: 'next',
            priority: 'high',
            contexts: '@home',
            description: 'Reference notes',
            dueDate: '2026-03-20',
            recurrence: 'daily',
            reviewAt: '2026-03-21T09:00',
            startTime: '2026-03-19T09:00',
            tags: '#notes',
            location: 'Office',
            timeEstimate: '30min',
            ...overrides.draft,
        },
        prioritiesEnabled: overrides.prioritiesEnabled ?? true,
        timeEstimatesEnabled: overrides.timeEstimatesEnabled ?? true,
        visibleEditAttachmentsLength: overrides.visibleEditAttachmentsLength ?? 1,
    };
};

describe('useTaskItemFieldLayout', () => {
    it('keeps the default editor shallow while leaving optional metadata hidden until used', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            draft: {
                priority: '',
                energyLevel: '',
                assignedTo: '',
                location: '',
                timeEstimate: '',
            },
        })));

        expect(result.current.basicFields).toEqual(expect.arrayContaining(['status', 'contexts', 'dueDate']));
        expect(result.current.organizationFields).not.toContain('priority');
        expect(result.current.organizationFields).not.toContain('energyLevel');
        expect(result.current.organizationFields).not.toContain('assignedTo');
        expect(result.current.organizationFields).not.toContain('timeEstimate');
        expect(result.current.detailsFields).not.toContain('location');
        expect(result.current.sectionOpenDefaults.details).toBe(false);
    });

    it('hides status when the task editor layout disables it even for non-inbox tasks', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: ['status'],
                    },
                },
            },
            draft: { status: 'next' },
        })));

        expect(result.current.basicFields).not.toContain('status');
    });

    it('hides every configured field when hidden fields have no task content', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: [...DEFAULT_TASK_EDITOR_ORDER],
                    },
                },
            },
            task: baseTask,
            draft: {
                status: 'next',
                projectId: '',
                sectionId: '',
                areaId: '',
                priority: '',
                energyLevel: '',
                assignedTo: '',
                contexts: '',
                description: '',
                dueDate: '',
                recurrence: '',
                reviewAt: '',
                startTime: '',
                tags: '',
                location: '',
                timeEstimate: '',
            },
            visibleEditAttachmentsLength: 0,
        })));

        expect(result.current.showProjectField).toBe(false);
        expect(result.current.showAreaField).toBe(false);
        expect(result.current.showSectionField).toBe(false);
        expect(result.current.basicFields).toEqual([]);
        expect(result.current.schedulingFields).toEqual([]);
        expect(result.current.organizationFields).toEqual([]);
        expect(result.current.detailsFields).toEqual([]);
    });

    it('hides action-only fields while a task is being edited as reference', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            draft: { status: 'reference' },
        })));

        expect(result.current.basicFields).toContain('status');
        expect(result.current.basicFields).not.toContain('dueDate');
        expect(result.current.schedulingFields).toEqual([]);
        expect(result.current.basicFields).toContain('contexts');
        expect(result.current.organizationFields).toContain('tags');
        expect(result.current.organizationFields).not.toContain('priority');
        expect(result.current.organizationFields).not.toContain('timeEstimate');
        expect(result.current.detailsFields).toContain('description');
        expect(result.current.detailsFields).toContain('attachments');
        expect(result.current.detailsFields).not.toContain('checklist');
    });

    it('uses the draft status rather than the persisted task status for field visibility', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            task: {
                ...baseTask,
                status: 'reference',
                checklist: [{ id: 'item-1', title: 'Checklist item', isCompleted: false }],
            },
            draft: { status: 'next' },
        })));

        expect(result.current.basicFields).toContain('dueDate');
        expect(result.current.schedulingFields).toHaveLength(3);
        expect(result.current.schedulingFields).toEqual(expect.arrayContaining(['startTime', 'recurrence', 'reviewAt']));
        expect(result.current.basicFields).toContain('contexts');
        expect(result.current.organizationFields).toContain('priority');
        expect(result.current.organizationFields).toContain('timeEstimate');
        expect(result.current.detailsFields).toContain('checklist');
    });

    it('groups the scheduling dates together above the recurrence editor', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams()));

        expect(result.current.schedulingFields).toEqual(['startTime', 'reviewAt', 'recurrence']);
    });

    it('splits basic fields around the organizer row following the configured order', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        order: ['contexts', 'dueDate', 'area', 'project', 'section', 'status'],
                    },
                },
            },
        })));

        expect(result.current.basicFieldsBeforeOrganizers).toEqual(['contexts', 'dueDate']);
        expect(result.current.organizerFields).toEqual(['area', 'project']);
        expect(result.current.basicFieldsAfterOrganizers).toEqual(['status']);
    });

    it('keeps status above the organizer row with the default order', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams()));

        expect(result.current.basicFieldsBeforeOrganizers).toEqual(['status']);
        expect(result.current.organizerFields).toEqual(['project', 'area']);
        expect(result.current.basicFieldsAfterOrganizers).toEqual(expect.arrayContaining(['contexts', 'dueDate']));
        expect(result.current.basicFields).toEqual([
            ...result.current.basicFieldsBeforeOrganizers,
            ...result.current.basicFieldsAfterOrganizers,
        ]);
    });

    it('places every basic field before an empty organizer row', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: ['project', 'area', 'section'],
                    },
                },
            },
            draft: { projectId: '', sectionId: '', areaId: '' },
            task: baseTask,
        })));

        expect(result.current.organizerFields).toEqual([]);
        expect(result.current.basicFieldsAfterOrganizers).toEqual([]);
        expect(result.current.basicFieldsBeforeOrganizers).toEqual(result.current.basicFields);
    });

    it('reveals the empty assignedTo field while editing a task as waiting (#1021)', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            draft: { status: 'waiting', assignedTo: '' },
        })));

        expect(result.current.organizationFields).toContain('assignedTo');
    });

    it('keeps assignedTo hidden by default for non-waiting statuses when empty', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            draft: { status: 'next', assignedTo: '' },
        })));

        expect(result.current.organizationFields).not.toContain('assignedTo');
    });

    it('keeps assignedTo hidden while waiting when the saved layout explicitly hides it', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: ['assignedTo'],
                    },
                },
            },
            draft: { status: 'waiting', assignedTo: '' },
        })));

        expect(result.current.organizationFields).not.toContain('assignedTo');
    });

    it('keeps showing assignedTo while waiting once it already has a value', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            draft: { status: 'waiting', assignedTo: 'Sam' },
        })));

        expect(result.current.organizationFields).toContain('assignedTo');
    });

    it('moves due date into scheduling when configured and preserves section open defaults', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        sections: {
                            dueDate: 'scheduling',
                        },
                        sectionOpen: {
                            scheduling: true,
                            details: false,
                        },
                    },
                },
            },
        })));

        expect(result.current.basicFields).not.toContain('dueDate');
        expect(result.current.schedulingFields).toContain('dueDate');
        expect(result.current.sectionOpenDefaults).toEqual({
            basic: true,
            scheduling: true,
            organization: false,
            details: false,
        });
    });
});
