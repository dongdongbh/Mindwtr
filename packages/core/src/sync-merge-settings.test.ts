import { describe, expect, it } from 'vitest';
import {
    mergeSettingsForSync,
    mergeSupportPromptSettings,
    restoreDeviceLocalAiSettings,
    sanitizeMergedSettingsForSync,
} from './sync-merge-settings';
import { selectFocusSavedFilters } from './focus-controls';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { normalizeFilterCriteria } from './saved-filters';
import { sanitizeAppDataForRemote } from './sync-helpers';
import type { AppData, SavedFilter, SettingsSyncGroup } from './types';

type Settings = AppData['settings'];

// #742 (2026-07-16 comment): naturalLanguageDates is a synced GTD boolean.
// Per P14 (#120), explicit values always beat an unset/default value on a
// peer, regardless of which side's sync timestamp is newer — a device that
// never touched the field must never overwrite a peer that set it.
describe('mergeSettingsForSync > gtd.naturalLanguageDates', () => {
    it('an incoming explicit false survives merge against a local peer without the field', () => {
        const local: Settings = { gtd: {} };
        const incoming: Settings = { gtd: { naturalLanguageDates: false } };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.naturalLanguageDates).toBe(false);
    });

    it('a local explicit false survives merge against an incoming peer without the field', () => {
        const local: Settings = { gtd: { naturalLanguageDates: false } };
        const incoming: Settings = { gtd: {} };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.naturalLanguageDates).toBe(false);
    });

    it('an incoming explicit false survives even when the local peer set a newer gtd timestamp for other fields', () => {
        const local: Settings = {
            gtd: { defaultScheduleTime: '09:00' },
            syncPreferencesUpdatedAt: { gtd: '2026-07-16T12:00:00.000Z' },
        };
        const incoming: Settings = {
            gtd: { naturalLanguageDates: false },
            syncPreferencesUpdatedAt: { gtd: '2026-07-01T00:00:00.000Z' },
        };

        const merged = mergeSettingsForSync(local, incoming);

        // The local device's newer gtd timestamp wins the tiebreaker for
        // fields both sides set differently, but naturalLanguageDates is
        // unset locally, so the incoming explicit value still applies.
        expect(merged.gtd?.naturalLanguageDates).toBe(false);
        expect(merged.gtd?.defaultScheduleTime).toBe('09:00');
    });

    it('both sides explicit and differing: the newer peer (by gtd sync timestamp) wins', () => {
        const local: Settings = {
            gtd: { naturalLanguageDates: true },
            syncPreferencesUpdatedAt: { gtd: '2026-07-01T00:00:00.000Z' },
        };
        const incoming: Settings = {
            gtd: { naturalLanguageDates: false },
            syncPreferencesUpdatedAt: { gtd: '2026-07-16T12:00:00.000Z' },
        };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.naturalLanguageDates).toBe(false);
    });

    it('neither side sets the field: merged gtd omits it (default true applies at read time)', () => {
        const local: Settings = { gtd: { defaultScheduleTime: '09:00' } };
        const incoming: Settings = { gtd: {} };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.naturalLanguageDates).toBeUndefined();
    });
});

const OLDER = '2026-07-01T00:00:00.000Z';
const NEWER = '2026-08-01T00:00:00.000Z';

const stamp = (settings: Settings, group: SettingsSyncGroup | 'preferences', at: string): Settings => ({
    ...settings,
    syncPreferencesUpdatedAt: { ...settings.syncPreferencesUpdatedAt, [group]: at },
});

describe('mergeSettingsForSync > AI request timeout', () => {
    it('preserves a local explicit timeout when a newer old-version peer omits it', () => {
        const local = stamp({ ai: { model: 'local-model', requestTimeoutSeconds: 120 } }, 'ai', OLDER);
        const incoming = stamp({ ai: { model: 'incoming-model' } }, 'ai', NEWER);

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.ai).toMatchObject({ model: 'incoming-model', requestTimeoutSeconds: 120 });
        expect(mergeSettingsForSync(merged, incoming)).toEqual(merged);
    });

    it('preserves a local explicit timeout when a newer peer sends an invalid value', () => {
        const local = stamp({ ai: { requestTimeoutSeconds: 300 } }, 'ai', OLDER);
        const incoming = stamp({ ai: { requestTimeoutSeconds: 45 } }, 'ai', NEWER);

        expect(mergeSettingsForSync(local, incoming).ai?.requestTimeoutSeconds).toBe(300);
    });

    it('drops an invalid timeout when neither peer has an explicit valid value', () => {
        const sanitized = sanitizeMergedSettingsForSync(
            { ai: { requestTimeoutSeconds: 0 } },
            { ai: {} },
        );

        expect(sanitized.ai?.requestTimeoutSeconds).toBeUndefined();
    });

    it('does not materialize the default timeout while sanitizing old settings', () => {
        const sanitized = sanitizeMergedSettingsForSync({ ai: {} }, { ai: {} });

        expect(sanitized.ai?.requestTimeoutSeconds).toBeUndefined();
    });
});

