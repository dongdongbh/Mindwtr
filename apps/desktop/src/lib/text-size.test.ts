import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    applyDesktopTextSize,
    coerceDesktopTextSize,
    DEFAULT_DESKTOP_TEXT_SIZE_MODE,
} from './text-size';

describe('text-size', () => {
    beforeEach(() => {
        document.documentElement.removeAttribute('data-text-size');
        document.documentElement.style.removeProperty('--mindwtr-text-scale');
    });

    afterEach(() => {
        document.documentElement.removeAttribute('data-text-size');
        document.documentElement.style.removeProperty('--mindwtr-text-scale');
    });

    it('coerces unknown values to the default preset', () => {
        expect(coerceDesktopTextSize('huge')).toBe(DEFAULT_DESKTOP_TEXT_SIZE_MODE);
        expect(coerceDesktopTextSize(null)).toBe(DEFAULT_DESKTOP_TEXT_SIZE_MODE);
    });

    it('applies the selected preset to the document root', () => {
        applyDesktopTextSize('extra-large');

        expect(document.documentElement.dataset.textSize).toBe('extra-large');
        expect(document.documentElement.style.getPropertyValue('--mindwtr-text-scale')).toBe('1.25');
    });
});
