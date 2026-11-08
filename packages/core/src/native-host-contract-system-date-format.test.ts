import { afterEach, describe, expect, it } from 'vitest';
import { configureDateFormatting, createDateFormatter, getDateFormattingConfig } from './date';
import { createNativeHostContract } from './native-host-contract';

describe('the native system date format', () => {
    afterEach(() => configureDateFormatting());

    it('applies the device short date pattern to the System date format as RN iOS does, and a rejected pattern falls back to the locale', async () => {
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const day = new Date(2031, 2, 12);
        const shown = (date: Date) => createDateFormatter(getDateFormattingConfig())(date, 'P');
        const before = shown(day);

        expect(host.setSystemDateFormat({ systemDateFormat: 'd.M.yyyy' })).toEqual({ ok: true, value: { systemDateFormat: 'd.M.yyyy' } });
        expect(getDateFormattingConfig().systemDateFormat).toBe('d.M.yyyy');
        expect(shown(day)).toBe('12.3.2031');

        expect(host.setSystemDateFormat({ systemDateFormat: 'yy/M/d' })).toEqual({ ok: true, value: { systemDateFormat: null } });
        expect(getDateFormattingConfig().systemDateFormat).toBeUndefined();
        expect(shown(day)).toBe(before);

        expect(host.setSystemDateFormat({ systemDateFormat: 7 } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});
