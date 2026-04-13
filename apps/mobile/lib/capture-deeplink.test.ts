import { describe, expect, it } from 'vitest';
import { isShortcutCaptureUrl, parseShortcutCaptureUrl } from './capture-deeplink';

describe('capture-deeplink', () => {
    it('parses capture URLs with title, note, project, and tags', () => {
        expect(
            parseShortcutCaptureUrl(
                'mindwtr://capture?title=Buy%20groceries&note=From%20store&project=Shopping&tags=errands,%20home'
            )
        ).toEqual({
            title: 'Buy groceries',
            note: 'From store',
            project: 'Shopping',
            tags: ['errands', 'home'],
        });
    });

    it('accepts triple-slash form and fallback fields', () => {
        expect(parseShortcutCaptureUrl('mindwtr:///capture?text=Pay%20bill&description=Utility')).toEqual({
            title: 'Pay bill',
            note: 'Utility',
            tags: [],
        });
    });

    it('returns null for unsupported URLs', () => {
        expect(parseShortcutCaptureUrl('https://mindwtr.app/capture?title=Test')).toBeNull();
        expect(parseShortcutCaptureUrl('mindwtr://focus')).toBeNull();
        expect(parseShortcutCaptureUrl('mindwtr://capture?title=')).toBeNull();
    });

    it('trims values and drops empty tags', () => {
        expect(parseShortcutCaptureUrl('mindwtr://capture?title=%20Task%20&tags=%20alpha%20,%20,%20beta%20')).toEqual({
            title: 'Task',
            tags: ['alpha', 'beta'],
        });
    });

    it('detects capture routes even when the payload is invalid', () => {
        expect(isShortcutCaptureUrl('mindwtr://capture?title=')).toBe(true);
        expect(isShortcutCaptureUrl('mindwtr:///capture?note=Missing%20title')).toBe(true);
        expect(isShortcutCaptureUrl('mindwtr://focus')).toBe(false);
        expect(isShortcutCaptureUrl('https://mindwtr.app/capture?title=Test')).toBe(false);
    });
});
