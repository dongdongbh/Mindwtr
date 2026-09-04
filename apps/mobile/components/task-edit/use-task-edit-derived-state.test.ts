import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { AppData, Task } from '@mindwtr/core';
import { createTaskDraft, setTaskDraftField } from '@mindwtr/core/task-draft';

import { DEFAULT_TASK_EDITOR_ORDER } from './task-edit-modal.utils';
import { useTaskEditDerivedState } from './use-task-edit-derived-state';

const baseTask: Task = {
    id: 'task-1',
    title: 'Monthly check',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
};

describe('useTaskEditDerivedState', () => {
    it('hides status when the task editor layout disables it even for non-inbox tasks', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const settings: AppData['settings'] = {
            gtd: {
                taskEditor: {
                    hidden: ['status'],
                },
            },
        };

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                checklist: baseTask.checklist,
                draft: createTaskDraft(baseTask),
                settings,
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.basicFields).not.toContain('status');
        expect(derived?.showStatusField).toBe(false);
    });

    // #1155: Reference is a destination for any task, not a status you can only
    // keep once you are already there.
    it('offers Reference in the status list for a next-action task', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                checklist: baseTask.checklist,
                draft: createTaskDraft(baseTask),
                settings: {},
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(baseTask.status).not.toBe('reference');
        expect(derived?.availableStatusOptions).toEqual(
            ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'],
        );
    });

    it('hides every configured field when hidden fields have no task content', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const settings: AppData['settings'] = {
            gtd: {
                taskEditor: {
                    hidden: [...DEFAULT_TASK_EDITOR_ORDER],
                },
            },
        };

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                checklist: baseTask.checklist,
                draft: createTaskDraft(baseTask),
                settings,
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.basicFields).toEqual([]);
        expect(derived?.schedulingFields).toEqual([]);
        expect(derived?.organizationFields).toEqual([]);
        expect(derived?.detailsFields).toEqual([]);
        expect(derived?.showStatusField).toBe(false);
    });

    it('reveals the empty assignedTo field while editing a task as waiting (#1021)', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const draft = setTaskDraftField(createTaskDraft(baseTask), 'status', 'waiting');

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                checklist: baseTask.checklist,
                draft,
                settings: {},
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.organizationFields).toContain('assignedTo');
    });

    it('keeps assignedTo hidden by default for non-waiting statuses when empty', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const draft = setTaskDraftField(createTaskDraft(baseTask), 'status', 'next');

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                checklist: baseTask.checklist,
                draft,
                settings: {},
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.organizationFields).not.toContain('assignedTo');
    });

    it('keeps assignedTo hidden while waiting when the saved layout explicitly hides it', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const draft = setTaskDraftField(createTaskDraft(baseTask), 'status', 'waiting');
        const settings: AppData['settings'] = {
            gtd: {
                taskEditor: {
                    hidden: ['assignedTo'],
                },
            },
        };

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                checklist: baseTask.checklist,
                draft,
                settings,
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.organizationFields).not.toContain('assignedTo');
    });

    it('keeps showing assignedTo while waiting once it already has a value', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        let draft = setTaskDraftField(createTaskDraft(baseTask), 'status', 'waiting');
        draft = setTaskDraftField(draft, 'assignedTo', 'Sam');

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                checklist: baseTask.checklist,
                draft,
                settings: {},
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.organizationFields).toContain('assignedTo');
    });

    it('does not resurrect task values that were cleared in the draft', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const task: Task = {
            ...baseTask,
            projectId: 'project-1',
            areaId: 'area-1',
            sectionId: 'section-1',
            priority: 'high',
            energyLevel: 'high',
            assignedTo: 'Morgan',
            location: 'Office',
            timeEstimate: '1hr',
            startTime: '2026-06-04T09:00',
            dueDate: '2026-06-05T17:00',
            reviewAt: '2026-06-06T09:00',
            recurrence: { rule: 'daily' },
        };
        let draft = createTaskDraft(task);
        draft = setTaskDraftField(draft, 'projectId', '');
        draft = setTaskDraftField(draft, 'sectionId', '');
        draft = setTaskDraftField(draft, 'areaId', '');
        draft = setTaskDraftField(draft, 'priority', '');
        draft = setTaskDraftField(draft, 'energyLevel', '');
        draft = setTaskDraftField(draft, 'assignedTo', '');
        draft = setTaskDraftField(draft, 'location', '');
        draft = setTaskDraftField(draft, 'timeEstimate', '');
        draft = setTaskDraftField(draft, 'startTime', '');
        draft = setTaskDraftField(draft, 'dueDate', '');
        draft = setTaskDraftField(draft, 'reviewAt', '');
        draft = setTaskDraftField(draft, 'recurrence', '');

        function Probe() {
            derived = useTaskEditDerivedState({
                task,
                checklist: task.checklist,
                draft,
                settings: {
                    gtd: {
                        taskEditor: {
                            hidden: [...DEFAULT_TASK_EDITOR_ORDER],
                        },
                    },
                },
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.activeProjectId).toBe('');
        expect(derived?.projectFilterAreaId).toBe('');
        expect(derived?.basicFields).toEqual([]);
        expect(derived?.schedulingFields).toEqual([]);
        expect(derived?.organizationFields).toEqual([]);
        expect(derived?.detailsFields).toEqual([]);
    });
});
