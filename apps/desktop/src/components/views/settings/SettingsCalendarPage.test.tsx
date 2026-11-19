import { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { getEnglishSettingsLabels } from './labels';
import { SettingsCalendarPage } from './SettingsCalendarPage';
import { buildDesktopSettingsSearchResults, expandSettingsSection, findSettingsRow } from './settings-search';

const baseProps = {
    t: getEnglishSettingsLabels(),
    newCalendarName: '',
    newCalendarUrl: '',
    calendarError: null,
    externalCalendars: [],
    showSystemCalendarSection: false,
    systemCalendarPermission: 'unsupported' as const,
    calendarPushEnabled: false,
    calendarPushTargetCalendarId: null,
    calendarPushTargets: [],
    calendarPushLoading: false,
    onCalendarNameChange: vi.fn(),
    onCalendarUrlChange: vi.fn(),
    onAddCalendar: vi.fn(),
    onToggleCalendar: vi.fn(),
    onCalendarColorChange: vi.fn(),
    onRemoveCalendar: vi.fn(),
    onRequestSystemCalendarPermission: vi.fn(),
    onToggleCalendarPush: vi.fn(),
    onCalendarPushTargetChange: vi.fn(),
    onRefreshCalendarPushTargets: vi.fn(),
    maskCalendarUrl: (url: string) => url,
};

const workCalendar = {
    id: 'work',
    name: 'Work',
    url: 'https://calendar.example/work.ics',
    enabled: true,
    color: '#2563EB',
};

describe('SettingsCalendarPage', () => {
    it('links to the calendar integration guide in the docs site', () => {
        const { getByRole, queryByRole } = render(<SettingsCalendarPage {...baseProps} />);

        const external = getByRole('button', { name: /^External calendars/ });
        expect(external).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('link', { name: /Calendar integration guide/ })).not.toBeInTheDocument();
        fireEvent.click(external);

        expect(getByRole('link', { name: /Calendar integration guide/ })).toHaveAttribute(
            'href',
            'https://docs.mindwtr.app/use/calendar-integration',
        );

        expect(queryByRole('button', { name: 'Choose local .ics file' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: /^System calendar/ })).not.toBeInTheDocument();
    });

    it('offers a local ICS file picker when available', () => {
        const onChooseLocalCalendarFile = vi.fn();
        const { getByRole } = render(
            <SettingsCalendarPage
                {...baseProps}
                onChooseLocalCalendarFile={onChooseLocalCalendarFile}
            />,
        );

        fireEvent.click(getByRole('button', { name: /^External calendars/ }));
        fireEvent.click(getByRole('button', { name: 'Choose local .ics file' }));

        expect(onChooseLocalCalendarFile).toHaveBeenCalledTimes(1);
    });

    it('does not offer a permission action when system calendars are unsupported', () => {
        const { getByRole, getByText, queryByRole } = render(
            <SettingsCalendarPage
                {...baseProps}
                showSystemCalendarSection
                systemCalendarPermission="unsupported"
            />,
        );

        const system = getByRole('button', { name: /^System calendar/ });
        expect(system).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(system);
        expect(getByText(/System calendar access: Unsupported/)).toBeInTheDocument();
        expect(queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
    });

    it('shows calendar errors while the external calendar card is collapsed', () => {
        const { getByRole, rerender } = render(<SettingsCalendarPage {...baseProps} showSystemCalendarSection />);
        fireEvent.click(getByRole('button', { name: /^System calendar/ }));
        rerender(
            <SettingsCalendarPage
                {...baseProps}
                showSystemCalendarSection
                calendarError="Couldn't load calendar targets."
            />,
        );

        expect(getByRole('button', { name: /^External calendars/ })).toHaveAttribute('aria-expanded', 'false');
        expect(getByRole('alert')).toHaveTextContent("Couldn't load calendar targets.");
    });

    it('changes an external calendar color from the swatches', () => {
        const onCalendarColorChange = vi.fn();
        const { getByRole } = render(
            <SettingsCalendarPage
                {...baseProps}
                externalCalendars={[workCalendar]}
                onCalendarColorChange={onCalendarColorChange}
            />,
        );

        fireEvent.click(getByRole('button', { name: /^External calendars/ }));
        fireEvent.click(getByRole('button', { name: 'Work #7C3AED' }));
        expect(onCalendarColorChange).toHaveBeenCalledWith('work', '#7C3AED');
    });

    it('keeps the feed and setup together and preserves edits when the card closes', () => {
        function CalendarSettings() {
            const [name, setName] = useState('');
            const [url, setUrl] = useState('');
            const [enabled, setEnabled] = useState(true);

            return (
                <SettingsCalendarPage
                    {...baseProps}
                    newCalendarName={name}
                    newCalendarUrl={url}
                    externalCalendars={[{ ...workCalendar, enabled }]}
                    onCalendarNameChange={setName}
                    onCalendarUrlChange={setUrl}
                    onToggleCalendar={(_id, checked) => setEnabled(checked)}
                    maskCalendarUrl={() => 'calendar.example/…'}
                />
            );
        }

        const { getByRole, getByText, queryByRole } = render(<CalendarSettings />);
        const external = getByRole('button', { name: /^External calendars/ });
        fireEvent.click(external);
        expect(getByRole('listitem')).toContainElement(getByText('calendar.example/…'));
        fireEvent.change(getByRole('textbox', { name: 'Name' }), { target: { value: 'Personal' } });
        fireEvent.change(getByRole('textbox', { name: 'ICS URL' }), { target: { value: 'https://example.test/private.ics' } });
        fireEvent.click(getByRole('checkbox', { name: 'Work' }));

        fireEvent.click(external);
        expect(queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
        expect(queryByRole('listitem')).not.toBeInTheDocument();

        fireEvent.click(external);
        expect(getByRole('textbox', { name: 'Name' })).toHaveValue('Personal');
        expect(getByRole('textbox', { name: 'ICS URL' })).toHaveValue('https://example.test/private.ics');
        expect(getByRole('checkbox', { name: 'Work' })).not.toBeChecked();
    });

    it.each(['calendarName', 'calendarUrl', 'calendarChooseLocalFile', 'calendarPushTitle', 'calendarPushTarget'])(
        'reveals the calendar setting %s from search',
        (key) => {
            render(
                <SettingsCalendarPage
                    {...baseProps}
                    onChooseLocalCalendarFile={vi.fn()}
                    showSystemCalendarSection
                    systemCalendarPermission="granted"
                    calendarPushEnabled
                />,
            );
            const result = buildDesktopSettingsSearchResults((label) => label)
                .find((entry) => entry.pageId === 'integrations' && entry.key === key);
            expect(result).toBeDefined();
            expect(findSettingsRow(key)).toBeNull();
            act(() => {
                expect(expandSettingsSection(result?.sectionKey)).toBe(true);
            });
            expect(findSettingsRow(key)).toBeVisible();
        },
    );

    it.each(['calendar', 'externalCalendars'])('opens the configured feed list from the %s search result', (key) => {
        const { getByRole, queryByRole } = render(<SettingsCalendarPage {...baseProps} externalCalendars={[workCalendar]} />);
        const result = buildDesktopSettingsSearchResults((label) => label)
            .find((entry) => entry.pageId === 'integrations' && entry.key === key);

        expect(queryByRole('list')).not.toBeInTheDocument();
        act(() => {
            expect(expandSettingsSection(result?.sectionKey)).toBe(true);
        });
        expect(getByRole('listitem')).toHaveTextContent('Work');
        expect(findSettingsRow(key)).toBeVisible();
    });
});
