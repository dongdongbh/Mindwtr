import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const languageMocks = vi.hoisted(() => ({
    t: vi.fn((key: string) => key),
}));

const calendarMocks = vi.hoisted(() => ({
    getCalendars: vi.fn(async () => []),
    setCalendars: vi.fn(async () => undefined),
}));

vi.mock('../../../contexts/language-context', () => ({
    useLanguage: () => ({ t: languageMocks.t, language: 'fr' }),
}));

vi.mock('../../../lib/external-calendar-service', () => ({
    ExternalCalendarService: calendarMocks,
}));

import { useCalendarSettings } from './useCalendarSettings';

describe('useCalendarSettings feedback localization', () => {
    it('defers calendar IO until enabled and retains the editor on rerender', async () => {
        const { result, rerender } = renderHook(({ loadEnabled }) => useCalendarSettings({
            loadEnabled,
            settings: {},
            updateSettings: vi.fn(async () => undefined),
            showSaved: vi.fn(),
            supportsSystemCalendar: false,
        }), { initialProps: { loadEnabled: false } });
        expect(calendarMocks.getCalendars).not.toHaveBeenCalled();
        rerender({ loadEnabled: true });
        await waitFor(() => expect(calendarMocks.getCalendars).toHaveBeenCalledTimes(1));
        act(() => result.current.onCalendarUrlChange('https://example.com/draft.ics'));
        rerender({ loadEnabled: true });
        expect(calendarMocks.getCalendars).toHaveBeenCalledTimes(1);
        expect(result.current.newCalendarUrl).toBe('https://example.com/draft.ics');
    });

    beforeEach(() => {
        vi.clearAllMocks();
        languageMocks.t.mockImplementation((key: string) => (
            key === 'settings.calendar.invalidSource'
                ? 'Utilisez une adresse de calendrier valide.'
                : key
        ));
    });

    it('uses the active locale for validation feedback', async () => {
        const { result } = renderHook(() => useCalendarSettings({
            settings: {},
            updateSettings: vi.fn(async () => undefined),
            showSaved: vi.fn(),
            supportsSystemCalendar: false,
        }));
        await waitFor(() => expect(calendarMocks.getCalendars).toHaveBeenCalled());

        act(() => result.current.onCalendarUrlChange('not-a-calendar-url'));
        act(() => result.current.onAddCalendar());

        expect(result.current.calendarError).toBe('Utilisez une adresse de calendrier valide.');
    });
});
