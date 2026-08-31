import { describe, it, expect, vi } from 'vitest';
import { CLOCK_SKEW_THRESHOLD_MS, SYNC_REPAIR_REV_BY, mergeAppData, mergeAppDataWithStats } from './sync';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { chooseDeterministicWinner } from './sync-signatures';
import { MAX_SYNC_REVISION } from './sync-revision';
import { createMockArea, createMockProject, createMockSection, createMockTask, mockAppData } from './sync-test-utils';
import { AppData, Task, Project, Attachment, Section, Area } from './types';
import { sanitizeAppDataForRemote, areSyncPayloadsEqual } from './sync-helpers';
import { runAttachmentTransferLifecycle } from './attachment-transfer';

const parseLoggedContext = (value: unknown): Record<string, unknown> => {
    expect(typeof value).toBe('string');
    return JSON.parse(String(value)) as Record<string, unknown>;
};

describe('Sync Logic', () => {
    describe('mergeAppData', () => {
        it('converges when an old-client project lacks taskSortBy', () => {
            const newClientProject = {
                ...createMockProject('project-sort', '2026-07-19T12:00:00.000Z'),
                taskSortBy: 'due',
                rev: 2,
                revBy: 'new-client',
            } satisfies Project;
            const oldClientProject = {
                ...createMockProject('project-sort', '2026-07-19T11:00:00.000Z'),
                rev: 1,
                revBy: 'old-client',
            } satisfies Project;
            const oldClientData = mockAppData([], [oldClientProject]);

            const first = mergeAppData(mockAppData([], [newClientProject]), oldClientData);
            const second = mergeAppDataWithStats(first, oldClientData);

            expect(first.projects[0].taskSortBy).toBe('due');
            expect(second.data).toEqual(first);
            expect(second.stats.projects.conflicts).toBe(0);
        });

        it('repairs recurrence series identity once across an rc.5-shaped peer', () => {
            const updatedAt = '2026-07-19T12:00:00.000Z';
            const currentTask = {
                ...createMockTask('recurring-task', updatedAt),
                recurrence: { rule: 'daily', seriesId: 'series-a' },
                rev: 5,
                revBy: 'current-client',
            } satisfies Task;
            const rc5Task = {
                ...createMockTask('recurring-task', updatedAt),
                recurrence: { rule: 'daily' },
                rev: 5,
                revBy: 'rc5-client',
            } satisfies Task;

            const forward = mergeAppData(mockAppData([currentTask]), mockAppData([rc5Task]));
            const reverse = mergeAppData(mockAppData([rc5Task]), mockAppData([currentTask]));
            expect(forward.tasks[0]).toEqual(reverse.tasks[0]);
            expect(forward.tasks[0]).toMatchObject({
                rev: 6,
                revBy: SYNC_REPAIR_REV_BY,
                recurrence: {
                    rule: 'daily',
                    seriesId: 'series-a',
                    rrule: 'FREQ=DAILY;X-MINDWTR-SERIES-ID=series-a',
                },
            });

            const recurrence = forward.tasks[0].recurrence;
            if (!recurrence || typeof recurrence === 'string') throw new Error('Expected normalized recurrence');
            const { seriesId: _seriesId, ...rc5Recurrence } = recurrence;
            const rc5RoundTrip = {
                ...forward.tasks[0],
                recurrence: rc5Recurrence,
            };
            const second = mergeAppDataWithStats(forward, mockAppData([rc5RoundTrip]));

            expect(second.data).toEqual(forward);
            expect(second.stats.tasks.conflicts).toBe(0);
        });

        it('preserves series identity when a newer rc.5 client edits the recurrence rule', () => {
            const currentTask = {
                ...createMockTask('recurring-task', '2026-07-19T12:00:00.000Z'),
                recurrence: { rule: 'daily', seriesId: 'series-a' },
                rev: 5,
                revBy: 'current-client',
            } satisfies Task;
            const rc5EditedTask = {
                ...createMockTask('recurring-task', '2026-07-19T12:01:00.000Z'),
                recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY' },
                rev: 6,
                revBy: 'rc5-client',
            } satisfies Task;

            const forward = mergeAppData(mockAppData([currentTask]), mockAppData([rc5EditedTask]));
            const reverse = mergeAppData(mockAppData([rc5EditedTask]), mockAppData([currentTask]));
            expect(forward.tasks[0]).toEqual(reverse.tasks[0]);
            expect(forward.tasks[0]).toMatchObject({
                rev: 7,
                revBy: SYNC_REPAIR_REV_BY,
                recurrence: {
                    rule: 'weekly',
                    seriesId: 'series-a',
                    rrule: 'FREQ=WEEKLY;X-MINDWTR-SERIES-ID=series-a',
                },
            });

            const recurrence = forward.tasks[0].recurrence;
            if (!recurrence || typeof recurrence === 'string') throw new Error('Expected normalized recurrence');
            const { seriesId: _seriesId, ...rc5Recurrence } = recurrence;
            const rc5RoundTrip = {
                ...forward.tasks[0],
                recurrence: rc5Recurrence,
            };
            const second = mergeAppDataWithStats(forward, mockAppData([rc5RoundTrip]));

            expect(second.data).toEqual(forward);
            expect(second.stats.tasks.conflicts).toBe(0);
        });

        it('does not graft series identity onto an equal-revision divergent recurrence', () => {
            const updatedAt = '2026-07-19T12:00:00.000Z';
            const currentTask = {
                ...createMockTask('recurring-task', updatedAt),
                recurrence: { rule: 'daily', seriesId: 'series-a' },
                rev: 5,
                revBy: 'current-client',
            } satisfies Task;
            const concurrentRc5Task = {
                ...createMockTask('recurring-task', updatedAt),
                recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY' },
                rev: 5,
                revBy: 'rc5-client',
            } satisfies Task;

            const forward = mergeAppData(mockAppData([currentTask]), mockAppData([concurrentRc5Task]));
            const reverse = mergeAppData(mockAppData([concurrentRc5Task]), mockAppData([currentTask]));

            expect(forward.tasks[0]).toEqual(reverse.tasks[0]);
            expect(forward.tasks[0]).toMatchObject({
                recurrence: {
                    rule: 'weekly',
                    rrule: 'FREQ=WEEKLY',
                },
            });
            expect(typeof forward.tasks[0]?.recurrence === 'object'
                ? forward.tasks[0].recurrence.seriesId
                : undefined).toBeUndefined();

            const unrelatedRc5Task = {
                ...concurrentRc5Task,
                updatedAt: '2026-07-19T12:02:00.000Z',
                rev: 7,
            };
            const unrelated = mergeAppData(
                mockAppData([currentTask]),
                mockAppData([unrelatedRc5Task]),
            );
            expect(typeof unrelated.tasks[0]?.recurrence === 'object'
                ? unrelated.tasks[0].recurrence.seriesId
                : undefined).toBeUndefined();
        });

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

        it('a cleanup-cleared attachment tombstone converges instead of resurrecting (#1064)', () => {
            // Cleanup used to strip the tombstoned record from the local doc;
            // the union merge re-imported the peer's copy every cycle, renewing
            // an attachments conflict forever. Cleanup now keeps the tombstone
            // and clears its cloudKey with a fresh updatedAt — that version
            // must win the merge and the follow-up merge must be a no-op.
            const clearedTombstone: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'doc.txt',
                uri: '',
                localStatus: 'missing',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-03T00:00:00.000Z',
                deletedAt: '2023-01-02T00:00:00.000Z',
            };
            const remoteTombstone: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'doc.txt',
                uri: '',
                cloudKey: 'attachments/att-1.txt',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
                deletedAt: '2023-01-02T00:00:00.000Z',
            };
            const localTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [clearedTombstone],
            };
            const remoteTask: Task = {
                ...createMockTask('1', '2023-01-02'),
                attachments: [remoteTombstone],
            };

            const first = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([remoteTask]));
            const attachment = first.data.tasks[0].attachments?.find(a => a.id === 'att-1');
            expect(attachment?.deletedAt).toBe('2023-01-02T00:00:00.000Z');
            expect(attachment?.cloudKey).toBeUndefined();
            expect(attachment?.localStatus).toBe('missing');

            const second = mergeAppDataWithStats(first.data, sanitizeAppDataForRemote(first.data));
            expect(second.stats.tasks.conflicts).toBe(0);
            expect(second.data.tasks[0].attachments?.find(a => a.id === 'att-1')?.cloudKey).toBeUndefined();
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

        describe('content-revision conflicts (#1057)', () => {
            it('a higher contentRev wins the content fields even when the other side wins the task-level LWW', () => {
                const localAttachment: Attachment = {
                    id: 'att-rev',
                    kind: 'file',
                    title: 'local-title.txt',
                    uri: '/local/doc.txt',
                    cloudKey: 'attachments/att-rev.txt',
                    fileHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    contentRev: 2,
                    contentMtimeMs: 1000,
                    contentSize: 10,
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-03T00:00:00.000Z',
                };
                const incomingAttachment: Attachment = {
                    id: 'att-rev',
                    kind: 'file',
                    title: 'incoming-title.txt',
                    uri: '/incoming/doc.txt',
                    cloudKey: 'attachments/att-rev.txt',
                    fileHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    contentRev: 5,
                    contentMtimeMs: 2000,
                    contentSize: 20,
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-02T00:00:00.000Z',
                };
                const localTask: Task = { ...createMockTask('1', '2023-01-03'), attachments: [localAttachment] };
                const incomingTask: Task = { ...createMockTask('1', '2023-01-02'), attachments: [incomingAttachment] };

                const forward = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
                const forwardAttachment = forward.tasks[0].attachments?.find((a) => a.id === 'att-rev');
                // Task-level (attachment-level) LWW picks local (the later updatedAt), so
                // non-content fields like title come from local...
                expect(forwardAttachment?.title).toBe('local-title.txt');
                // ...but the higher contentRev (incoming) wins the content identity outright.
                expect(forwardAttachment?.contentRev).toBe(5);
                expect(forwardAttachment?.fileHash).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
                expect(forwardAttachment?.contentMtimeMs).toBe(2000);
                expect(forwardAttachment?.contentSize).toBe(20);

                // Convergent regardless of merge direction.
                const reverse = mergeAppData(mockAppData([incomingTask]), mockAppData([localTask]));
                const reverseAttachment = reverse.tasks[0].attachments?.find((a) => a.id === 'att-rev');
                expect(reverseAttachment?.contentRev).toBe(forwardAttachment?.contentRev);
                expect(reverseAttachment?.fileHash).toBe(forwardAttachment?.fileHash);
                expect(reverseAttachment?.title).toBe(forwardAttachment?.title);
            });

            it('keeps a deferred upload marker only when that local content identity wins', () => {
                const localAttachment: Attachment = {
                    id: 'att-pending',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/local/doc.txt',
                    cloudKey: 'attachments/att-pending.txt',
                    fileHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    contentRev: 3,
                    pendingContentUpload: true,
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-03T00:00:00.000Z',
                };
                const incomingAttachment: Attachment = {
                    ...localAttachment,
                    uri: '',
                    fileHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    contentRev: 4,
                    pendingContentUpload: undefined,
                    updatedAt: '2023-01-02T00:00:00.000Z',
                };
                const localTask: Task = { ...createMockTask('1', '2023-01-03'), attachments: [localAttachment] };
                const incomingTask: Task = { ...createMockTask('1', '2023-01-02'), attachments: [incomingAttachment] };

                const remoteWins = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
                expect(remoteWins.tasks[0].attachments?.[0]).toMatchObject({
                    contentRev: 4,
                    fileHash: incomingAttachment.fileHash,
                });
                expect(remoteWins.tasks[0].attachments?.[0]?.pendingContentUpload).toBeUndefined();

                const winningLocalAttachment = { ...localAttachment, contentRev: 5 };
                const winningLocalTask: Task = {
                    ...localTask,
                    attachments: [winningLocalAttachment],
                };
                const localWins = mergeAppData(mockAppData([winningLocalTask]), mockAppData([incomingTask]));
                expect(localWins.tasks[0].attachments?.[0]).toMatchObject({
                    contentRev: 5,
                    fileHash: winningLocalAttachment.fileHash,
                    pendingContentUpload: true,
                });

                const sameIdentityRemoteWinner = {
                    ...localAttachment,
                    uri: '',
                    fileHash: localAttachment.fileHash?.toUpperCase(),
                    pendingContentUpload: undefined,
                    updatedAt: '2023-01-04T00:00:00.000Z',
                };
                const tiedIdentity = mergeAppData(
                    mockAppData([localTask]),
                    mockAppData([{ ...incomingTask, attachments: [sameIdentityRemoteWinner] }]),
                );
                expect(tiedIdentity.tasks[0].attachments?.[0]).toMatchObject({
                    contentRev: localAttachment.contentRev,
                    fileHash: sameIdentityRemoteWinner.fileHash,
                    pendingContentUpload: true,
                });
            });

            it('a tied contentRev defers to whatever the attachment-level LWW already picked', () => {
                const localAttachment: Attachment = {
                    id: 'att-tie',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/local/doc.txt',
                    cloudKey: 'attachments/att-tie.txt',
                    fileHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    contentRev: 3,
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-03T00:00:00.000Z',
                };
                const incomingAttachment: Attachment = {
                    id: 'att-tie',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/incoming/doc.txt',
                    cloudKey: 'attachments/att-tie.txt',
                    fileHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    contentRev: 3,
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-02T00:00:00.000Z',
                };
                const localTask: Task = { ...createMockTask('1', '2023-01-03'), attachments: [localAttachment] };
                const incomingTask: Task = { ...createMockTask('1', '2023-01-02'), attachments: [incomingAttachment] };

                const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));
                const attachment = merged.tasks[0].attachments?.find((a) => a.id === 'att-tie');
                // Local wins the attachment-level LWW (later updatedAt); a tied contentRev
                // means there's nothing else to prefer, so its content fields come along.
                expect(attachment?.contentRev).toBe(3);
                expect(attachment?.fileHash).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            });

            it('merges cleanly against an old client that never set the new fields (missing is equivalent to 0)', () => {
                const oldClientAttachment: Attachment = {
                    id: 'att-old-client',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/old/doc.txt',
                    cloudKey: 'attachments/att-old-client.txt',
                    fileHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-02T00:00:00.000Z',
                };
                const newClientAttachment: Attachment = {
                    id: 'att-old-client',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/new/doc.txt',
                    cloudKey: 'attachments/att-old-client.txt',
                    fileHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                    contentRev: 1,
                    contentMtimeMs: 5000,
                    contentSize: 50,
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-01T00:00:00.000Z',
                };
                const oldClientTask: Task = { ...createMockTask('1', '2023-01-02'), attachments: [oldClientAttachment] };
                const newClientTask: Task = { ...createMockTask('1', '2023-01-01'), attachments: [newClientAttachment] };

                // New client's contentRev (1) beats the old client's implicit 0 regardless
                // of which side is "local" vs "incoming", and regardless of which side wins
                // the (irrelevant, older-updatedAt) attachment-level LWW.
                const oldLocal = mergeAppData(mockAppData([oldClientTask]), mockAppData([newClientTask]));
                const newLocal = mergeAppData(mockAppData([newClientTask]), mockAppData([oldClientTask]));
                for (const merged of [oldLocal, newLocal]) {
                    const attachment = merged.tasks[0].attachments?.find((a) => a.id === 'att-old-client');
                    expect(attachment?.contentRev).toBe(1);
                    expect(attachment?.fileHash).toBe('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
                    expect(attachment?.contentMtimeMs).toBe(5000);
                    expect(attachment?.contentSize).toBe(50);
                }

                // Merging the already-merged result against itself is a no-op (second-merge
                // idempotence): re-merging never re-derives a different content identity.
                const second = mergeAppData(oldLocal, oldLocal);
                const secondAttachment = second.tasks[0].attachments?.find((a) => a.id === 'att-old-client');
                expect(secondAttachment?.contentRev).toBe(1);
                expect(secondAttachment?.fileHash).toBe('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
            });

            it('keeps this device\'s recorded stat when merging against its own stripped remote twin (no local churn)', async () => {
                // Steady state on one device: local carries the stat, the remote copy of the
                // same attachment is sanitized (no uri/localStatus/stat), everything else is
                // byte-for-byte equal, so the attachment-level LWW is a tie. Whichever copy the
                // tie hands to `winner`, the merged record must keep the local stat: dropping it
                // made every post-merge check-on-touch pass re-record it, which persisted a
                // local write, which queued another sync, forever (desktop, WebDAV, 2026-08-31).
                const localAttachment: Attachment = {
                    id: 'att-twin',
                    kind: 'file',
                    title: 'photo.jpg',
                    uri: '/device/attachments/att-twin.jpg',
                    cloudKey: 'attachments/att-twin.jpg',
                    fileHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                    contentRev: 1,
                    contentMtimeMs: 1780243119338,
                    contentSize: 92826,
                    localStatus: 'available',
                    createdAt: '2026-04-19T20:06:20.922Z',
                    updatedAt: '2026-04-19T20:06:20.922Z',
                };
                const local = mockAppData([{ ...createMockTask('twin', '2026-04-19'), attachments: [localAttachment] }]);
                const remote = sanitizeAppDataForRemote(local);
                expect(remote.tasks[0].attachments?.[0]?.contentMtimeMs).toBeUndefined();

                const merged = mergeAppData(local, remote);
                const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-twin');
                expect(attachment).toMatchObject({
                    contentMtimeMs: 1780243119338,
                    contentSize: 92826,
                    localStatus: 'available',
                    uri: '/device/attachments/att-twin.jpg',
                });

                // And the post-merge lifecycle sees nothing to record: no patch, no local write.
                const { patches } = await runAttachmentTransferLifecycle({
                    attachmentsById: new Map([[attachment!.id, attachment!]]),
                    getLocalFilePresence: async () => 'present' as const,
                    getLocalFileStat: async () => ({ mtimeMs: 1780243119338, size: 92826 }),
                    computeLocalFileHash: async () => { throw new Error('stat matched; hash must not be read'); },
                    contentChangePhase: 'post-merge',
                    onUpload: async () => { throw new Error('must not upload'); },
                    onUploadError: vi.fn(),
                    onDownload: async () => { throw new Error('must not download'); },
                    onDownloadError: vi.fn(),
                });
                expect(patches.size).toBe(0);
            });

            it('two devices with byte-identical content and different local mtimes converge to zero remote writes (review B1)', async () => {
                // Reproduces the reviewer's exact scenario: two devices hold the same bytes but
                // recorded their own stat at different times (1000ms vs 2000ms) — nothing about
                // the actual content ever changes. Before the fix, contentMtimeMs/contentSize
                // traveled on the wire, so the merge would force one device to "adopt" the
                // other's foreign mtime, which its own next check-on-touch pass would "correct"
                // back — an unbounded remote-write loop on both sides.
                const sharedFile = (contentMtimeMs: number): Attachment => ({
                    id: 'att-shared',
                    kind: 'file',
                    title: 'shared.txt',
                    uri: '/device/shared.txt',
                    cloudKey: 'attachments/att-shared.txt',
                    fileHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                    contentRev: 1,
                    contentMtimeMs,
                    contentSize: 10,
                    localStatus: 'available',
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-01T00:00:00.000Z',
                });
                const taskFor = (attachment: Attachment): Task => ({
                    ...createMockTask('shared', '2023-01-01'),
                    attachments: [attachment],
                });

                let localA = mockAppData([taskFor(sharedFile(1000))]);
                let localB = mockAppData([taskFor(sharedFile(2000))]);
                // Remote starts already converged (both devices previously fully synced).
                let remote = sanitizeAppDataForRemote(localA);

                // One sync cycle for one device: merge against remote, run the post-merge
                // attachment lifecycle against that device's own (unchanging) disk file, then
                // report whether the resulting sanitized document differs from remote.
                const runCycle = async (
                    local: AppData,
                    ownStat: { mtimeMs: number; size: number },
                ): Promise<{ local: AppData; remoteWrite: boolean; sanitized: AppData }> => {
                    const merged = mergeAppData(local, remote);
                    await runAttachmentTransferLifecycle({
                        attachmentsById: new Map(
                            merged.tasks.flatMap((task) => (task.attachments ?? []).map((a) => [a.id, a] as const)),
                        ),
                        getLocalFilePresence: async () => 'present' as const,
                        getLocalFileStat: async () => ownStat,
                        computeLocalFileHash: async () => 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                        contentChangePhase: 'post-merge',
                        onUpload: async () => { throw new Error('must not upload: nothing changed'); },
                        onUploadError: vi.fn(),
                        onDownload: async () => { throw new Error('must not download: bytes are already correct'); },
                        onDownloadError: vi.fn(),
                    });
                    const sanitized = sanitizeAppDataForRemote(merged);
                    const remoteWrite = !areSyncPayloadsEqual(sanitized, remote);
                    return { local: merged, remoteWrite, sanitized };
                };

                // Cycle 1 may legitimately write once per device while remote catches up
                // to whichever's sanitized shape wins the tie.
                const cycle1A = await runCycle(localA, { mtimeMs: 1000, size: 10 });
                if (cycle1A.remoteWrite) remote = cycle1A.sanitized;
                localA = cycle1A.local;
                const cycle1B = await runCycle(localB, { mtimeMs: 2000, size: 10 });
                if (cycle1B.remoteWrite) remote = cycle1B.sanitized;
                localB = cycle1B.local;

                // Cycles 2 and 3: nothing changed anywhere on either device — must be
                // complete no-ops (the acceptance-critical invariant).
                for (let cycle = 0; cycle < 2; cycle += 1) {
                    const cycleA = await runCycle(localA, { mtimeMs: 1000, size: 10 });
                    expect(cycleA.remoteWrite).toBe(false);
                    localA = cycleA.local;
                    const cycleB = await runCycle(localB, { mtimeMs: 2000, size: 10 });
                    expect(cycleB.remoteWrite).toBe(false);
                    localB = cycleB.local;
                }
            });
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

        it('blocks deeply nested encoded traversal segments in attachment uris', () => {
            const localAttachment: Attachment = {
                id: 'att-deep-encoded',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                localStatus: 'available',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            let nestedTraversal = '../secret.txt';
            for (let index = 0; index < 10; index += 1) {
                nestedTraversal = encodeURIComponent(nestedTraversal);
            }
            const incomingAttachment: Attachment = {
                id: 'att-deep-encoded',
                kind: 'file',
                title: 'doc.txt',
                uri: `/incoming/${nestedTraversal}`,
                cloudKey: 'attachments/att-deep-encoded.txt',
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
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-deep-encoded');

            expect(attachment?.uri).toBe('/local/doc.txt');
            expect(attachment?.cloudKey).toBe('attachments/att-deep-encoded.txt');
        });

        it('blocks traversal segments in file uris', () => {
            const localAttachment: Attachment = {
                id: 'att-file-uri',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                localStatus: 'available',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-file-uri',
                kind: 'file',
                title: 'doc.txt',
                uri: 'file:///../secret.txt',
                cloudKey: 'attachments/att-file-uri.txt',
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
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-file-uri');

            expect(attachment?.uri).toBe('/local/doc.txt');
            expect(attachment?.cloudKey).toBe('attachments/att-file-uri.txt');
        });

        it('sanitizes attachment uris on one-sided incoming tasks', () => {
            const incomingTask: Task = {
                ...createMockTask('incoming-only', '2023-01-03'),
                attachments: [{
                    id: 'att-one-sided',
                    kind: 'file',
                    title: 'secret.txt',
                    uri: 'file:///safe/%252e%252e/secret.txt',
                    cloudKey: 'attachments/att-one-sided.txt',
                    localStatus: 'available',
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-03T00:00:00.000Z',
                }],
            };

            const merged = mergeAppData(mockAppData([]), mockAppData([incomingTask]));
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-one-sided');

            expect(attachment?.uri).toBe('');
            expect(attachment?.cloudKey).toBe('attachments/att-one-sided.txt');
        });

        it('detaches live tasks and tombstones stale sections when their project is deleted', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
            try {
                const local = mockAppData([], [
                    createMockProject('project-deleted', '2024-01-03T00:00:00.000Z', '2024-01-03T00:00:00.000Z'),
                ]);
                const incomingSection: Section = createMockSection(
                    'section-stale',
                    'project-deleted',
                    '2024-01-02T00:00:00.000Z'
                );
                incomingSection.rev = 5;
                const incomingTask: Task = {
                    ...createMockTask('task-stale', '2024-01-04T00:00:00.000Z'),
                    projectId: 'project-deleted',
                    sectionId: 'section-stale',
                    rev: 2,
                };

                const merged = mergeAppData(local, mockAppData([incomingTask], [], [incomingSection]));
                const repairedSection = merged.sections.find((section) => section.id === 'section-stale');

                expect(repairedSection?.deletedAt).toBe('2026-02-01T00:00:00.000Z');
                expect(repairedSection?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
                expect(repairedSection?.rev).toBe(6);
                expect(repairedSection?.revBy).toBe('sync-repair');
                expect(merged.tasks[0].projectId).toBeUndefined();
                expect(merged.tasks[0].sectionId).toBeUndefined();
                expect(merged.tasks[0].rev).toBe(3);
                expect(merged.tasks[0].revBy).toBe('sync-repair');
            } finally {
                vi.useRealTimers();
            }
        });

        it('clears deleted area references from merged projects and tasks', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));
            try {
                const local: AppData = {
                    tasks: [],
                    projects: [],
                    sections: [],
                    areas: [
                        createMockArea('area-deleted', '2024-01-03T00:00:00.000Z', '2024-01-03T00:00:00.000Z'),
                    ],
                    settings: {},
                };
                const incomingProject: Project = {
                    ...createMockProject('project-1', '2024-01-04T00:00:00.000Z'),
                    areaId: 'area-deleted',
                    rev: 4,
                };
                const incomingTask: Task = {
                    ...createMockTask('task-1', '2024-01-04T00:00:00.000Z'),
                    areaId: 'area-deleted',
                    rev: 7,
                };

                const merged = mergeAppData(local, {
                    tasks: [incomingTask],
                    projects: [incomingProject],
                    sections: [],
                    areas: [],
                    settings: {},
                });

                expect(merged.projects[0].areaId).toBeUndefined();
                expect(merged.projects[0].rev).toBe(5);
                expect(merged.projects[0].revBy).toBe('sync-repair');
                expect(merged.tasks[0].areaId).toBeUndefined();
                expect(merged.tasks[0].rev).toBe(8);
                expect(merged.tasks[0].revBy).toBe('sync-repair');
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not keep incrementing repair revisions for already repaired stale area references', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-02-03T00:00:00.000Z'));
            try {
                const local: AppData = {
                    tasks: [],
                    projects: [],
                    sections: [],
                    areas: [
                        createMockArea('area-deleted', '2024-01-03T00:00:00.000Z', '2024-01-03T00:00:00.000Z'),
                    ],
                    settings: {},
                };
                const incomingTask: Task = {
                    ...createMockTask('task-repaired-stale-area', '2024-01-04T00:00:00.000Z'),
                    areaId: 'area-deleted',
                    rev: 8,
                    revBy: 'sync-repair',
                };

                const merged = mergeAppData(local, {
                    tasks: [incomingTask],
                    projects: [],
                    sections: [],
                    areas: [],
                    settings: {},
                });

                expect(merged.tasks[0].areaId).toBeUndefined();
                expect(merged.tasks[0].rev).toBe(8);
                expect(merged.tasks[0].revBy).toBe('sync-repair');
                expect(merged.tasks[0].updatedAt).toBe('2026-02-03T00:00:00.000Z');
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps a cleared area color cleared against a peer that still has it (#974)', () => {
            // rev and updatedAt disagree on purpose: the cleared side has the
            // HIGHER rev but the OLDER updatedAt, and the still-colored peer
            // has the newer updatedAt but the lower rev. If merge fell back
            // to plain updatedAt LWW, the still-colored peer (newer
            // updatedAt) would win and this test would fail — so a pass here
            // actually pins the rev-based mechanism, not just "clear wins".
            const clearedArea: Area = {
                ...createMockArea('area-1', '2024-01-01T00:00:00.000Z'),
                color: undefined,
                rev: 5,
                revBy: 'device-b',
            };
            const staleColoredArea: Area = {
                ...createMockArea('area-1', '2024-01-02T00:00:00.000Z'),
                color: '#3b82f6',
                rev: 2,
                revBy: 'device-a',
            };

            const merged = mergeAppData(
                { ...mockAppData(), areas: [clearedArea] },
                { ...mockAppData(), areas: [staleColoredArea] },
            );

            expect(merged.areas[0].color).toBeUndefined();
            expect(merged.areas[0].rev).toBe(5);
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

        it('keeps a safe attachment URI when both sides report missing local files', () => {
            const localAttachment: Attachment = {
                id: 'att-missing-uri',
                kind: 'file',
                title: 'doc.txt',
                uri: '/local/doc.txt',
                localStatus: 'missing',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const incomingAttachment: Attachment = {
                id: 'att-missing-uri',
                kind: 'file',
                title: 'doc.txt',
                uri: '/incoming/doc.txt',
                localStatus: 'missing',
                cloudKey: 'attachments/att-missing-uri.txt',
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
            const attachment = merged.tasks[0].attachments?.find((item) => item.id === 'att-missing-uri');

            expect(attachment?.uri).toBe('/incoming/doc.txt');
            expect(attachment?.localStatus).toBe('missing');
            expect(attachment?.cloudKey).toBe('attachments/att-missing-uri.txt');
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
                fileHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
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
            expect(attachment?.fileHash).toBe('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
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
                pendingContentUpload: true,
            };
            const incomingAttachment: Attachment = {
                id: 'att-1',
                kind: 'file',
                title: 'local.txt',
                uri: '/tmp/incoming.txt',
                cloudKey: 'attachments/att-1.txt',
                fileHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
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
            expect(attachment?.pendingContentUpload).toBeUndefined();
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

        it('uses the later updatedAt for tombstone operation time when it is newer than deletedAt', () => {
            const deletedTask = {
                ...createMockTask('1', '2023-01-02T00:02:00.000Z', '2023-01-02T00:00:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const liveTask = {
                ...createMockTask('1', '2023-01-02T00:01:00.000Z'),
                rev: 7,
                revBy: 'device-b',
            } satisfies Task;

            const forward = mergeAppData(mockAppData([deletedTask]), mockAppData([liveTask]));
            const reverse = mergeAppData(mockAppData([liveTask]), mockAppData([deletedTask]));

            expect(forward.tasks).toHaveLength(1);
            expect(forward.tasks[0]).toEqual(reverse.tasks[0]);
            expect(forward.tasks[0].deletedAt).toBe('2023-01-02T00:00:00.000Z');
            expect(forward.tasks[0].updatedAt).toBe('2023-01-02T00:02:00.000Z');
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

        it('prefers deletion when legacy live update falls inside the ambiguity window', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.100Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:00:00.000Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.000Z');
        });

        it('prefers deletion when legacy live update is 20 seconds newer inside the ambiguity window', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:20.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:00:00.000Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.000Z');
        });

        it('prefers deletion when legacy delete time is only 100ms newer', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.100Z', '2023-01-02T00:00:00.100Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:00:00.100Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.100Z');
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
            expect(forward.tasks[0].deletedAt).toBeUndefined();
            expect(forward.tasks[0].title).toBe('aa live');
        });

        it('logs when a live item is preserved inside the delete ambiguity window', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const deletedTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const liveTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;

            const merged = mergeAppData(mockAppData([deletedTask]), mockAppData([liveTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();

            const warningCall = warnSpy.mock.calls.find(([message]) => (
                message === 'Preserved live item during ambiguous delete-vs-live merge'
            ));
            expect(warningCall).toBeTruthy();
            const [, warningMeta] = warningCall ?? [];
            expect(warningMeta).toEqual(
                expect.objectContaining({
                    scope: 'sync',
                    category: 'sync',
                    context: expect.any(String),
                })
            );
            expect(parseLoggedContext(warningMeta?.context)).toMatchObject({
                entityType: 'task',
                id: '1',
                operationDiffMs: 0,
                localDeletedAt: '2023-01-02T00:00:00.000Z',
                localRev: 7,
                incomingRev: 7,
            });
        });

        it('prefers live data over revBy tie-breaks inside the ambiguity window', () => {
            const deletedTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:00:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const liveTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z'),
                rev: 7,
                revBy: 'device-z',
            } satisfies Task;

            const merged = mergeAppData(mockAppData([deletedTask]), mockAppData([liveTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBeUndefined();
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

        it('falls back to deterministic tie-break when only one side has revBy', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'alpha',
                rev: 7,
                revBy: 'device-z',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                title: 'zulu',
                rev: 7,
            } satisfies Task;

            const merged = mergeAppData(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].title).toBe('zulu');
            expect(merged.tasks[0].title).toBe(chooseDeterministicWinner(localTask, incomingTask).title);
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

        it('treats purgedAt as permanent deletion when legacy deletedAt is missing', () => {
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
            expect(result.data.tasks[0]).toMatchObject({
                title: '(deleted)',
                deletedAt: localTask.purgedAt,
                purgedAt: localTask.purgedAt,
                rev: 8,
                revBy: SYNC_REPAIR_REV_BY,
            });
            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.conflictIds).toEqual([]);
        });

        it('does not count conflict when stale recurrence preview flag differs on non-recurring task', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                showFutureRecurrence: true,
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(result.data.tasks).toHaveLength(1);
            expect(result.data.tasks[0].showFutureRecurrence).toBeUndefined();
            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.conflictIds).toHaveLength(0);
            expect(result.stats.tasks.conflictSamples).toHaveLength(0);
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

        it('does not count conflict when only revision number differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 4,
                revBy: 'device-z',
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(result.data.tasks).toHaveLength(1);
            expect(result.data.tasks[0].rev).toBe(7);
            expect(result.data.tasks[0].revBy).toBe('device-a');
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

        it('does not count conflict when only file attachment transport metadata differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                attachments: [{
                    id: 'att-1',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/local/doc.txt',
                    localStatus: 'available',
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-02T00:00:00.000Z',
                }],
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                attachments: [{
                    id: 'att-1',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '',
                    cloudKey: 'attachments/att-1.txt',
                    fileHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-02T00:00:00.000Z',
                }],
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));
            const attachment = result.data.tasks[0].attachments?.find((item) => item.id === 'att-1');

            expect(result.data.tasks).toHaveLength(1);
            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.conflictIds).toHaveLength(0);
            expect(attachment?.uri).toBe('/local/doc.txt');
            expect(attachment?.localStatus).toBe('available');
            expect(attachment?.cloudKey).toBe('attachments/att-1.txt');
            expect(attachment?.fileHash).toBe('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        });

        it('does not count conflict when attachment order differs but content matches', () => {
            const attachmentA: Attachment = {
                id: 'att-a',
                kind: 'file',
                title: 'a.txt',
                uri: '/tmp/a.txt',
                localStatus: 'available',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const attachmentB: Attachment = {
                id: 'att-b',
                kind: 'link',
                title: 'Docs',
                uri: 'https://example.com/docs',
                createdAt: '2023-01-01T00:00:00.000Z',
                updatedAt: '2023-01-02T00:00:00.000Z',
            };
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                attachments: [attachmentB, attachmentA],
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                attachments: [attachmentA, attachmentB],
            } satisfies Task;

            const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

            expect(result.data.tasks).toHaveLength(1);
            expect(result.stats.tasks.conflicts).toBe(0);
            expect(result.stats.tasks.conflictIds).toHaveLength(0);
        });

        it('counts conflict when link attachment content differs', () => {
            const localTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                attachments: [{
                    id: 'att-link',
                    kind: 'link',
                    title: 'Docs',
                    uri: 'https://example.com/docs-a',
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-02T00:00:00.000Z',
                }],
            } satisfies Task;
            const incomingTask = {
                ...createMockTask('1', '2023-01-02T00:05:00.000Z'),
                rev: 7,
                revBy: 'device-a',
                attachments: [{
                    id: 'att-link',
                    kind: 'link',
                    title: 'Docs',
                    uri: 'https://example.com/docs-b',
                    createdAt: '2023-01-01T00:00:00.000Z',
                    updatedAt: '2023-01-02T00:00:00.000Z',
                }],
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

        it('stamps synthesized area order with a repair revision', () => {
            const legacyArea = {
                ...createMockArea('area-1', '2023-01-02T00:05:00.000Z'),
                rev: 4,
                revBy: 'device-a',
            };
            delete (legacyArea as Partial<Area>).order;

            const merged = mergeAppData(
                { ...mockAppData(), areas: [legacyArea] },
                mockAppData()
            );

            expect(merged.areas[0].order).toBe(0);
            expect(merged.areas[0].rev).toBe(5);
            expect(merged.areas[0].revBy).toBe(SYNC_REPAIR_REV_BY);
        });

        it('caps synthesized area repair revisions at the safe maximum', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                const legacyArea = {
                    ...createMockArea('area-1', '2023-01-02T00:05:00.000Z'),
                    rev: MAX_SYNC_REVISION,
                    revBy: 'device-a',
                };
                delete (legacyArea as Partial<Area>).order;

                const merged = mergeAppData(
                    { ...mockAppData(), areas: [legacyArea] },
                    mockAppData()
                );

                expect(merged.areas[0].order).toBe(0);
                expect(merged.areas[0].rev).toBe(MAX_SYNC_REVISION);
                expect(merged.areas[0].revBy).toBe(SYNC_REPAIR_REV_BY);
                expect(warnSpy.mock.calls.some(([message]) => (
                    message === 'Sync revision reached safe maximum; preserving capped revision'
                ))).toBe(true);
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('repairs deleted project and task area references before restore', () => {
            const nowIso = '2026-04-01T00:00:00.000Z';
            const oldIso = '2026-03-31T00:00:00.000Z';
            const deletedProject = {
                ...createMockProject('project-1', oldIso, oldIso),
                areaId: 'area-live',
                areaTitle: 'Old title',
                rev: 2,
                revBy: 'device-a',
            } satisfies Project;
            const deletedTask = {
                ...createMockTask('task-1', oldIso, oldIso),
                areaId: 'area-deleted',
                rev: 2,
                revBy: 'device-a',
            } satisfies Task;
            const liveArea = {
                ...createMockArea('area-live', oldIso),
                name: 'Renamed area',
            } satisfies Area;
            const deletedArea = createMockArea('area-deleted', oldIso, oldIso);

            const merged = mergeAppData(
                {
                    ...mockAppData([deletedTask], [deletedProject]),
                    areas: [liveArea, deletedArea],
                },
                mockAppData(),
                { nowIso }
            );

            expect(merged.projects[0]).toMatchObject({
                areaId: 'area-live',
                areaTitle: 'Renamed area',
                rev: 3,
                revBy: SYNC_REPAIR_REV_BY,
                updatedAt: nowIso,
                deletedAt: oldIso,
            });
            expect(merged.tasks[0]).toMatchObject({
                areaId: undefined,
                rev: 3,
                revBy: SYNC_REPAIR_REV_BY,
                updatedAt: nowIso,
                deletedAt: oldIso,
            });
        });

        it('logs a structured warning when a delete wins over a live edit', () => {
            const logs: LogPayload[] = [];
            setLogger((payload) => {
                logs.push(payload);
            });

            try {
                const result = mergeAppDataWithStats(
                    mockAppData([
                        createMockTask(
                            'task-delete-wins',
                            '2026-04-01T00:01:00.000Z',
                            '2026-04-01T00:01:00.000Z'
                        ),
                    ]),
                    mockAppData([{
                        ...createMockTask('task-delete-wins', '2026-04-01T00:00:00.000Z'),
                        title: 'Edited elsewhere',
                    }])
                );

                expect(result.data.tasks[0].deletedAt).toBe('2026-04-01T00:01:00.000Z');
            } finally {
                setLogger(consoleLogger);
            }

            const discardedLog = logs.find((entry) => entry.message === 'syncConflictDiscarded');
            expect(discardedLog?.context).toMatchObject({
                entityType: 'task',
                id: 'task-delete-wins',
                discardedSide: 'incoming',
                winnerSide: 'local',
                reason: 'deleteState',
            });
        });

        it('summarizes elided discarded-conflict warnings', () => {
            const logs: LogPayload[] = [];
            setLogger((payload) => {
                logs.push(payload);
            });

            try {
                const localTasks = Array.from({ length: 6 }, (_, index) =>
                    createMockTask(
                        `task-delete-wins-${index}`,
                        '2026-04-01T00:01:00.000Z',
                        '2026-04-01T00:01:00.000Z'
                    )
                );
                const incomingTasks = Array.from({ length: 6 }, (_, index) => ({
                    ...createMockTask(`task-delete-wins-${index}`, '2026-04-01T00:00:00.000Z'),
                    title: `Edited elsewhere ${index}`,
                }));

                mergeAppDataWithStats(mockAppData(localTasks), mockAppData(incomingTasks));
            } finally {
                setLogger(consoleLogger);
            }

            expect(logs.filter((entry) => entry.message === 'syncConflictDiscarded')).toHaveLength(5);
            const summary = logs.find((entry) => entry.message === 'syncConflictDiscardedSummary');
            expect(summary?.context).toMatchObject({
                entityType: 'task',
                total: 6,
                elided: 1,
            });
        });

        it('logs task status resolutions when revision order makes one side win', () => {
            const logs: LogPayload[] = [];
            setLogger((payload) => {
                logs.push(payload);
            });

            try {
                const localTask = {
                    ...createMockTask('task-status-resolution', '2026-05-11T20:00:00.000Z'),
                    status: 'done',
                    completedAt: '2026-05-11T20:00:00.000Z',
                    rev: 2,
                    revBy: 'android-device',
                } satisfies Task;
                const incomingTask = {
                    ...createMockTask('task-status-resolution', '2026-05-11T19:59:00.000Z'),
                    status: 'next',
                    rev: 3,
                    revBy: 'desktop-device',
                } satisfies Task;

                const result = mergeAppDataWithStats(mockAppData([localTask]), mockAppData([incomingTask]));

                expect(result.data.tasks[0].status).toBe('next');
                expect(result.stats.tasks.conflicts).toBe(0);
            } finally {
                setLogger(consoleLogger);
            }

            const statusLog = logs.find((entry) => entry.message === 'syncTaskStatusResolution');
            expect(statusLog?.context).toMatchObject({
                id: 'task-status-resolution',
                winnerSide: 'incoming',
                resolutionReason: 'revision',
                countedConflict: false,
                localStatus: 'done',
                incomingStatus: 'next',
                localCompletedAt: '2026-05-11T20:00:00.000Z',
                localRev: 2,
                incomingRev: 3,
                localRevBy: 'android-device',
                incomingRevBy: 'desktop-device',
            });
        });

        it('prefers deletion when legacy delete-vs-live operation times are equal', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z', '2023-01-02T00:05:00.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:05:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:05:00.000Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.000Z');
        });

        it('still prefers delete when it is more than the ambiguity window newer than live', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:00:31.000Z', '2023-01-02T00:00:31.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:00:31.000Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:00:31.000Z');
        });

        it('treats invalid deletedAt as a conservative deletion timestamp', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-01T00:00:00.000Z', 'invalid-date'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:00:00.000Z'),
            ]);

            const merged = mergeAppDataWithStats(local, incoming);

            expect(merged.data.tasks).toHaveLength(1);
            expect(merged.data.tasks[0].deletedAt).toBeUndefined();
            expect(merged.data.tasks[0].updatedAt).toBe('2023-01-02T00:00:00.000Z');
            expect(merged.stats.tasks.invalidTimestamps).toBe(1);
        });

        it('uses max(updatedAt, deletedAt) as delete operation time beyond skew window', () => {
            const local = mockAppData([
                createMockTask('1', '2023-01-02T00:12:00.000Z', '2023-01-02T00:05:00.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2023-01-02T00:11:00.000Z'),
            ]);

            const merged = mergeAppData(local, incoming);

            expect(merged.tasks).toHaveLength(1);
            expect(merged.tasks[0].deletedAt).toBe('2023-01-02T00:05:00.000Z');
            expect(merged.tasks[0].updatedAt).toBe('2023-01-02T00:12:00.000Z');
        });

        it('clamps far-future timestamps during merge conflict evaluation', () => {
            const local = mockAppData([
                createMockTask('1', '2099-01-01T00:00:00.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('1', '2026-01-01T00:00:00.000Z'),
            ]);

            const result = mergeAppDataWithStats(local, incoming, { nowIso: '2026-01-01T00:00:00.000Z' });
            expect(result.stats.tasks.maxClockSkewMs).toBeLessThanOrEqual(CLOCK_SKEW_THRESHOLD_MS);
            expect(result.stats.tasks.futureTimestampClamps).toBe(1);
            expect(result.stats.tasks.futureTimestampClampIds).toEqual(['1']);
        });

        it('preserves relative ordering when both timestamps are clamped in the future', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                const localTask = {
                    ...createMockTask('1', '2099-01-01T00:00:00.000Z'),
                    title: 'zz older future',
                } satisfies Task;
                const incomingTask = {
                    ...createMockTask('1', '2099-01-02T00:00:00.000Z'),
                    title: 'aa newer future',
                } satisfies Task;

                const result = mergeAppDataWithStats(
                    mockAppData([localTask]),
                    mockAppData([incomingTask]),
                    { nowIso: '2026-01-01T00:00:00.000Z' }
                );
                const merged = result.data;

                expect(merged.tasks).toHaveLength(1);
                expect(merged.tasks[0].title).toBe('aa newer future');
                expect(merged.tasks[0].updatedAt).toBe('2099-01-02T00:00:00.000Z');
                expect(result.stats.tasks.futureTimestampClamps).toBe(2);
                expect(result.stats.tasks.futureTimestampClampIds).toEqual(['1']);

                const warningCall = warnSpy.mock.calls.find(([message]) => (
                    message === 'Both merge candidates had future updatedAt timestamps clamped'
                ));
                expect(warningCall).toBeTruthy();
                const [, warningMeta] = warningCall ?? [];
                expect(parseLoggedContext(warningMeta?.context)).toMatchObject({
                    entityType: 'task',
                    id: '1',
                    localUpdatedAt: '2099-01-01T00:00:00.000Z',
                    incomingUpdatedAt: '2099-01-02T00:00:00.000Z',
                    clampTime: '2026-01-01T00:00:00.000Z',
                });
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('does not use Date.now for entity clamping after normalizing the merge clock', () => {
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

                expect(nowSpy).not.toHaveBeenCalled();
            } finally {
                nowSpy.mockRestore();
            }
        });

        it('uses a deterministic winner for legacy records when timestamps are within skew threshold', () => {
            const olderTask = {
                ...createMockTask('1', '2023-01-02T00:00:00.000Z'),
                title: 'Bravo',
            } satisfies Task;
            const newerTask = {
                ...createMockTask('1', '2023-01-02T00:04:00.000Z'),
                title: 'Alpha',
            } satisfies Task;

            const expectedWinner = chooseDeterministicWinner(olderTask, newerTask);
            const forward = mergeAppData(mockAppData([olderTask]), mockAppData([newerTask]));
            const reverse = mergeAppData(mockAppData([newerTask]), mockAppData([olderTask]));

            expect(forward.tasks).toHaveLength(1);
            expect(forward.tasks[0]).toEqual(reverse.tasks[0]);
            expect(forward.tasks[0].title).toBe(expectedWinner.title);
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

        it('reuses a recoverable peer createdAt before falling back to updatedAt', () => {
            const localProject: Project = {
                ...createMockProject('p1', '2023-01-02T00:03:00.000Z'),
                title: 'local wins',
                createdAt: '2023-01-02T00:05:00.000Z',
            };
            const incomingProject: Project = {
                ...createMockProject('p1', '2023-01-02T00:01:00.000Z'),
                title: 'incoming older',
                createdAt: '2023-01-02T00:00:00.000Z',
            };

            const { data, stats } = mergeAppDataWithStats(
                mockAppData([], [localProject]),
                mockAppData([], [incomingProject])
            );

            expect(data.projects).toHaveLength(1);
            expect(data.projects[0].title).toBe('local wins');
            expect(data.projects[0].updatedAt).toBe('2023-01-02T00:03:00.000Z');
            expect(data.projects[0].createdAt).toBe('2023-01-02T00:00:00.000Z');
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

    });
});
