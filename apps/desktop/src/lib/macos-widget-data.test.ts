import { describe, expect, it } from 'vitest';
import type { AppData, Project, Task } from '@mindwtr/core';

import { MAC_WIDGET_MAX_ITEMS, buildMacWidgetPayload } from './macos-widget-data';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Plan review',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T08:00:00.000Z',
    updatedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Project',
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T08:00:00.000Z',
    updatedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
});

const makeData = (tasks: Task[], projects: Project[] = []): AppData => ({
    tasks,
    projects,
    sections: [],
    areas: [],
    settings: {},
});

describe('buildMacWidgetPayload', () => {
    it('reports the empty state with no actionable tasks', () => {
        const payload = buildMacWidgetPayload(makeData([]), 'en', false);
        expect(payload.items).toEqual([]);
        expect(payload.subtitle).toContain('0');
        expect(payload.emptyMessage).toBeTruthy();
        expect(payload.focusedCount).toBe(0);
    });

    it('excludes deleted, done, and archived tasks; inbox tasks count but do not appear in the list', () => {
        const data = makeData([
            makeTask({ id: 'a', status: 'next' }),
            makeTask({ id: 'b', status: 'done' }),
            makeTask({ id: 'c', status: 'archived' }),
            makeTask({ id: 'd', status: 'inbox', deletedAt: '2026-01-02T00:00:00.000Z' }),
            makeTask({ id: 'e', status: 'inbox' }),
        ]);
        const payload = buildMacWidgetPayload(data, 'en', false);
        expect(payload.items.map((item) => item.id)).toEqual(['a']);
        expect(payload.subtitle).toContain('1');
    });

    it('puts starred tasks first, ahead of other actionable next tasks', () => {
        const data = makeData([
            makeTask({ id: 'plain-next', status: 'next', title: 'Plain next' }),
            makeTask({ id: 'starred', status: 'next', title: 'Starred', isFocusedToday: true }),
        ]);
        const payload = buildMacWidgetPayload(data, 'en', false);
        expect(payload.items.map((item) => item.id)).toEqual(['starred', 'plain-next']);
        expect(payload.focusedCount).toBe(1);
    });

    it('blocks non-first steps of a sequential project', () => {
        const project = makeProject({ id: 'seq-project', isSequential: true });
        const data = makeData(
            [
                makeTask({ id: 'step-1', status: 'next', projectId: 'seq-project', order: 0 }),
                makeTask({ id: 'step-2', status: 'next', projectId: 'seq-project', order: 1 }),
            ],
            [project],
        );
        const payload = buildMacWidgetPayload(data, 'en', false);
        expect(payload.items.map((item) => item.id)).toEqual(['step-1']);
    });

    it('gives the sequential project slot to the later step that is due today', () => {
        // The widget must name the same next action the Focus screen does
        // (#1090). Selecting by chain order alone showed 'step-1' here.
        const project = makeProject({ id: 'seq-project', isSequential: true });
        const dueToday = new Date();
        dueToday.setHours(17, 0, 0, 0);
        const data = makeData(
            [
                makeTask({ id: 'step-1', status: 'next', projectId: 'seq-project', order: 0 }),
                makeTask({
                    id: 'step-3',
                    status: 'next',
                    projectId: 'seq-project',
                    order: 2,
                    dueDate: dueToday.toISOString(),
                }),
            ],
            [project],
        );
        const payload = buildMacWidgetPayload(data, 'en', false);
        expect(payload.items.map((item) => item.id)).toEqual(['step-3']);
    });

    it('caps the item list at MAC_WIDGET_MAX_ITEMS', () => {
        const tasks = Array.from({ length: MAC_WIDGET_MAX_ITEMS + 5 }, (_, index) =>
            makeTask({ id: `task-${index}`, status: 'next' }));
        const payload = buildMacWidgetPayload(makeData(tasks), 'en', false);
        expect(payload.items).toHaveLength(MAC_WIDGET_MAX_ITEMS);
        expect(payload.subtitle).toContain('+5');
    });

    it('resolves the dark palette from the system scheme when theme is "system"', () => {
        const light = buildMacWidgetPayload(makeData([]), 'en', false);
        const dark = buildMacWidgetPayload(makeData([]), 'en', true);
        expect(light.palette.background).not.toBe(dark.palette.background);
    });

    it('resolves a fixed dark palette for an explicit dark theme regardless of system scheme', () => {
        const data: AppData = { ...makeData([]), settings: { theme: 'dark' } };
        const payload = buildMacWidgetPayload(data, 'en', false);
        expect(payload.themeMode).toBe('dark');
        expect(payload.palette.text).toBe('#F9FAFB');
    });
});
