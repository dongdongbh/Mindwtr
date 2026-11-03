import { describe, expect, it } from 'vitest';
import {
    isEntityOpenUrl,
    isOpenFeatureUrl,
    isShortcutCaptureUrl,
    parseEntityOpenUrl,
    parseOpenFeatureUrl,
    parseShortcutCaptureUrl,
    resolveOpenFeaturePath,
} from './capture-deeplink';

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

    it('accepts App Actions create-thing parameter names', () => {
        expect(parseShortcutCaptureUrl('mindwtr:///capture?name=Call%20dentist&description=Tomorrow')).toEqual({
            title: 'Call dentist',
            note: 'Tomorrow',
            tags: [],
        });
    });

    it('detects capture routes even when the payload is invalid', () => {
        expect(isShortcutCaptureUrl('mindwtr://capture?title=')).toBe(true);
        expect(isShortcutCaptureUrl('mindwtr:///capture?note=Missing%20title')).toBe(true);
        expect(isShortcutCaptureUrl('mindwtr://focus')).toBe(false);


        expect(isShortcutCaptureUrl('mindwtr:///capture-quick?mode=text')).toBe(false);
        expect(isOpenFeatureUrl('mindwtr:///capture-quick?mode=text')).toBe(false);
        expect(isShortcutCaptureUrl('https://mindwtr.app/capture?title=Test')).toBe(false);
    });

    it('parses and resolves App Actions open-feature URLs', () => {
        expect(isOpenFeatureUrl('mindwtr:///open-feature?feature=focus')).toBe(true);
        expect(parseOpenFeatureUrl('mindwtr:///open-feature?feature=waiting')).toEqual({ feature: 'waiting' });
        expect(resolveOpenFeaturePath('today')).toBe('/focus');
        expect(resolveOpenFeaturePath('someday')).toBe('/someday');
        expect(resolveOpenFeaturePath('unknown')).toBe('/inbox');
    });

    it('parses entity-open URLs for task, project, and area (#1017)', () => {
        expect(isEntityOpenUrl('mindwtr://open?task=abc-123')).toBe(true);
        expect(isEntityOpenUrl('mindwtr:///open?project=abc-123')).toBe(true);
        expect(isEntityOpenUrl('mindwtr://open-feature?feature=focus')).toBe(false);
        expect(isEntityOpenUrl('mindwtr://capture?title=x')).toBe(false);

        expect(parseEntityOpenUrl('mindwtr://open?task=abc-123')).toEqual({ kind: 'task', id: 'abc-123' });
        expect(parseEntityOpenUrl('mindwtr:///open?project=proj-1')).toEqual({ kind: 'project', id: 'proj-1' });
        expect(parseEntityOpenUrl('mindwtr://open?area=area-1')).toEqual({ kind: 'area', id: 'area-1' });
    });

    it('returns null for a malformed or empty entity-open URL', () => {
        expect(parseEntityOpenUrl('mindwtr://open')).toBeNull();
        expect(parseEntityOpenUrl('mindwtr://open?task=')).toBeNull();
        expect(parseEntityOpenUrl('https://mindwtr.app/open?task=abc-123')).toBeNull();
        expect(parseEntityOpenUrl('mindwtr://focus')).toBeNull();
    });
});
