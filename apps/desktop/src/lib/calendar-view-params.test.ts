import { describe, expect, it } from 'vitest';

import { stageCalendarDropLanding } from './calendar-view-params';

const setUrl = (search: string) => window.history.replaceState({}, '', `/${search}`);
const params = () => new URLSearchParams(window.location.search);


const NOW = new Date(2026, 6, 25);

describe('stageCalendarDropLanding', () => {


    it('rescues schedule mode to week', () => {
        setUrl('?calendarView=schedule&calendarDate=2026-01-05&calendarMonth=2026-01');

        stageCalendarDropLanding(NOW);

        expect(params().get('calendarView')).toBe('week');
        expect(params().get('calendarDate')).toBe('2026-07-25');
        expect(params().get('calendarMonth')).toBe('2026-07');
    });

    it.each(['day', 'week'])('keeps %s mode but lands on today', (mode) => {
        setUrl(`?calendarView=${mode}&calendarDate=2026-01-05&calendarMonth=2026-01`);

        stageCalendarDropLanding(NOW);

        expect(params().get('calendarView')).toBe(mode);
        expect(params().get('calendarDate')).toBe('2026-07-25');
        expect(params().get('calendarMonth')).toBe('2026-07');
    });


    it('keeps month mode on the current month without selecting a day', () => {
        setUrl('?calendarView=month&calendarDate=2026-01-05&calendarMonth=2026-01');

        stageCalendarDropLanding(NOW);

        expect(params().get('calendarView')).toBe('month');
        expect(params().get('calendarMonth')).toBe('2026-07');
        expect(params().get('calendarDate')).toBeNull();
    });

    it('leaves a calendar that was never opened on its default month', () => {
        setUrl('?');

        stageCalendarDropLanding(NOW);

        expect(params().get('calendarView')).toBeNull();
        expect(params().get('calendarMonth')).toBe('2026-07');
        expect(params().get('calendarDate')).toBeNull();
    });
});
