import { describe, expect, it } from 'vitest';
import {
    getEnglishI18nValue,
    resolveSettingsSearchI18nKey,
    SETTINGS_SEARCH_INDEX,
    SETTINGS_SEARCH_MOBILE_EXCLUSIONS,
} from '@mindwtr/core';

import {
    buildSettingsMenuSearchText,
    findSettingsMenuMatch,
    normalizeSettingsScreen,
    SETTINGS_MENU_KEYWORD_KEYS,
    settingsMenuMatchesQuery,
    type SettingsMenuRowId,
} from './settings.constants';


const t = (key: string): string => getEnglishI18nValue(key) ?? key;

const ROW_TITLE_KEY: Record<SettingsMenuRowId, string> = {
    general: 'settings.general',
    gtd: 'settings.gtd',
    manage: 'settings.manage',
    notifications: 'settings.notifications',
    sync: 'settings.sync',
    data: 'settings.data',
    advanced: 'settings.advanced',
    about: 'settings.about',
};
const ROW_IDS = Object.keys(ROW_TITLE_KEY) as SettingsMenuRowId[];

function visibleRowIds(query: string): SettingsMenuRowId[] {
    return ROW_IDS.filter((id) =>
        settingsMenuMatchesQuery(buildSettingsMenuSearchText(id, t(ROW_TITLE_KEY[id]), undefined, t), query),
    );
}


const PREVIOUS_SETTINGS_MENU_KEYWORD_KEYS: Record<SettingsMenuRowId, readonly string[]> = {
    general: [
        'settings.appearance', 'settings.theme', 'settings.language', 'settings.weekStart',
        'settings.dateFormat', 'settings.timeFormat', 'settings.calendarSystem',
        'settings.mobile.showTaskAge', 'settings.mobile.appLock', 'settings.privacy',
    ],
    gtd: [
        'settings.features', 'settings.featurePomodoro', 'settings.gtdMobile.pomodoroSettings',
        'settings.autoArchive', 'settings.taskEditorLayout',
        'settings.captureDefault', 'settings.inboxProcessing', 'settings.gtdMobile.defaultScheduleTime',
        'settings.focusTaskLimit', 'settings.defaultProjectFlowMode', 'settings.defaultArea',
        'settings.weeklyReviewConfig', 'settings.dailyReviewConfig',
        'settings.naturalLanguageDates',
    ],
    manage: ['settings.manage', 'areas.manage', 'contexts.title', 'tags.title', 'settings.unassignedAreaColor'],
    notifications: [
        'settings.notifications', 'settings.dailyDigest', 'settings.weeklyReview',
        'settings.dueDateNotifications', 'settings.startDateNotifications', 'settings.persistentCaptureLabel',
    ],
    sync: [
        'settings.sync', 'settings.syncBackend', 'settings.syncBackendWebdav',
        'settings.cloudProviderDropbox', 'settings.syncHistory', 'settings.recoverySnapshots',
    ],
    data: [
        'settings.data', 'settings.backup', 'settings.exportBackup', 'settings.syncMobile.restoreBackup',
        'settings.syncMobile.importFromTodoist', 'settings.syncMobile.importFromTicktick',
        'settings.syncMobile.importFromDgtGtd', 'settings.syncMobile.importFromOmnifocus',
        'settings.diagnostics', 'settings.debugLogging',
    ],
    advanced: [
        'settings.advanced', 'settings.ai', 'settings.aiProvider', 'settings.aiModel', 'settings.aiApiKey',
        'settings.aiProviderOpenAI', 'settings.aiProviderAnthropic', 'settings.aiProviderGemini',
        'settings.calendar', 'settings.calendarMobile.icsSubscriptions',
    ],
    about: ['settings.about', 'settings.changelog', 'settings.checkForUpdates', 'settings.documentation'],
};