// One representative field per value-replacing group. savedFilters is excluded on
// purpose: it merges by filter id with its own per-filter LWW, covered separately below.
const GROUP_CASES: Array<{
    group: SettingsSyncGroup;
    local: Settings;
    incoming: Settings;
    read: (settings: Settings) => unknown;
    localValue: unknown;
    incomingValue: unknown;
}> = [
    {
        group: 'appearance',
        local: { theme: 'dark' },
        incoming: { theme: 'light' },
        read: (settings) => settings.theme,
        localValue: 'dark',
        incomingValue: 'light',
    },
    {
        group: 'language',
        local: { language: 'en' },
        incoming: { language: 'de' },
        read: (settings) => settings.language,
        localValue: 'en',
        incomingValue: 'de',
    },
    {
        group: 'gtd',
        local: { gtd: { defaultScheduleTime: '09:00' } },
        incoming: { gtd: { defaultScheduleTime: '17:00' } },
        read: (settings) => settings.gtd?.defaultScheduleTime,
        localValue: '09:00',
        incomingValue: '17:00',
    },
    {
        group: 'externalCalendars',
        local: { externalCalendars: [{ id: 'cal-1', name: 'Local', url: 'https://example.com/local.ics', enabled: true }] },
        incoming: { externalCalendars: [{ id: 'cal-1', name: 'Incoming', url: 'https://example.com/incoming.ics', enabled: true }] },
        read: (settings) => settings.externalCalendars?.[0]?.url,
        localValue: 'https://example.com/local.ics',
        incomingValue: 'https://example.com/incoming.ics',
    },
    {
        group: 'ai',
        local: { ai: { model: 'local-model' } },
        incoming: { ai: { model: 'incoming-model' } },
        read: (settings) => settings.ai?.model,
        localValue: 'local-model',
        incomingValue: 'incoming-model',
    },
];

describe('mergeSettingsForSync > gtd.taskEditor', () => {
    const layoutA: NonNullable<Settings['gtd']>['taskEditor'] = {
        order: ['status', 'priority'],
        hidden: ['energyLevel'],
        sectionOpen: { scheduling: true },
        defaultsVersion: 4,
    };
    const layoutB: NonNullable<Settings['gtd']>['taskEditor'] = {
        hidden: ['location', 'assignedTo'],
        defaultsVersion: 4,
    };

    it('a configured layout survives merge against a peer without one, regardless of timestamps', () => {
        const local: Settings = {
            gtd: { taskEditor: layoutA },
            syncPreferencesUpdatedAt: { gtd: '2026-08-01T00:00:00.000Z' },
        };
        const incoming: Settings = {
            gtd: { defaultScheduleTime: '09:00' },
            syncPreferencesUpdatedAt: { gtd: '2026-08-20T00:00:00.000Z' },
        };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.taskEditor).toEqual(layoutA);
        expect(merged.gtd?.defaultScheduleTime).toBe('09:00');
    });

    it('both sides configured: the newer peer by gtd timestamp wins whole', () => {
        const local: Settings = {
            gtd: { taskEditor: layoutA },
            syncPreferencesUpdatedAt: { gtd: '2026-08-01T00:00:00.000Z' },
        };
        const incoming: Settings = {
            gtd: { taskEditor: layoutB },
            syncPreferencesUpdatedAt: { gtd: '2026-08-20T00:00:00.000Z' },
        };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.taskEditor).toEqual(layoutB);
    });
});

describe('mergeSettingsForSync > expanded GTD settings', () => {
    it('merges capture, workflow, review, and feature preferences while preserving device-local inbox mode', () => {
        const local: Settings = {
            gtd: {
                inboxProcessing: {
                    defaultMode: 'quick',
                    twoMinuteEnabled: true,
                },
            },
            features: { priorities: true },
            syncPreferencesUpdatedAt: { gtd: OLDER },
        };
        const incoming: Settings = {
            gtd: {
                defaultCaptureMethod: 'audio',
                saveAudioAttachments: false,
                inboxProcessing: {
                    defaultMode: 'guided',
                    scheduleEnabled: true,
                },
                weeklyReview: { includeContextStep: false },
                dailyReview: { includeFocusStep: false },
            },
            quickAddAutoClean: true,
            markdownEditorAssist: false,
            features: { pomodoro: true },
            syncPreferencesUpdatedAt: { gtd: NEWER },
        };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd).toMatchObject({
            defaultCaptureMethod: 'audio',
            saveAudioAttachments: false,
            inboxProcessing: {
                defaultMode: 'quick',
                twoMinuteEnabled: true,
                scheduleEnabled: true,
            },
            weeklyReview: { includeContextStep: false },
            dailyReview: { includeFocusStep: false },
        });
        expect(merged.quickAddAutoClean).toBe(true);
        expect(merged.markdownEditorAssist).toBe(false);
        expect(merged.features).toEqual({ priorities: true, pomodoro: true });
    });

    it('preserves new explicit fields when an older peer omits them', () => {
        const local: Settings = {
            gtd: {
                defaultCaptureMethod: 'audio',
                weeklyReview: { includeContextStep: false },
            },
            quickAddAutoClean: true,
            features: { pomodoro: true },
            syncPreferencesUpdatedAt: { gtd: OLDER },
        };
        const incoming: Settings = {
            gtd: { defaultScheduleTime: '09:00' },
            syncPreferencesUpdatedAt: { gtd: NEWER },
        };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.defaultCaptureMethod).toBe('audio');
        expect(merged.gtd?.weeklyReview).toEqual({ includeContextStep: false });
        expect(merged.quickAddAutoClean).toBe(true);
        expect(merged.features?.pomodoro).toBe(true);
        expect(merged.gtd?.defaultScheduleTime).toBe('09:00');
    });

    it('rejects malformed expanded GTD values from a newer remote payload', () => {
        const local: Settings = {
            gtd: {
                timeEstimatePresets: ['15min'],
                autoArchiveDays: 7,
                defaultCaptureMethod: 'text',
                saveAudioAttachments: true,
                inboxProcessing: { scheduleEnabled: false },
                weeklyReview: { includeContextStep: true },
                dailyReview: { includeFocusStep: true },
                pomodoro: {
                    customDurations: { focusMinutes: 25, breakMinutes: 5 },
                    linkTask: false,
                },
            },
            quickAddAutoClean: false,
            markdownEditorAssist: true,
            features: { pomodoro: false },
            syncPreferencesUpdatedAt: { gtd: OLDER },
        };
        const incoming: Settings = {
            gtd: {
                timeEstimatePresets: 'many' as never,
                autoArchiveDays: -5,
                defaultCaptureMethod: 'camera' as never,
                saveAudioAttachments: 'yes' as never,
                inboxProcessing: { scheduleEnabled: 'yes' as never },
                weeklyReview: 'sometimes' as never,
                dailyReview: { includeFocusStep: 'yes' as never },
                pomodoro: {
                    customDurations: { focusMinutes: Number.NaN, breakMinutes: 999 },
                    linkTask: 'yes' as never,
                },
            },
            quickAddAutoClean: 'yes' as never,
            markdownEditorAssist: 1 as never,
            features: { pomodoro: 'yes' as never },
            syncPreferencesUpdatedAt: { gtd: NEWER },
        };

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.gtd?.timeEstimatePresets).toEqual(['15min']);
        expect(merged.gtd?.autoArchiveDays).toBe(7);
        expect(merged.gtd?.defaultCaptureMethod).toBe('text');
        expect(merged.gtd?.saveAudioAttachments).toBe(true);
        expect(merged.gtd?.inboxProcessing?.scheduleEnabled).toBe(false);
        expect(merged.gtd?.weeklyReview).toEqual({ includeContextStep: true });
        expect(merged.gtd?.dailyReview).toEqual({ includeFocusStep: true });
        expect(merged.gtd?.pomodoro).toEqual({
            customDurations: { focusMinutes: 25, breakMinutes: 180 },
            linkTask: false,
        });
        expect(merged.quickAddAutoClean).toBe(false);
        expect(merged.markdownEditorAssist).toBe(true);
        expect(merged.features?.pomodoro).toBe(false);
    });
});

