import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import {
    InboxProcessingScheduleFields,
    type InboxProcessingScheduleFieldControl,
    type InboxProcessingScheduleFieldsControls,
} from './InboxProcessingScheduleFields';

const t = (key: string) => {
    const labels: Record<string, string> = {
        'common.clear': 'Clear',
        'taskEdit.startDateLabel': 'Start Date',
        'taskEdit.dueDateLabel': 'Due Date',
        'taskEdit.reviewDateLabel': 'Review Date',
        'taskEdit.dateOnly': 'Date only',
        'task.aria.startTime': 'Start time',
        'task.aria.dueTime': 'Due time',
        'task.aria.reviewTime': 'Review time',
    };
    return labels[key] ?? key;
};

const createField = (
    overrides: Partial<InboxProcessingScheduleFieldControl> = {}
): InboxProcessingScheduleFieldControl => ({
    date: '',
    timeDraft: '',
    hasTime: false,
    onDateChange: vi.fn(),
    onTimeDraftChange: vi.fn(),
    onTimeCommit: vi.fn(),
    onClear: vi.fn(),
    onDateOnly: vi.fn(),
    ...overrides,
});

const createControls = (
    overrides: Partial<InboxProcessingScheduleFieldsControls> = {}
): InboxProcessingScheduleFieldsControls => ({
    start: createField(),
    due: createField(),
    review: createField(),
    ...overrides,
});

afterEach(() => {
    cleanup();
});

describe('InboxProcessingScheduleFields date-only control', () => {
    it('strips the time when the date-only button is clicked', () => {
        const onDateOnly = vi.fn();
        const fields = createControls({
            due: createField({ date: '2026-04-19', timeDraft: '11:45', hasTime: true, onDateOnly }),
        });

        const { getByRole } = render(
            <LanguageProvider>
                <InboxProcessingScheduleFields t={t} fields={fields} visibleFieldKeys={['due']} />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('button', { name: 'Date only: Due Date' }));

        expect(onDateOnly).toHaveBeenCalledTimes(1);
    });

    it('hides the date-only button when the field has no time', () => {
        const fields = createControls({
            due: createField({ date: '2026-04-19', timeDraft: '', hasTime: false }),
        });

        const { queryByRole } = render(
            <LanguageProvider>
                <InboxProcessingScheduleFields t={t} fields={fields} visibleFieldKeys={['due']} />
            </LanguageProvider>
        );

        expect(queryByRole('button', { name: 'Date only: Due Date' })).toBeNull();
    });
});

describe('InboxProcessingScheduleFields calendar system', () => {
    const originalSettings = useTaskStore.getState().settings;
    const originalLanguages = navigator.languages;

    afterEach(() => {


        cleanup();
        useTaskStore.setState({ settings: originalSettings });
        Object.defineProperty(navigator, 'languages', {
            value: originalLanguages,
            configurable: true,
        });
    });

    it('renders Jalali dates when the calendarSystem setting is jalali', () => {


        Object.defineProperty(navigator, 'languages', {
            value: ['fa-IR'],
            configurable: true,
        });
        useTaskStore.setState({
            settings: { ...useTaskStore.getState().settings, calendarSystem: 'jalali' },
        });
        const fields = createControls({ due: createField({ date: '2026-04-19' }) });

        const { getByLabelText } = render(
            <LanguageProvider>
                <InboxProcessingScheduleFields t={t} fields={fields} visibleFieldKeys={['due']} />
            </LanguageProvider>
        );

        expect((getByLabelText('Due Date') as HTMLInputElement).value).toBe('1405-01-30');
    });

    it('renders Gregorian dates by default', () => {
        const fields = createControls({ due: createField({ date: '2026-04-19' }) });

        const { getByLabelText } = render(
            <LanguageProvider>
                <InboxProcessingScheduleFields t={t} fields={fields} visibleFieldKeys={['due']} />
            </LanguageProvider>
        );

        expect((getByLabelText('Due Date') as HTMLInputElement).value).not.toBe('1405-01-30');
    });
});
