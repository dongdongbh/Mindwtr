import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeAppDataForRemote } from './sync-helpers';
import { mergeSettingsForSync } from './sync-merge-settings';
import type { AppData, SettingsSyncGroup } from './types';

type Settings = AppData['settings'];

// Every setting is either synced between a user's devices or device-local.
// Two hand-written functions decide which: sanitizeSettingsForRemote (what
// leaves the device) and mergeSettingsForSync (what an incoming document may
// change). This file writes the rule down so a new field cannot start
// travelling between devices without someone deciding that it should.

const SYNCED_TOP_LEVEL_KEYS = [
    'taxonomy',                 // always: saved contexts and tags are shared dataset data
    'syncPreferences',          // always: the choice of what to sync
    'syncPreferencesUpdatedAt', // always: the timestamps behind that choice
    'analyticsProfileId',       // always: one dataset = one anonymous profile
    'supportPrompt',            // always: the cooldown is per dataset (#1237)
    'theme',                    // group appearance
    'appearance',               // group appearance
    'keybindingStyle',          // group appearance
    'language',                 // group language
    'weekStart',                // group language
    'dateFormat',               // group language
    'timeFormat',               // group language
    'gtd',                      // group gtd
    'taskReminderDefault',      // group gtd; notification capability stays device-local
    'quickAddAutoClean',        // group gtd
    'markdownEditorAssist',     // group gtd
    'features',                 // group gtd
    'savedFilters',             // group savedFilters
    'externalCalendars',        // group externalCalendars (local file:// and content:// entries removed)
    'ai',                       // group ai (minus apiKey, baseUrl, openAIExtraBodyParams, speechToText.offlineModelPath, speechToText.baseUrl)
];

const DEVICE_LOCAL_TOP_LEVEL_KEYS = [
    'attachments',                    // local cleanup bookkeeping and pending remote deletes
    'calendar',                       // which calendar window this device is looking at
    'calendarSystem',                 // device calendar system
    'globalQuickAddShortcut',         // desktop shortcut registration is local runtime behaviour
    'window',                         // desktop window placement and tray behaviour
    'savedSearches',                  // device-local search shortcuts
    'savedSearchesUpdatedAt',         // device-local search write ownership
    'sidebarCollapsed',               // per-device layout state
    'taskSortBy',                     // per-device list order
    'diagnostics',                    // per-device logging switch
    'analytics',                      // per-device heartbeat switch
    'security',                       // per-device app lock
    'network',                        // per-device proxy
    'filters',                        // per-device area filter
    'deviceId',                       // identifies this install
    'migrations',                     // per-install migration bookkeeping
    'lastSyncAt',                     // sync bookkeeping of this device
    'lastSyncStatus',                 // sync bookkeeping of this device
    'lastSyncError',                  // sync bookkeeping of this device
    'lastSyncStats',                  // sync bookkeeping of this device
    'lastSyncHistory',                // sync bookkeeping of this device
    'pendingRemoteWriteAt',           // sync bookkeeping of this device
    'pendingRemoteWriteRetryAt',      // sync bookkeeping of this device
    'pendingRemoteWriteAttempts',     // sync bookkeeping of this device
    'notificationsEnabled',           // notifications are a per-device permission
    'undoNotificationsEnabled',       // per-device notification switch
    'startDateNotificationsEnabled',  // per-device notification switch
    'dueDateNotificationsEnabled',    // per-device notification switch
    'reviewAtNotificationsEnabled',   // per-device notification switch
    'dailyDigestMorningEnabled',      // per-device digest switch
    'dailyDigestMorningTime',         // per-device digest time
    'dailyDigestEveningEnabled',      // per-device digest switch
    'dailyDigestEveningTime',         // per-device digest time
    'weeklyReviewEnabled',            // per-device reminder switch
    'weeklyReviewDay',                // per-device reminder day
    'weeklyReviewTime',               // per-device reminder time
];

const readInterfaceProperties = (source: string, header: string): string[] => {
    const start = source.indexOf(header);
    if (start < 0) throw new Error(`Interface header not found: ${header}`);
    const body = source.slice(start + header.length);
    const end = body.indexOf('\n}');
    if (end < 0) throw new Error(`Interface body not closed: ${header}`);
    return Array.from(body.slice(0, end).matchAll(/^\s{4}([A-Za-z]+)\??:/gm), (match) => match[1]);
};

const OLDER = '2026-07-01T00:00:00.000Z';
const NEWER = '2026-08-01T00:00:00.000Z';
const SYNC_GROUPS: Array<SettingsSyncGroup | 'preferences'> = [
    'preferences', 'appearance', 'language', 'gtd', 'externalCalendars', 'ai', 'savedFilters',
];

const stampAll = (settings: Settings, at: string): Settings => ({
    ...settings,
    syncPreferencesUpdatedAt: Object.fromEntries(SYNC_GROUPS.map((group) => [group, at])),
});

