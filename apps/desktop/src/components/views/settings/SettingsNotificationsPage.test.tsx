import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTaskStore } from '@mindwtr/core';

import { getEnglishSettingsLabels } from './labels';
import { SettingsNotificationsPage } from './SettingsNotificationsPage';

const t = getEnglishSettingsLabels();

describe('SettingsNotificationsPage', () => {
    afterEach(cleanup);
    it('offers independent Off-or-time fields without a separate enable switch', () => {
        useTaskStore.setState({ settings: { timeFormat: '24h' } });
        const updateSettings = vi.fn(async () => undefined);
        const props = { t, notificationsEnabled: true, startDateNotificationsEnabled: true, dueDateNotificationsEnabled: true,
            reviewAtNotificationsEnabled: true, weeklyReviewEnabled: false, weeklyReviewDay: 0, weeklyReviewTime: '18:00',
            weekdayOptions: [], dailyDigestMorningEnabled: false, dailyDigestEveningEnabled: false,
            dailyDigestMorningTime: '09:00', dailyDigestEveningTime: '20:00', updateSettings, showSaved: vi.fn() };
        const view = render(<SettingsNotificationsPage {...props} />);
        const start = screen.getByRole('textbox', { name: t.dateOnlyStartReminders });
        expect(start).toBeEnabled();
        expect(start).toHaveValue('');
        expect(start).toHaveAttribute('placeholder', t.dateOnlyReminderOff);
        expect(screen.queryByRole('switch', { name: t.dateOnlyStartReminders })).toBeNull();
        fireEvent.change(start, { target: { value: '07:15' } });
        expect(updateSettings).toHaveBeenCalledWith({ dateOnlyStartReminderTime: '07:15' });
        view.rerender(<SettingsNotificationsPage {...props} dateOnlyStartReminderTime="07:15" dateOnlyDueReminderTime="18:30" />);
        fireEvent.click(screen.getByRole('button', { name: `${t.dateOnlyStartReminders}: ${t.dateOnlyReminderOff}` }));
        expect(updateSettings).toHaveBeenCalledWith({ dateOnlyStartReminderTime: '' });
        expect(screen.getByRole('textbox', { name: t.dateOnlyDueReminders })).toHaveValue('18:30');
        view.rerender(<SettingsNotificationsPage {...props} notificationsEnabled={false} />);
        expect(screen.getByRole('textbox', { name: t.dateOnlyStartReminders })).toBeDisabled();
        expect(screen.getByRole('textbox', { name: t.dateOnlyDueReminders })).toBeDisabled();
    });

    it('keeps an enabled morning digest editable while task notifications are off', () => {
        const updateSettings = vi.fn(async () => undefined);

        render(
            <SettingsNotificationsPage
                t={t}
                notificationsEnabled={false}
                startDateNotificationsEnabled={false}
                dueDateNotificationsEnabled={false}
                reviewAtNotificationsEnabled={false}
                weeklyReviewEnabled={false}
                weeklyReviewDay={0}
                weeklyReviewTime="09:00"
                weekdayOptions={[{ value: 0, label: 'Sunday' }]}
                dailyDigestMorningEnabled
                dailyDigestEveningEnabled={false}
                dailyDigestMorningTime="08:00"
                dailyDigestEveningTime="18:00"
                updateSettings={updateSettings}
                showSaved={vi.fn()}
            />,
        );

        const defaultSelect = screen.getByRole('combobox', { name: t.taskReminderDefault });
        expect(defaultSelect).toBeEnabled();
        expect(defaultSelect).toHaveValue('send');
        fireEvent.change(defaultSelect, { target: { value: 'skip' } });
        expect(updateSettings).toHaveBeenCalledWith({ taskReminderDefault: 'skip' });

        const morningSwitch = screen.getByRole('switch', { name: t.dailyDigestMorning });
        expect(morningSwitch).toBeEnabled();
        expect(screen.getByRole('textbox', { name: t.dailyDigestMorning })).toBeEnabled();

        fireEvent.click(morningSwitch);

        expect(updateSettings).toHaveBeenCalledWith({ dailyDigestMorningEnabled: false });
    });
});
