import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { getEnglishSettingsLabels } from './labels';
import { SettingsNotificationsPage } from './SettingsNotificationsPage';

const t = getEnglishSettingsLabels();

describe('SettingsNotificationsPage', () => {
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