// One settings object with a non-default value for every classified key.
const fullSettings = (): Settings => ({
    taxonomy: { contexts: [{ token: '@Shared', rev: 1, revBy: 'scope-device', updatedAt: OLDER }] },
    // synced
    syncPreferences: {
        appearance: true, language: true, gtd: true, externalCalendars: true, ai: true, savedFilters: true,
    },
    syncPreferencesUpdatedAt: {},
    analyticsProfileId: 'profile-1',
    supportPrompt: { lastShownAt: OLDER },
    theme: 'dark',
    appearance: { density: 'compact', textSize: 'small' },
    keybindingStyle: 'emacs',
    language: 'zh',
    weekStart: 'monday',
    dateFormat: 'yyyy-MM-dd',
    timeFormat: '24h',
    gtd: { autoArchiveDays: 14 },
    taskReminderDefault: 'skip',
    quickAddAutoClean: true,
    markdownEditorAssist: false,
    features: { priorities: true },
    savedFilters: [{
        id: 'filter-1',
        name: 'Desk',
        view: 'focus',
        criteria: { contexts: ['@desk'] },
        createdAt: OLDER,
        updatedAt: OLDER,
    }],
    externalCalendars: [
        { id: 'cal-1', name: 'Work', url: 'https://example.com/work.ics', enabled: true },
        { id: 'cal-local', name: 'Local', url: 'file:///home/user/agenda.ics', enabled: true },
    ],
    ai: {
        enabled: true,
        provider: 'openai',
        model: 'local-model',
        apiKey: 'local-secret',
        baseUrl: 'http://localhost:1234/v1',
        openAIExtraBodyParams: { keep: true },
        speechToText: {
            enabled: true,
            provider: 'openai',
            model: 'local-speech',
            baseUrl: 'http://localhost:8000/v1',
            offlineModelPath: '/local/model.bin',
        },
    },
    // device-local
    attachments: { lastCleanupAt: OLDER },
    calendar: { viewMode: 'week' },
    calendarSystem: 'persian',
    globalQuickAddShortcut: 'ctrl+alt+m',
    window: { decorations: false, closeBehavior: 'tray' },
    savedSearches: [{ id: 'search-1', name: 'Desk', query: '@desk' }],
    savedSearchesUpdatedAt: OLDER,
    sidebarCollapsed: true,
    taskSortBy: 'due',
    diagnostics: { loggingEnabled: true },
    analytics: { heartbeatEnabled: false },
    security: { mobileAppLockEnabled: true, mobileAppLockRelockDelayMinutes: 5 },
    network: { proxyUrl: 'http://proxy.local:8080' },
    filters: { areaId: 'area-1', areaIds: ['area-1'] },
    deviceId: 'local-device-id',
    migrations: { version: 3 },
    lastSyncAt: OLDER,
    lastSyncStatus: 'success',
    lastSyncError: 'local error',
    lastSyncStats: {
        tasks: {
            localTotal: 1, incomingTotal: 1, mergedTotal: 1, localOnly: 0, incomingOnly: 0,
            conflicts: 0, resolvedUsingLocal: 0, resolvedUsingIncoming: 0, deletionsWon: 0, conflictIds: [],
        },
        projects: {
            localTotal: 0, incomingTotal: 0, mergedTotal: 0, localOnly: 0, incomingOnly: 0,
            conflicts: 0, resolvedUsingLocal: 0, resolvedUsingIncoming: 0, deletionsWon: 0, conflictIds: [],
        },
        sections: {
            localTotal: 0, incomingTotal: 0, mergedTotal: 0, localOnly: 0, incomingOnly: 0,
            conflicts: 0, resolvedUsingLocal: 0, resolvedUsingIncoming: 0, deletionsWon: 0, conflictIds: [],
        },
        areas: {
            localTotal: 0, incomingTotal: 0, mergedTotal: 0, localOnly: 0, incomingOnly: 0,
            conflicts: 0, resolvedUsingLocal: 0, resolvedUsingIncoming: 0, deletionsWon: 0, conflictIds: [],
        },
    },
    lastSyncHistory: [{
        at: OLDER, status: 'success', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0,
    }],
    pendingRemoteWriteAt: OLDER,
    pendingRemoteWriteRetryAt: OLDER,
    pendingRemoteWriteAttempts: 1,
    notificationsEnabled: true,
    undoNotificationsEnabled: false,
    startDateNotificationsEnabled: true,
    dueDateNotificationsEnabled: false,
    reviewAtNotificationsEnabled: true,
    dailyDigestMorningEnabled: true,
    dailyDigestMorningTime: '07:30',
    dailyDigestEveningEnabled: false,
    dailyDigestEveningTime: '19:30',
    weeklyReviewEnabled: true,
    weeklyReviewDay: 1,
    weeklyReviewTime: '10:00',
});

const asData = (settings: Settings): AppData => ({
    tasks: [], projects: [], sections: [], areas: [], people: [], settings,
});