describe('sanitizeMergedSettingsForSync > gtd.taskEditor shape guard', () => {
    it('falls back to the local layout when the incoming value is not an object', () => {
        const local: Settings = { gtd: { taskEditor: { hidden: ['location'] } } };
        const merged: Settings = { gtd: { taskEditor: 'corrupt' as never } };

        const sanitized = sanitizeMergedSettingsForSync(merged, local);

        expect(sanitized.gtd?.taskEditor).toEqual({ hidden: ['location'] });
    });

    it('drops wrong-typed sub-values but keeps unknown keys for newer clients', () => {
        const merged: Settings = {
            gtd: {
                taskEditor: {
                    order: 'not-an-array',
                    hidden: ['location'],
                    sectionOpen: 7,
                    defaultsVersion: 'four',
                    futureKey: 'kept',
                } as never,
            },
        };

        const sanitized = sanitizeMergedSettingsForSync(merged, {});

        expect(sanitized.gtd?.taskEditor).toEqual({ hidden: ['location'], futureKey: 'kept' });
    });
});

describe('mergeSettingsForSync > group arbitration', () => {
    it.each(GROUP_CASES)('$group: the incoming side wins when its group timestamp is newer', (testCase) => {
        const merged = mergeSettingsForSync(
            stamp(testCase.local, testCase.group, OLDER),
            stamp(testCase.incoming, testCase.group, NEWER),
        );

        expect(testCase.read(merged)).toEqual(testCase.incomingValue);
        expect(merged.syncPreferencesUpdatedAt?.[testCase.group]).toBe(NEWER);
    });

    it.each(GROUP_CASES)('$group: the local side wins when its group timestamp is newer', (testCase) => {
        const merged = mergeSettingsForSync(
            stamp(testCase.local, testCase.group, NEWER),
            stamp(testCase.incoming, testCase.group, OLDER),
        );

        expect(testCase.read(merged)).toEqual(testCase.localValue);
        expect(merged.syncPreferencesUpdatedAt?.[testCase.group]).toBe(NEWER);
    });

    it.each(GROUP_CASES)('$group: a local opt-out keeps the local value even against a newer incoming side', (testCase) => {
        const merged = mergeSettingsForSync(
            stamp({ ...testCase.local, syncPreferences: { [testCase.group]: false } }, testCase.group, OLDER),
            stamp(testCase.incoming, testCase.group, NEWER),
        );

        expect(testCase.read(merged)).toEqual(testCase.localValue);
    });

    it.each(GROUP_CASES)('$group: an empty newer incoming side never clears the local value', (testCase) => {
        const merged = mergeSettingsForSync(
            stamp(testCase.local, testCase.group, OLDER),
            stamp({}, testCase.group, NEWER),
        );

        expect(testCase.read(merged)).toEqual(testCase.localValue);
    });

    it.each(GROUP_CASES)('$group: an empty local side takes the incoming value', (testCase) => {
        const merged = mergeSettingsForSync(
            stamp({}, testCase.group, OLDER),
            stamp(testCase.incoming, testCase.group, NEWER),
        );

        expect(testCase.read(merged)).toEqual(testCase.incomingValue);
    });
});

