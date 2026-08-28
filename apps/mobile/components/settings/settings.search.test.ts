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
    SETTINGS_MENU_KEYWORD_KEYS,
    settingsMenuMatchesQuery,
    type SettingsMenuRowId,
} from './settings.constants';

// Real English translator backed by the actual core en locale table. Mirrors
// language-context's `t`, which returns the key itself when a translation is
// missing — so this catches any keyword key that doesn't resolve.
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

// Snapshot of the hand-authored SETTINGS_MENU_KEYWORD_KEYS this task replaced
// with a derivation from core's SETTINGS_SEARCH_PAGE_KEYS roster. Pinned
// verbatim (not re-derived) so the superset check below can't shrink in
// lockstep with a bug in the new derivation — see COMMON-20260726.md's "a test
// that iterates the new thing cannot catch the new thing shrinking".
const PREVIOUS_SETTINGS_MENU_KEYWORD_KEYS: Record<SettingsMenuRowId, readonly string[]> = {
    general: [
        'settings.appearance', 'settings.theme', 'settings.language', 'settings.weekStart',
        'settings.dateFormat', 'settings.timeFormat', 'settings.calendarSystem',
        'settings.mobile.showTaskAge', 'settings.mobile.appLock', 'settings.privacy',
    ],
    gtd: [
        'settings.features', 'settings.featurePomodoro', 'settings.gtdMobile.pomodoroSettings',
        'settings.timeEstimatePresets', 'settings.autoArchive', 'settings.taskEditorLayout',
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
    // Regression guard for the review's HIGH finding: keyword keys were guessed
    // from desktop naming and silently resolved to nothing. Every listed key
    // must be a real English translation, or search misses that content.
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

    // The bug this task fixes: the old guard only checked that mobile's keys
    // RESOLVE, never that they COVER. A key present on desktop and silently
    // absent from mobile's list was invisible here and nothing failed. This
    // pins the pre-fix hand-authored list and asserts the new,
    // core-roster-derived list is a strict superset of it, row by row — never
    // a same-size "round trip" of the new roster against itself.
    it('the new derived roster is a superset of every previously indexed key', () => {
        for (const row of ROW_IDS) {
            const previous = PREVIOUS_SETTINGS_MENU_KEYWORD_KEYS[row];
            const current = new Set(SETTINGS_MENU_KEYWORD_KEYS[row]);
            const dropped = previous.filter((key) => !current.has(key));
            expect(dropped, `row "${row}" lost keys`).toEqual([]);
        }
    });

    // Coverage direction, the actual point of the task: every desktop
    // settings-search key not on core's exclusion list must have SOME row on
    // mobile whose keywords resolve to the same English text (mobile
    // namespaces some labels under settings.mobile.*/gtdMobile.*/syncMobile.*
    // — a different key, the same text — see settings.constants.ts's
    // MOBILE_SEARCH_KEY_OVERRIDES). A key silently dropped here means a real
    // setting becomes unfindable through mobile search.
    it('every non-excluded desktop settings-search key is discoverable somewhere on mobile', () => {
        const mobileTexts = new Set(
            Object.values(SETTINGS_MENU_KEYWORD_KEYS)
                .flat()
                .map((key) => getEnglishI18nValue(key))
                .filter((value): value is string => Boolean(value)),
        );
        const missing: string[] = [];
        for (const entry of SETTINGS_SEARCH_INDEX) {
            if (entry.key in SETTINGS_SEARCH_MOBILE_EXCLUSIONS) continue;
            const text = getEnglishI18nValue(resolveSettingsSearchI18nKey(entry.key));
            if (text && !mobileTexts.has(text)) missing.push(`${entry.key} -> "${text}"`);
        }
        expect(missing).toEqual([]);
    });

    it('surfaces the right row for real setting labels and hides unrelated rows', () => {
        // "pomodoro" is a GTD sub-screen setting, not a menu title.
        expect(visibleRowIds('pomodoro')).toEqual(['gtd']);
        // The exact content the review flagged as missing before the fix:
        expect(visibleRowIds('todoist')).toEqual(['data']);
        expect(visibleRowIds('ticktick')).toEqual(['data']);
        expect(visibleRowIds('omnifocus')).toEqual(['data']);
        // "areas" is a Manage sub-setting (areas.manage -> "Areas").
        expect(visibleRowIds('areas')).toEqual(['manage']);
        // AI provider indexed on the Advanced row.
        expect(visibleRowIds('anthropic')).toEqual(['advanced']);
    });

    // The three settings this task found genuinely missing from mobile search
    // despite existing (with a working i18n key) on mobile's own screens:
    // gtd-settings-screen.tsx renders quickAddAutoClean/markdownEditorAssist,
    // sync-settings-sections.tsx renders backgroundSync — none were indexed.
    it('finds the settings this task discovered were missing from the mobile index', () => {
        expect(visibleRowIds('clean up quick add')).toEqual(['gtd']);
        expect(visibleRowIds('editor typing help')).toEqual(['gtd']);
        expect(visibleRowIds('background sync')).toEqual(['sync']);
        // Android-only, so it is absent from desktop's roster and no derived
        // key covers it — general-settings-screen renders it behind
        // isAppSearchSupported().
        expect(visibleRowIds('expose to system search')).toEqual(['general']);
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

    // #884 follow-up: the row still navigates to its sub-screen, but while
    // searching its second line names the setting that matched and the path to
    // it — the same "Page → Section" data desktop shows in its results list.
    it('reports which setting matched a row and where it lives', () => {
        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, 'clean up quick add')).toEqual({
            title: 'Clean up quick add text',
            path: 'GTD → Default capture method',
        });
        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, 'estimate')).toEqual({
            title: 'Time estimate presets',
            path: 'GTD',
        });
        // A row that matched on its own title has no inner setting to report.
        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, 'gtd')).toBeNull();
        expect(findSettingsMenuMatch('gtd', t('settings.gtd'), t, '  ')).toBeNull();
    });
});
