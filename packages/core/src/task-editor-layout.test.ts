import { describe, expect, it } from 'vitest';

import {
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_HIDDEN,
    DEFAULT_TASK_EDITOR_VISIBLE,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isTaskEditorSectionableField,
    isTaskEditorSectionFieldVisible,
    normalizeTaskEditorOrder,
    TASK_EDITOR_FIXED_FIELDS,
} from './task-editor-layout';
import type { TaskEditorFieldId, TaskEditorSettings } from './types';

describe('isTaskEditorSectionFieldVisible (#1190)', () => {
    it.each([
        { name: 'reveals sections when the selected project has them', hasProjectSections: true, expected: true },
        { name: 'keeps sectionless projects simple', hasProjectSections: false, expected: false },
        { name: 'respects an explicitly hidden empty field', hidden: ['section'], hasProjectSections: true, expected: false },
        { name: 'respects an explicitly enabled field', hidden: [], hasProjectSections: false, expected: true },
        { name: 'keeps an existing assignment editable', hidden: ['section'], sectionId: 'section-1', hasProjectSections: true, expected: true },
        { name: 'does not depend on sections having synced before the task', sectionId: 'section-1', hasProjectSections: false, expected: true },
    ] satisfies Array<{
        name: string;
        hidden?: TaskEditorSettings['hidden'];
        sectionId?: string;
        hasProjectSections: boolean;
        expected: boolean;
    }>)('$name', ({ hidden, sectionId, hasProjectSections, expected }) => {
        expect(isTaskEditorSectionFieldVisible({ hidden }, {
            projectId: 'project-1', sectionId, hasProjectSections,
        })).toBe(expected);
    });

    it('never shows a project section without a selected project', () => {
        expect(isTaskEditorSectionFieldVisible({ hidden: [] }, {
            projectId: '', sectionId: 'old-section', hasProjectSections: true,
        })).toBe(false);
    });

    it('distinguishes persisted defaults from saved field customizations', () => {
        const defaults = { defaultsVersion: 5, hidden: [...DEFAULT_TASK_EDITOR_HIDDEN] };
        const context = { projectId: 'project-1', sectionId: '', hasProjectSections: true };
        expect(isTaskEditorSectionFieldVisible(defaults, context)).toBe(true);
        expect(isTaskEditorSectionFieldVisible({
            ...defaults, order: [...DEFAULT_TASK_EDITOR_ORDER],
        }, context)).toBe(false);
        expect(defaults.hidden).toEqual(DEFAULT_TASK_EDITOR_HIDDEN);
    });
});

describe('isTaskEditorSectionableField', () => {
    it('excludes the fixed fields and textDirection', () => {
        expect(isTaskEditorSectionableField('status')).toBe(false);
        expect(isTaskEditorSectionableField('project')).toBe(false);
        expect(isTaskEditorSectionableField('section')).toBe(false);
        expect(isTaskEditorSectionableField('area')).toBe(false);
        expect(isTaskEditorSectionableField('textDirection')).toBe(false);
    });

    it('includes every other roster field', () => {
        expect(isTaskEditorSectionableField('dueDate')).toBe(true);
        expect(isTaskEditorSectionableField('attachments')).toBe(true);
        expect(TASK_EDITOR_FIXED_FIELDS.every((fieldId) => !isTaskEditorSectionableField(fieldId))).toBe(true);
    });
});

describe('getTaskEditorSectionAssignments', () => {
    it('merges saved section overrides with the defaults', () => {
        expect(getTaskEditorSectionAssignments({
            sections: {
                dueDate: 'scheduling',
                tags: 'details',
            },
        })).toMatchObject({
            dueDate: 'scheduling',
            tags: 'details',
            section: 'basic',
            contexts: 'basic',
        });
    });

    it('ignores overrides for a fixed (non-sectionable) field', () => {
        expect(getTaskEditorSectionAssignments({
            sections: { status: 'details' } as unknown as Record<TaskEditorFieldId, 'details'>,
        }).status).toBe('basic');
    });

    it('falls back to the defaults when nothing is saved', () => {
        expect(getTaskEditorSectionAssignments(undefined).recurrence).toBe('scheduling');
    });
});

describe('getTaskEditorSectionOpenDefaults', () => {
    it('uses saved section-open values when present', () => {
        expect(getTaskEditorSectionOpenDefaults({
            sectionOpen: {
                scheduling: true,
                details: false,
            },
        })).toEqual({
            basic: true,
            scheduling: true,
            organization: false,
            details: false,
        });
    });

    it('keeps optional sections collapsed by default', () => {
        expect(getTaskEditorSectionOpenDefaults(undefined)).toEqual({
            basic: true,
            scheduling: false,
            organization: false,
            details: false,
        });
    });
});

describe('roster defaults', () => {
    it('keeps the standard preset shallow while leaving collapsed sections discoverable', () => {
        expect(DEFAULT_TASK_EDITOR_VISIBLE).toEqual(expect.arrayContaining([
            'status',
            'project',
            'area',
            'contexts',
            'dueDate',
            'recurrence',
            'startTime',
            'reviewAt',
            'tags',
            'description',
            'attachments',
            'checklist',
        ]));
        expect(DEFAULT_TASK_EDITOR_VISIBLE).not.toEqual(expect.arrayContaining([
            'section',
            'priority',
            'energyLevel',
            'timeEstimate',
            'assignedTo',
            'location',
        ]));
    });
});

describe('normalizeTaskEditorOrder', () => {
    it('drops ids no longer in the roster', () => {
        const result = normalizeTaskEditorOrder(
            ['status', 'not-a-real-field' as TaskEditorFieldId, 'project'],
            new Set()
        );
        expect(result).not.toContain('not-a-real-field');
    });

    it('appends fields missing from the saved order, in roster order', () => {
        const result = normalizeTaskEditorOrder(['status'], new Set());
        expect(result).toEqual(DEFAULT_TASK_EDITOR_ORDER);
    });

    it('removes disabled fields even when they appear in the saved order', () => {
        const result = normalizeTaskEditorOrder(
            [...DEFAULT_TASK_EDITOR_ORDER],
            new Set<TaskEditorFieldId>(['priority', 'timeEstimate'])
        );
        expect(result).not.toContain('priority');
        expect(result).not.toContain('timeEstimate');
        expect(result).toHaveLength(DEFAULT_TASK_EDITOR_ORDER.length - 2);
    });

    it('preserves a valid saved order verbatim', () => {
        const custom = [...DEFAULT_TASK_EDITOR_ORDER].reverse();
        expect(normalizeTaskEditorOrder(custom, new Set())).toEqual(custom);
    });
});
