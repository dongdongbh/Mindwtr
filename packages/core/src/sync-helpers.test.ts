import { describe, expect, it } from 'vitest';
import {
    areSyncPayloadsEqual,
    assertNoPendingAttachmentUploads,
    computeCoveredSettingsFingerprint,
    computeSyncChangeFingerprint,
    computeSyncPayloadFingerprint,
    findPendingAttachmentUploads,
    hasPendingSyncSideEffects,
    normalizeCloudUrl,
    normalizeWebdavUrl,
    sanitizeAppDataForRemote,
} from './sync-helpers';
import { GTD_SYNCED_FIELD_KEYS, type GtdSyncedFieldKey } from './settings-options';
import { mergeSettingsForSync } from './sync-merge-settings';
import type { AppData, Attachment, GtdSettings } from './types';

// One representative, distinct-from-default value per gtd synced field, used
// to drive the allowlist-drift guard test below without hardcoding the field
// list a second time.
const GTD_SYNCED_FIELD_SAMPLE_VALUES: Record<GtdSyncedFieldKey, GtdSettings[GtdSyncedFieldKey]> = {
    defaultScheduleTime: '09:30',
    defaultAreaMode: 'fixed',
    defaultAreaId: 'area-1',
    focusTaskLimit: 5,
    focusGroupBy: 'project',
    defaultProjectFlowMode: 'sequential',
    naturalLanguageDates: false,
    taskEditor: {
        order: ['status', 'priority'],
        hidden: ['energyLevel'],
        sectionOpen: { scheduling: true },
        defaultsVersion: 4,
    },
    viewSections: {
        someday: [{ id: 'books', title: 'Books to read', order: 0 }],
    },
};

const now = '2026-02-19T00:00:00.000Z';