describe('mergeSettingsForSync > savedFilters', () => {
    const localFilter = {
        id: 'filter-1',
        name: 'Local name',
        view: 'tasks' as const,
        criteria: {},
        createdAt: OLDER,
        updatedAt: OLDER,
    };

    it('preserves rolling task date criteria from a peer and converges on the second merge', () => {
        const filters = ['today', 'next_7_days', 'overdue_next_7_days', 'next_14_days', 'next_30_days', 'upcoming'].map((preset) => ({
            ...localFilter, id: `date-${preset}`, criteria: { anyDateRange: { preset } },
        })) as NonNullable<Settings['savedFilters']>;
        const previousPeer: Settings = { savedFilters: [localFilter] };
        const currentPeer: Settings = { savedFilters: filters };
        const merged = mergeSettingsForSync(previousPeer, currentPeer);
        expect(merged.savedFilters).toEqual([...filters, localFilter]);
        expect(mergeSettingsForSync(merged, currentPeer)).toEqual(merged);
        expect(mergeSettingsForSync(currentPeer, merged).savedFilters).toEqual(merged.savedFilters);
    });

    it('keeps filters only one side knows about', () => {
        const merged = mergeSettingsForSync(
            { savedFilters: [localFilter] },
            { savedFilters: [{ ...localFilter, id: 'filter-2', name: 'Incoming only' }] },
        );

        expect(merged.savedFilters?.map((filter) => filter.id).sort()).toEqual(['filter-1', 'filter-2']);
    });

    it('resolves a same-id conflict by the filter updatedAt, not the group timestamp', () => {
        const merged = mergeSettingsForSync(
            stamp({ savedFilters: [{ ...localFilter, updatedAt: NEWER, name: 'Local newer' }] }, 'savedFilters', OLDER),
            stamp({ savedFilters: [{ ...localFilter, name: 'Incoming older' }] }, 'savedFilters', NEWER),
        );

        expect(merged.savedFilters?.[0]?.name).toBe('Local newer');
    });

    it('a local opt-out keeps the local filter set', () => {
        const merged = mergeSettingsForSync(
            stamp({ savedFilters: [localFilter], syncPreferences: { savedFilters: false } }, 'savedFilters', OLDER),
            stamp({ savedFilters: [{ ...localFilter, id: 'filter-2', name: 'Incoming only' }] }, 'savedFilters', NEWER),
        );

        expect(merged.savedFilters?.map((filter) => filter.id)).toEqual(['filter-1']);
    });

    // A newer app's filter (a view, a field and a sort this build does not
    // know), an undated filter, and a user order that is not createdAt order.
    const newer = {
        id: 'filter-newer', name: 'Calendar lane', view: 'calendar', color: '#ff0000', sortBy: 'somethingNew',
        criteria: { contexts: ['@desk'] }, createdAt: NEWER, updatedAt: NEWER,
    };
    const undated = { id: 'filter-undated', name: 'Calls', view: 'focus', criteria: { contexts: ['@calls'] } };
    const older = { id: 'filter-older', name: 'Desk', view: 'focus', criteria: { contexts: ['@desk'] }, createdAt: OLDER, updatedAt: OLDER };
    const stored = [newer, undated, older] as unknown as NonNullable<Settings['savedFilters']>;
    const settingsWith = (savedFilters: unknown[], at: string): Settings => stamp(
        { savedFilters: savedFilters as NonNullable<Settings['savedFilters']>, syncPreferences: { savedFilters: true } },
        'savedFilters',
        at,
    );

    it('keeps every filter as stored when the peer did not change them', () => {
        const merged = mergeSettingsForSync(settingsWith(stored, OLDER), settingsWith(stored, OLDER));

        expect(merged.savedFilters).toEqual(stored);
        expect(selectFocusSavedFilters(merged.savedFilters).map((filter) => filter.id)).toEqual(['filter-undated', 'filter-older']);
    });

    it('changes only the filter the peer changed, in place', () => {
        const edited = { ...older, name: 'Desk (edited)', updatedAt: NEWER };
        const expected = [newer, undated, edited];

        expect(mergeSettingsForSync(settingsWith(stored, OLDER), settingsWith([newer, undated, edited], NEWER)).savedFilters)
            .toEqual(expected);
        expect(mergeSettingsForSync(settingsWith([newer, undated, edited], NEWER), settingsWith(stored, OLDER)).savedFilters)
            .toEqual(expected);
    });

    it('settles on one order: the remote copy\'s, unless this device changed its filters later', () => {
        const reordered = [older, newer, undated];

        const tie = mergeSettingsForSync(settingsWith(stored, OLDER), settingsWith(reordered, OLDER));
        expect(tie.savedFilters).toEqual(reordered);
        expect(mergeSettingsForSync(tie, settingsWith(reordered, OLDER)).savedFilters).toEqual(reordered);

        expect(mergeSettingsForSync(settingsWith(stored, NEWER), settingsWith(reordered, OLDER)).savedFilters).toEqual(stored);
        // Entries only the other side holds join at the end, in that side's order.
        expect(mergeSettingsForSync(settingsWith([older], NEWER), settingsWith([newer, undated], OLDER)).savedFilters)
            .toEqual([older, newer, undated]);
    });

    it('logs the merge with counts only', () => {
        const logs: LogPayload[] = [];
        setLogger((payload) => { logs.push(payload); });
        try {
            mergeSettingsForSync(settingsWith(stored, OLDER), settingsWith([older], NEWER));
        } finally {
            setLogger(consoleLogger);
        }

        expect(logs.filter((entry) => entry.message === 'Saved filters merged as stored').map((entry) => entry.context)).toEqual([
            { releaseCheck: 'v1.3.3/saved-filters-kept-as-stored', count: 3, hiddenCount: 1, order: 'remote' },
        ]);
        expect(JSON.stringify(logs)).not.toMatch(/Calendar lane|filter-newer/);
    });

    it('sends every filter as stored in the sync payload', () => {
        const data: AppData = {
            tasks: [], projects: [], sections: [], areas: [], people: [], settings: settingsWith(stored, OLDER),
        };

        expect(sanitizeAppDataForRemote(data).settings.savedFilters).toEqual(stored);
    });

    it('keeps the full filter when a v1.3.2 peer publishes only its rewrite of it', () => {
        const full = { ...newer, view: 'calendar', color: 'red' } as unknown as SavedFilter;
        const plain = older as SavedFilter;
        // The v1.3.2 peer holds its rewrite of the filter and makes an unrelated edit.
        const editedOnOldPeer = { ...plain, name: 'Desk (edited on v1.3.2)', updatedAt: LATEST };
        const oldPeerList = v132NormalizeSavedFilters([full, editedOnOldPeer]);
        expect(oldPeerList.find((filter) => filter.id === full.id)).toMatchObject({ view: 'focus' });

        const published = mergeSettingsForSync(settingsWith([full, plain], OLDER), settingsWith(oldPeerList, NEWER));

        // The remote copy's order (v1.3.2 sorted it), the full filter, the old peer's edit.
        expect(published.savedFilters).toEqual([editedOnOldPeer, full]);
        expect(selectFocusSavedFilters(published.savedFilters).map((filter) => filter.id)).toEqual(['filter-older']);
        // Both directions agree, and a second merge changes nothing.
        expect(mergeSettingsForSync(settingsWith(oldPeerList, NEWER), settingsWith([full, plain], OLDER)).savedFilters)
            .toEqual([editedOnOldPeer, full]);
        expect(mergeSettingsForSync(published, published).savedFilters).toEqual(published.savedFilters);
        // v1.3.2 compares documents after its own rewrite: what this build publishes
        // reads as unchanged there, so the old peer does not upload again.
        expect(v132NormalizeSavedFilters(published.savedFilters)).toEqual(oldPeerList);
    });

    it.each(['today', 'next_7_days', 'overdue_next_7_days', 'next_14_days', 'next_30_days', 'upcoming'] as const)(
        'retains same-id %s task-date criteria when a v1.3.2 peer strips them', (preset) => {
            const full: SavedFilter = { ...older, id: 'dates', name: 'Dates', criteria: {
                contexts: ['@desk'], anyDateRange: { preset },
                ...(preset !== 'today' ? { dueDateRange: { preset }, startDateRange: { preset } } : {}),
            } };
            const stripped = v132NormalizeSavedFilters([full]);
            expect(stripped).toEqual([{ ...full, criteria: { contexts: ['@desk'] } }]);
            let completePeer = settingsWith([full], OLDER);
            const oldPeer = settingsWith(stripped, NEWER);
            for (let round = 0; round < 3; round += 1) {
                expect(mergeSettingsForSync(oldPeer, completePeer).savedFilters).toEqual([full]);
                completePeer = mergeSettingsForSync(completePeer, oldPeer);
                expect(completePeer.savedFilters).toEqual([full]);
                expect(v132NormalizeSavedFilters(completePeer.savedFilters)).toEqual(stripped);
            }
            // A real edit is distinguished by updatedAt, even when it removes the date criterion.
            const edited = { ...stripped[0], updatedAt: LATEST };
            expect(mergeSettingsForSync(completePeer, settingsWith([edited], NEWER)).savedFilters).toEqual([edited]);
            expect(mergeSettingsForSync(settingsWith([edited], NEWER), completePeer).savedFilters).toEqual([edited]);
        },
    );

    it('logs a privacy-safe receipt only when retaining a full filter over a legacy rewrite', () => {
        const full: SavedFilter = { ...older, criteria: { anyDateRange: { preset: 'overdue_next_7_days' } } };
        const stripped = v132NormalizeSavedFilters([full]);
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            mergeSettingsForSync(settingsWith([full], OLDER), settingsWith(stripped, NEWER));
            mergeSettingsForSync(settingsWith([full], OLDER), settingsWith([full], NEWER));
            mergeSettingsForSync(settingsWith([full], OLDER), settingsWith([{ ...stripped[0], updatedAt: LATEST }], NEWER));
        } finally {
            setLogger(consoleLogger);
        }
        const receipts = logs.filter((entry) => entry.context?.releaseCheck === 'v1.3.8/saved-filter-date-preserved');
        expect(receipts).toEqual([{
            level: 'info', message: 'Saved filter retained over legacy rewrite',
            scope: 'saved-filters', category: 'sync', force: true,
            context: { releaseCheck: 'v1.3.8/saved-filter-date-preserved', count: 1, outcome: 'kept-full' },
        }]);
        expect(JSON.stringify(receipts)).not.toMatch(/Desk|filter-older|criteria|overdue_next_7_days/);
    });

    it('recognizes the old bounded-range fallback for presets v1.3.2 did not understand', () => {
        const full: SavedFilter = { ...older, criteria: {
            dueDateRange: { preset: 'next_7_days', from: '2026-10-01', to: '2026-10-31' },
            startDateRange: { preset: 'overdue_next_7_days', from: '2026-10-01' },
        } };
        const stripped = v132NormalizeSavedFilters([full]);
        expect(stripped[0].criteria).toEqual({
            dueDateRange: { from: '2026-10-01', to: '2026-10-31' },
            startDateRange: { from: '2026-10-01', to: undefined },
        });
        expect(mergeSettingsForSync(settingsWith([full], OLDER), settingsWith(stripped, NEWER)).savedFilters).toEqual([full]);
        expect(mergeSettingsForSync(settingsWith(stripped, NEWER), settingsWith([full], OLDER)).savedFilters).toEqual([full]);
    });

    it('lets a newer edit made on a v1.3.2 peer win by time (documented limit)', () => {
        const full = { ...newer, view: 'calendar', color: 'red' } as unknown as SavedFilter;
        const editedOnOldPeer = { ...v132NormalizeSavedFilters([full])[0]!, name: 'Renamed on v1.3.2', updatedAt: LATEST };

        const merged = mergeSettingsForSync(settingsWith([full], OLDER), settingsWith([editedOnOldPeer], NEWER));

        expect(merged.savedFilters).toEqual([editedOnOldPeer]);
    });

    it('converges on one copy when two peers hold different undated copies of a filter', () => {
        const a = { id: 'f', name: 'A', view: 'focus', criteria: {} };
        const b = { id: 'f', name: 'B', view: 'focus', criteria: {} };

        // Same group timestamp: one deterministic winner, whichever side merges.
        let peerA = settingsWith([a], OLDER);
        let peerB = settingsWith([b], OLDER);
        for (let round = 0; round < 3; round += 1) {
            peerA = mergeSettingsForSync(peerA, peerB);
            peerB = mergeSettingsForSync(peerB, peerA);
        }
        expect(peerA.savedFilters).toEqual(peerB.savedFilters);
        expect(mergeSettingsForSync(settingsWith([a], OLDER), settingsWith([b], OLDER)).savedFilters)
            .toEqual(mergeSettingsForSync(settingsWith([b], OLDER), settingsWith([a], OLDER)).savedFilters);

        // A strictly newer group timestamp wins, from either side.
        expect(mergeSettingsForSync(settingsWith([a], OLDER), settingsWith([b], NEWER)).savedFilters).toEqual([b]);
        expect(mergeSettingsForSync(settingsWith([b], NEWER), settingsWith([a], OLDER)).savedFilters).toEqual([b]);
    });
});

