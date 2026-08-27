import { describe, expect, it, vi } from 'vitest';
import {
    applyAttachmentCleanupResult,
    findDeletedAttachmentsForFileCleanup,
    findLiveAttachmentResourceReferences,
    findOrphanedAttachments,
    hasFreshAttachmentCleanupWork,
    isAttachmentCloudResourceReferenced,
    isAttachmentLocalResourceReferenced,
    PENDING_REMOTE_ATTACHMENT_DELETE_MAX_ATTEMPTS,
    runAttachmentCleanupLifecycle,
} from './attachment-cleanup';
import type { AppData, Attachment } from './types';

const buildData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
});

describe('findOrphanedAttachments', () => {
    it('treats deleted attachments on active tasks as orphaned cleanup candidates', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'inbox',
            contexts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'file',
                    uri: '/tmp/file',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: new Date().toISOString(),
                },
            ],
        });

        const orphaned = findOrphanedAttachments(data);
        expect(orphaned.map((attachment) => attachment.id)).toEqual(['a1']);
    });

    it('keeps attachments on deleted but restorable tasks', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'done',
            contexts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'file',
                    uri: '/tmp/file',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            ],
        });

        const orphaned = findOrphanedAttachments(data);
        expect(orphaned).toHaveLength(0);
    });

    it('detects attachments on purged tasks', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'done',
            contexts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            purgedAt: new Date().toISOString(),
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'file',
                    uri: '/tmp/file',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            ],
        });

        const orphaned = findOrphanedAttachments(data);
        expect(orphaned.map((a) => a.id)).toEqual(['a1']);
    });

    it('keeps attachments on deleted but restorable projects until purge', () => {
        const data = buildData();
        data.projects.push({
            id: 'p1',
            title: 'Project',
            status: 'active',
            color: '#2563eb',
            order: 0,
            tagIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            attachments: [{
                id: 'a1',
                kind: 'file',
                title: 'file',
                uri: '/tmp/project-file',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }],
        });

        expect(findOrphanedAttachments(data)).toHaveLength(0);

        data.projects[0].purgedAt = new Date().toISOString();
        expect(findOrphanedAttachments(data).map((attachment) => attachment.id)).toEqual(['a1']);
    });

    it('keeps attachments referenced by active tasks', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'inbox',
            contexts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'file',
                    uri: '/tmp/file',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            ],
        });

        const orphaned = findOrphanedAttachments(data);
        expect(orphaned).toHaveLength(0);
    });
});

describe('findDeletedAttachmentsForFileCleanup', () => {
    it('finds deleted attachments on active tasks and projects', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'inbox',
            contexts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'audio',
                    uri: '',
                    cloudKey: 'attachments/a1.m4a',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: new Date().toISOString(),
                },
            ],
        });
        data.projects.push({
            id: 'p1',
            title: 'Project',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attachments: [
                {
                    id: 'a2',
                    kind: 'file',
                    title: 'doc',
                    uri: '/tmp/doc',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: new Date().toISOString(),
                },
            ],
        });

        const deleted = findDeletedAttachmentsForFileCleanup(data);
        expect(deleted.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    });

    it('returns deleted attachments even when parents are deleted', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'done',
            contexts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'file',
                    uri: '/tmp/file',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: new Date().toISOString(),
                },
            ],
        });

        const deleted = findDeletedAttachmentsForFileCleanup(data);
        expect(deleted.map((a) => a.id)).toEqual(['a1']);
    });
});

