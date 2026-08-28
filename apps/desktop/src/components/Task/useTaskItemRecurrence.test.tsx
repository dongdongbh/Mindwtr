import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTaskDraft, type Task } from '@mindwtr/core';

import { useTaskItemRecurrence } from './useTaskItemRecurrence';

const baseTask: Task = {
    id: 'task-1',
    title: 'Monthly check',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
};

describe('useTaskItemRecurrence', () => {
    it('anchors custom monthly recurrence controls to the start date when no due date is set', () => {
        const setField = vi.fn();
        const task: Task = {
            ...baseTask,
            startTime: '2026-06-04T09:00',
        };
        const { result } = renderHook(() => useTaskItemRecurrence({
            task,
            draft: {
                ...createTaskDraft(task),
                startTime: '2026-06-04T09:00',
                dueDate: '',
                recurrence: 'monthly',
                recurrenceRRule: '',
            },
            setField,
        }));

        act(() => {
            result.current.openCustomRecurrence();
        });

        expect(result.current.customMonthDays).toEqual([4]);
        expect(result.current.customWeekday).toBe('TH');

        act(() => {
            result.current.setCustomMode('nth');
        });
        act(() => {
            result.current.applyCustomRecurrence();
        });

        expect(setField).toHaveBeenCalledWith('recurrence', 'monthly');
        expect(setField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=MONTHLY;BYDAY=1TH');
    });

    it('emits BYMONTHDAY=-1 for the last-day choice and reopens with it selected', () => {
        const setField = vi.fn();
        const task: Task = { ...baseTask, dueDate: '2026-06-10' };
        const draft = {
            ...createTaskDraft(task),
            dueDate: '2026-06-10',
            recurrence: 'monthly' as const,
            recurrenceRRule: '',
        };
        const { result, rerender } = renderHook(
            (props: { recurrenceRRule: string }) => useTaskItemRecurrence({
                task,
                draft: { ...draft, recurrenceRRule: props.recurrenceRRule },
                setField,
            }),
            { initialProps: { recurrenceRRule: '' } },
        );

        act(() => {
            result.current.openCustomRecurrence();
        });
        act(() => {
            result.current.setCustomMode('lastDay');
        });
        act(() => {
            result.current.applyCustomRecurrence();
        });

        expect(setField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=MONTHLY;BYMONTHDAY=-1');

        rerender({ recurrenceRRule: 'FREQ=MONTHLY;BYMONTHDAY=-1' });
        act(() => {
            result.current.openCustomRecurrence();
        });

        expect(result.current.customMode).toBe('lastDay');
        // The day grid falls back to the anchor rather than clamping -1 to 1.
        expect(result.current.customMonthDays).toEqual([10]);
    });

    it('round-trips a multi-day month rule through the RRULE', () => {
        const setField = vi.fn();
        const task: Task = { ...baseTask, dueDate: '2026-06-01' };
        const draft = {
            ...createTaskDraft(task),
            dueDate: '2026-06-01',
            recurrence: 'monthly' as const,
            recurrenceRRule: '',
        };
        const { result, rerender } = renderHook(
            (props: { recurrenceRRule: string }) => useTaskItemRecurrence({
                task,
                draft: { ...draft, recurrenceRRule: props.recurrenceRRule },
                setField,
            }),
            { initialProps: { recurrenceRRule: '' } },
        );

        act(() => {
            result.current.openCustomRecurrence();
        });
        // Anchored on the 1st; adding the 16th out of order still emits a sorted list.
        act(() => {
            result.current.toggleCustomMonthDay(16);
        });
        expect(result.current.customMonthDays).toEqual([1, 16]);
        act(() => {
            result.current.applyCustomRecurrence();
        });

        expect(setField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=MONTHLY;BYMONTHDAY=1,16');

        rerender({ recurrenceRRule: 'FREQ=MONTHLY;BYMONTHDAY=1,16' });
        // The list is custom even though its first day equals the anchor day.
        expect(result.current.monthlyRecurrence.pattern).toBe('custom');
        act(() => {
            result.current.openCustomRecurrence();
        });
        expect(result.current.customMode).toBe('date');
        expect(result.current.customMonthDays).toEqual([1, 16]);
    });

    it('round-trips a mixed last-day and numbered-day rule', () => {
        const setField = vi.fn();
        const task: Task = { ...baseTask, dueDate: '2026-06-15' };
        const { result } = renderHook(() => useTaskItemRecurrence({
            task,
            draft: {
                ...createTaskDraft(task),
                dueDate: '2026-06-15',
                recurrence: 'monthly',
                recurrenceRRule: 'FREQ=MONTHLY;BYMONTHDAY=-1,15',
            },
            setField,
        }));

        act(() => {
            result.current.openCustomRecurrence();
        });

        expect(result.current.customMode).toBe('date');
        expect(result.current.customMonthDays).toEqual([-1, 15]);

        act(() => {
            result.current.applyCustomRecurrence();
        });

        expect(setField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=MONTHLY;BYMONTHDAY=-1,15');
    });

    it('ignores the toggle that would clear the last selected month day', () => {
        const setField = vi.fn();
        const task: Task = { ...baseTask, dueDate: '2026-06-01' };
        const { result } = renderHook(() => useTaskItemRecurrence({
            task,
            draft: {
                ...createTaskDraft(task),
                dueDate: '2026-06-01',
                recurrence: 'monthly' as const,
                recurrenceRRule: 'FREQ=MONTHLY;BYMONTHDAY=1,16',
            },
            setField,
        }));

        act(() => {
            result.current.openCustomRecurrence();
        });
        act(() => {
            result.current.toggleCustomMonthDay(16);
        });
        expect(result.current.customMonthDays).toEqual([1]);
        act(() => {
            result.current.toggleCustomMonthDay(1);
        });
        expect(result.current.customMonthDays).toEqual([1]);
    });
});