const LATEST = '2026-09-01T00:00:00.000Z';

// v1.3.2's saved-filter behavior (packages/core/src/saved-filters.ts
// at tag v1.3.2). Other criterion normalization is unchanged; freeze the old
// date surface below rather than teaching this fixture new fields/presets. Every v1.3.2 load,
// save, merge and remote comparison ran its list through this.
const V132_VIEWS = new Set(['focus', 'next', 'waiting', 'someday', 'contexts', 'all']);
const V132_GROUP_BY = new Set(['none', 'context', 'project', 'area', 'energy', 'priority', 'person', 'tag']);
const V132_SORT_FIELDS = new Set([
    'default', 'due', 'start', 'review', 'title', 'created', 'created-desc', 'priority', 'energy', 'timeEstimate', 'project', 'updated',
]);
function v132NormalizeSavedFilter(value: unknown): SavedFilter | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) return null;
    if (typeof record.name !== 'string' || !record.name.trim()) return null;
    const view = typeof record.view === 'string' && V132_VIEWS.has(record.view) ? record.view : 'focus';
    const createdAt = typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt : new Date().toISOString();
    const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt.trim() ? record.updatedAt : createdAt;
    const sortBy = typeof record.sortBy === 'string' && V132_SORT_FIELDS.has(record.sortBy) ? record.sortBy : undefined;
    const sortOrder = record.sortOrder === 'asc' || record.sortOrder === 'desc' ? record.sortOrder : undefined;
    const groupBy = typeof record.groupBy === 'string' && V132_GROUP_BY.has(record.groupBy) ? record.groupBy : undefined;
    const icon = typeof record.icon === 'string' && record.icon.trim() ? record.icon.trim() : undefined;
    const deletedAt = typeof record.deletedAt === 'string' && record.deletedAt.trim() ? record.deletedAt.trim() : undefined;
    const criteria = normalizeFilterCriteria(record.criteria);
    delete criteria.anyDateRange;
    const rawCriteria = typeof record.criteria === 'object' && record.criteria !== null
        ? record.criteria as Record<string, unknown> : {};
    for (const field of ['dueDateRange', 'startDateRange'] as const) {
        const range = v132NormalizeDateRange(rawCriteria[field]);
        if (range) criteria[field] = range;
        else delete criteria[field];
    }
    return {
        id: record.id.trim(),
        name: record.name.trim(),
        ...(icon ? { icon } : {}),
        view,
        criteria,
        ...(sortBy ? { sortBy } : {}),
        ...(sortOrder ? { sortOrder } : {}),
        ...(groupBy ? { groupBy } : {}),
        createdAt,
        updatedAt,
        ...(deletedAt ? { deletedAt } : {}),
    } as SavedFilter;
}
// v1.3.2 date-range reader, including fallback to explicit bounds.
function v132NormalizeDateRange(value: unknown): import('./types').DateRange | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.preset === 'today' || record.preset === 'this_week' || record.preset === 'this_month'
        || record.preset === 'overdue' || record.preset === 'no_date') return { preset: record.preset };
    const from = typeof record.from === 'string' && record.from.trim() ? record.from.trim() : undefined;
    const to = typeof record.to === 'string' && record.to.trim() ? record.to.trim() : undefined;
    return from || to ? { from, to } : undefined;
}
function v132NormalizeSavedFilters(value: unknown): SavedFilter[] {
    if (!Array.isArray(value)) return [];
    const byId = new Map<string, SavedFilter>();
    for (const item of value) {
        const normalized = v132NormalizeSavedFilter(item);
        if (!normalized) continue;
        byId.set(normalized.id, normalized);
    }
    return Array.from(byId.values()).sort((a, b) => {
        const createdDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
        return a.name.localeCompare(b.name);
    });
}