const fileAttachment = (overrides: Partial<Attachment> = {}): Attachment => ({
    id: 'att-1',
    kind: 'file',
    title: 'photo.jpg',
    uri: '/tmp/photo.jpg',
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const createData = (attachments: Attachment[]): AppData => ({
    tasks: [
        {
            id: 'task-1',
            title: 'Task',
            status: 'inbox',
            tags: [],
            contexts: [],
            attachments,
            createdAt: now,
            updatedAt: now,
        },
    ],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
});

describe('sync-helpers normalizeCloudUrl', () => {
    it('appends /v1/data to a bare self-hosted base URL', () => {
        expect(normalizeCloudUrl('https://example.com')).toBe('https://example.com/v1/data');
        expect(normalizeCloudUrl('https://example.com/mindwtr/')).toBe('https://example.com/mindwtr/v1/data');
    });

    it('appends /data when the versioned API base is already provided', () => {
        expect(normalizeCloudUrl('https://example.com/v1')).toBe('https://example.com/v1/data');
        expect(normalizeCloudUrl('https://example.com/api/v2/')).toBe('https://example.com/api/v2/data');
    });

    it('preserves full data endpoints for compatibility', () => {
        expect(normalizeCloudUrl('https://example.com/v1/data')).toBe('https://example.com/v1/data');
        expect(normalizeCloudUrl('https://example.com/data/')).toBe('https://example.com/data');
    });
});

describe('sync-helpers normalizeWebdavUrl', () => {
    it('strips cache-busting query strings before appending data.json', () => {
        expect(normalizeWebdavUrl('https://dav.example.com/mindwtr?_=1782668355219')).toBe(
            'https://dav.example.com/mindwtr/data.json'
        );
        expect(normalizeWebdavUrl('https://dav.example.com/mindwtr/#sync')).toBe(
            'https://dav.example.com/mindwtr/data.json#sync'
        );
    });

    it('strips cache-busting query strings from existing WebDAV data file URLs', () => {
        expect(normalizeWebdavUrl('https://dav.example.com/mindwtr/data.json?_=1782668355219')).toBe(
            'https://dav.example.com/mindwtr/data.json'
        );
    });
});

describe('sync-helpers pending attachment uploads', () => {
    it('detects file attachments with local uri and missing cloud key', () => {
        const data = createData([fileAttachment()]);
        const pending = findPendingAttachmentUploads(data);

        expect(pending).toEqual([
            {
                ownerType: 'task',
                ownerId: 'task-1',
                attachmentId: 'att-1',
                title: 'photo.jpg',
                uriScheme: 'file',
                localStatus: undefined,
            },
        ]);
    });

    it('ignores attachments that are already uploaded, remote links, or marked missing', () => {
        const data = createData([
            fileAttachment({ id: 'uploaded', cloudKey: 'attachments/uploaded.jpg' }),
            fileAttachment({ id: 'remote', uri: 'https://example.com/photo.jpg' }),
            fileAttachment({ id: 'missing', localStatus: 'missing' }),
            {
                id: 'link-1',
                kind: 'link',
                title: 'Web',
                uri: 'https://example.com',
                createdAt: now,
                updatedAt: now,
            },
        ]);

        expect(findPendingAttachmentUploads(data)).toHaveLength(0);
    });

    it('ignores attachments whose parent task is deleted', () => {
        const data = createData([fileAttachment()]);
        data.tasks[0].deletedAt = now;

        expect(findPendingAttachmentUploads(data)).toHaveLength(0);
    });

    it('throws a clear error when pending uploads remain before remote write', () => {
        const data = createData([
            fileAttachment({ id: 'att-1' }),
            fileAttachment({ id: 'att-2', uri: 'content://attachment/att-2' }),
        ]);

        expect(() => assertNoPendingAttachmentUploads(data)).toThrow(
            'Attachment upload incomplete: 2 file attachment(s) are still pending upload'
        );
    });
});

describe('sync-helpers pending sync side effects', () => {
    it('stays false for clean sync data', () => {
        expect(hasPendingSyncSideEffects(createData([]))).toBe(false);
    });

    it('detects pending remote writes, uploads, and remote deletes', () => {
        const pendingWrite = createData([]);
        pendingWrite.settings.pendingRemoteWriteAt = now;
        expect(hasPendingSyncSideEffects(pendingWrite)).toBe(true);

        expect(hasPendingSyncSideEffects(createData([fileAttachment()]))).toBe(true);

        const pendingDelete = createData([]);
        pendingDelete.settings.attachments = {
            pendingRemoteDeletes: [{
                attachmentId: 'att-1',
                cloudKey: 'attachments/att-1.jpg',
                queuedAt: now,
                ownerType: 'task',
                ownerId: 'task-1',
            }],
        };
        expect(hasPendingSyncSideEffects(pendingDelete)).toBe(true);
    });
});

describe('sync-helpers sanitizeAppDataForRemote', () => {
    it('keeps only sync-eligible settings groups for remote payloads', () => {
        const data: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                gtd: { autoArchiveDays: 7 },
                features: { priorities: true },
                notificationsEnabled: false,
                weeklyReviewEnabled: true,
                window: { decorations: false, closeBehavior: 'tray' },
                diagnostics: { loggingEnabled: true },
                analytics: { heartbeatEnabled: false },
                network: { proxyUrl: 'http://user:pass@proxy.local:8080' },
                taskSortBy: 'updatedAt',
                sidebarCollapsed: true,
                deviceId: 'local-device-id',
                lastSyncAt: now,
                lastSyncStatus: 'success',
                lastSyncError: 'x',
                lastSyncHistory: [
                    {
                        at: now,
                        status: 'success',
                        conflicts: 0,
                        conflictIds: [],
                        maxClockSkewMs: 0,
                        timestampAdjustments: 0,
                    },
                ],
                syncPreferences: {
                    appearance: true,
                    language: false,
                    externalCalendars: true,
                    savedFilters: true,
                    ai: true,
                },
                syncPreferencesUpdatedAt: {
                    appearance: now,
                    language: now,
                    externalCalendars: now,
                    savedFilters: now,
                    ai: now,
                    preferences: now,
                },
                theme: 'dark',
                appearance: { density: 'compact', textSize: 'small', mobileQuickAccessView: 'contexts' },
                keybindingStyle: 'emacs',
                globalQuickAddShortcut: 'ctrl+alt+m',
                language: 'zh',
                weekStart: 'monday',
                dateFormat: 'yyyy-MM-dd',
                timeFormat: '24h',
                externalCalendars: [
                    { id: 'cal-1', name: 'Work', url: 'https://example.com/work.ics', enabled: true },
                    { id: 'cal-local', name: 'Local', url: 'file:///home/user/agenda.ics', enabled: true },
                    { id: 'cal-android-local', name: 'Android Local', url: 'content://com.android.providers.media.documents/document/calendar.ics', enabled: true },
                ],
                savedFilters: [{
                    id: 'filter-1',
                    name: 'Desk',
                    view: 'focus',
                    criteria: { contexts: ['@desk'] },
                    createdAt: now,
                    updatedAt: now,
                }],
                ai: {
                    enabled: true,
                    provider: 'openai',
                    apiKey: 'secret',
                    speechToText: {
                        enabled: true,
                        provider: 'whisper',
                        offlineModelPath: '/tmp/model.bin',
                    },
                },
            },
        };

        const sanitized = sanitizeAppDataForRemote(data);

        expect(sanitized.settings.syncPreferences).toEqual(data.settings.syncPreferences);
        expect(sanitized.settings.syncPreferencesUpdatedAt).toEqual(data.settings.syncPreferencesUpdatedAt);
        expect(sanitized.settings.theme).toBe('dark');
        expect(sanitized.settings.appearance).toEqual({ density: 'compact', textSize: 'small', mobileQuickAccessView: 'contexts' });
        expect(sanitized.settings.keybindingStyle).toBe('emacs');
        expect(sanitized.settings.externalCalendars).toEqual([
            { id: 'cal-1', name: 'Work', url: 'https://example.com/work.ics', enabled: true },
        ]);
        expect(sanitized.settings.savedFilters).toEqual(data.settings.savedFilters);

        expect(sanitized.settings.language).toBeUndefined();
        expect(sanitized.settings.weekStart).toBeUndefined();
        expect(sanitized.settings.dateFormat).toBeUndefined();
        expect(sanitized.settings.timeFormat).toBeUndefined();

        expect(sanitized.settings.ai?.apiKey).toBeUndefined();
        expect(sanitized.settings.ai?.speechToText?.offlineModelPath).toBeUndefined();

        expect(sanitized.settings.globalQuickAddShortcut).toBeUndefined();
        expect(sanitized.settings.deviceId).toBeUndefined();
        expect(sanitized.settings.lastSyncAt).toBeUndefined();
        expect(sanitized.settings.lastSyncStatus).toBeUndefined();
        expect(sanitized.settings.lastSyncError).toBeUndefined();
        expect(sanitized.settings.lastSyncHistory).toBeUndefined();
        expect(sanitized.settings.window).toBeUndefined();
        expect(sanitized.settings.notificationsEnabled).toBeUndefined();
        expect(sanitized.settings.diagnostics).toBeUndefined();
        expect(sanitized.settings.analytics).toBeUndefined();
        expect(sanitized.settings.network).toBeUndefined();
        expect(sanitized.settings.gtd).toBeUndefined();
        expect(sanitized.settings.features).toBeUndefined();
        expect(sanitized.settings.taskSortBy).toBeUndefined();
        expect(sanitized.settings.sidebarCollapsed).toBeUndefined();
    });

    it('includes synced GTD preferences', () => {
        const data = createData([]);
        data.settings = {
            syncPreferences: { gtd: true, language: true },
            gtd: {
                defaultScheduleTime: '09:30',
                defaultAreaMode: 'fixed',
                defaultAreaId: 'area-1',
                focusTaskLimit: 5,
                focusGroupBy: 'project',
                defaultProjectFlowMode: 'sequential',
                inboxProcessing: { scheduleEnabled: true },
            },
            language: 'en',
            timeFormat: '24h',
        };

        const sanitized = sanitizeAppDataForRemote(data);

        expect(sanitized.settings.gtd).toEqual({
            defaultScheduleTime: '09:30',
            defaultAreaMode: 'fixed',
            defaultAreaId: 'area-1',
            focusTaskLimit: 5,
            focusGroupBy: 'project',
            defaultProjectFlowMode: 'sequential',
        });
        expect(sanitized.settings.language).toBe('en');
        expect(sanitized.settings.timeFormat).toBe('24h');
    });

    it('uploads a default area that is the only GTD preference set (#default-area-sync)', () => {
        const data = createData([]);
        data.settings = {
            syncPreferences: { gtd: true },
            gtd: { defaultAreaId: 'area-1', defaultAreaMode: 'fixed' },
        };

        const sanitized = sanitizeAppDataForRemote(data);

        expect(sanitized.settings.gtd).toEqual({
            defaultAreaMode: 'fixed',
            defaultAreaId: 'area-1',
        });
    });

    it('does not include the default schedule time with only synced date/time preferences', () => {
        const data = createData([]);
        data.settings = {
            syncPreferences: { language: true },
            gtd: {
                defaultScheduleTime: '09:30',
            },
            language: 'en',
            timeFormat: '24h',
        };

        const sanitized = sanitizeAppDataForRemote(data);

        expect(sanitized.settings.gtd).toBeUndefined();
        expect(sanitized.settings.language).toBe('en');
        expect(sanitized.settings.timeFormat).toBe('24h');
    });

    // Guard against allowlist drift (this is the second incident — see
    // naturalLanguageDates below): every field in GTD_SYNCED_FIELD_KEYS must
    // round-trip through sanitizeAppDataForRemote on its own. A field that is
    // wired into the merge side (sync-merge-settings.ts) but missing from the
    // upload allowlist silently never leaves the device.
    for (const key of GTD_SYNCED_FIELD_KEYS) {
        it(`uploads the gtd.${key} field in isolation`, () => {
            const data = createData([]);
            data.settings = {
                syncPreferences: { gtd: true },
                gtd: { [key]: GTD_SYNCED_FIELD_SAMPLE_VALUES[key] },
            };

            const sanitized = sanitizeAppDataForRemote(data);

            expect(sanitized.settings.gtd).toEqual({ [key]: GTD_SYNCED_FIELD_SAMPLE_VALUES[key] });
        });
    }

    it('uploads gtd.naturalLanguageDates: false — false is meaningful and must not be dropped as falsy', () => {
        const data = createData([]);
        data.settings = {
            syncPreferences: { gtd: true },
            gtd: { naturalLanguageDates: false, focusTaskLimit: 5 },
        };

        const sanitized = sanitizeAppDataForRemote(data);

        expect(sanitized.settings.gtd).toEqual({ naturalLanguageDates: false, focusTaskLimit: 5 });
    });

    it('round-trips gtd.naturalLanguageDates: false through sanitize then merge into an older peer', () => {
        const data = createData([]);
        data.settings = {
            syncPreferences: { gtd: true },
            syncPreferencesUpdatedAt: { gtd: '2026-07-20T00:00:00.000Z' },
            gtd: { naturalLanguageDates: false },
        };

        const sanitized = sanitizeAppDataForRemote(data);

        const peerSettings: AppData['settings'] = {
            gtd: { naturalLanguageDates: true },
            syncPreferencesUpdatedAt: { gtd: '2026-07-01T00:00:00.000Z' },
        };

        const merged = mergeSettingsForSync(peerSettings, sanitized.settings);

        expect(merged.gtd?.naturalLanguageDates).toBe(false);
    });

    it('sanitizes file attachment URIs while preserving cloud metadata', () => {
        const data: AppData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Task',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                    attachments: [
                        {
                            id: 'att-1',
                            kind: 'file',
                            title: 'a.pdf',
                            uri: '/storage/a.pdf',
                            cloudKey: 'attachments/a.pdf',
                            fileHash: 'hash-a',
                            localStatus: 'available',
                            createdAt: now,
                            updatedAt: now,
                        },
                    ],
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        const sanitized = sanitizeAppDataForRemote(data);
        const attachment = sanitized.tasks[0]?.attachments?.[0];

        expect(attachment).toMatchObject({
            id: 'att-1',
            kind: 'file',
            uri: '',
            cloudKey: 'attachments/a.pdf',
            fileHash: 'hash-a',
        });
        expect(attachment?.localStatus).toBeUndefined();
    });

    it('omits permanently deleted content from remote payloads', () => {
        const data = createData([fileAttachment({ id: 'private-attachment' })]);
        data.tasks[0] = {
            ...data.tasks[0],
            title: 'Private task',
            description: 'Private task notes',
            deletedAt: now,
            purgedAt: now,
        };
        data.projects = [{
            id: 'private-project',
            title: 'Private project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            supportNotes: 'Private project notes',
            createdAt: now,
            updatedAt: now,
            deletedAt: now,
            purgedAt: now,
        }];
        data.sections = [{
            id: 'private-section',
            projectId: 'private-project',
            title: 'Private section',
            description: 'Private section notes',
            order: 0,
            createdAt: now,
            updatedAt: now,
            deletedAt: now,
        }];

        const sanitized = sanitizeAppDataForRemote(data);

        expect(sanitized.tasks[0].title).toBe('(deleted)');
        expect(sanitized.tasks[0].description).toBeUndefined();
        expect(sanitized.tasks[0].attachments).toBeUndefined();
        expect(sanitized.projects[0].title).toBe('(deleted)');
        expect(sanitized.projects[0].supportNotes).toBeUndefined();
        expect(sanitized.sections[0].title).toBe('');
        expect(sanitized.sections[0].description).toBeUndefined();
        expect(JSON.stringify(sanitized)).not.toContain('Private');
    });

    it('keeps live file attachments that have neither uri nor cloudKey unless marked missing', () => {
        const data = createData([
            fileAttachment({
                id: 'missing-reference',
                uri: '',
                cloudKey: undefined,
            }),
        ]);

        const sanitized = sanitizeAppDataForRemote(data);
        const attachment = sanitized.tasks[0]?.attachments?.[0];
        expect(attachment).toBeDefined();
        expect(attachment?.deletedAt).toBeUndefined();
        expect(attachment?.uri).toBe('');
        expect(attachment?.cloudKey).toBeUndefined();
    });

    it('tombstones missing local file attachments that have no cloud key', () => {
        const data = createData([
            fileAttachment({
                id: 'missing-local-file',
                uri: '',
                cloudKey: undefined,
                localStatus: 'missing',
            }),
        ]);

        const sanitized = sanitizeAppDataForRemote(data);
        const attachment = sanitized.tasks[0]?.attachments?.[0];
        expect(attachment).toBeDefined();
        expect(attachment?.deletedAt).toBeDefined();
        expect(attachment?.uri).toBe('');
        expect(attachment?.cloudKey).toBeUndefined();
        expect(attachment?.localStatus).toBeUndefined();
    });

    it('tombstones local-only file attachments on deleted tasks before remote sync', () => {
        const data = createData([fileAttachment({ id: 'deleted-parent-attachment' })]);
        data.tasks[0].deletedAt = now;

        const sanitized = sanitizeAppDataForRemote(data);
        const attachment = sanitized.tasks[0]?.attachments?.[0];

        expect(attachment).toBeDefined();
        expect(attachment?.deletedAt).toBe(now);
        expect(attachment?.uri).toBe('');
        expect(attachment?.cloudKey).toBeUndefined();
        expect(attachment?.localStatus).toBeUndefined();
    });
});

