import { describe, it, expect, vi } from 'vitest';
import { CLOCK_SKEW_THRESHOLD_MS, mergeAppData, mergeAppDataWithStats, filterDeleted, appendSyncHistory } from './sync';
import { createMockArea, createMockProject, createMockSection, createMockTask, mockAppData } from './sync-test-utils';
import { AppData, Task, Project, Attachment, Section, Area } from './types';

describe('Sync Logic', () => {
    describe('mergeAppData', () => {
        it('should merge attachments across devices', () => {
            const localAttachment: Attachment = {
                id: 'att-local',
                kind: 'file',
                title: 'local.txt',
                uri: '/tmp/local.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-incoming',
                kind: 'link',
                title: 'example',
                uri: 'https://example.com',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'), // incoming wins task conflict
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].updatedAt).toBe('2023-01-03');
            expect((merged.tasks[0].attachments || []).map(a => a.id).sort()).toEqual(['att-incoming', 'att-local']);
        });

        it('uses winner attachment uri when incoming wins and has a usable uri', () => {
            const localAttachment: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                localStatus: 'available',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'doc.txt',
                uri: '/incoming/doc.txt',
                cloudKey: 'attachments/att-1.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find(a => a.id === 'att-1');

            expect(attachment?.uri).toBe('/incoming/doc.txt');
            expect(attachment?.localStatus).toBe('available');
            expect(attachment?.cloudKey).toBe('attachments/att-1.txt');
        });

        it('does not copy attachment uris with traversal segments from the winning side', () => {
            const localAttachment: Attachment = {
                id: 'att-traversal',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                localStatus: 'available',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-traversal',
                kind: 'file',
                title: 'doc.txt',
                uri: '/incoming/../secret.txt',
                cloudKey: 'attachments/att-traversal.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-traversal');

            expect(attachment?.uri).toBe('/local/doc.txt');
            expect(attachment?.cloudKey).toBe('attachments/att-traversal.txt');
        });

        it('blocks double-encoded traversal segments in attachment uris', () => {
            const localAttachment: Attachment = {
                id: 'att-double-encoded',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                localStatus: 'available',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-double-encoded',
                kind: 'file',
                title: 'doc.txt',
                uri: '/incoming/%252e%252e/secret.txt',
                cloudKey: 'attachments/att-double-encoded.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-double-encoded');

            expect(attachment?.uri).toBe('/local/doc.txt');
            expect(attachment?.cloudKey).toBe('attachments/att-double-encoded.txt');
        });

        it('marks attachment as available when local URI exists without localStatus', () => {
            const localAttachment: Attachment = {
                id: 'att-available',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-available',
                kind: 'file',
                title: 'doc.txt',
                uri: '',
                cloudKey: 'attachments/att-available.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-available');

            expect(attachment?.uri).toBe('/local/doc.txt');
            expect(attachment?.localStatus).toBe('available');
        });

        it('should retain local cloudKey when incoming lacks it', () => {
            const localAttachment: Attachment = {
                id: 'att-2',
                kind: 'file',
                title: 'note.txt',
                uri: '/local/note.txt',
                cloudKey: 'attachments/att-2.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-2',
                kind: 'file',
                title: 'note.txt',
                uri: '',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find(a => a.id === 'att-2');

            expect(attachment?.cloudKey).toBe('attachments/att-2.txt');
        });

        it('preserves incoming URI when local attachment wins without a usable URI', () => {
            const localAttachment: Attachment = {
                id: 'att-uri-fallback',
                kind: 'file',
                title: 'doc.txt',
                uri: '',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-04T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-uri-fallback',
                kind: 'file',
                title: 'doc.txt',
                uri: '/incoming/doc.txt',
                cloudKey: 'attachments/att-uri-fallback.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };
            const localTask: Task = {
                ...createMockTask('1', '2023-01-04'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-uri-fallback');

            expect(attachment?.uri).toBe('/incoming/doc.txt');
            expect(attachment?.localStatus).toBe('available');
            expect(attachment?.cloudKey).toBe('attachments/att-uri-fallback.txt');
        });

        it('falls back to incoming URI when local attachment is missing', () => {
            const localAttachment: Attachment = {
                id: 'att-missing',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                localStatus: 'missing',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-missing',
                kind: 'file',
                title: 'doc.txt',
                uri: '/incoming/doc.txt',
                cloudKey: 'attachments/att-missing.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };
            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-missing');
            expect(attachment?.uri).toBe('/incoming/doc.txt');
            expect(attachment?.cloudKey).toBe('attachments/att-missing.txt');
        });

        it('marks merged file attachments as missing when no usable URI survives', () => {
            const localAttachment: Attachment = {
                id: 'att-orphaned',
                kind: 'file',
                title: 'doc.txt',
                uri: '  ',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-orphaned',
                kind: 'file',
                title: 'doc.txt',
                uri: '/incoming/../secret.txt',
                cloudKey: 'attachments/att-orphaned.txt',
                fileHash: 'hash-1',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };
            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-orphaned');

            expect(attachment?.uri).toBe('');
            expect(attachment?.localStatus).toBe('missing');
            expect(attachment?.cloudKey).toBe('attachments/att-orphaned.txt');
            expect(attachment?.fileHash).toBe('hash-1');
        });

        it('enriches incoming-only attachments with localStatus when uri exists', () => {
            const incomingAttachment: Attachment = {
                id: 'att-incoming-only',
                kind: 'file',
                title: 'incoming-only.txt',
                uri: '/incoming/incoming-only.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-incoming-only');

            expect(attachment?.uri).toBe('/incoming/incoming-only.txt');
            expect(attachment?.localStatus).toBe('available');
        });

        it('preserves explicit empty attachment arrays', () => {
            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            expect(Array.isArray(merged.tasks[0].attachments)).toBe(true);
            expect(merged.tasks[0].attachments).toEqual([]);
        });

        it('should preserve attachment deletions using attachment timestamps', () => {
            const localAttachment: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'local.txt',
                uri: '/tmp/local.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-04T00:00:00.000Z',
                deletedAt: '2023-01-04T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'local.txt',
                uri: '/tmp/local.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find(a => a.id === 'att-1');
            expect(attachment?.deletedAt).toBe('2023-01-04T00:00:00.000Z');
        });

        it('does not resurrect cloud metadata for deleted attachments', () => {
            const localAttachment: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'local.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-04T00:00:00.000Z',
                deletedAt: '2023-01-04T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'local.txt',
                uri: '/tmp/incoming.txt',
                cloudKey: 'attachments/att-1.txt',
                fileHash: 'hash-1',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
            };

            const localTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [localAttachment],
            };
            const incomingTask: Task = {
                ...createMockTask('1', '2023-01-03'),
                attachments: [incomingAttachment],
            };

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-1');

            expect(attachment?.deletedAt).toBe('2023-01-04T00:00:00.000Z');
            expect(attachment?.cloudKey).toBeUndefined();
            expect(attachment?.fileHash).toBeUndefined();
        });

        it('should merge unique items from both sources', () => {
            const local = mockAppData([createMockTask('1', '2023-01-01')]);
            const incoming = mockAppData([createMockTask('2', '2023-01-01')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(2);
            expect(merged.tasks.find(t => t.id === '1')).toBeDefined();
            expect(merged.tasks.find(t => t.id === '2')).toBeDefined();
        });

        it('should merge sections from both sources', () => {
            const local = mockAppData([], [], [createMockSection('s1', 'p1', '2023-01-01')]);
            const incoming = mockAppData([], [], [createMockSection('s2', 'p1', '2023-01-01')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.sections).toHaveLength(2);
            expect(merged.sections.find((s) => s.id === 's1')).toBeDefined();
            expect(merged.sections.find((s) => s.id === 's2')).toBeDefined();
        });

        it('should update section when incoming is newer', () => {
            const local = mockAppData([], [], [createMockSection('s1', 'p1', '2023-01-01')]);
            const incoming = mockAppData([], [], [createMockSection('s1', 'p1', '2023-01-02')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.sections).toHaveLength(1);
            expect(merged.sections[0].updatedAt).toBe('2023-01-02');
        });

        it('should preserve section deletion when incoming delete is newer', () => {
            const local = mockAppData([], [], [createMockSection('s1', 'p1', '2023-01-01')]);
            const incoming = mockAppData([], [], [createMockSection('s1', 'p1', '2023-01-02', '2023-01-02')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.sections).toHaveLength(1);
            expect(merged.sections[0].deletedAt).toBe('2023-01-02');
        });

        it('should update local item if incoming is newer', () => {
            const local = mockAppData([createMockTask('1', '2023-01-01')]);
            const incoming = mockAppData([createMockTask('1', '2023-01-02')]); // Newer

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02');
        });

        it('should keep local item if local is newer', () => {
            const local = mockAppData([createMockTask('1', '2023-01-02')]); // Newer
            const incoming = mockAppData([createMockTask('1', '2023-01-01')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02');
        });

        it('should handle soft deletions correctly (incoming delete wins if newer)', () => {
            const local = mockAppData([createMockTask('1', '2023-01-01')]);
            const incoming = mockAppData([createMockTask('1', '2023-01-02', '2023-01-02')]); // Deleted and Newer

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02');
        });

        it('should handle soft deletions correctly (local delete wins if newer)', () => {
            const local = mockAppData([createMockTask('1', '2023-01-02', '2023-01-02')]); // Deleted and Newer
            const incoming = mockAppData([createMockTask('1', '2023-01-01')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02');
        });

        it('prefers deletion when delete time is newer within skew threshold', () => {
            const local = mockAppData([createMockTask('1', '2023-01-02T00:00:00.000Z')]);
            const incoming = mockAppData([createMockTask('1', '2023-01-02T00:04:00.000Z', '2023-01-02T00:04:00.000Z')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:04:00.000Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:04:00.000Z');
        });

        it('uses strict last operation time for delete-vs-live conflicts', () => {
            const local = mockAppData([createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z')]);
            const incoming = mockAppData([createMockTask('1', '2023-01-02T00:03:00.000Z')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:03:00.000Z');
        });

        it('uses strict last operation time for delete-vs-live conflicts with revisions', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z'),
                rev: 10,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:03:00.000Z'),
                rev: 9,
                revBy: 'device-b',
            } satisfies Task;
            const local = mockAppData([localTask]);
            const incoming = mockAppData([incomingTask]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:03:00.000Z');
        });

        it('uses higher revisions to break ambiguous delete-vs-live conflicts', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.100Z', '2023-01-02T00:00:00.100Z'),
                rev: 5,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z'),
                rev: 4,
                revBy: 'device-b',
            } satisfies Task;

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:00:00.100Z');
        });

        it('keeps the live item when it has the higher revision inside the ambiguity window', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.100Z', '2023-01-02T00:00:00.100Z'),
                rev: 4,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z'),
                rev: 5,
                revBy: 'device-b',
            } satisfies Task;

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.000Z');
        });

        it('keeps newer live update when delete is only 100ms older', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.100Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.100Z');
        });

        it('keeps the live item when delete is only 100ms newer', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.100Z', '2023-01-02T00:00:00.100Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.000Z');
        });

        it('resolves equal revision delete-vs-live conflicts consistently across sync direction', () => {
            const deletedTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z'),
                title: 'zz deleted',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const liveTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z'),
                title: 'aa live',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;

            const forward = mergeAppData(mockAppData([deletedTask]), mockAppData([liveTask]));
            const reverse = mergeAppData(mockAppData([liveTask]), mockAppData([deletedTask]));

            expect(forward.tasks).toHaveLength(1);
            expect(forward.tasks[0]).toEqual(reverse.tasks[0]);
        });

        it('prefers newer timestamp when revisions tie but revBy differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'local newer',
                rev: 7,
                revBy: 'device-z',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:01:00.000Z'),
                title: 'incoming older',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].title).toBe('local newer');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:05:00.000Z');
        });

        it('uses revBy tie-break only when revision and timestamp are equal', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'local',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'incoming',
                rev: 7,
                revBy: 'device-z',
            } satisfies Task;

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].title).toBe('incoming');
        });

        it('counts a conflict when revision metadata matches but content differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'omega',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'alpha',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(result.data.tasks).toHaveLength(1);
            expect(result.data.tasks[0].title).toBe('omega');
            expect(result.stats.tasks.conflicts).toBe(1);
            expect(result.stats.tasks.conflictIds).toContain('1');
        });

        it('does not count conflict when only purgedAt differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                purgedAt: '2023-01-03T00:00:00.000Z',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(result.data.tasks).toHaveLength(1);
            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.conflictIds).toHaveLength(0);
        });

        it('does not count conflict when only revBy differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-z',
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(result.data.tasks).toHaveLength(1);
            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.conflictIds).toHaveLength(0);
        });

        it('counts conflict when revBy differs and content differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'omega',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'alpha',
                rev: 7,
                revBy: 'device-z',
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(result.data.tasks).toHaveLength(1);
            expect(result.stats.tasks.conflicts).toBe(1);
            expect(result.stats.tasks.conflictIds).toContain('1');
        });

        it('resolves equal revision/timestamp conflicts consistently across sync direction', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'omega',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'alpha',
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;

            const forward = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const reverse = mergeAppData(mockAppData([incomingTask]), mockAppData([localTask]));

            expect(forward.tasks[0].title).toBe('omega');
            expect(reverse.tasks[0].title).toBe('omega');
        });

        it('resolves legacy equal-timestamp conflicts consistently across sync direction', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'omega',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'alpha',
            } satisfies Task;

            const forward = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const reverse = mergeAppData(mockAppData([incomingTask]), mockAppData([localTask]));

            expect(forward.tasks[0].title).toBe('omega');
            expect(reverse.tasks[0].title).toBe('omega');
        });

        it('resolves order-only legacy drift consistently across sync direction', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                order: 42,
                orderNum: 42,
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
            } satisfies Task;

            const forward = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
            const reverse = mergeAppData(mockAppData([incomingTask]), mockAppData([localTask]));

            expect(forward.tasks[0]).toEqual(reverse.tasks[0]);
        });

        it('prefers the live item when delete-vs-live operation times are equal', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:05:00.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:05:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:05:00.000Z');
        });

        it('still prefers delete when it is more than the ambiguity window newer than live', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:06.000Z', '2023-01-02T00:00:06.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:00:06.000Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:06.000Z');
        });

        it('treats invalid deletedAt as a conservative deletion timestamp', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-01T00:00:00.000Z', 'invalid-date'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.000Z');
        });

        it('uses deletedAt as delete operation time when deciding delete-vs-live beyond skew window', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:12:00.000Z', '2023-01-02T00:05:00.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:11:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:11:00.000Z');
        });

        it('clamps far-future timestamps during merge conflict evaluation', () => {
            const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:00:00.000Z').getTime());
            try {
                const local = mockAppData([
                    createMockTask('1', '2099-01-01T00:00:00.000Z'),
                ]);
                const incoming = mockAppData([
                    createMockTask('1', '2026-01-01T00:00:00.000Z'),
                ]);

                const result = mergeAppDataWithStats(local, incoming);
                expect(result.stats.tasks.maxClockSkewMs).toBeLessThanOrEqual(CLOCK_SKEW_THRESHOLD_MS);
            } finally {
                nowSpy.mockRestore();
            }
        });

        it('preserves relative ordering when both timestamps are clamped in the future', () => {
            const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:00:00.000Z').getTime());
            try {
                const localTask = {
                    ...createMockTask('1', '2099-01-01T00:00:00.000Z'),
                    title: 'zz older future',
                } satisfies Task;
                const incomingTask = {
                    ...createMockTask('1', '2099-01-02T00:00:00.000Z'),
                    title: 'aa newer future',
                } satisfies Task;

                const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));

                expect(merged.tasks).toHaveLength(1);
                expect(merged.tasks[0].title).toBe('aa newer future');
                expect(merged.tasks[0].updatedAt).toBe('2099-01-02T00:00:00.000Z');
            } finally {
                nowSpy.mockRestore();
            }
        });

        it('captures merge time once per entity collection', () => {
            const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:00:00.000Z').getTime());
            try {
                const local = mockAppData([
                    createMockTask('1', '2026-01-01T00:00:00.000Z'),
                    createMockTask('2', '2026-01-01T00:00:00.000Z'),
                ]);
                const incoming = mockAppData([
                    createMockTask('1', '2099-01-01T00:00:00.000Z'),
                    createMockTask('2', '2099-01-02T00:00:00.000Z'),
                ]);

                mergeAppDataWithStats(local, incoming);

                expect(nowSpy).toHaveBeenCalledTimes(4);
            } finally {
                nowSpy.mockRestore();
            }
        });

        it('prefers newer item when timestamps are within skew threshold', () => {
            const local = mockAppData([createMockTask('1', '2023-01-02T00:00:00.000Z')]);
            const incoming = mockAppData([createMockTask('1', '2023-01-02T00:04:00.000Z')]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:04:00.000Z');
        });

        it('treats empty updatedAt as older than a valid epoch timestamp', () => {
            const local = mockAppData([], [
                {
                    ...createMockProject('p1', ''),
                    title: 'Zulu',
                },
            ]);
            const incoming = mockAppData([], [
                {
                    ...createMockProject('p1', '1970-01-01T00:00:00.000Z'),
                    title: 'Alpha',
                },
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.projects).toHaveLength(1);
            expect(merged.projects[0].title).toBe('Alpha');
            expect(merged.projects[0].updatedAt).toBe('1970-01-01T00:00:00.000Z');
        });

        it('normalizes invalid createdAt without rewriting updatedAt', () => {
            const localProject: Project = {
                ...createMockProject('p1', '2023-01-02T00:01:00.000Z'),
                createdAt: '2023-01-02T00:05:00.000Z',
            };
            const { data, stats } = mergeAppDataWithStats(mockAppData([], [localProject]), mockAppData());

            expect(data.projects).toHaveLength(1);
            expect(data.projects[0].updatedAt).toBe('2023-01-02T00:01:00.000Z');
            expect(data.projects[0].createdAt).toBe('2023-01-02T00:01:00.000Z');
            expect(stats.projects.timestampAdjustments).toBe(1);
        });

        it('should revive item if update is newer than deletion', () => {
            // This case implies "undo delete" or "re-edit" happened after delete on another device
            const local = mockAppData([createMockTask('1', '2023-01-01', '2023-01-01')]); // Deleted
            const incoming = mockAppData([createMockTask('1', '2023-01-02')]); // Undone/Edited later

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02');
        });

        it('should preserve local settings regardless of incoming settings', () => {
            const local: AppData = { ...mockAppData(), settings: { theme: 'dark' } };
            const incoming: AppData = { ...mockAppData(), settings: { theme: 'light' } };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.theme).toBe('dark');
        });

        it('merges synced language settings per field', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'en',
                    weekStart: 'monday',
                    dateFormat: 'yyyy-MM-dd',
                    timeFormat: '24h',
                    syncPreferences: { language: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-01T00:00:00.000Z',
                        language: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'es',
                    weekStart: 'monday',
                    timeFormat: '12h',
                    syncPreferences: { language: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        language: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.language).toBe('es');
            expect(merged.settings.weekStart).toBe('monday');
            expect(merged.settings.dateFormat).toBe('yyyy-MM-dd');
            expect(merged.settings.timeFormat).toBe('12h');
        });

        it('merges language settings even when sync preferences are empty', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'en',
                    syncPreferences: {},
                    syncPreferencesUpdatedAt: {
                        language: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'es',
                    syncPreferences: {},
                    syncPreferencesUpdatedAt: {
                        language: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.language).toBe('es');
        });

        it('merges settings for disabled preference groups instead of dropping them', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    theme: 'dark',
                    syncPreferences: { appearance: false },
                    syncPreferencesUpdatedAt: {
                        appearance: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    theme: 'light',
                    syncPreferences: { appearance: false },
                    syncPreferencesUpdatedAt: {
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.theme).toBe('light');
        });

        it('deep-clones merged settings arrays to avoid shared references', () => {
            const incomingCalendars = [
                { id: 'cal-1', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true },
            ];
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: [
                        { id: 'cal-local', name: 'Local', url: 'https://calendar.example.com/local.ics', enabled: true },
                    ],
                    syncPreferencesUpdatedAt: {
                        externalCalendars: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: incomingCalendars,
                    syncPreferencesUpdatedAt: {
                        externalCalendars: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.externalCalendars).toEqual(incomingCalendars);
            expect(merged.settings.externalCalendars).not.toBe(incomingCalendars);

            incomingCalendars[0].name = 'Mutated Incoming';
            expect(merged.settings.externalCalendars?.[0]?.name).toBe('Team');
        });

        it('falls back to local values when incoming synced settings are malformed', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'en',
                    weekStart: 'monday',
                    dateFormat: 'yyyy-MM-dd',
                    externalCalendars: [
                        { id: 'cal-local', name: 'Local', url: 'https://calendar.example.com/local.ics', enabled: true },
                    ],
                    syncPreferences: {
                        language: true,
                        externalCalendars: true,
                    },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-01T00:00:00.000Z',
                        language: '2024-01-01T00:00:00.000Z',
                        externalCalendars: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'xx' as AppData['settings']['language'],
                    weekStart: 'friday' as AppData['settings']['weekStart'],
                    dateFormat: 123 as unknown as string,
                    externalCalendars: [
                        { id: '', name: 'Broken', url: '', enabled: true },
                    ] as AppData['settings']['externalCalendars'],
                    syncPreferences: {
                        language: 'yes' as unknown as boolean,
                    },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        language: '2024-01-02T00:00:00.000Z',
                        externalCalendars: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.language).toBe('en');
            expect(merged.settings.weekStart).toBe('monday');
            expect(merged.settings.dateFormat).toBe('yyyy-MM-dd');
            expect(merged.settings.externalCalendars).toEqual(local.settings.externalCalendars);
            expect(merged.settings.syncPreferences).toEqual(local.settings.syncPreferences);
        });

        it('keeps area tombstones so deletions sync across devices', () => {
            const local: AppData = {
                ...mockAppData(),
                areas: [createMockArea('a1', '2023-01-01T00:00:00.000Z')],
            };
            const incoming: AppData = {
                ...mockAppData(),
                areas: [createMockArea('a1', '2023-01-03T00:00:00.000Z', '2023-01-03T00:00:00.000Z')],
            };

            const merged = mergeAppData(local, incoming);
            expect(merged.areas).toHaveLength(1);
            expect(merged.areas[0].deletedAt).toBe('2023-01-03T00:00:00.000Z');
        });

        it('does not globally re-sort areas after merge', () => {
            const local: AppData = {
                ...mockAppData(),
                areas: [
                    { ...createMockArea('a1', '2023-01-04T00:00:00.000Z'), order: 10 },
                    { ...createMockArea('a2', '2023-01-04T00:00:00.000Z'), order: 0 },
                ],
            };
            const incoming: AppData = {
                ...mockAppData(),
                areas: [],
            };

            const merged = mergeAppData(local, incoming);
            expect(merged.areas.map((area) => area.id)).toEqual(['a1', 'a2']);
            expect(merged.areas.map((area) => area.order)).toEqual([10, 0]);
        });
    });

    describe('mergeAppDataWithStats', () => {
        it('should report conflicts and resolution counts', () => {
            const local = mockAppData([
                {
                    ...createMockTask('1', '2023-01-02'),
                    title: 'Local title',
                },
                createMockTask('2', '2023-01-01'),
            ]);
            const incoming = mockAppData([
                {
                    ...createMockTask('1', '2023-01-01'), // older -> local wins conflict
                    title: 'Incoming title',
                },
                createMockTask('3', '2023-01-01'), // incoming only
            ]);

            const result = mergeAppDataWithStats(local, incoming);

            expect(result.data.tasks).toHaveLength(3);
            expect(result.stats.tasks.localOnly).toBe(1);
            expect(result.stats.tasks.incomingOnly).toBe(1);
            expect(result.stats.tasks.conflicts).toBe(1);
            expect(result.stats.tasks.resolvedUsingLocal).toBeGreaterThan(0);
        });

        it('captures conflict diagnostics for content and revision drift', () => {
            const now = '2026-03-16T00:00:00.000Z';
            const local = mockAppData([
                {
                    ...createMockTask('content-conflict', now),
                    title: 'Local title',
                },
                {
                    ...createMockTask('revision-conflict', now),
                    rev: 2,
                    revBy: 'device-local',
                },
            ]);
            const incoming = mockAppData([
                {
                    ...createMockTask('content-conflict', now),
                    title: 'Incoming title',
                },
                {
                    ...createMockTask('revision-conflict', now),
                    rev: 1,
                    revBy: 'device-remote',
                },
            ]);

            const result = mergeAppDataWithStats(local, incoming);
            const contentSample = result.stats.tasks.conflictSamples?.find((sample) => sample.id === 'content-conflict');
            const revisionSample = result.stats.tasks.conflictSamples?.find((sample) => sample.id === 'revision-conflict');

            expect(result.stats.tasks.conflictReasonCounts).toEqual({
                content: 1,
                revision: 1,
            });
            expect(contentSample).toMatchObject({
                reasons: ['content'],
                winner: 'local',
                diffKeys: ['title'],
            });
            expect(revisionSample).toMatchObject({
                reasons: ['revision'],
                winner: 'local',
                diffKeys: [],
            });
            expect(revisionSample?.localComparableHash).toBe(revisionSample?.incomingComparableHash);
        });

        it('does not count conflict when only timestamp differs for legacy items', () => {
            const local = mockAppData([createMockTask('1', '2026-02-22T22:30:40.000Z')]);
            const incoming = mockAppData([createMockTask('1', '2026-02-22T22:30:11.000Z')]);

            const result = mergeAppDataWithStats(local, incoming);

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.maxClockSkewMs).toBe(29000);
            expect(result.data.tasks[0].updatedAt).toBe('2026-02-22T22:30:40.000Z');
        });

        it('does not count conflicts for legacy order-field shape differences', () => {
            const now = '2026-02-22T22:30:40.000Z';
            const localTask = {
                ...createMockTask('task-1', now),
                order: 7,
                orderNum: 7,
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('task-1', now),
            } satisfies Task;
            const localProject = {
                ...createMockProject('project-1', now),
                order: 0,
            } satisfies Project;
            const incomingProject = {
                ...createMockProject('project-1', now),
            } as unknown as Project;
            const localSection = {
                ...createMockSection('section-1', 'project-1', now),
                order: 0,
            } satisfies Section;
            const incomingSection = {
                ...createMockSection('section-1', 'project-1', now),
            } as unknown as Section;
            delete (incomingProject as Record<string, unknown>).order;
            delete (incomingSection as Record<string, unknown>).order;

            const result = mergeAppDataWithStats(
                mockAppData([localTask], [localProject], [localSection]),
                mockAppData([incomingTask], [incomingProject], [incomingSection])
            );

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.projects.conflicts).toBe(0);
            expect(result.stats.sections.conflicts).toBe(0);
        });

        it('does not count conflicts for omitted legacy default fields', () => {
            const now = '2026-03-07T00:00:00.000Z';
            const localTask = {
                ...createMockTask('task-legacy', now),
                isFocusedToday: false,
                pushCount: 0,
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('task-legacy', now),
            } as unknown as Task;
            delete (incomingTask as Record<string, unknown>).status;
            delete (incomingTask as Record<string, unknown>).tags;
            delete (incomingTask as Record<string, unknown>).contexts;

            const localProject = {
                ...createMockProject('project-legacy', now),
                color: '#6B7280',
                isSequential: false,
                isFocused: false,
            } satisfies Project;
            const incomingProject = {
                ...createMockProject('project-legacy', now),
            } as unknown as Project;
            delete (incomingProject as Record<string, unknown>).status;
            delete (incomingProject as Record<string, unknown>).color;
            delete (incomingProject as Record<string, unknown>).tagIds;
            delete (incomingProject as Record<string, unknown>).isSequential;
            delete (incomingProject as Record<string, unknown>).isFocused;

            const localSection = {
                ...createMockSection('section-legacy', 'project-legacy', now),
                isCollapsed: false,
            } satisfies Section;
            const incomingSection = {
                ...createMockSection('section-legacy', 'project-legacy', now),
            } as unknown as Section;
            delete (incomingSection as Record<string, unknown>).isCollapsed;

            const result = mergeAppDataWithStats(
                mockAppData([localTask], [localProject], [localSection]),
                mockAppData([incomingTask], [incomingProject], [incomingSection])
            );

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.projects.conflicts).toBe(0);
            expect(result.stats.sections.conflicts).toBe(0);
        });

        it('does not count conflicts when remote payload omits default task and project fields', () => {
            const now = '2026-03-13T00:00:00.000Z';
            const localTask = {
                ...createMockTask('task-1', now),
                isFocusedToday: false,
            } satisfies Task;
            const incomingTask = {
                id: 'task-1',
                title: 'Task task-1',
                status: 'inbox',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: now,
            } as unknown as Task;

            const localProject = {
                ...createMockProject('project-1', now),
                isSequential: false,
                isFocused: false,
            } satisfies Project;
            const incomingProject = {
                id: 'project-1',
                title: 'Project project-1',
                status: 'active',
                color: '#000000',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: now,
            } as unknown as Project;

            const result = mergeAppDataWithStats(
                mockAppData([localTask], [localProject]),
                mockAppData([incomingTask], [incomingProject])
            );

            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.projects.conflicts).toBe(0);
            expect(result.data.tasks[0]).toMatchObject({
                id: 'task-1',
                tags: [],
                contexts: [],
                isFocusedToday: false,
            });
            expect(result.data.projects[0]).toMatchObject({
                id: 'project-1',
                tagIds: [],
                isSequential: false,
                isFocused: false,
            });
        });
    });

    describe('appendSyncHistory', () => {
        it('drops invalid entries and respects limits', () => {
            const entry = {
                at: '2024-01-01T00:00:00.000Z',
                status: 'success',
                conflicts: 0,
                conflictIds: [],
                maxClockSkewMs: 0,
                timestampAdjustments: 0,
            } as const;
            const settings: AppData['settings'] = {
                lastSyncHistory: [
                    entry,
                    { invalid: true } as any,
                ],
            };

            const next = appendSyncHistory(settings, {
                ...entry,
                at: '2024-01-02T00:00:00.000Z',
            }, 2);

            expect(next).toHaveLength(2);
            expect(next[0].at).toBe('2024-01-02T00:00:00.000Z');
            expect(next[1].at).toBe('2024-01-01T00:00:00.000Z');
        });
    });

    describe('filterDeleted', () => {
        it('should filter out items with deletedAt set', () => {
            const tasks = [
                createMockTask('1', '2023-01-01'),
                createMockTask('2', '2023-01-01', '2023-01-01')
            ];

            const filtered = filterDeleted(tasks);

            expect(filtered).toHaveLength(1);
            expect(filtered[0].id).toBe('1');
        });
    });
});
