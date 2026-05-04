import { describe, expect, it } from 'vitest';
import { isQuickAddWindowLocation } from './quick-add-window';

describe('isQuickAddWindowLocation', () => {
    it('detects the dedicated quick add window query flag', () => {
        expect(isQuickAddWindowLocation({ search: '?quickAddWindow=1' })).toBe(true);
        expect(isQuickAddWindowLocation({ search: '?quickAddWindow=true' })).toBe(true);
    });

    it('ignores normal app locations', () => {
        expect(isQuickAddWindowLocation({ search: '' })).toBe(false);
        expect(isQuickAddWindowLocation({ search: '?quickAddWindow=0' })).toBe(false);
        expect(isQuickAddWindowLocation({ search: '?view=inbox' })).toBe(false);
    });
});
