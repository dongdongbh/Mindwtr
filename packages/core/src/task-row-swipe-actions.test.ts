import { describe, expect, it } from 'vitest';
import { buildTaskRowSwipeActions } from './task-row-swipe-actions';
import type { TaskStatus } from './types';

const t = (key: string) => `[${key}]`;
const ids = (status: TaskStatus, extra: { isFocusedToday?: boolean; selectionMode?: boolean; interactionDisabled?: boolean } = {}) => {
    const actions = buildTaskRowSwipeActions({ task: { status, isFocusedToday: extra.isFocusedToday }, t, ...extra });
    return { swipeRight: actions.swipeRight.map((action) => action.id), swipeLeft: actions.swipeLeft.map((action) => action.id) };
};

describe('buildTaskRowSwipeActions (#1464)', () => {
    it.each(['inbox', 'next', 'waiting', 'someday'] as const)('gives an unfinished %s task the full tray', (status) => {
        expect(ids(status)).toEqual({ swipeRight: ['done', 'focus'], swipeLeft: ['organize', 'dates', 'delete'] });
    });

    it('labels and targets the actions', () => {
        const { swipeRight, swipeLeft } = buildTaskRowSwipeActions({ task: { status: 'inbox' }, t });
        expect(swipeRight).toEqual([
            { id: 'done', label: '[common.done]', status: 'done', enabled: true },
            { id: 'focus', label: '[digest.focus]', focused: false, enabled: true },
        ]);
        expect(swipeLeft.map((action) => action.label)).toEqual(['[nav.sectionOrganize]', '[task.dates]', '[common.delete]']);
    });

    it('turns Focus into Remove from focus on a starred task', () => {
        const focus = buildTaskRowSwipeActions({ task: { status: 'next', isFocusedToday: true }, t }).swipeRight[1];
        expect(focus).toMatchObject({ id: 'focus', label: '[agenda.removeFromFocus]', focused: true });
    });

    it('keeps Restore on a done task, with Organize and Delete', () => {
        expect(ids('done')).toEqual({ swipeRight: ['restore'], swipeLeft: ['organize', 'delete'] });
        expect(buildTaskRowSwipeActions({ task: { status: 'done' }, t }).swipeRight[0].status).toBe('inbox');
    });

    it('keeps the single status action for Reference (with Organize) and Archived', () => {
        expect(ids('reference')).toEqual({ swipeRight: ['next'], swipeLeft: ['organize', 'delete'] });
        expect(ids('archived')).toEqual({ swipeRight: ['done'], swipeLeft: ['delete'] });
    });

    it('disables every action in selection mode and offers none on a disabled row', () => {
        const selecting = buildTaskRowSwipeActions({ task: { status: 'next' }, t, selectionMode: true });
        expect([...selecting.swipeRight, ...selecting.swipeLeft].every((action) => !action.enabled)).toBe(true);
        expect(ids('next', { interactionDisabled: true })).toEqual({ swipeRight: [], swipeLeft: [] });
    });
});