describe('sanitizeMergedSettingsForSync', () => {
    it('is a no-op on an already merged document (round-trip)', () => {
        const local: Settings = stamp({ theme: 'dark', language: 'en', gtd: { defaultScheduleTime: '09:00' } }, 'appearance', OLDER);
        const incoming: Settings = stamp({ theme: 'light', language: 'de' }, 'appearance', NEWER);

        const merged = mergeSettingsForSync(local, incoming);

        expect(sanitizeMergedSettingsForSync(merged, local)).toEqual(merged);
    });

    it('falls back to the local value for an out-of-range incoming value', () => {
        const local: Settings = { theme: 'dark', gtd: { focusTaskLimit: 5 } };
        const merged = sanitizeMergedSettingsForSync(
            { theme: 'neon' as Settings['theme'], gtd: { focusTaskLimit: 9999 } },
            local,
        );

        expect(merged.theme).toBe('dark');
        expect(merged.gtd?.focusTaskLimit).toBe(5);
    });
});

// Two behaviours worth pinning because they read as accidents. Both are reported
// rather than changed: they are the current, shipped arbitration.
describe('mergeSettingsForSync > documented quirks', () => {
    // mergeGroup reads localSettings.syncPreferences, not the preferences it just
    // merged, so a remote that re-enables a group only takes effect on the NEXT
    // merge. The merged preference itself is stored immediately, so it converges.
    it('honors the pre-merge opt-out even when the incoming side re-enabled the group', () => {
        const local = stamp(
            stamp({ theme: 'dark', syncPreferences: { appearance: false } }, 'appearance', OLDER),
            'preferences',
            OLDER,
        );
        const incoming = stamp(
            stamp({ theme: 'light', syncPreferences: { appearance: true } }, 'appearance', NEWER),
            'preferences',
            NEWER,
        );

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.syncPreferences?.appearance).toBe(true);
        expect(merged.theme).toBe('dark');
        // Second round, now that the opt-out is gone, the incoming value lands.
        expect(mergeSettingsForSync(merged, incoming).theme).toBe('light');
    });

    // isSameValue compares with JSON.stringify, which is key-order sensitive, so
    // two semantically identical objects count as a difference and the winner's
    // copy (key order included) replaces the local one.
    it('treats key-order-only differences as a change and takes the winner copy', () => {
        const local = stamp({ ai: { enabled: true, model: 'shared-model' } }, 'ai', OLDER);
        const incoming = stamp({ ai: { model: 'shared-model', enabled: true } }, 'ai', NEWER);

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.ai).toEqual({ enabled: true, model: 'shared-model', apiKey: undefined });
        expect(Object.keys(merged.ai ?? {}).slice(0, 2)).toEqual(['model', 'enabled']);
    });
});

