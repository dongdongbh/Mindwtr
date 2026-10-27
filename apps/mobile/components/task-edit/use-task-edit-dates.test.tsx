import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting } from '@mindwtr/core';
import { createTaskDraft } from '@mindwtr/core/task-draft';

import { useTaskEditDates } from './use-task-edit-dates';

const t = (key: string) => ({
    'common.notSet': 'Not set',
}[key] ?? key);

afterEach(() => {
    configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
});

function DateFormatterProbe({ startDate, dueDate }: { startDate: string; dueDate: string }) {
    const { formatDate, formatDueDate } = useTaskEditDates({
        draft: null,
        pendingDueDate: null,
        pendingStartDate: null,
        setDraftField: vi.fn(),
        setPendingDueDate: vi.fn(),
        setPendingStartDate: vi.fn(),
        setShowDatePicker: vi.fn(),
        showDatePicker: null,
        t,
    });

    return <Text>{`${formatDate(startDate)}|${formatDueDate(dueDate)}`}</Text>;
}

describe('useTaskEditDates', () => {
    it('formats task edit dates with the configured app date and time format', () => {
        configureDateFormatting({ language: 'en', dateFormat: 'ymd', timeFormat: '24h', systemLocale: 'en-US' });

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <DateFormatterProbe
                    startDate="2026-06-05T09:30:00"
                    dueDate="2026-06-05T17:00:00"
                />
            );
        });

        expect(tree.root.findByType(Text).props.children).toBe('2026-06-05 09:30|2026-06-05 17:00');
    });

    it('writes a picked review time on the review day as local wall time (#1465)', () => {
        const setDraftField = vi.fn();
        const setShowDatePicker = vi.fn();
        let onDateChange!: ReturnType<typeof useTaskEditDates>['onDateChange'];
        function Probe() {
            ({ onDateChange } = useTaskEditDates({
                draft: createTaskDraft({ id: 't', title: 'T', status: 'next', tags: [], contexts: [], reviewAt: '2026-04-28', createdAt: '', updatedAt: '' }),
                pendingDueDate: null,
                pendingStartDate: null,
                setDraftField,
                setPendingDueDate: vi.fn(),
                setPendingStartDate: vi.fn(),
                setShowDatePicker,
                showDatePicker: 'review-time',
                t,
            }));
            return null;
        }
        act(() => { renderer.create(<Probe />); });

        act(() => { onDateChange({ type: 'set' } as never, new Date(2026, 0, 2, 14, 30)); });
        expect(setDraftField).toHaveBeenCalledWith('reviewAt', '2026-04-28T14:30');
    });
});
