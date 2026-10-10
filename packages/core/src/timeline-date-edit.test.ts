import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    canEditTimelineProjectDates,
    canEditTimelineTaskDates,
    planTimelineProjectDateEdit,
    planTimelineTaskDateEdit,
} from './timeline-date-edit';
import type { Project, Task } from './types';

const task = (patch: Partial<Task> = {}): Task => ({
    id: 'task', title: 'Private task', status: 'next', tags: [], contexts: [],
    createdAt: '2026-01-01', updatedAt: '2026-01-01', startTime: '2026-03-07', dueDate: '2026-03-10', ...patch,
});
const project = (patch: Partial<Project> = {}): Project => ({
    id: 'project', title: 'Private project', status: 'active', color: '#000000', order: 0, tagIds: [],
    createdAt: '2026-01-01', updatedAt: '2026-01-01', startDate: '2026-03-07', dueDate: '2026-03-10', ...patch,
});

describe('timeline calendar-day date edits', () => {
    const timezone = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'America/New_York'; });
    afterAll(() => {
        if (timezone === undefined) delete process.env.TZ;
        else process.env.TZ = timezone;
    });

    it('moves date-only spans and resizes only the selected endpoint', () => {
        expect(planTimelineTaskDateEdit(task(), { kind: 'move', days: 2 })).toEqual({
            updates: { startTime: '2026-03-09', dueDate: '2026-03-12' },
            effectiveDates: { start: '2026-03-09', due: '2026-03-12' },
        });
        expect(planTimelineTaskDateEdit(task(), { kind: 'start', days: 1 })?.updates).toEqual({
            startTime: '2026-03-08', relativeStartOffset: undefined,
        });
        expect(planTimelineTaskDateEdit(task(), { kind: 'due', days: 1 })?.updates).toEqual({ dueDate: '2026-03-11' });
    });

    it.each([
        ['2026-03-07T09:34:56.789-05:00', '2026-03-08T13:34:56.789Z'],
        ['2026-10-31T09:34:56.789-04:00', '2026-11-01T14:34:56.789Z'],
    ])('preserves local clock seconds and milliseconds across DST from %s', (startTime, expected) => {
        expect(planTimelineTaskDateEdit(task({ startTime, dueDate: undefined }), { kind: 'move', days: 1 })?.updates)
            .toEqual({ startTime: expected });
    });

    it('does not write or change the repeated fall-DST instant for zero displacement', () => {
        const original = task({ startTime: '2026-11-01T01:30:45.987-05:00', dueDate: undefined });
        expect(planTimelineTaskDateEdit(original, { kind: 'move', days: 0 })).toBeNull();
        expect(original.startTime).toBe('2026-11-01T01:30:45.987-05:00');
    });

    it.each(['start', 'due'] as const)('moves a single %s marker without inventing an endpoint or resize', (endpoint) => {
        const original = task(endpoint === 'start' ? { dueDate: undefined } : { startTime: undefined });
        const plan = planTimelineTaskDateEdit(original, { kind: 'move', days: 1 });
        expect(plan?.updates).toEqual(endpoint === 'start' ? { startTime: '2026-03-08' } : { dueDate: '2026-03-11' });
        expect(planTimelineTaskDateEdit(original, { kind: endpoint, days: 1 })).toBeNull();
    });

    it.each([
        { startTime: 'bad' }, { dueDate: '2026-02-30' }, { startTime: '2026-03-11' },
        { startTime: undefined, dueDate: undefined }, { status: 'done' }, { status: 'reference' },
        { status: 'archived' }, { deletedAt: '2026-03-01' }, { purgedAt: '2026-03-01' },
        { cancelledAt: '2026-03-01' }, { relativeStartOffset: { amount: 1, unit: 'day' } },
        { relativeStartOffset: { amount: -1, unit: 'hour' } },
        { startTime: undefined, relativeStartOffset: { amount: -1, unit: 'day' } },
    ] as Partial<Task>[])('rejects invalid or nonactionable task %j', (patch) => {
        expect(canEditTimelineTaskDates(task(patch))).toBe(false);
        expect(planTimelineTaskDateEdit(task(patch), { kind: 'move', days: 1 })).toBeNull();
    });

    it('rejects fractional displacement and reversed resizes while allowing a timed start on a date-only due day', () => {
        expect(planTimelineTaskDateEdit(task(), { kind: 'move', days: 0.5 })).toBeNull();
        expect(planTimelineTaskDateEdit(task(), { kind: 'start', days: 4 })).toBeNull();
        expect(canEditTimelineTaskDates(task({ startTime: '2026-03-10T23:59:59', dueDate: '2026-03-10' }))).toBe(true);
    });

    it('preserves relative links for a move and due resize, clearing the link for a start resize', () => {
        const original = task({ startTime: '2026-03-08', relativeStartOffset: { amount: -2, unit: 'day' },
            recurrence: { rule: 'weekly', strategy: 'strict' } });
        expect(planTimelineTaskDateEdit(original, { kind: 'move', days: 1 })).toEqual({
            updates: { startTime: '2026-03-09', dueDate: '2026-03-11', relativeStartOffset: original.relativeStartOffset },
            effectiveDates: { start: '2026-03-09', due: '2026-03-11' },
        });
        expect(planTimelineTaskDateEdit(original, { kind: 'due', days: 1 })?.updates).toEqual({
            startTime: '2026-03-09', dueDate: '2026-03-11', relativeStartOffset: original.relativeStartOffset,
        });
        expect(planTimelineTaskDateEdit(original, { kind: 'start', days: 1 })?.updates).toEqual({
            startTime: '2026-03-09', relativeStartOffset: undefined,
        });
        expect(original.recurrence).toEqual({ rule: 'weekly', strategy: 'strict' });
    });

    it('requires an active parent for task editing and two explicit coherent dates for projects', () => {
        expect(canEditTimelineTaskDates(task({ projectId: 'project' }), project())).toBe(true);
        expect(canEditTimelineTaskDates(task({ projectId: 'project' }), project({ status: 'waiting' }))).toBe(false);
        for (const patch of [{ startDate: undefined }, { dueDate: undefined }, { dueDate: 'bad' },
            { startDate: '2026-03-11' }, { status: 'someday' }, { deletedAt: '2026-03-01' }, { cancelledAt: '2026-03-01' }] as Partial<Project>[]) {
            expect(canEditTimelineProjectDates(project(patch))).toBe(false);
            expect(planTimelineProjectDateEdit(project(patch), { kind: 'move', days: 1 })).toBeNull();
        }
        expect(planTimelineProjectDateEdit(project(), { kind: 'move', days: 1 })?.updates).toEqual({
            startDate: '2026-03-08', dueDate: '2026-03-11',
        });
        expect(planTimelineProjectDateEdit(project(), { kind: 'start', days: 1 })?.updates).toEqual({ startDate: '2026-03-08' });
        expect(planTimelineProjectDateEdit(project(), { kind: 'due', days: 1 })?.updates).toEqual({ dueDate: '2026-03-11' });
        expect(planTimelineProjectDateEdit(project(), { kind: 'due', days: -4 })).toBeNull();
    });
});