describe('mergeSettingsForSync > dataset identity', () => {
    it('adopts the remote analytics profile id and keeps the local one only when remote has none', () => {
        expect(mergeSettingsForSync({ analyticsProfileId: 'local' }, { analyticsProfileId: 'remote' }).analyticsProfileId).toBe('remote');
        expect(mergeSettingsForSync({ analyticsProfileId: 'local' }, {}).analyticsProfileId).toBe('local');
        expect(mergeSettingsForSync({ analyticsProfileId: 'local' }, { analyticsProfileId: '' }).analyticsProfileId).toBe('local');
        expect(mergeSettingsForSync({}, { analyticsProfileId: 'remote' }).analyticsProfileId).toBe('remote');
    });

    it('keeps the newest support-prompt timestamps from either side', () => {
        expect(mergeSupportPromptSettings(
            { lastShownAt: '2026-01-01T00:00:00.000Z' },
            { lastShownAt: '2026-02-01T00:00:00.000Z' },
        )).toEqual({ lastShownAt: '2026-02-01T00:00:00.000Z' });
        expect(mergeSupportPromptSettings({ lastShownAt: '2026-01-01T00:00:00.000Z' }, { lastShownAt: 'not-a-date' }))
            .toEqual({ lastShownAt: '2026-01-01T00:00:00.000Z' });
        expect(mergeSupportPromptSettings(undefined, undefined)).toBeUndefined();
        expect(mergeSettingsForSync({}, { supportPrompt: { lastShownAt: '2026-02-01T00:00:00.000Z' } }).supportPrompt)
            .toEqual({ lastShownAt: '2026-02-01T00:00:00.000Z' });
    });
});

