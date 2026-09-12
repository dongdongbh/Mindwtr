import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_EDITOR_HIDDEN, DEFAULT_TASK_EDITOR_ORDER, REFERENCE_HIDDEN_TASK_FIELDS, type AppData, type Section, type Task } from '@mindwtr/core';
import { createTaskDraft, setTaskDraftField } from '@mindwtr/core/task-draft';

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
    it('reveals project sections for an unassigned task and follows draft project changes (#1190)', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const task = { ...baseTask, projectId: 'project-1' };
        let draft = createTaskDraft(task);
        const section: Section = {
            id: 'section-1', projectId: 'project-1', title: 'Planning', order: 0,
            createdAt: baseTask.createdAt, updatedAt: baseTask.updatedAt,
        };
        let sections: Section[] = [section];
        let settings: AppData['settings'] = {
            gtd: { taskEditor: { defaultsVersion: 5, hidden: [...DEFAULT_TASK_EDITOR_HIDDEN] } },
        };
        function Probe() {
            derived = useTaskEditDerivedState({
                task, draft, sections, settings, projects: [], checklist: [],
                prioritiesEnabled: true, timeEstimatesEnabled: true,
                contextInputDraft: '', descriptionDraft: '', tagInputDraft: '',
                visibleAttachmentsLength: 0, t: (key) => key,
            });
            return null;
        }
        let view: renderer.ReactTestRenderer;
        renderer.act(() => { view = renderer.create(React.createElement(Probe)); });
        const update = () => renderer.act(() => view.update(React.createElement(Probe)));
        try {
            expect(derived?.basicFields).toContain('section');
            expect(derived?.projectSections.map((section) => section.id)).toEqual(['section-1']);

            draft = setTaskDraftField(draft, 'projectId', 'project-2');
            update();
            expect(derived?.basicFields).not.toContain('section');
            expect(derived?.projectSections).toEqual([]);

            sections = [...sections, { ...section, id: 'section-2', projectId: 'project-2', title: 'Delivery' }];
            update();
            expect(derived?.basicFields).toContain('section');
            expect(derived?.projectSections.map((section) => section.id)).toEqual(['section-2']);

            settings = { gtd: { taskEditor: { hidden: ['section'] } } };
            update();
            expect(derived?.basicFields).not.toContain('section');

            draft = setTaskDraftField(draft, 'sectionId', 'section-2');
            update();
            expect(derived?.basicFields).toContain('section');

            draft = setTaskDraftField(draft, 'sectionId', '');
            settings = {};
            sections = sections.map((section) => ({ ...section, deletedAt: '2026-09-09T12:00:00Z' }));
            update();
            expect(derived?.basicFields).not.toContain('section');

            draft = setTaskDraftField(draft, 'projectId', '');
            settings = { gtd: { taskEditor: { hidden: [] } } };
            update();
            expect(derived?.basicFields).not.toContain('section');
            expect(derived?.projectSections).toEqual([]);
        } finally {
            renderer.act(() => view.unmount());
        }
    });

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

    it('uses the shared Reference field contract while retaining memo metadata fields', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const referenceTask: Task = {
            ...baseTask,
            status: 'reference',
            projectId: 'project-1',
            areaId: 'area-1',
            assignedTo: 'Alex',
            description: 'Reference body',
            tags: ['#research'],
            contexts: ['@private'],
            location: 'Archive room',
            priority: 'high',
            energyLevel: 'low',
            timeEstimate: '1hr',
            startTime: '2026-09-12T09:00:00.000Z',
            dueDate: '2026-09-13T09:00:00.000Z',
            reviewAt: '2026-09-14T09:00:00.000Z',
            recurrence: { rule: 'daily' },
            checklist: [{ id: 'step-1', title: 'Old action detail', isCompleted: false }],
        };

        function Probe() {
            derived = useTaskEditDerivedState({
                task: referenceTask,
                checklist: referenceTask.checklist,
                draft: createTaskDraft(referenceTask),
                settings: { gtd: { taskEditor: { hidden: [] } } },
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '@private',
                descriptionDraft: 'Reference body',
                tagInputDraft: '#research',
                visibleAttachmentsLength: 1,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        const visibleFields = [
            ...(derived?.basicFields ?? []),
            ...(derived?.schedulingFields ?? []),
            ...(derived?.organizationFields ?? []),
            ...(derived?.detailsFields ?? []),
        ];
        expect(visibleFields).toEqual(expect.arrayContaining([
            'description', 'project', 'area', 'assignedTo', 'tags', 'attachments',
        ]));
        REFERENCE_HIDDEN_TASK_FIELDS.forEach((fieldId) => {
            expect(visibleFields).not.toContain(fieldId);
        });
        expect(derived?.showStatusField).toBe(false);
    });
});