describe('sync-helpers areSyncPayloadsEqual', () => {
    it('treats payloads as equal when object key order differs', () => {
        const left: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                syncPreferences: { appearance: true, language: true },
                syncPreferencesUpdatedAt: {
                    language: now,
                    appearance: now,
                },
                theme: 'dark',
            },
        };
        const right: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                theme: 'dark',
                syncPreferencesUpdatedAt: {
                    appearance: now,
                    language: now,
                },
                syncPreferences: { language: true, appearance: true },
            },
        };

        expect(areSyncPayloadsEqual(left, right)).toBe(true);
    });

    it('detects real payload differences', () => {
        const left: AppData = {
            tasks: [{
                id: 't1',
                title: 'A',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: now,
                updatedAt: now,
            }],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const right: AppData = {
            ...left,
            tasks: [{ ...left.tasks[0], title: 'B' }],
        };

        expect(areSyncPayloadsEqual(left, right)).toBe(false);
    });
});

describe('sync-helpers computeCoveredSettingsFingerprint', () => {
    it('changes when a device-local field like the area filter changes (#316)', () => {
        const before = computeCoveredSettingsFingerprint({
            filters: { areaIds: ['area-1'] },
        } as AppData['settings']);
        const after = computeCoveredSettingsFingerprint({
            filters: { areaIds: ['area-2'] },
        } as AppData['settings']);
        expect(after).not.toBe(before);
    });

    it('ignores sync status bookkeeping fields the running cycle rewrites', () => {
        const before = computeCoveredSettingsFingerprint({
            filters: { areaIds: ['area-1'] },
            lastSyncAt: '2026-04-01T00:00:00.000Z',
            lastSyncStatus: 'success',
        } as AppData['settings']);
        const after = computeCoveredSettingsFingerprint({
            filters: { areaIds: ['area-1'] },
            lastSyncAt: '2026-04-02T00:00:00.000Z',
            lastSyncStatus: 'error',
            lastSyncError: 'offline',
        } as AppData['settings']);
        expect(after).toBe(before);
    });

    it('changes when the device proxy changes during a sync cycle', () => {
        const before = computeCoveredSettingsFingerprint({
            network: { proxyUrl: 'http://proxy-one.local:8080' },
        } as AppData['settings']);
        const after = computeCoveredSettingsFingerprint({
            network: { proxyUrl: 'http://proxy-two.local:8080' },
        } as AppData['settings']);
        expect(after).not.toBe(before);
    });
});