// The API key lives only on the device, so the address it is sent to and the
// extra request body must be device-local too: a sync document must never
// choose where this device sends its key or what the request carries.
describe('mergeSettingsForSync > device-local AI fields', () => {
    it('drops an incoming endpoint and extra body when the local device has none', () => {
        const local = stamp({ ai: { enabled: true, provider: 'openai' } }, 'ai', OLDER);
        const incoming = stamp({
            ai: {
                enabled: true,
                provider: 'openai',
                baseUrl: 'https://other-host.example/v1',
                openAIExtraBodyParams: { x: 1 },
                speechToText: { enabled: true, provider: 'openai', baseUrl: 'https://other-host.example/v1' },
            },
        }, 'ai', NEWER);

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.ai?.baseUrl).toBeUndefined();
        expect(merged.ai?.openAIExtraBodyParams).toBeUndefined();
        expect(merged.ai?.speechToText?.baseUrl).toBeUndefined();
        expect(merged.ai?.speechToText?.enabled).toBe(true);
        expect(mergeSettingsForSync(merged, incoming)).toEqual(merged);
    });

    it('keeps the local endpoint and extra body while other AI fields still sync', () => {
        const local = stamp({
            ai: {
                provider: 'openai',
                baseUrl: 'http://localhost:1234/v1',
                openAIExtraBodyParams: { keep: true },
                speechToText: { provider: 'openai', baseUrl: 'http://localhost:8000/v1' },
            },
        }, 'ai', OLDER);
        const incoming = stamp({
            ai: {
                provider: 'openai',
                model: 'incoming-model',
                baseUrl: 'https://other-host.example/v1',
                openAIExtraBodyParams: { x: 1 },
                speechToText: { provider: 'openai', baseUrl: 'https://other-host.example/v1' },
            },
        }, 'ai', NEWER);

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.ai?.model).toBe('incoming-model');
        expect(merged.ai?.baseUrl).toBe('http://localhost:1234/v1');
        expect(merged.ai?.openAIExtraBodyParams).toEqual({ keep: true });
        expect(merged.ai?.speechToText?.baseUrl).toBe('http://localhost:8000/v1');
        expect(mergeSettingsForSync(merged, incoming)).toEqual(merged);
    });

    it('keeps the local speech endpoint when the incoming side has no speech settings', () => {
        const local = stamp({
            ai: { provider: 'openai', speechToText: { baseUrl: 'http://localhost:8000/v1' } },
        }, 'ai', OLDER);
        const incoming = stamp({ ai: { provider: 'openai', model: 'incoming-model' } }, 'ai', NEWER);

        const merged = mergeSettingsForSync(local, incoming);

        expect(merged.ai?.speechToText?.baseUrl).toBe('http://localhost:8000/v1');
        expect(mergeSettingsForSync(merged, incoming)).toEqual(merged);
    });
});

// The sync run reconciles the copy it read from disk with the live store and
// passes the disk copy first, so the merge's device-local AI fields come from
// the wrong side there. This puts them back.
describe('restoreDeviceLocalAiSettings', () => {
    const data = (ai: AppData['settings']['ai']): AppData => ({
        tasks: [], projects: [], sections: [], areas: [], people: [], settings: { ai },
    });

    it('takes the endpoint, extra body and offline model path from the live store', () => {
        const merged = data({
            provider: 'openai',
            baseUrl: 'http://old/v1',
            openAIExtraBodyParams: { old: true },
            speechToText: { enabled: true, baseUrl: 'http://old-speech/v1', offlineModelPath: '/old/model.bin' },
        });
        const inMemory = data({
            provider: 'openai',
            baseUrl: 'http://new/v1',
            openAIExtraBodyParams: { fresh: true },
            speechToText: { baseUrl: 'http://new-speech/v1', offlineModelPath: '/new/model.bin' },
        });

        const restored = restoreDeviceLocalAiSettings(merged, inMemory);

        expect(restored.settings.ai?.baseUrl).toBe('http://new/v1');
        expect(restored.settings.ai?.openAIExtraBodyParams).toEqual({ fresh: true });
        expect(restored.settings.ai?.speechToText?.baseUrl).toBe('http://new-speech/v1');
        expect(restored.settings.ai?.speechToText?.offlineModelPath).toBe('/new/model.bin');
        // Fields outside the device-local set are left as the merge decided.
        expect(restored.settings.ai?.speechToText?.enabled).toBe(true);
    });

    it('carries a cleared endpoint over instead of reviving the old one', () => {
        const merged = data({ provider: 'openai', baseUrl: 'http://old/v1' });

        const restored = restoreDeviceLocalAiSettings(merged, data({ provider: 'openai' }));

        expect(restored.settings.ai?.baseUrl).toBeUndefined();
    });

    // The caller reads this identity to decide whether its snapshot still matches
    // the document on disk, so an unchanged call must not build a new object.
    it('returns the same object when nothing has to change', () => {
        const ai = {
            provider: 'openai' as const,
            baseUrl: 'http://same/v1',
            openAIExtraBodyParams: { keep: true },
            speechToText: { baseUrl: 'http://same-speech/v1', offlineModelPath: '/same/model.bin' },
        };
        const merged = data({ ...ai });

        expect(restoreDeviceLocalAiSettings(merged, data({ ...ai }))).toBe(merged);
    });

    it('leaves the document alone when the store holds no AI settings yet', () => {
        const merged = data({ provider: 'openai', baseUrl: 'http://disk/v1' });

        const restored = restoreDeviceLocalAiSettings(merged, data(undefined));

        expect(restored).toBe(merged);
        expect(restored.settings.ai?.baseUrl).toBe('http://disk/v1');
    });
});
