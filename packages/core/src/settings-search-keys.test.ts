import { describe, expect, it } from 'vitest';

import { getEnglishI18nValue } from './i18n';
import {
    buildSettingsSearchResults,
    formatSettingsSearchPath,
    getSettingsSearchEntryKeys,
    getSettingsSearchPageEnglishText,
    matchSettingsSearchResults,
    resolveSettingsSearchI18nKey,
    SETTINGS_SEARCH_INDEX,
    SETTINGS_SEARCH_MOBILE_EXCLUSIONS,
    SETTINGS_SEARCH_PAGE_IDS,
    SETTINGS_SEARCH_PAGE_TITLE_KEYS,
    type SettingsSearchPageId,
} from './settings-search-keys';

const ALL_PAGE_IDS = SETTINGS_SEARCH_PAGE_IDS;
const ALL_KEYS = SETTINGS_SEARCH_INDEX.map((entry) => entry.key);

describe('settings search key roster', () => {
    it('resolves every page key (excluded or not) to a real English string', () => {


        const unresolved = ALL_KEYS.filter((key) => {
            const value = getEnglishI18nValue(resolveSettingsSearchI18nKey(key));
            return !value || !value.trim();
        });
        expect(unresolved).toEqual([]);
    });

    it('resolves every section and page title to a real English string', () => {
        const unresolved: string[] = [];
        for (const entry of SETTINGS_SEARCH_INDEX) {
            if (!entry.section) continue;
            const value = getEnglishI18nValue(resolveSettingsSearchI18nKey(entry.section));
            if (!value || !value.trim()) unresolved.push(entry.section);
        }
        for (const pageId of ALL_PAGE_IDS) {
            const value = getEnglishI18nValue(SETTINGS_SEARCH_PAGE_TITLE_KEYS[pageId]);
            if (!value || !value.trim()) unresolved.push(pageId);
        }
        expect(unresolved).toEqual([]);
    });

    it('has no stale exclusion-list entries', () => {
        const known = new Set(ALL_KEYS);
        for (const [key, reason] of Object.entries(SETTINGS_SEARCH_MOBILE_EXCLUSIONS)) {
            expect(known.has(key), `exclusion "${key}" is not a real page key`).toBe(true);
            expect(reason.trim().length > 0, `exclusion "${key}" needs a reason`).toBe(true);
        }
    });

    it('lists every setting once per page', () => {
        for (const pageId of ALL_PAGE_IDS) {
            const keys = getSettingsSearchEntryKeys(pageId);
            expect(new Set(keys).size, `page "${pageId}" repeats a key`).toBe(keys.length);
        }
    });


    function findUnaccountedKeys(
        keys: readonly string[],
        exclusions: Record<string, string>,
        resolve: (key: string) => string | undefined,
    ): string[] {
        return keys.filter((key) => !(key in exclusions) && !resolve(key));
    }

    it('every real page key is indexed or deliberately excluded', () => {
        for (const pageId of ALL_PAGE_IDS) {
            const unaccounted = findUnaccountedKeys(
                getSettingsSearchEntryKeys(pageId),
                SETTINGS_SEARCH_MOBILE_EXCLUSIONS,
                (key) => getEnglishI18nValue(resolveSettingsSearchI18nKey(key)),
            );
            expect(unaccounted, `page "${pageId}" has unaccounted keys`).toEqual([]);
        }
    });

    it('the coverage check actually fails on a key that is neither indexed nor excluded', () => {


        const fixtureKeys = ['knownGood', 'orphanKey'];
        const fixtureExclusions = {};
        const resolve = (key: string) => (key === 'knownGood' ? 'Known Good' : undefined);
        expect(findUnaccountedKeys(fixtureKeys, fixtureExclusions, resolve)).toEqual(['orphanKey']);


        expect(findUnaccountedKeys(fixtureKeys, { orphanKey: 'test fixture' }, resolve)).toEqual([]);
    });

    it('getSettingsSearchPageEnglishText drops excluded keys and returns real text', () => {
        const gtdText = getSettingsSearchPageEnglishText('gtd');
        expect(gtdText).toContain('Pomodoro timer');

        expect(getSettingsSearchPageEnglishText('main')).not.toContain('Keyboard shortcuts');
    });


    const english = buildSettingsSearchResults((key) => getEnglishI18nValue(key));

    function search(query: string): Array<{ title: string; page: SettingsSearchPageId; path: string }> {
        return matchSettingsSearchResults(english, query).map((result) => ({
            title: result.title,
            page: result.pageId,
            path: formatSettingsSearchPath(result),
        }));
    }

    it('finds both quick-add settings for "add", each with its page and section', () => {
        const results = search('add');
        expect(results).toContainEqual({
            title: 'Global quick add shortcut',
            page: 'main',
            path: 'General → Input',
        });
        expect(results).toContainEqual({
            title: 'Clean up quick add text',
            page: 'gtd',
            path: 'GTD → Default capture method',
        });
    });

    it('finds the default area setting for "area"', () => {
        expect(search('area')).toContainEqual({
            title: 'Default area for new tasks',
            page: 'gtd',
            path: 'GTD → Default capture method',
        });
    });

    it('finds the default project flow setting for "project"', () => {
        expect(search('project')).toContainEqual({
            title: 'Default project flow',
            page: 'gtd',
            path: 'GTD',
        });
    });

    it('does not advertise the retired time-estimate preset editor', () => {
        expect(ALL_KEYS).not.toContain('timeEstimatePresets');
    });

    it('finds regional overrides inside Regional formats', () => {
        for (const key of ['weekStart', 'dateFormat', 'timeFormat', 'calendarSystem']) {
            expect(SETTINGS_SEARCH_INDEX).toContainEqual({ pageId: 'main', key, section: 'regionalFormats' });
        }
    });

    it('finds keyboard and window preferences under Advanced', () => {
        for (const key of ['keybindings', 'windowDecorations', 'closeBehavior', 'showTray', 'launchAtStartup']) {
            expect(SETTINGS_SEARCH_INDEX).toContainEqual({ pageId: 'advanced', key, section: 'keyboardAndWindow' });
            expect(getSettingsSearchEntryKeys('main')).not.toContain(key);
        }
        expect(getSettingsSearchEntryKeys('main')).toContain('globalQuickAddShortcut');
    });

    it('indexes task editor autosave under the editor layout section, desktop-only', () => {
        expect(SETTINGS_SEARCH_INDEX).toContainEqual({ pageId: 'gtd', key: 'taskEditorAutosave', section: 'taskEditorLayout' });
        expect(SETTINGS_SEARCH_MOBILE_EXCLUSIONS).toHaveProperty('taskEditorAutosave');
        expect(search('automatically').map((result) => result.title)).toContain('Save edits automatically');
    });

    it('retains Timeline and AI/integration route identities', () => {
        expect(getSettingsSearchEntryKeys('gtd')).toContain('featureTimeline');
        expect(ALL_PAGE_IDS).toContain('ai');
        expect(ALL_PAGE_IDS).toContain('integrations');
    });

    it('ranks settings whose own name matches above ones that only share a page', () => {
        const titles = matchSettingsSearchResults(english, 'pomodoro').map((r) => r.title);
        expect(titles[0]).toBe('Pomodoro timer');
    });

    it('matches page synonyms, but only on the row that is the page itself', () => {
        const withSynonyms = buildSettingsSearchResults((key) => getEnglishI18nValue(key), {
            main: ['dark mode'],
        });
        const results = matchSettingsSearchResults(withSynonyms, 'dark mode');
        expect(results.map((r) => r.key)).toEqual(['general']);
    });

    it('returns nothing for an empty query', () => {
        expect(matchSettingsSearchResults(english, '   ')).toEqual([]);
    });
});