describe('settings menu search index', () => {
    it('finds Gmail capture under the GTD capture settings', () => {
        expect(visibleRowIds('Gmail')).toContain('gtd');
        expect(SETTINGS_SEARCH_MOBILE_EXCLUSIONS).not.toHaveProperty('gmailCapture');
        expect(SETTINGS_SEARCH_MOBILE_EXCLUSIONS).not.toHaveProperty('gmailCaptureLabel');
    });
    it('redirects retired preset-editor links to the GTD summary', () => {
        expect(normalizeSettingsScreen('gtd-time-estimates')).toBe('gtd');
        expect(normalizeSettingsScreen('gtd-task-editor')).toBe('gtd-task-editor');
        expect(normalizeSettingsScreen('unknown')).toBe('main');
    });


    it('every keyword key resolves to a real English translation', () => {
        const unresolved: string[] = [];
        for (const keys of Object.values(SETTINGS_MENU_KEYWORD_KEYS)) {
            for (const key of keys) {
                const value = getEnglishI18nValue(key);
                if (!value || value === key) unresolved.push(key);
            }
        }
        expect(unresolved).toEqual([]);
    });


    it('the new derived roster is a superset of every previously indexed key', () => {
        for (const row of ROW_IDS) {
            const previous = PREVIOUS_SETTINGS_MENU_KEYWORD_KEYS[row];
            const current = new Set(SETTINGS_MENU_KEYWORD_KEYS[row]);
            const dropped = previous.filter((key) => !current.has(key));
            expect(dropped, `row "${row}" lost keys`).toEqual([]);
        }
    });


    it('every available desktop settings-search key is discoverable somewhere on mobile', () => {
        const mobileTexts = new Set(
            Object.values(SETTINGS_MENU_KEYWORD_KEYS)
                .flat()
                .map((key) => getEnglishI18nValue(key))
                .filter((value): value is string => Boolean(value)),
        );
        const missing: string[] = [];
        for (const entry of SETTINGS_SEARCH_INDEX) {
            if (entry.key in SETTINGS_SEARCH_MOBILE_EXCLUSIONS) continue;


            if (entry.key === 'backgroundSync') continue;
            const text = getEnglishI18nValue(resolveSettingsSearchI18nKey(entry.key));
            if (text && !mobileTexts.has(text)) missing.push(`${entry.key} -> "${text}"`);
        }
        expect(missing).toEqual([]);
    });

    it('surfaces the right row for real setting labels and hides unrelated rows', () => {

        expect(visibleRowIds('pomodoro')).toEqual(['gtd']);

        expect(visibleRowIds('todoist')).toEqual(['data']);
        expect(visibleRowIds('ticktick')).toEqual(['data']);
        expect(visibleRowIds('omnifocus')).toEqual(['data']);

        expect(visibleRowIds('areas')).toEqual(['manage']);

        expect(visibleRowIds('anthropic')).toEqual(['advanced']);
        expect(visibleRowIds('official website')).toEqual(['about']);
    });


    it('finds the settings this task discovered were missing from the mobile index', () => {
        expect(visibleRowIds('clean up quick add')).toEqual(['gtd']);
        expect(visibleRowIds('editor typing help')).toEqual(['gtd']);


        expect(visibleRowIds('expose to system search')).toEqual(['general']);
    });

    it('does not navigate to the removed mobile background-sync interval card', () => {
        expect(visibleRowIds('background sync')).toEqual([]);
        expect(visibleRowIds('sync history')).toEqual(['sync']);
    });

    it('shows every row for an empty or whitespace query', () => {
        expect(visibleRowIds('')).toEqual(ROW_IDS);
        expect(visibleRowIds('   ')).toEqual(ROW_IDS);
    });

    it('drops keys with no translation instead of leaking raw keys into the text', () => {
        const text = buildSettingsMenuSearchText('gtd', t('settings.gtd'), undefined, t);
        expect(text).not.toContain('settings.');
        expect(text).toContain('pomodoro timer');
    });


    it('reports which setting matched a row and where it lives', () => {
        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, 'clean up quick add')).toEqual({
            title: 'Clean up quick add text',
            path: 'GTD → Default capture method',
        });


        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, 'estimate')).toBeNull();

        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, 'gtd')).toBeNull();
        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, '  ')).toBeNull();
    });
});
