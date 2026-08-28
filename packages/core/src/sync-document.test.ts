import { describe, expect, it } from 'vitest';
import {
    areRemoteSyncDocumentsEqual,
    computeRemoteSyncDocumentFingerprint,
    computeSyncPayloadFingerprint,
    parseSyncDocument,
    toRemoteSyncDocument,
} from './index';
import type { AppData } from './types';

const NOW = '2026-08-01T12:00:00.000Z';

const createData = (title = 'Task'): AppData => ({
    tasks: [{
        id: 'task-1',
        title,
        status: 'inbox',
        tags: [],
        contexts: [],
        createdAt: NOW,
        updatedAt: NOW,
    }],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
});

describe('Sync document lifecycle', () => {
    it('accepts old partial documents and normalizes them idempotently', () => {
        const first = parseSyncDocument({
            tasks: [],
            projects: [],
            areas: [],
            settings: {},
        }, 'remote');

        expect(first).toEqual({
            ok: true,
            data: {
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                people: [],
                settings: {},
            },
        });
        if (!first.ok) throw new Error('Expected the partial document to be accepted');

        expect(parseSyncDocument(first.data, 'remote')).toEqual(first);
    });

    it('reports malformed raw fields before normalization can replace them', () => {
        const result = parseSyncDocument({ tasks: 'not-an-array' }, 'remote');

        expect(result).toEqual({
            ok: false,
            errors: ['remote payload field "tasks" must be an array when present'],
        });
    });

    it('rejects malformed entity envelopes before merge code dereferences them', () => {
        for (const surface of ['tasks', 'projects', 'sections', 'areas', 'people'] as const) {
            expect(parseSyncDocument({ [surface]: [null] }, 'remote')).toEqual({
                ok: false,
                errors: [`remote payload field "${surface}[0]" must be an object`],
            });
            expect(parseSyncDocument({ [surface]: [{}] }, 'remote')).toEqual({
                ok: false,
                errors: [`remote payload field "${surface}[0].id" must be a non-empty string`],
            });
        }
    });

    it('strips device-local file state from remote attachments without applying outbound tombstones', () => {
        const data = createData();
        const fileAttachment = {
            id: 'file-1',
            kind: 'file' as const,
            title: 'notes.txt',
            uri: '/device/private/notes.txt',
            cloudKey: 'attachments/file-1.txt',
            fileHash: 'a'.repeat(64),
            contentRev: 3,
            contentMtimeMs: 1234,
            contentSize: 42,
            pendingContentUpload: true,
            localStatus: 'available' as const,
            createdAt: NOW,
            updatedAt: NOW,
        };
        const missingWithoutCloudKey = {
            ...fileAttachment,
            id: 'file-2',
            uri: '/device/private/missing.txt',
            cloudKey: undefined,
            localStatus: 'missing' as const,
        };
        const linkAttachment = {
            id: 'link-1',
            kind: 'link' as const,
            title: 'Reference',
            uri: 'https://example.com/reference',
            createdAt: NOW,
            updatedAt: NOW,
        };
        data.tasks[0].attachments = [fileAttachment, linkAttachment];
        data.projects = [{
            id: 'project-1',
            title: 'Project',
            status: 'active',
            createdAt: NOW,
            updatedAt: NOW,
            attachments: [missingWithoutCloudKey],
        }];

        const parsed = parseSyncDocument(data, 'remote');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error('Expected the remote document to parse');

        expect(parsed.data.tasks[0].attachments).toEqual([{
            id: fileAttachment.id,
            kind: fileAttachment.kind,
            title: fileAttachment.title,
            uri: '',
            cloudKey: fileAttachment.cloudKey,
            fileHash: fileAttachment.fileHash,
            contentRev: fileAttachment.contentRev,
            createdAt: NOW,
            updatedAt: NOW,
        }, linkAttachment]);
        expect(parsed.data.projects[0].attachments?.[0]).toEqual({
            id: missingWithoutCloudKey.id,
            kind: missingWithoutCloudKey.kind,
            title: missingWithoutCloudKey.title,
            uri: '',
            cloudKey: undefined,
            fileHash: missingWithoutCloudKey.fileHash,
            contentRev: missingWithoutCloudKey.contentRev,
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(parsed.data.projects[0].attachments?.[0]?.deletedAt).toBeUndefined();
    });

    it('preserves device-local attachment state when parsing local persistence', () => {
        const data = createData();
        const attachment = {
            id: 'pending-file',
            kind: 'file' as const,
            title: 'pending.txt',
            uri: '/managed/pending.txt',
            cloudKey: 'attachments/pending-file.txt',
            fileHash: 'b'.repeat(64),
            contentRev: 2,
            contentMtimeMs: 4321,
            contentSize: 24,
            pendingContentUpload: true,
            localStatus: 'available' as const,
            createdAt: NOW,
            updatedAt: NOW,
        };
        data.tasks[0].attachments = [attachment];

        const parsed = parseSyncDocument(data, 'local');

        expect(parsed).toEqual({ ok: true, data });
    });

    it('uses the same remote shape for equality and fingerprints', () => {
        const left = createData();
        left.settings.lastSyncAt = NOW;
        left.settings.lastSyncStatus = 'success';
        const right = createData();
        right.settings.lastSyncAt = '2026-08-02T12:00:00.000Z';
        right.settings.lastSyncStatus = 'error';

        const leftRemote = toRemoteSyncDocument(left);
        const rightRemote = toRemoteSyncDocument(right);

        expect(areRemoteSyncDocumentsEqual(leftRemote, rightRemote)).toBe(true);
        expect(computeRemoteSyncDocumentFingerprint(leftRemote)).toBe(
            computeRemoteSyncDocumentFingerprint(rightRemote),
        );
        expect(computeRemoteSyncDocumentFingerprint(leftRemote)).toBe(
            computeSyncPayloadFingerprint(left),
        );

        const changedRemote = toRemoteSyncDocument(createData('Changed'));
        expect(areRemoteSyncDocumentsEqual(leftRemote, changedRemote)).toBe(false);
        expect(computeRemoteSyncDocumentFingerprint(leftRemote)).not.toBe(
            computeRemoteSyncDocumentFingerprint(changedRemote),
        );
    });
});
