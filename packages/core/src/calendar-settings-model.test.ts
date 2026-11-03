import { describe, expect, it } from 'vitest';
import type { CalendarPushTargetCalendar } from './calendar-push-service';
import {
    buildCalendarPushTargetChoices,
    calendarSettingsToasts,
    keptPushTargetEvents,
    maskCalendarFeedUrl,
    planCalendarPushColor,
    setCalendarFeedColor,
} from './calendar-settings-model';
import { getTranslator } from './i18n';
import { loadTranslations } from './i18n/i18n-loader';

describe('Settings › Calendar rules', () => {
    it('shows a subscription URL as its scheme and host only: never a user name, a password or the path', () => {
        expect(maskCalendarFeedUrl('https://alex:s3cret@calendar.example.com/team/basic.ics')).toBe('https://calendar.example.com/...');
        expect(maskCalendarFeedUrl('user@calendar.example.com/private/feed')).toBe('calendar.example.com/...');
        expect(maskCalendarFeedUrl(' https://calendar.example.com/team/basic.ics ')).toBe('https://calendar.example.com/...');

        expect(maskCalendarFeedUrl('https://calendar.example.com/ical/a1b2c3d4e5f6/basic.ics')).not.toMatch(/basic|ics|e5f6/);
        expect(maskCalendarFeedUrl('https://calendar.example.com?token=abcdef')).toBe('https://calendar.example.com/...');
        expect(maskCalendarFeedUrl('https://calendar.example.com')).toBe('https://calendar.example.com');
        expect(maskCalendarFeedUrl('content://com.android.providers.downloads.documents/document/42')).toBe('content://com.android.providers.downloads.documents/...');
        expect(maskCalendarFeedUrl('webcal://alex:s3cret@h')).toBe('webcal://h');
        expect(maskCalendarFeedUrl('webcal://alex:s3cret@calendar.example.com/team.ics')).toBe('webcal://calendar.example.com/...');
    });

    it('writes nothing when a color is picked again', () => {
        const feeds = [{ id: 'team', name: 'Team', url: 'https://example.com/team.ics', enabled: true, color: '#059669' }, { id: 'auto', name: 'Auto', url: 'https://example.com/auto.ics', enabled: true }];
        expect(setCalendarFeedColor(feeds, 'team', '#059669')).toBeNull();
        expect(setCalendarFeedColor(feeds, 'auto', undefined)).toBeNull();
        expect(setCalendarFeedColor(feeds, 'team', '#2563eb')?.[0]).toMatchObject({ color: '#2563EB' });
        expect(setCalendarFeedColor(feeds, 'team', undefined)?.[0]).not.toHaveProperty('color');

        expect(planCalendarPushColor('#059669', '#059669')).toBeNull();
        expect(planCalendarPushColor('#7c3aed', '#7C3AED')).toBeNull();
        expect(planCalendarPushColor('#3B82F6', '#059669')).toBe('#059669');
    });

    it('says where the Mindwtr calendar is: an account on Android, the local source on iOS, or where it already is', async () => {
        await loadTranslations('en');
        const t = getTranslator('en');
        const shared: CalendarPushTargetCalendar = { id: 'work', name: 'Work', sourceName: 'alex@gmail.com', isMindwtrDedicated: false, isMindwtrManaged: false, isLocalOnly: false };
        const managed = (isLocalOnly: boolean): CalendarPushTargetCalendar => ({
            id: 'made', name: 'Mindwtr', sourceName: isLocalOnly ? 'local account' : 'alex@gmail.com', isMindwtrDedicated: true, isMindwtrManaged: true, isLocalOnly,
        });
        const first = (platform: string, targets: CalendarPushTargetCalendar[]) => {
            const choices = buildCalendarPushTargetChoices({ targets, targetId: null, color: '#3B82F6', tr: t, platform });
            return [choices.options[0].description, choices.localHint];
        };

        expect(first('android', [shared])).toEqual(['Dedicated account calendar', false]);
        expect(first('ios', [shared])).toEqual(['Dedicated local calendar', true]);
        expect(first('android', [managed(false), shared])).toEqual(['Dedicated account calendar · alex@gmail.com', false]);
        expect(first('android', [managed(true), shared])).toEqual(['Dedicated local calendar · local account', true]);
    });

    it('says the pushed events stay when Delete leaves the chosen calendar', async () => {
        await loadTranslations('en');
        const t = getTranslator('en');
        const toasts = calendarSettingsToasts((key) => t(key), t);
        expect(keptPushTargetEvents(null, null)).toBe(false);
        expect(keptPushTargetEvents('made', null)).toBe(false);
        expect(keptPushTargetEvents('work', 'work')).toBe(true);
        expect(toasts.mindwtrCalendarDeleted(false).message).toBe('The Mindwtr calendar and all its events have been removed.');
        expect(toasts.mindwtrCalendarDeleted(true).message).toBe('The Mindwtr calendar was removed. Events already pushed to the calendar you chose stay there.');
        expect(toasts.pushColorFailed()).toEqual({ title: 'Error', message: 'The Mindwtr calendar color could not be changed. Try again.', tone: 'warning', durationMs: 4200 });
    });
});