describe('settings sync scope contract', () => {
    it('every settings key is classified exactly once', () => {
        const source = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
        const declared = [
            ...readInterfaceProperties(source, 'export interface NotificationSettings {'),
            ...readInterfaceProperties(source, 'export interface AppSettings extends NotificationSettings {'),
        ];
        expect(declared.length).toBeGreaterThan(40);

        const classified = new Set([...SYNCED_TOP_LEVEL_KEYS, ...DEVICE_LOCAL_TOP_LEVEL_KEYS]);
        for (const name of declared) {
            expect(
                classified.has(name),
                `Classify "${name}" as synced or device-local in sync-settings-scope.contract.test.ts`,
            ).toBe(true);
        }
        expect([...classified].sort()).toEqual([...new Set(declared)].sort());
        expect(SYNCED_TOP_LEVEL_KEYS.filter((key) => DEVICE_LOCAL_TOP_LEVEL_KEYS.includes(key))).toEqual([]);
    });

    it('only classified-synced keys leave the device', () => {
        const sanitized = sanitizeAppDataForRemote(asData(fullSettings())).settings;
        // undefined values never reach the wire, so drop them the way JSON does.
        const onWire = JSON.parse(JSON.stringify(sanitized)) as Record<string, unknown>;

        expect(Object.keys(onWire).sort()).toEqual([...SYNCED_TOP_LEVEL_KEYS].sort());

        const ai = onWire.ai as Record<string, unknown>;
        expect(ai.apiKey).toBeUndefined();
        expect(ai.baseUrl).toBeUndefined();
        expect(ai.openAIExtraBodyParams).toBeUndefined();
        const speechToText = ai.speechToText as Record<string, unknown>;
        expect(speechToText.offlineModelPath).toBeUndefined();
        expect(speechToText.baseUrl).toBeUndefined();

        expect(onWire.externalCalendars).toEqual([
            { id: 'cal-1', name: 'Work', url: 'https://example.com/work.ics', enabled: true },
        ]);
    });

    it('an incoming document never changes a device-local setting', () => {
        const local = stampAll(fullSettings(), OLDER);
        const incoming = stampAll({
            ...fullSettings(),
            // every device-local key holds a different valid value
            attachments: { lastCleanupAt: NEWER },
            calendar: { viewMode: 'month' },
            calendarSystem: 'gregorian',
            globalQuickAddShortcut: 'ctrl+shift+n',
            window: { decorations: true, closeBehavior: 'quit' },
            savedSearches: [{ id: 'search-2', name: 'Errands', query: '@errands' }],
            savedSearchesUpdatedAt: NEWER,
            sidebarCollapsed: false,
            taskSortBy: 'title',
            diagnostics: { loggingEnabled: false },
            analytics: { heartbeatEnabled: true },
            security: { mobileAppLockEnabled: false, mobileAppLockRelockDelayMinutes: 15 },
            network: { proxyUrl: 'http://other-proxy.local:9090' },
            filters: { areaId: 'area-2', areaIds: ['area-2'] },
            deviceId: 'remote-device-id',
            migrations: { version: 9 },
            lastSyncAt: NEWER,
            lastSyncStatus: 'error',
            lastSyncError: 'remote error',
            lastSyncStats: undefined,
            lastSyncHistory: [{
                at: NEWER, status: 'error', conflicts: 1, conflictIds: ['t1'], maxClockSkewMs: 5, timestampAdjustments: 1,
            }],
            pendingRemoteWriteAt: NEWER,
            pendingRemoteWriteRetryAt: NEWER,
            pendingRemoteWriteAttempts: 7,
            notificationsEnabled: false,
            undoNotificationsEnabled: true,
            startDateNotificationsEnabled: false,
            dueDateNotificationsEnabled: true,
            reviewAtNotificationsEnabled: false,
            dailyDigestMorningEnabled: false,
            dailyDigestMorningTime: '06:00',
            dailyDigestEveningEnabled: true,
            dailyDigestEveningTime: '21:00',
            weeklyReviewEnabled: false,
            weeklyReviewDay: 5,
            weeklyReviewTime: '16:00',
            // AI credentials, endpoints and local paths must not arrive either
            ai: {
                enabled: true,
                provider: 'openai',
                model: 'incoming-model',
                apiKey: 'remote-secret',
                baseUrl: 'https://other-host.example/v1',
                openAIExtraBodyParams: { x: 1 },
                speechToText: {
                    enabled: true,
                    provider: 'openai',
                    model: 'local-speech',
                    baseUrl: 'https://other-host.example/v1',
                    offlineModelPath: '/remote/model.bin',
                },
            },
        }, NEWER);

        const merged = mergeSettingsForSync(local, incoming);

        for (const key of DEVICE_LOCAL_TOP_LEVEL_KEYS) {
            expect(
                merged[key as keyof Settings],
                `device-local setting "${key}" was changed by the incoming document`,
            ).toEqual(local[key as keyof Settings]);
        }

        expect(merged.ai?.baseUrl).toBe('http://localhost:1234/v1');
        expect(merged.ai?.openAIExtraBodyParams).toEqual({ keep: true });
        expect(merged.ai?.speechToText?.baseUrl).toBe('http://localhost:8000/v1');
        expect(merged.ai?.speechToText?.offlineModelPath).toBe('/local/model.bin');
        expect(merged.ai?.apiKey).toBeUndefined();
        // Fields outside the device-local set still sync.
        expect(merged.ai?.model).toBe('incoming-model');

        expect(mergeSettingsForSync(merged, incoming)).toEqual(merged);
    });
});
