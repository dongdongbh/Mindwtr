import { describe, expect, it } from 'vitest';
import {
    areRemoteSyncDocumentsEqual,
    computeRemoteSyncDocumentFingerprint,
    computeSyncPayloadFingerprint,
    generateDeterministicUUID,
    mergeAppData,
    parseSyncDocument,
    toRemoteSyncDocument,
} from './index';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import type { AppData, Attachment, Project, Task } from './types';

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

    it('recovers legacy task and project URL attachment strings deterministically', () => {
        const taskUri = 'https://example.test/issue/1';
        const projectUri = 'http://example.test/project/1';
        const input = createData();
        input.tasks[0] = {
            ...input.tasks[0],
            dueDate: '',
            attachments: `  ${taskUri}  `,
        } as unknown as Task;
        input.tasks.push({
            ...input.tasks[0],
            id: 'task-2',
            attachments: taskUri,
        } as unknown as Task);
        input.projects = [{
            id: 'project-1',
            title: 'Project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            dueDate: '2026-08-03',
            createdAt: '2026-07-01T10:00:00.000Z',
            updatedAt: '2026-07-02T11:00:00.000Z',
            attachments: projectUri,
        } as unknown as Project];
        const original = structuredClone(input);

        const first = parseSyncDocument(input, 'remote');
        const second = parseSyncDocument(structuredClone(input), 'remote');
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (!first.ok || !second.ok) throw new Error('Expected legacy URLs to be accepted');

        expect(first.legacyAttachmentsChanged).toBe(true);
        expect(second.legacyAttachmentsChanged).toBe(true);
        expect(input).toEqual(original);
        expect(first.data.tasks[0].dueDate).toBe('');
        expect(first.data.projects[0].dueDate).toBe('2026-08-03');
        expect(first.data.tasks[0].attachments).toEqual([{
            id: generateDeterministicUUID(JSON.stringify([
                'legacy-attachment-link',
                'task',
                'task-1',
                taskUri,
            ])),
            kind: 'link',
            title: taskUri,
            uri: taskUri,
            createdAt: NOW,
            updatedAt: NOW,
        }]);
        expect(first.data.projects[0].attachments).toEqual([{
            id: generateDeterministicUUID(JSON.stringify([
                'legacy-attachment-link',
                'project',
                'project-1',
                projectUri,
            ])),
            kind: 'link',
            title: projectUri,
            uri: projectUri,
            createdAt: '2026-07-01T10:00:00.000Z',
            updatedAt: '2026-07-02T11:00:00.000Z',
        }]);
        expect(first.data.tasks[0].attachments).toEqual(second.data.tasks[0].attachments);
        expect(first.data.projects[0].attachments).toEqual(second.data.projects[0].attachments);
        const attachmentIds = [
            first.data.tasks[0].attachments?.[0]?.id,
            first.data.tasks[1].attachments?.[0]?.id,
            first.data.projects[0].attachments?.[0]?.id,
        ];
        expect(new Set(attachmentIds).size).toBe(attachmentIds.length);
        expect(() => toRemoteSyncDocument(first.data)).not.toThrow();
        const merged = mergeAppData(first.data, second.data, { nowIso: NOW });
        expect(merged).toEqual(mergeAppData(second.data, first.data, { nowIso: NOW }));
        expect(mergeAppData(merged, second.data, { nowIso: NOW })).toEqual(merged);
    });

    it('uses deterministic owner timestamps or the epoch for recovered links', () => {
        const input = createData();
        input.tasks[0] = {
            ...input.tasks[0],
            createdAt: 'invalid',
            updatedAt: 'invalid',
            attachments: 'https://example.test/epoch',
        } as unknown as Task;

        const parsed = parseSyncDocument(input, 'local');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error('Expected the legacy URL to be accepted');

        expect(parsed.data.tasks[0].attachments?.[0]).toMatchObject({
            createdAt: '1970-01-01T00:00:00.000Z',
            updatedAt: '1970-01-01T00:00:00.000Z',
        });
    });

    it('retains valid attachment arrays and tombstones by identity', () => {
        const input = createData();
        const attachments: Attachment[] = [{
            id: 'file-1',
            kind: 'file',
            title: 'notes.txt',
            uri: '',
            cloudKey: 'attachments/file-1.txt',
            createdAt: NOW,
            updatedAt: NOW,
        }, {
            id: 'link-1',
            kind: 'link',
            title: 'Deleted reference',
            uri: 'https://example.test/deleted',
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: NOW,
        }];
        input.tasks[0].attachments = attachments;

        const parsed = parseSyncDocument(input, 'remote');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error('Expected valid attachments to be accepted');

        expect(parsed.data.tasks).toBe(input.tasks);
        expect(parsed.data.tasks[0]).toBe(input.tasks[0]);
        expect(parsed.data.tasks[0].attachments).toBe(attachments);
        expect(parsed.data.tasks[0].attachments?.[1]).toBe(attachments[1]);
        expect(parsed).not.toHaveProperty('legacyAttachmentsChanged');
    });

    it('accepts nullable attachment clearing without marking a legacy repair', () => {
        const input = createData();
        input.tasks[0] = { ...input.tasks[0], attachments: null } as unknown as Task;

        const parsed = parseSyncDocument(input, 'remote');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error('Expected nullable attachment clearing to be accepted');

        expect(parsed.data.tasks[0].attachments).toBeNull();
        expect(parsed).not.toHaveProperty('legacyAttachmentsChanged');
    });

    it.each([
        [
            'unsupported string',
            'ftp://example.test/file',
            'remote payload field "tasks[0].attachments" must be an array or an absolute HTTP(S) URL string when present',
        ],
        [
            'object field',
            {},
            'remote payload field "tasks[0].attachments" must be an array or an absolute HTTP(S) URL string when present',
        ],
        ['null entry', [null], 'remote payload field "tasks[0].attachments[0]" must be an object'],
        ['number entry', [42], 'remote payload field "tasks[0].attachments[0]" must be an object'],
        ['malformed object entry', [{}], 'remote payload field "tasks[0].attachments[0].id" must be a non-empty string'],
        [
            'unknown attachment kind',
            [{ id: 'attachment-1', kind: 'bookmark' }],
            'remote payload field "tasks[0].attachments[0].kind" must be "file" or "link"',
        ],
    ])('rejects a malformed attachment %s with a field-path error', (_label, attachments, expectedError) => {
        const input = createData();
        input.tasks[0] = { ...input.tasks[0], attachments } as unknown as Task;

        expect(() => parseSyncDocument(input, 'remote')).not.toThrow();
        const parsed = parseSyncDocument(input, 'remote');
        expect(parsed.ok).toBe(false);
        if (parsed.ok) throw new Error('Expected malformed attachments to be rejected');
        expect(parsed.errors).toContain(expectedError);
    });

    it('recovers partial legacy attachment entries instead of rejecting the document', () => {
        const uri = 'https://example.test/issue/9';
        const legacyUrl = 'https://example.test/wiki/9';
        const input = createData();
        input.projects = [{
            id: 'project-1', title: 'Project', status: 'active', color: '#000000', order: 0,
            tagIds: [], createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-02T11:00:00.000Z',
            attachments: [
                { id: 'a1', kind: 'link', title: 'Ticket', uri },
                { url: legacyUrl },
            ],
        } as unknown as Project];
        const original = structuredClone(input);

        const first = parseSyncDocument(input, 'remote');
        const second = parseSyncDocument(structuredClone(input), 'remote');
        expect(first.ok).toBe(true);
        if (!first.ok || !second.ok) throw new Error('Expected partial attachment entries to be recovered');

        expect(input).toEqual(original);
        expect(first.legacyAttachmentsChanged).toBe(true);
        expect(first.data.projects[0].attachments).toEqual([
            {
                id: 'a1', kind: 'link', title: 'Ticket', uri,
                createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-02T11:00:00.000Z',
            },
            {
                id: generateDeterministicUUID(JSON.stringify([
                    'legacy-attachment-link', 'project', 'project-1', legacyUrl,
                ])),
                kind: 'link', title: legacyUrl, uri: legacyUrl,
                createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-02T11:00:00.000Z',
            },
        ]);
        // Two peers repairing the same raw document must publish the same bytes.
        expect(second.data).toEqual(first.data);
        expect(() => toRemoteSyncDocument(first.data)).not.toThrow();
        expect(parseSyncDocument(structuredClone(first.data), 'remote')).toEqual({ ok: true, data: first.data });
    });

    it.each([
        ['no usable URI', { id: 'a1', kind: 'link', title: 'x' }, 'tasks[0].attachments[0].uri'],
        ['a relative URI', { id: 'a1', kind: 'link', title: 'x', uri: '/local/path' }, 'tasks[0].attachments[0].createdAt'],
        ['a file record', { id: 'a1', kind: 'file', uri: 'https://example.test/f' }, 'tasks[0].attachments[0].title'],
    ])('still rejects an attachment entry with %s', (_label, attachment, expectedPath) => {
        const input = createData();
        input.tasks[0] = { ...input.tasks[0], attachments: [attachment] } as unknown as Task;

        const parsed = parseSyncDocument(input, 'remote');
        expect(parsed.ok).toBe(false);
        if (parsed.ok) throw new Error('Expected the unrecoverable entry to be rejected');
        expect(parsed.errors.some((error) => error.includes(expectedPath))).toBe(true);
    });

    it('rejects id/kind-valid records with missing or malformed required fields', () => {
        const validAttachment = {
            id: 'attachment-valid',
            kind: 'link',
            title: '',
            uri: '',
            createdAt: NOW,
            updatedAt: NOW,
        };
        const malformedAttachments = [
            { ...validAttachment, id: 'missing-title', title: undefined },
            { ...validAttachment, id: 'wrong-title', title: 42 },
            { ...validAttachment, id: 'missing-uri', uri: undefined },
            { ...validAttachment, id: 'wrong-uri', uri: {} },
            { ...validAttachment, id: 'missing-created', createdAt: undefined },
            { ...validAttachment, id: 'invalid-created', createdAt: 'not-a-date' },
            { ...validAttachment, id: 'missing-updated', updatedAt: undefined },
            { ...validAttachment, id: 'wrong-updated', updatedAt: 42 },
        ];
        const input = createData();
        input.projects = [{
            id: 'project-malformed',
            title: 'Project',
            status: 'active',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: NOW,
            updatedAt: NOW,
            attachments: malformedAttachments,
        } as unknown as Project];
        const original = structuredClone(input);

        const parsed = parseSyncDocument(input, 'remote');

        expect(parsed).toEqual({
            ok: false,
            errors: [
                'remote payload field "projects[0].attachments[0].title" must be a string',
                'remote payload field "projects[0].attachments[1].title" must be a string',
                'remote payload field "projects[0].attachments[2].uri" must be a string',
                'remote payload field "projects[0].attachments[3].uri" must be a string',
                'remote payload field "projects[0].attachments[4].createdAt" must be a valid ISO timestamp',
                'remote payload field "projects[0].attachments[5].createdAt" must be a valid ISO timestamp',
                'remote payload field "projects[0].attachments[6].updatedAt" must be a valid ISO timestamp',
                'remote payload field "projects[0].attachments[7].updatedAt" must be a valid ISO timestamp',
            ],
        });
        expect(input).toEqual(original);
    });

    it('does not recreate an attachment payload on a purged owner', () => {
        const input = createData();
        input.tasks[0] = {
            ...input.tasks[0],
            deletedAt: NOW,
            purgedAt: NOW,
            attachments: 'https://example.test/purged',
        } as unknown as Task;

        const parsed = parseSyncDocument(input, 'remote');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error('Expected the purged owner to parse');
        expect(parsed.legacyAttachmentsChanged).toBe(true);
        expect(parsed.data.tasks[0].attachments).toBeUndefined();
        expect(toRemoteSyncDocument(parsed.data).tasks[0].attachments).toBeUndefined();
    });

    it('logs only accepted repairs without attachment or owner data', () => {
        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            const rejected = createData();
            rejected.tasks[0] = {
                ...rejected.tasks[0],
                attachments: 'https://example.test/private-task',
            } as unknown as Task;
            rejected.projects = [{
                id: 'project-private',
                title: 'Private project',
                status: 'active',
                color: '#000000',
                order: 0,
                tagIds: [],
                createdAt: NOW,
                updatedAt: NOW,
                attachments: [null],
            } as unknown as Project];
            expect(parseSyncDocument(rejected, 'remote').ok).toBe(false);
            expect(logs).toHaveLength(0);

            const accepted = createData();
            accepted.tasks[0] = {
                ...accepted.tasks[0],
                attachments: 'https://example.test/private-task',
            } as unknown as Task;
            const parsed = parseSyncDocument(accepted, 'remote');
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) throw new Error('Expected the legacy URL to be accepted');
            expect(logs).toEqual([{
                level: 'info',
                message: 'Legacy attachment URL normalized for sync',
                scope: 'sync',
                context: {
                    count: 1,
                },
            }]);
            expect(JSON.stringify(logs)).not.toContain('example.test');
            expect(JSON.stringify(logs)).not.toContain('task-1');

            const repeated = parseSyncDocument(parsed.data, 'remote');
            expect(repeated.ok).toBe(true);
            expect(repeated).not.toHaveProperty('legacyAttachmentsChanged');
            expect(logs).toHaveLength(1);
        } finally {
            setLogger(consoleLogger);
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
            staleContentHash: 'b'.repeat(64),
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
