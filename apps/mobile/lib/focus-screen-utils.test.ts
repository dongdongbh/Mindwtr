import { describe, expect, it } from 'vitest';

import { getFocusTokenOptions, splitFocusedTasks } from './focus-screen-utils';

describe('splitFocusedTasks', () => {
    it('separates focused tasks while preserving relative order inside each group', () => {
        const { focusedTasks, otherTasks } = splitFocusedTasks([
            { id: 'due-1', isFocusedToday: false },
            { id: 'focus-1', isFocusedToday: true },
            { id: 'due-2', isFocusedToday: false },
            { id: 'focus-2', isFocusedToday: true },
            { id: 'focus-3', isFocusedToday: true },
        ]);

        expect(focusedTasks.map((task) => task.id)).toEqual([
            'focus-1',
            'focus-2',
            'focus-3',
        ]);
        expect(otherTasks.map((task) => task.id)).toEqual([
            'due-1',
            'due-2',
        ]);
    });

    it('returns empty groups when one side is absent', () => {
        const tasks = [
            { id: 'focus-1', isFocusedToday: true },
            { id: 'focus-2', isFocusedToday: true },
        ];

        expect(splitFocusedTasks(tasks)).toEqual({
            focusedTasks: tasks,
            otherTasks: [],
        });
    });
});

describe('getFocusTokenOptions', () => {
    it('returns sorted unique contexts and tags', () => {
        expect(getFocusTokenOptions([
            { contexts: ['@work', '@home', ''], tags: ['#deep'] },
            { contexts: ['@work/calls', '@home'], tags: ['#deep', '#ops'] },
            { contexts: [], tags: [] },
        ] as any)).toEqual(['@home', '@work', '@work/calls', '#deep', '#ops']);
    });
});

describe('buildFocusTaskSections', () => {
    const task = (id: string) => ({ id, title: id } as unknown as import('@mindwtr/core').Task);
    const translate = (key: string) => ({ 'agenda.todaysFocus': 'Starred', 'focus.schedule': 'Today', 'agenda.reviewDue': 'Review', 'focus.nextActions': 'Next', 'agenda.upcoming': 'Soon' } as Record<string, string>)[key];

    it('keeps the Focus screen order and only shows the optional sections when they have tasks', async () => {
        const { buildFocusTaskSections } = await import('./focus-sections');
        const full = buildFocusTaskSections({
            focusedTasks: [task('f')], schedule: [task('s')], reviewDue: [], nextActions: [task('n')], upcoming: [task('u')],
        }, translate);
        expect(full.map((section) => [section.key, section.title, section.items.length])).toEqual([
            ['focus', 'Starred', 1], ['schedule', 'Today', 1], ['reviewDue', 'Review', 0], ['next', 'Next', 1], ['upcoming', 'Soon', 1],
        ]);

        const sparse = buildFocusTaskSections({ focusedTasks: [], schedule: [], reviewDue: [], nextActions: [], upcoming: [] }, () => undefined);
        expect(sparse.map((section) => section.key)).toEqual(['schedule', 'reviewDue', 'next']);
        expect(sparse.map((section) => section.title)).toEqual(['Today', 'Review Due', 'Next actions']);
    });
});
