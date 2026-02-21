import { describe, expect, it } from 'vitest';
import {
    areSyncPayloadsEqual,
    assertNoPendingAttachmentUploads,
    findPendingAttachmentUploads,
    sanitizeAppDataForRemote,
} from './sync-helpers';
import type { AppData, Attachment } from './types';

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
                    ai: true,
                },
                syncPreferencesUpdatedAt: {
                    appearance: now,
                    language: now,
                    externalCalendars: now,
                    ai: now,
                    preferences: now,
                },
                theme: 'dark',
                appearance: { density: 'compact' },
                keybindingStyle: 'emacs',
                globalQuickAddShortcut: 'ctrl+alt+m',
                language: 'zh',
                weekStart: 'monday',
                dateFormat: 'yyyy-MM-dd',
                externalCalendars: [{ id: 'cal-1', name: 'Work', url: 'https://example.com/work.ics', enabled: true }],
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
        expect(sanitized.settings.appearance).toEqual({ density: 'compact' });
        expect(sanitized.settings.keybindingStyle).toBe('emacs');
        expect(sanitized.settings.externalCalendars).toEqual(data.settings.externalCalendars);

        expect(sanitized.settings.language).toBeUndefined();
        expect(sanitized.settings.weekStart).toBeUndefined();
        expect(sanitized.settings.dateFormat).toBeUndefined();

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
        expect(sanitized.settings.gtd).toBeUndefined();
        expect(sanitized.settings.features).toBeUndefined();
        expect(sanitized.settings.taskSortBy).toBeUndefined();
        expect(sanitized.settings.sidebarCollapsed).toBeUndefined();
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