describe('findLiveAttachmentResourceReferences', () => {
    it('tracks live local URIs and cloud keys while ignoring purged records', () => {
        const data = buildData();
        data.tasks.push({
            id: 'live-task',
            title: 'Live',
            status: 'inbox',
            contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            attachments: [
                {
                    id: 'live',
                    kind: 'file',
                    title: 'live',
                    uri: 'file:///tmp/shared',
                    cloudKey: 'attachments/shared.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'deleted',
                    kind: 'file',
                    title: 'deleted',
                    uri: '/tmp/deleted',
                    cloudKey: 'attachments/deleted.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    deletedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        });
        data.projects.push({
            id: 'deleted-project',
            title: 'Deleted Project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            deletedAt: '2026-01-02T00:00:00.000Z',
            purgedAt: '2026-01-02T00:00:00.000Z',
            attachments: [
                {
                    id: 'deleted-parent',
                    kind: 'file',
                    title: 'deleted-parent',
                    uri: '/tmp/deleted-parent',
                    cloudKey: 'attachments/deleted-parent.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const references = findLiveAttachmentResourceReferences(data);
        expect(Array.from(references.localUris)).toEqual(['/tmp/shared']);
        expect(Array.from(references.cloudKeys)).toEqual(['attachments/shared.txt']);
    });

    it('detects cleanup targets that share a live local URI or cloud key', () => {
        const data = buildData();
        data.tasks.push({
            id: 'live-task',
            title: 'Live',
            status: 'inbox',
            contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            attachments: [
                {
                    id: 'live',
                    kind: 'file',
                    title: 'live',
                    uri: '/tmp/shared',
                    cloudKey: 'attachments/shared.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const references = findLiveAttachmentResourceReferences(data);
        expect(isAttachmentLocalResourceReferenced({
            id: 'orphan',
            kind: 'file',
            title: 'orphan',
            uri: 'file:///tmp/shared',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        }, references)).toBe(true);
        expect(isAttachmentCloudResourceReferenced({
            cloudKey: 'attachments/shared.txt',
        }, references)).toBe(true);
        expect(isAttachmentLocalResourceReferenced({
            id: 'other',
            kind: 'file',
            title: 'other',
            uri: '/tmp/other',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        }, references)).toBe(false);
        expect(isAttachmentCloudResourceReferenced({
            cloudKey: 'attachments/other.txt',
        }, references)).toBe(false);
    });

    const buildLiveReferences = (uri: string) => {
        const data = buildData();
        data.tasks.push({
            id: 'live-task',
            title: 'Live',
            status: 'inbox',
            contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            attachments: [{
                id: 'live',
                kind: 'file',
                title: 'live',
                uri,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }],
        });
        return findLiveAttachmentResourceReferences(data);
    };

    const orphanWithUri = (uri: string) => ({
        id: 'orphan',
        kind: 'file' as const,
        title: 'orphan',
        uri,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    });

    it('matches percent-encoded and decoded spellings of the same local uri', () => {
        expect(isAttachmentLocalResourceReferenced(
            orphanWithUri('/a/My File.pdf'),
            buildLiveReferences('file:///a/My%20File.pdf'),
        )).toBe(true);
        expect(isAttachmentLocalResourceReferenced(
            orphanWithUri('file:///a/My%20File.pdf'),
            buildLiveReferences('/a/My File.pdf'),
        )).toBe(true);
    });

    it('matches a backslash-separated windows path against its forward-slash twin', () => {
        expect(isAttachmentLocalResourceReferenced(
            orphanWithUri('C:/Users/me/Docs/report.pdf'),
            buildLiveReferences('C:\\Users\\me\\Docs\\report.pdf'),
        )).toBe(true);
    });

    it('tolerates malformed percent sequences without throwing', () => {
        expect(() => buildLiveReferences('/a/100%.pdf')).not.toThrow();
        expect(isAttachmentLocalResourceReferenced(
            orphanWithUri('/a/100%.pdf'),
            buildLiveReferences('/a/100%.pdf'),
        )).toBe(true);
    });
});

describe('hasFreshAttachmentCleanupWork', () => {
    const now = '2026-07-14T12:00:00.000Z';
    const fileTombstone = (overrides: Record<string, unknown> = {}) => ({
        id: 'a1',
        kind: 'file' as const,
        title: 'file',
        uri: '/managed/file.pdf',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
        ...overrides,
    });
    const withTaskAttachment = (attachment: Record<string, unknown>, taskOverrides: Record<string, unknown> = {}): AppData => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'next',
            contexts: [],
            createdAt: now,
            updatedAt: now,
            attachments: [attachment],
            ...taskOverrides,
        } as AppData['tasks'][number]);
        return data;
    };

    it('fires for an unprocessed file tombstone and goes quiet once stamped and cleared', () => {
        expect(hasFreshAttachmentCleanupWork(withTaskAttachment(fileTombstone({ cloudKey: 'attachments/file.pdf' })))).toBe(true);
        expect(hasFreshAttachmentCleanupWork(
            withTaskAttachment(fileTombstone({ localStatus: 'missing', cloudKey: undefined })),
        )).toBe(false);
    });

    it('fires for a stamped tombstone whose cloud key is not covered by a pending delete', () => {
        const uncovered = withTaskAttachment(fileTombstone({ localStatus: 'missing', cloudKey: 'attachments/file.pdf' }));
        expect(hasFreshAttachmentCleanupWork(uncovered)).toBe(true);

        const covered = withTaskAttachment(fileTombstone({ localStatus: 'missing', cloudKey: 'attachments/file.pdf' }));
        covered.settings.attachments = {
            pendingRemoteDeletes: [{ cloudKey: 'attachments/file.pdf', attempts: 1 }],
        };
        expect(hasFreshAttachmentCleanupWork(covered)).toBe(false);
    });

    it('fires for records on purged parents and ignores live attachments', () => {
        expect(hasFreshAttachmentCleanupWork(withTaskAttachment(
            fileTombstone({ deletedAt: undefined }),
            { status: 'done', deletedAt: now, purgedAt: now },
        ))).toBe(true);
        expect(hasFreshAttachmentCleanupWork(withTaskAttachment(fileTombstone({ deletedAt: undefined })))).toBe(false);
    });
});

describe('remote attachment retention and batching', () => {
    const now = '2026-07-14T12:00:00.000Z';
    const H1 = `attachments/a1.${'1'.repeat(64)}.pdf`;
    const H2 = `attachments/a1.${'2'.repeat(64)}.pdf`;
    const H3 = `attachments/a1.${'3'.repeat(64)}.pdf`;

    const makeAttachment = (cloudKey: string, overrides: Partial<Attachment> = {}): Attachment => ({
        id: 'a1',
        kind: 'file',
        title: 'report.pdf',
        uri: '/managed/report.pdf',
        cloudKey,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });

    const withAttachments = (...attachments: Attachment[]): AppData => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'next',
            contexts: [],
            createdAt: now,
            updatedAt: now,
            attachments,
        });
        return data;
    };

    it('retains a File Sync generation while clearing its tombstone metadata', async () => {
        const data = withAttachments(makeAttachment(H1, { deletedAt: now }));
        data.settings.attachments = {
            pendingRemoteDeletes: [{ cloudKey: H1, title: 'report.pdf', attempts: 3 }],
        };
        const deleteRemoteAttachment = vi.fn(async () => undefined);

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment,
            shouldRetainRemoteAttachment: () => true,
        });

        expect(deleteRemoteAttachment).not.toHaveBeenCalled();
        expect(result.appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
        expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
    });

    it('bounds remote deletes and preserves unprocessed attempt state', async () => {
        const data = withAttachments(makeAttachment(H3));
        data.settings.attachments = {
            pendingRemoteDeletes: [
                { cloudKey: H1, title: 'one', attempts: 1 },
                { cloudKey: H2, title: 'two', attempts: 2 },
                { cloudKey: 'attachments/a1.4.pdf', title: 'three', attempts: 3 },
            ],
        };
        const deleteRemoteAttachment = vi.fn(async () => undefined);

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            maxAttachmentTargets: 2,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment,
        });

        expect(deleteRemoteAttachment.mock.calls.map(([target]) => target.cloudKey)).toEqual([H1, H2]);
        expect(result.reachedBatchLimit).toBe(true);
        expect(result.appData.settings.attachments?.pendingRemoteDeletes).toEqual([
            { cloudKey: 'attachments/a1.4.pdf', title: 'three', attempts: 3 },
        ]);
    });
});

describe('legacy record removal coverage', () => {
    it('removal now reaches only purged-parent records through applyAttachmentCleanupResult', () => {
        const data: AppData = {
            tasks: [
                {
                    id: 't1',
                    title: 'Task',
                    status: 'done',
                    contexts: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: new Date().toISOString(),
                    purgedAt: new Date().toISOString(),
                    attachments: [
                        {
                            id: 'a1',
                            kind: 'file',
                            title: 'file',
                            uri: '/tmp/file',
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        },
                    ],
                },
            ],
            projects: [
                {
                    id: 'p1',
                    title: 'Project',
                    status: 'active',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: new Date().toISOString(),
                    attachments: [
                        {
                            id: 'a2',
                            kind: 'file',
                            title: 'file2',
                            uri: '/tmp/file2',
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            deletedAt: new Date().toISOString(),
                        },
                    ],
                },
            ],
            sections: [],
            areas: [],
            settings: {},
        };

        const cleaned = applyAttachmentCleanupResult(data, {
            lastCleanupAt: new Date().toISOString(),
            removableAttachmentIds: ['a1'],
            processedFileTombstoneIds: ['a2'],
        });
        // The purged-parent record goes; the live-parent tombstone stays (a peer
        // would resurrect it through the union merge) and is stamped instead.
        expect(cleaned.tasks[0].attachments).toHaveLength(0);
        expect(cleaned.projects[0].attachments?.map((attachment) => attachment.id)).toEqual(['a2']);
        expect(cleaned.projects[0].attachments?.[0]?.localStatus).toBe('missing');
    });

    it('clears cloud keys only on deleted records and bumps their updatedAt', () => {
        const stamp = '2026-07-14T12:00:00.000Z';
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'next',
            contexts: [],
            createdAt: stamp,
            updatedAt: stamp,
            attachments: [
                {
                    id: 'tombstone',
                    kind: 'file',
                    title: 'tombstone',
                    uri: '',
                    cloudKey: 'attachments/shared.pdf',
                    createdAt: stamp,
                    updatedAt: stamp,
                    deletedAt: stamp,
                },
                {
                    id: 'live-twin',
                    kind: 'file',
                    title: 'live-twin',
                    uri: '/managed/shared.pdf',
                    cloudKey: 'attachments/shared.pdf',
                    createdAt: stamp,
                    updatedAt: stamp,
                },
            ],
        });

        const cleaned = applyAttachmentCleanupResult(data, {
            lastCleanupAt: '2026-07-15T00:00:00.000Z',
            clearedCloudKeys: ['attachments/shared.pdf'],
        });
        const [tombstone, liveTwin] = cleaned.tasks[0].attachments ?? [];
        expect(tombstone?.cloudKey).toBeUndefined();
        expect(tombstone?.updatedAt).toBe('2026-07-15T00:00:00.000Z');
        expect(liveTwin?.cloudKey).toBe('attachments/shared.pdf');
        expect(liveTwin?.updatedAt).toBe(stamp);
    });
});

describe('applyAttachmentCleanupResult', () => {
    it('stores cleanup metadata and removes all orphaned attachments when not batch-limited', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'done',
            contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            deletedAt: '2026-01-01T00:00:00.000Z',
            purgedAt: '2026-01-01T00:00:00.000Z',
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'file',
                    uri: '/tmp/file',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const orphaned = findOrphanedAttachments(data);
        const cleaned = applyAttachmentCleanupResult(data, {
            lastCleanupAt: '2026-01-02T00:00:00.000Z',
            orphanedAttachments: orphaned,
            removableAttachmentIds: orphaned.map((attachment) => attachment.id),
            pendingRemoteDeletes: [{ cloudKey: 'attachments/missing.txt', attempts: 1 }],
        });

        expect(cleaned.tasks[0].attachments).toEqual([]);
        expect(cleaned.settings.attachments?.lastCleanupAt).toBe('2026-01-02T00:00:00.000Z');
        expect(cleaned.settings.attachments?.pendingRemoteDeletes).toEqual([
            { cloudKey: 'attachments/missing.txt', attempts: 1 },
        ]);
    });

    it('drops pending remote attachment deletes after max attempts or expiry', () => {
        const data = buildData();

        const cleaned = applyAttachmentCleanupResult(data, {
            lastCleanupAt: '2026-02-01T00:00:00.000Z',
            pendingRemoteDeletes: [
                {
                    cloudKey: 'attachments/too-many.txt',
                    attempts: PENDING_REMOTE_ATTACHMENT_DELETE_MAX_ATTEMPTS,
                    lastErrorAt: '2026-01-31T00:00:00.000Z',
                },
                {
                    cloudKey: 'attachments/too-old.txt',
                    attempts: 1,
                    lastErrorAt: '2025-12-01T00:00:00.000Z',
                },
                {
                    cloudKey: 'attachments/recent.txt',
                    attempts: 1,
                    lastErrorAt: '2026-01-31T00:00:00.000Z',
                },
            ],
        });

        expect(cleaned.settings.attachments?.pendingRemoteDeletes).toEqual([
            {
                cloudKey: 'attachments/recent.txt',
                attempts: 1,
                lastErrorAt: '2026-01-31T00:00:00.000Z',
            },
        ]);
    });

    it('removes only processed orphaned attachments when batch-limited', () => {
        const data = buildData();
        data.tasks.push({
            id: 't1',
            title: 'Task',
            status: 'done',
            contexts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            deletedAt: '2026-01-01T00:00:00.000Z',
            purgedAt: '2026-01-01T00:00:00.000Z',
            attachments: [
                {
                    id: 'processed',
                    kind: 'file',
                    title: 'processed',
                    uri: '/tmp/processed',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'deferred',
                    kind: 'file',
                    title: 'deferred',
                    uri: '/tmp/deferred',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const cleaned = applyAttachmentCleanupResult(data, {
            lastCleanupAt: '2026-01-02T00:00:00.000Z',
            orphanedAttachments: findOrphanedAttachments(data),
            processedOrphanedIds: ['processed'],
            removableAttachmentIds: ['processed'],
            reachedBatchLimit: true,
        });

        expect(cleaned.tasks[0].attachments?.map((attachment) => attachment.id)).toEqual(['deferred']);
        expect(cleaned.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
    });
});

describe('runAttachmentCleanupLifecycle', () => {
    const now = '2026-07-14T12:00:00.000Z';

    it('keeps a soft-deleted record as a tombstone and goes quiet once processed (#1064)', async () => {
        // Removing the record never stuck: the merge unions attachments by id,
        // so a peer's copy resurrected it next cycle and the conflict + cleanup
        // pass repeated forever. The record must survive as a tombstone with
        // processed-markers instead.
        const data = buildData();
        data.tasks.push({
            id: 'live-task',
            title: 'Live',
            status: 'next',
            contexts: [],
            createdAt: now,
            updatedAt: now,
            attachments: [{
                id: 'removed',
                kind: 'file',
                title: 'removed',
                uri: '/managed/removed.pdf',
                cloudKey: 'attachments/removed.pdf',
                createdAt: now,
                updatedAt: now,
                deletedAt: now,
            }],
        });
        const deleteLocalAttachment = vi.fn(async () => undefined);
        const deleteRemoteAttachment = vi.fn(async () => undefined);

        expect(hasFreshAttachmentCleanupWork(data)).toBe(true);
        const first = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment,
            deleteRemoteAttachment,
        });

        expect(deleteLocalAttachment).toHaveBeenCalledTimes(1);
        expect(deleteRemoteAttachment).toHaveBeenCalledTimes(1);
        const record = first.appData.tasks[0].attachments?.[0];
        expect(record?.id).toBe('removed');
        expect(record?.deletedAt).toBe(now);
        expect(record?.localStatus).toBe('missing');
        expect(record?.cloudKey).toBeUndefined();
        expect(record?.updatedAt).toBe(now);
        expect(first.shouldInvalidateFastSyncState).toBe(true);
        expect(hasFreshAttachmentCleanupWork(first.appData)).toBe(false);

        deleteLocalAttachment.mockClear();
        deleteRemoteAttachment.mockClear();
        const second = await runAttachmentCleanupLifecycle({
            appData: first.appData,
            now: () => now,
            deleteLocalAttachment,
            deleteRemoteAttachment,
        });
        expect(deleteLocalAttachment).not.toHaveBeenCalled();
        expect(deleteRemoteAttachment).not.toHaveBeenCalled();
        expect(second.shouldInvalidateFastSyncState).toBe(false);
        expect(second.appData.tasks[0].attachments?.[0]?.id).toBe('removed');
    });

    it('keeps the cloud key and stays covered by the pending delete when the remote delete fails', async () => {
        const data = buildData();
        data.tasks.push({
            id: 'live-task',
            title: 'Live',
            status: 'next',
            contexts: [],
            createdAt: now,
            updatedAt: now,
            attachments: [{
                id: 'removed',
                kind: 'file',
                title: 'removed',
                uri: '/managed/removed.pdf',
                cloudKey: 'attachments/removed.pdf',
                createdAt: now,
                updatedAt: now,
                deletedAt: now,
            }],
        });

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment: vi.fn(async () => {
                throw new Error('offline');
            }),
        });

        const record = result.appData.tasks[0].attachments?.[0];
        expect(record?.cloudKey).toBe('attachments/removed.pdf');
        expect(result.appData.settings.attachments?.pendingRemoteDeletes).toEqual([
            expect.objectContaining({ cloudKey: 'attachments/removed.pdf', attempts: 1 }),
        ]);
        // The pending entry owns the retry cadence; the tombstone must not
        // re-trigger an immediate pass on every sync cycle.
        expect(hasFreshAttachmentCleanupWork(result.appData)).toBe(false);
    });

    it('removes orphaned metadata without deleting resources still referenced by a live task', async () => {
        const data = buildData();
        data.tasks.push(
            {
                id: 'purged',
                title: 'Purged',
                status: 'done',
                contexts: [],
                createdAt: now,
                updatedAt: now,
                deletedAt: now,
                purgedAt: now,
                attachments: [{
                    id: 'orphan',
                    kind: 'file',
                    title: 'shared',
                    uri: 'file:///managed/shared.pdf',
                    cloudKey: 'attachments/shared.pdf',
                    createdAt: now,
                    updatedAt: now,
                }],
            },
            {
                id: 'live',
                title: 'Live',
                status: 'next',
                contexts: [],
                createdAt: now,
                updatedAt: now,
                attachments: [{
                    id: 'live-copy',
                    kind: 'file',
                    title: 'shared',
                    uri: '/managed/shared.pdf',
                    cloudKey: 'attachments/shared.pdf',
                    createdAt: now,
                    updatedAt: now,
                }],
            },
        );
        const deleteLocalAttachment = vi.fn(async () => undefined);
        const deleteRemoteAttachment = vi.fn(async () => undefined);

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment,
            deleteRemoteAttachment,
        });

        expect(deleteLocalAttachment).not.toHaveBeenCalled();
        expect(deleteRemoteAttachment).not.toHaveBeenCalled();
        expect(result.appData.tasks[0].attachments).toEqual([]);
        expect(result.appData.tasks[1].attachments?.map((attachment) => attachment.id)).toEqual(['live-copy']);
        expect(result.shouldInvalidateFastSyncState).toBe(true);
    });

    it('treats attachments on soft-deleted parents as live resource references', async () => {
        const data = buildData();
        data.tasks.push({
            id: 'restorable',
            title: 'Restorable',
            status: 'done',
            contexts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: now,
            attachments: [{
                id: 'restorable-attachment',
                kind: 'file',
                title: 'keep',
                uri: '/managed/keep.pdf',
                cloudKey: 'attachments/keep.pdf',
                createdAt: now,
                updatedAt: now,
            }],
        });
        data.settings.attachments = {
            pendingRemoteDeletes: [{
                cloudKey: 'attachments/keep.pdf',
                title: 'keep',
                attempts: 1,
                lastErrorAt: now,
            }],
        };
        const deleteRemoteAttachment = vi.fn(async () => undefined);

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment,
        });

        expect(deleteRemoteAttachment).not.toHaveBeenCalled();
        expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
        expect(result.appData.tasks[0].attachments).toHaveLength(1);
    });

    it('keeps a live cloud key that needs sanitizing out of the remote delete queue', async () => {
        const data = buildData();
        data.tasks.push(
            {
                id: 'purged',
                title: 'Purged',
                status: 'done',
                contexts: [],
                createdAt: now,
                updatedAt: now,
                deletedAt: now,
                purgedAt: now,
                attachments: [{
                    id: 'orphan',
                    kind: 'file',
                    title: 'shared',
                    uri: '/managed/orphan-copy.pdf',
                    cloudKey: 'attachments/shared.pdf',
                    createdAt: now,
                    updatedAt: now,
                }],
            },
            {
                id: 'live',
                title: 'Live',
                status: 'next',
                contexts: [],
                createdAt: now,
                updatedAt: now,
                attachments: [{
                    id: 'live-copy',
                    kind: 'file',
                    title: 'shared',
                    uri: '/managed/shared.pdf',
                    cloudKey: '  attachments/shared.pdf  ',
                    createdAt: now,
                    updatedAt: now,
                }],
            },
        );
        const deleteRemoteAttachment = vi.fn(async () => undefined);

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment,
        });

        expect(deleteRemoteAttachment).not.toHaveBeenCalled();
        expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
    });

    it('treats remote 404 as terminal instead of scheduling another retry', async () => {
        const data = buildData();
        data.settings.attachments = {
            pendingRemoteDeletes: [{
                cloudKey: 'attachments/missing.pdf',
                title: 'missing',
                attempts: 2,
                lastErrorAt: now,
            }],
        };
        const onRemoteAttachmentMissing = vi.fn();

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment: vi.fn(async () => {
                throw Object.assign(new Error('missing'), { status: 404 });
            }),
            onRemoteAttachmentMissing,
        });

        expect(onRemoteAttachmentMissing).toHaveBeenCalledWith(
            expect.objectContaining({ cloudKey: 'attachments/missing.pdf' }),
        );
        expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
    });

    it('increments retry state for retryable remote deletion failures', async () => {
        const data = buildData();
        data.settings.attachments = {
            pendingRemoteDeletes: [{
                cloudKey: 'attachments/retry.pdf',
                title: 'retry',
                attempts: 2,
                lastErrorAt: '2026-07-13T12:00:00.000Z',
            }],
        };
        const error = new Error('offline');
        const onRemoteDeleteError = vi.fn();

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment: vi.fn(async () => {
                throw error;
            }),
            onRemoteDeleteError,
        });

        expect(onRemoteDeleteError).toHaveBeenCalledWith(
            expect.objectContaining({ cloudKey: 'attachments/retry.pdf' }),
            error,
        );
        expect(result.appData.settings.attachments?.pendingRemoteDeletes).toEqual([{
            cloudKey: 'attachments/retry.pdf',
            title: 'retry',
            attempts: 3,
            lastErrorAt: now,
        }]);
    });

    it('propagates LocalSyncAbort from the final remote-delete freshness guard', async () => {
        const data = buildData();
        data.settings.attachments = {
            pendingRemoteDeletes: [{
                cloudKey: 'attachments/stale.pdf',
                title: 'stale',
            }],
        };
        const abort = new Error('Local changes detected during sync');
        abort.name = 'LocalSyncAbort';
        const onRemoteDeleteError = vi.fn();

        await expect(runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            deleteLocalAttachment: vi.fn(async () => undefined),
            deleteRemoteAttachment: vi.fn(async () => {
                throw abort;
            }),
            onRemoteDeleteError,
        })).rejects.toBe(abort);

        expect(onRemoteDeleteError).not.toHaveBeenCalled();
    });

    it('applies only the processed orphaned metadata when the batch limit is reached', async () => {
        const data = buildData();
        data.tasks.push({
            id: 'purged',
            title: 'Purged',
            status: 'done',
            contexts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: now,
            purgedAt: now,
            attachments: ['first', 'second'].map((id) => ({
                id,
                kind: 'file' as const,
                title: id,
                uri: '/managed/' + id + '.pdf',
                createdAt: now,
                updatedAt: now,
            })),
        });
        const deleteLocalAttachment = vi.fn(async () => undefined);
        const onBatchLimitReached = vi.fn();

        const result = await runAttachmentCleanupLifecycle({
            appData: data,
            now: () => now,
            maxAttachmentTargets: 1,
            deleteLocalAttachment,
            onBatchLimitReached,
        });

        expect(deleteLocalAttachment).toHaveBeenCalledTimes(1);
        expect(result.appData.tasks[0].attachments?.map((attachment) => attachment.id)).toEqual(['second']);
        expect(result.reachedBatchLimit).toBe(true);
        expect(result.processedOrphanedIds).toEqual(new Set(['first']));
        expect(onBatchLimitReached).toHaveBeenCalledWith({ limit: 1, total: 2 });
    });
});
