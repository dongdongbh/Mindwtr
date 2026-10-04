import { describe, expect, it } from 'vitest';
import { hasTranslatableEnglishText } from './locale-quality';

describe('mixed-English technical literals', () => {
    it('allows product names while preserving the check for surrounding prose', () => {
        expect(hasTranslatableEnglishText('Открыть Google Calendar на Android', 'settings.calendarDesc')).toBe(false);
        expect(hasTranslatableEnglishText('Открыть Google Calendar and choose a calendar', 'settings.calendarDesc')).toBe(true);
        expect(hasTranslatableEnglishText('Androidish', 'settings.calendarDesc')).toBe(true);
    });
    it('only allows parser fields in their documented help strings', () => {
        expect(hasTranslatableEnglishText('Операторы status: и project:', 'search.helpOperators')).toBe(false);
        expect(hasTranslatableEnglishText('status project', 'task.title')).toBe(true);
        expect(hasTranslatableEnglishText('status: choose project:', 'search.helpOperators')).toBe(true);
        expect(hasTranslatableEnglishText('projectile', 'search.helpOperators')).toBe(true);
    });
    it('preserves compound product names and the stricter English-mirror check', () => {
        expect(hasTranslatableEnglishText('Импорт Apple Reminders', 'onboarding.importDescMobile')).toBe(false);
        expect(hasTranslatableEnglishText('Apple Reminders')).toBe(true);
    });
});