describe('sync-helpers computeSyncPayloadFingerprint', () => {
    it('ignores device-local sync status fields', () => {
        const left: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                lastSyncAt: '2026-04-01T00:00:00.000Z',
                lastSyncStatus: 'success',
                lastSyncError: undefined,
            },
        };
        const right: AppData = {
            ...left,
            settings: {
                lastSyncAt: '2026-04-02T00:00:00.000Z',
                lastSyncStatus: 'error',
                lastSyncError: 'temporary network error',
            },
        };

        expect(computeSyncPayloadFingerprint(left)).toBe(computeSyncPayloadFingerprint(right));
    });

    it('changes when sync-eligible content changes', () => {
        const left = createData([]);
        const right = createData([]);
        right.tasks[0].title = 'Changed';

        expect(computeSyncPayloadFingerprint(left)).not.toBe(computeSyncPayloadFingerprint(right));
    });

    it('agrees with the cheap change fingerprint on what counts as a change', () => {
        const unchanged = createData([]);
        const edited = createData([]);
        edited.tasks[0].updatedAt = '2026-02-20T00:00:00.000Z';
        edited.tasks[0].rev = 2;

        expect(computeSyncChangeFingerprint(unchanged)).toBe(computeSyncChangeFingerprint(createData([])));
        expect(computeSyncChangeFingerprint(unchanged)).not.toBe(computeSyncChangeFingerprint(edited));
    });

    it('cheap change fingerprint ignores device-local sync status churn', () => {
        const before = createData([]);
        const after: AppData = {
            ...before,
            settings: {
                ...before.settings,
                lastSyncAt: '2026-04-02T00:00:00.000Z',
                lastSyncStatus: 'error',
                lastSyncError: 'temporary network error',
                lastSyncHistory: [{ at: '2026-04-02T00:00:00.000Z', status: 'error' }],
            } as AppData['settings'],
        };

        expect(computeSyncChangeFingerprint(after)).toBe(computeSyncChangeFingerprint(before));
    });

    it('cheap change fingerprint notices added, removed and deleted entities', () => {
        const base = createData([]);
        const added: AppData = { ...base, tasks: [...base.tasks, { ...base.tasks[0], id: 'task-2' }] };
        const removed: AppData = { ...base, tasks: [] };
        const deleted: AppData = { ...base, tasks: [{ ...base.tasks[0], deletedAt: now }] };
        const entityAdditions: AppData[] = [
            {
                ...base,
                projects: [{
                    id: 'project-1',
                    title: 'P',
                    status: 'active',
                    color: '#fff',
                    order: 0,
                    tagIds: [],
                    createdAt: now,
                    updatedAt: now,
                }],
            },
            {
                ...base,
                sections: [{
                    id: 'section-1',
                    projectId: 'project-1',
                    title: 'S',
                    order: 0,
                    createdAt: now,
                    updatedAt: now,
                }],
            },
            {
                ...base,
                areas: [{ id: 'area-1', name: 'A', order: 0, createdAt: now, updatedAt: now }],
            },
            {
                ...base,
                people: [{ id: 'person-1', name: 'P', createdAt: now, updatedAt: now }],
            },
            {
                ...base,
                settings: { syncPreferences: { appearance: true }, theme: 'dark' },
            },
        ];

        const baseFingerprint = computeSyncChangeFingerprint(base);
        expect(computeSyncChangeFingerprint(added)).not.toBe(baseFingerprint);
        expect(computeSyncChangeFingerprint(removed)).not.toBe(baseFingerprint);
        expect(computeSyncChangeFingerprint(deleted)).not.toBe(baseFingerprint);
        for (const changed of entityAdditions) {
            expect(computeSyncChangeFingerprint(changed)).not.toBe(baseFingerprint);
        }
    });

    it('uses a deterministic fallback timestamp for missing file attachments', () => {
        const data = createData([
            fileAttachment({
                updatedAt: '',
                localStatus: 'missing',
                cloudKey: undefined,
            }),
        ]);

        const sanitized = sanitizeAppDataForRemote(data);
        const attachment = sanitized.tasks[0].attachments?.[0];
        expect(attachment?.updatedAt).toBe('1970-01-01T00:00:00.000Z');
        expect(attachment?.deletedAt).toBe('1970-01-01T00:00:00.000Z');
        expect(computeSyncPayloadFingerprint(data)).toBe(computeSyncPayloadFingerprint(data));
    });
});
