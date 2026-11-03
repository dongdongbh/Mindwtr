import { afterEach, describe, expect, it } from 'vitest';
import { projectReviewPickerValue } from './project-details-presentation';


describe('projectReviewPickerValue', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    const ny = (day: string, opened: string) => {
        process.env.TZ = 'Asia/Tokyo';
        return projectReviewPickerValue(day, opened, 'America/New_York');
    };

    it('keeps the opened hour and minute and clears seconds and milliseconds, as RN Android does', () => {

        expect(ny('2026-11-20', '2026-10-04T21:23:37.456Z')).toBe('2026-11-20T22:23:00.000Z');
    });

    it('takes the standard offset after clocks are set back, as Java Calendar does', () => {

        expect(ny('2026-11-01', '2026-10-04T07:30:00.000Z')).toBe('2026-11-01T08:30:00.000Z');
    });

    it('resolves a repeated hour (clocks set back) to its later instant, as Java Calendar does', () => {

        expect(ny('2026-11-01', '2026-10-04T05:30:12.000Z')).toBe('2026-11-01T06:30:00.000Z');
    });

    it('moves a skipped hour (clocks set forward) forward, as lenient Java Calendar does', () => {

        expect(ny('2026-03-08', '2026-10-04T06:30:00.000Z')).toBe('2026-03-08T07:30:00.000Z');

        expect(ny('2026-03-08', '2026-10-04T07:30:00.000Z')).toBe('2026-03-08T07:30:00.000Z');
    });

    it('refuses a malformed day, instant or zone', () => {
        expect(projectReviewPickerValue('2026-3-8', '2026-10-04T06:30:00.000Z', 'America/New_York')).toBeNull();
        expect(projectReviewPickerValue('2026-03-08', 'not a date', 'America/New_York')).toBeNull();
        expect(projectReviewPickerValue('2026-03-08', '2026-10-04T06:30:00.000Z', 'Not/AZone')).toBeNull();
    });
});
