import { describe, expect, it, vi } from 'vitest';

import type { AppData, Project, Task } from './types';
import type {
    SyncBackendIO,
    SyncRunNotifier,
    SyncRunPlatformHooks,
    SyncRunPolicy,
    SyncRunStorage,
    SyncRunStoreBridge,
    SyncStatusUpdates,
} from './sync-run-ports';
import { SyncRemoteWriteConflict } from './sync-run-ports';
import { normalizeRemoteWriteResult, runSharedSyncCycle } from './sync-run';
import { normalizeAppData } from './sync-normalization';
import { cloneAppData } from './sync-runtime-utils';
import { toRemoteSyncDocument } from './sync-document';
import type { FastSyncState } from './sync-fast-sync';
import {
    SyncFileLockBusyError,
    SyncFileLockUnavailableError,
    type SyncBackend,
} from './sync-service-utils';
import type { SyncCycleIO, SyncCycleResult } from './sync-types';
import { performSyncCycle } from './sync';
import {
    SyncRemoteMutationFenceBusyError,
    SyncRemoteMutationFenceLostError,
    type SyncRemoteMutationFenceLease,
} from './sync-remote-fence';

const NOW = new Date('2026-07-13T10:00:00.000Z');
const STAMP = '2026-07-01T00:00:00.000Z';

const createTask = (id: string, title: string): Task => ({
    id,
    title,
    status: 'inbox',
    createdAt: STAMP,
    updatedAt: STAMP,
} as Task);

const createData = (tasks: Task[] = [], settings: AppData['settings'] = {}): AppData => normalizeAppData({
    tasks,
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings,
});

const createFenceLease = (overrides: Partial<SyncRemoteMutationFenceLease> = {}): SyncRemoteMutationFenceLease => ({
    assertHeld: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    retryAfterMs: vi.fn(() => 5_000),
    ...overrides,
});

type HarnessConfig = {
    local?: AppData;
    remote?: AppData | null;
    backend?: SyncBackend;
    fastSyncScope?: string | null;
    manual?: boolean;
    activationProbe?: boolean;
    ignorePendingRemoteWriteBackoff?: boolean;
    policy?: Partial<SyncRunPolicy>;
    io?: Partial<SyncBackendIO>;
    hooks?: Partial<SyncRunPlatformHooks>;
    storage?: Partial<SyncRunStorage>;
    attachmentCleanupIntervalMs?: number;
    performSyncCycle?: (io: SyncCycleIO) => Promise<SyncCycleResult>;
};

const createHarness = (config: HarnessConfig = {}) => {
    const initial = config.local ?? createData([createTask('t-local', 'Local task')]);
    const harness = {
        lastDataChangeAt: 1,
        inMemory: cloneAppData(initial),
        persisted: cloneAppData(initial),
        remote: (config.remote === undefined ? null : config.remote) as AppData | null,
        fastStates: new Map<string, FastSyncState>(),
        statusUpdates: [] as SyncStatusUpdates[],
        steps: [] as string[],
        warnings: [] as { message: string; error?: unknown }[],
        infos: [] as { message: string; extra?: Record<string, string> }[],
        diagnostics: [] as string[],
        uiErrors: [] as (string | null)[],
        callOrder: [] as string[],
    };

    const io: SyncBackendIO = {
        readRemote: vi.fn(async () => {
            harness.callOrder.push('readRemote');
            return harness.remote ? cloneAppData(harness.remote) : null;
        }),
        writeRemote: vi.fn(async (sanitized: AppData) => {
            harness.callOrder.push('writeRemote');
            harness.remote = cloneAppData(sanitized);
            return { fingerprint: `remote-fp-${JSON.stringify(sanitized.tasks.map((task) => task.id).sort())}` };
        }),
        readRemoteFingerprint: vi.fn(async () => (
            harness.remote
                ? `remote-fp-${JSON.stringify(harness.remote.tasks.map((task) => task.id).sort())}`
                : null
        )),
        ...config.io,
    };

    const store: SyncRunStoreBridge = {
        getLastDataChangeAt: () => harness.lastDataChangeAt,
        getInMemorySnapshot: () => cloneAppData(harness.inMemory),
        flushPendingSave: vi.fn(async () => {
            harness.callOrder.push('flush');
        }),
        setUiError: (message) => harness.uiErrors.push(message),
        getSettings: () => harness.inMemory.settings,
    };

    const storage: SyncRunStorage = {
        readPersistedLocal: vi.fn(async () => cloneAppData(harness.persisted)),
        persistLocal: vi.fn(async (data: AppData) => {
            harness.callOrder.push('persistLocal');
            harness.persisted = cloneAppData(data);
        }),
        persistSyncStatus: vi.fn(async (updates) => {
            harness.statusUpdates.push(updates);
        }),
        readFastSyncState: vi.fn(async (scope: string) => harness.fastStates.get(scope) ?? null),
        writeFastSyncState: vi.fn(async (state: FastSyncState) => {
            harness.fastStates.set(state.scope, state);
        }),
        injectExternalCalendars: vi.fn(async (data: AppData) => data),
        persistExternalCalendars: vi.fn(async () => {}),
        ...config.storage,
    };

    const notifier: SyncRunNotifier = {
        setStep: (step) => harness.steps.push(step),
        logInfo: (message, extra) => harness.infos.push({ message, extra }),
        logWarning: (message, error) => harness.warnings.push({ message, error }),
        logWarningExtra: (message) => harness.warnings.push({ message }),
        sanitizeLogMessage: (message) => message,
        logSyncError: vi.fn(async () => '/tmp/sync-error.log'),
        logMergeSummary: vi.fn(),
        onDiagnostic: (event) => harness.diagnostics.push(event.event),
    };

    const hooks: SyncRunPlatformHooks = {
        setupCycle: vi.fn(async () => ({
            kind: 'ready' as const,
            backend: config.backend ?? 'cloud',
            cloudProvider: 'selfhosted' as const,
            io,
            fastSyncScope: config.fastSyncScope ?? null,
        })),
        requestFollowUp: vi.fn(),
        requestFollowUpAfter: vi.fn(),
        formatErrorMessage: (error, backend) => `[${backend}] ${error instanceof Error ? error.message : String(error)}`,
        finalizeErrorStatus: vi.fn(async () => {}),
        finalizeSuccess: vi.fn(async () => {}),
        ...config.hooks,
    };

    const policy: SyncRunPolicy = {
        preSyncAttachmentsBeforeFastCheck: false,
        enableReadCheckSkip: false,
        postMergeAttachmentErrorPolicy: 'warn',
        attachmentPhasesEnabled: true,
        ...config.policy,
    };

    const run = (options: {
        manual?: boolean;
        activationProbe?: boolean;
        fileSyncLockBusyRetryAttempt?: number;
        ignorePendingRemoteWriteBackoff?: boolean;
    } = {}) => runSharedSyncCycle({
        options: {
            manual: config.manual ?? options.manual,
            activationProbe: config.activationProbe ?? options.activationProbe,
            fileSyncLockBusyRetryAttempt: options.fileSyncLockBusyRetryAttempt,
            ignorePendingRemoteWriteBackoff: config.ignorePendingRemoteWriteBackoff
                ?? options.ignorePendingRemoteWriteBackoff,
        },
        storage,
        notifier,
        store,
        hooks,
        policy,
        now: () => NOW,
        attachmentCleanupIntervalMs: config.attachmentCleanupIntervalMs,
        performSyncCycle: config.performSyncCycle,
    });

    return { harness, io, store, storage, notifier, hooks, policy, run };
};

describe('runSharedSyncCycle', () => {
    describe('persisted-vs-in-memory reconcile short-circuit (#766)', () => {
        it('uses the persisted side without merging when change fingerprints match', async () => {
            // Same id/rev/updatedAt metadata, diverged content. The fingerprint
            // short-circuit trusts the tuple and hands back the persisted side
            // (the previous cycle's merge output, whose byte shape the fast-sync
            // state recorded) — the accepted deferral this test documents.
            // Sides chosen so the assertion DISCRIMINATES: a real merge's
            // deterministic winner is signature-lexical and would pick the
            // in-memory 'Zebra title'; only the short-circuit yields 'Apple'.
            const inMemory = createData([createTask('t-1', 'Zebra title')]);
            const persisted = createData([createTask('t-1', 'Apple title')]);
            let capturedLocal: AppData | null = null;
            const { run } = createHarness({
                local: inMemory,
                storage: { readPersistedLocal: vi.fn(async () => cloneAppData(persisted)) },
                performSyncCycle: async (io) => {
                    capturedLocal = await io.readLocal();
                    return performSyncCycle(io);
                },
            });

            const result = await run();

            expect(result.success).toBe(true);
            expect(capturedLocal!.tasks.map((task) => task.title)).toEqual(['Apple title']);
        });

        it('still merges when the change fingerprints differ', async () => {
            // The extra task lives on the IN-MEMORY side so the assertion
            // discriminates: only a real merge unions it in — a broken
            // short-circuit handing back persisted would drop it.
            const inMemory = createData([
                createTask('t-1', 'Shared task'),
                createTask('t-extra', 'Only in memory'),
            ]);
            const persisted = createData([createTask('t-1', 'Shared task')]);
            let capturedLocal: AppData | null = null;
            const { run } = createHarness({
                local: inMemory,
                storage: { readPersistedLocal: vi.fn(async () => cloneAppData(persisted)) },
                performSyncCycle: async (io) => {
                    capturedLocal = await io.readLocal();
                    return performSyncCycle(io);
                },
            });

            const result = await run();

            expect(result.success).toBe(true);
            expect(capturedLocal!.tasks.map((task) => task.id).sort()).toEqual(['t-1', 't-extra']);
        });
    });

    it('repairs an aligned file remote recovered from a fallback candidate', async () => {
        const aligned = createData();
        const { io, run } = createHarness({
            local: aligned,
            remote: aligned,
            backend: 'file',
            io: { requiresRemoteRepair: () => true },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
    });

    it('returns success without any IO when setup reports the backend disabled', async () => {
        const { harness, io, storage, run, hooks } = createHarness({
            hooks: { setupCycle: vi.fn(async () => ({ kind: 'disabled' as const })) },
        });

        const result = await run();

        expect(result).toEqual({ success: true, skipped: 'disabled' });
        expect(hooks.setupCycle).toHaveBeenCalledTimes(1);
        expect(io.readRemote).not.toHaveBeenCalled();
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(harness.callOrder).toEqual(['flush']);
    });

    it('merges local and remote data, persists both sides, and finalizes success', async () => {
        const local = createData([createTask('t-local', 'Local task')]);
        const remote = createData([createTask('t-remote', 'Remote task')]);
        const { harness, io, hooks, run } = createHarness({ local, remote, fastSyncScope: 'scope-1' });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.stats).toBeDefined();
        expect(result.skipped).toBeUndefined();
        const persistedIds = harness.persisted.tasks.map((task) => task.id).sort();
        expect(persistedIds).toEqual(['t-local', 't-remote']);
        const remoteIds = harness.remote?.tasks.map((task) => task.id).sort();
        expect(remoteIds).toEqual(['t-local', 't-remote']);
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
        expect(hooks.finalizeSuccess).toHaveBeenCalledTimes(1);
        expect(hooks.finalizeSuccess).toHaveBeenCalledWith(
            expect.objectContaining({ tasks: expect.any(Array) }),
            expect.objectContaining({ status: 'success', wroteLocal: true }),
        );
        // Merged data persists locally without the pending-remote-write flag.
        expect(harness.persisted.settings.pendingRemoteWriteAt).toBeUndefined();
        expect(harness.persisted.settings.lastSyncStatus).toBe('success');
        // Fast-sync state recorded from the remote write fingerprint.
        expect(harness.fastStates.get('scope-1')?.remoteFingerprint).toContain('remote-fp-');
        expect(harness.steps).toEqual(expect.arrayContaining(['flush', 'fast-check', 'read-local', 'read-remote', 'merge', 'write-local', 'write-remote', 'refresh']));
        expect(harness.diagnostics).toEqual(expect.arrayContaining(['flush', 'merge-complete']));
    });

    it('does not finalize-upload stale local bytes when newer remote attachment content wins', async () => {
        const localTask = createTask('t-shared', 'Shared task');
        localTask.attachments = [{
            id: 'attachment-shared',
            kind: 'file',
            title: 'notes.txt',
            uri: '/local/notes.txt',
            cloudKey: 'attachments/notes.txt',
            fileHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            contentRev: 1,
            contentMtimeMs: 1000,
            contentSize: 10,
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const remoteTask = cloneAppData(createData([localTask])).tasks[0]!;
        remoteTask.updatedAt = '2026-07-02T00:00:00.000Z';
        remoteTask.attachments![0] = {
            ...remoteTask.attachments![0]!,
            uri: '',
            fileHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            contentRev: 3,
            contentMtimeMs: undefined,
            contentSize: undefined,
            localStatus: 'missing',
            updatedAt: '2026-07-02T00:00:00.000Z',
        };
        const seenPhases: string[] = [];
        const syncAttachments = vi.fn(async (data: AppData, helpers: { phase?: string }) => {
            seenPhases.push(helpers.phase ?? 'unknown');
            if (helpers.phase !== 'prepare') return false;
            const next = cloneAppData(data);
            const attachment = next.tasks[0]?.attachments?.[0];
            if (attachment) {
                attachment.fileHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
                attachment.contentRev = 2;
                attachment.contentMtimeMs = 2000;
                attachment.contentSize = 20;
                attachment.pendingContentUpload = true;
            }
            return next;
        });
        const { harness, io, run } = createHarness({
            local: createData([localTask]),
            remote: createData([remoteTask]),
            io: { syncAttachments },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(seenPhases).toEqual(['prepare', 'post-merge']);
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
        expect(harness.remote?.tasks[0]?.attachments?.[0]).toMatchObject({
            cloudKey: 'attachments/notes.txt',
            fileHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            contentRev: 3,
        });
        expect(harness.remote?.tasks[0]?.attachments?.[0]?.pendingContentUpload).toBeUndefined();
    });

    it('blocks a CloudKit document write while an existing blob replacement is pending', async () => {
        const localTask = createTask('t-cloudkit-replacement', 'CloudKit replacement');
        localTask.attachments = [{
            id: 'attachment-cloudkit-replacement',
            kind: 'file',
            title: 'notes.txt',
            uri: '/local/notes.txt',
            cloudKey: 'cloudkit:notes',
            fileHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            contentRev: 2,
            contentMtimeMs: 2000,
            contentSize: 20,
            pendingContentUpload: true,
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const local = createData([localTask]);
        const { io, run } = createHarness({
            local,
            remote: toRemoteSyncDocument(cloneAppData(local)),
            backend: 'cloudkit',
            io: { syncAttachments: vi.fn(async () => false) },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: false,
            error: expect.stringContaining('Attachment upload incomplete'),
        });
        expect(io.writeRemote).not.toHaveBeenCalled();
    });

    it('still permits CloudKit metadata for a local-only attachment with no cloud key', async () => {
        const localTask = createTask('t-cloudkit-local-only', 'CloudKit local only');
        localTask.attachments = [{
            id: 'attachment-cloudkit-local-only',
            kind: 'file',
            title: 'notes.txt',
            uri: '/local/notes.txt',
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const local = createData([localTask]);
        const { io, run } = createHarness({
            local,
            remote: cloneAppData(local),
            backend: 'cloudkit',
            io: { syncAttachments: vi.fn(async () => false) },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.attachmentWriteDeferred).toBeFalsy();
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
    });

    it('keeps candidate remote data out of durable local storage when an activation probe fails', async () => {
        const local = createData([createTask('t-local', 'Local task')]);
        const remote = createData([createTask('t-remote', 'Remote task')]);
        const syncAttachments = vi.fn(async () => true);
        const injectExternalCalendars = vi.fn(async (data: AppData) => data);
        const persistExternalCalendars = vi.fn(async () => {});
        const writeFastSyncState = vi.fn(async () => {});
        const { harness, io, hooks, storage, run } = createHarness({
            local,
            remote,
            activationProbe: true,
            fastSyncScope: 'candidate-scope',
            io: {
                syncAttachments,
                writeRemote: vi.fn(async () => {
                    throw new Error('candidate write failed');
                }),
            },
            storage: {
                injectExternalCalendars,
                persistExternalCalendars,
                writeFastSyncState,
            },
        });

        const result = await run();

        expect(result).toMatchObject({ success: false, error: '[cloud] candidate write failed' });
        expect(io.writeRemote).toHaveBeenCalledWith(expect.objectContaining({
            tasks: expect.arrayContaining([
                expect.objectContaining({ id: 't-local' }),
                expect.objectContaining({ id: 't-remote' }),
            ]),
        }), expect.any(Function));
        expect(harness.persisted.tasks.map((task) => task.id)).toEqual(['t-local']);
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(injectExternalCalendars).not.toHaveBeenCalled();
        expect(persistExternalCalendars).not.toHaveBeenCalled();
        expect(writeFastSyncState).not.toHaveBeenCalled();
        expect(syncAttachments).not.toHaveBeenCalled();
        expect(hooks.finalizeSuccess).not.toHaveBeenCalled();
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
        expect(hooks.requestFollowUp).not.toHaveBeenCalled();
        expect(harness.statusUpdates).toEqual([]);
    });

    it('returns a side-effect-free requeue when an activation probe meets a remote write conflict', async () => {
        const { hooks, storage, run } = createHarness({
            activationProbe: true,
            io: {
                writeRemote: vi.fn(async () => {
                    throw new SyncRemoteWriteConflict();
                }),
            },
        });

        const result = await run();

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(hooks.requestFollowUp).not.toHaveBeenCalled();
        expect(hooks.finalizeSuccess).not.toHaveBeenCalled();
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
    });

    it('does not scan or delete File Sync generations after an activation CAS conflict', async () => {
        const initialRemote = createData([createTask('t-remote', 'Initial remote')]);
        const readRemote = vi.fn().mockResolvedValueOnce(cloneAppData(initialRemote));
        const { storage, run } = createHarness({
            activationProbe: true,
            backend: 'file',
            remote: initialRemote,
            io: {
                readRemote,
                writeRemote: vi.fn(async () => {
                    throw new SyncRemoteWriteConflict();
                }),
            },
        });

        const result = await run();

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(readRemote).toHaveBeenCalledTimes(1);
        expect(storage.persistLocal).not.toHaveBeenCalled();
    });

    it('does not persist candidate attachment metadata when an activation probe requeues', async () => {
        const localTask = createTask('t-attached-requeue', 'Attached task');
        localTask.attachments = [{
            id: 'attachment-requeue',
            kind: 'file',
            title: 'Notes',
            uri: '/local/notes.txt',
            cloudKey: 'cloudkit:old',
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const { harness, storage, run } = createHarness({
            local: createData([localTask]),
            activationProbe: true,
            io: {
                syncAttachments: vi.fn(async (data: AppData) => {
                    const attachment = data.tasks[0]?.attachments?.[0];
                    if (attachment) {
                        attachment.cloudKey = 'attachments/candidate.txt';
                        attachment.localStatus = 'available';
                    }
                    return data;
                }),
                writeRemote: vi.fn(async () => {
                    throw new SyncRemoteWriteConflict();
                }),
            },
        });

        const result = await run();

        expect(result).toEqual({ success: true, skipped: 'requeued' });
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(harness.persisted.tasks[0]?.attachments?.[0]?.cloudKey).toBe('cloudkit:old');
    });

    it('forces a candidate remote write before an activation probe can succeed', async () => {
        const local = createData([createTask('t-shared', 'Shared task')]);
        const remote = cloneAppData(local);
        const { harness, io, hooks, storage, run } = createHarness({
            local,
            remote,
            activationProbe: true,
            fastSyncScope: 'candidate-scope',
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(hooks.finalizeSuccess).not.toHaveBeenCalled();
        expect(harness.fastStates.size).toBe(0);
    });

    it('proves local attachment bytes on the candidate before publishing their metadata', async () => {
        const localTask = createTask('t-attached', 'Attached task');
        localTask.attachments = [{
            id: 'attachment-1',
            kind: 'file',
            title: 'Notes',
            uri: '/local/notes.txt',
            // This key wins the ordinary attachment merge tie-break against
            // the candidate key below. An activation probe must still keep the
            // metadata it just proved on the candidate backend authoritative.
            cloudKey: 'cloudkit:a',
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const local = createData([localTask]);
        const syncAttachments = vi.fn(async (data: AppData, helpers: { activationProbe: boolean }) => {
            expect(helpers.activationProbe).toBe(true);
            const attachment = data.tasks[0]?.attachments?.[0];
            expect(attachment?.localStatus).toBe('missing');
            expect(attachment?.cloudKey).toBeUndefined();
            if (attachment) {
                attachment.cloudKey = 'attachments/a.txt';
                attachment.localStatus = 'available';
            }
            return data;
        });
        const { harness, io, storage, run } = createHarness({
            local,
            activationProbe: true,
            io: { syncAttachments },
            hooks: { shouldRunAttachmentPhase: vi.fn(async () => false) },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(syncAttachments).toHaveBeenCalledTimes(1);
        expect(io.writeRemote).toHaveBeenCalledWith(expect.objectContaining({
            tasks: expect.arrayContaining([
                expect.objectContaining({
                    attachments: expect.arrayContaining([
                        expect.objectContaining({ cloudKey: 'attachments/a.txt' }),
                    ]),
                }),
            ]),
        }), expect.any(Function));
        expect(harness.persisted.tasks[0]?.attachments?.[0]?.cloudKey).toBe('cloudkit:a');
        expect(storage.persistLocal).not.toHaveBeenCalled();
    });

    it('marks a newer local content winner for upload while retaining the candidate key during activation', async () => {
        const localTask = createTask('t-local-content-winner', 'Attached task');
        localTask.attachments = [{
            id: 'attachment-local-content-winner',
            kind: 'file',
            title: 'Notes',
            uri: '/local/notes.txt',
            cloudKey: 'cloudkit:old-backend',
            fileHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            contentRev: 4,
            contentMtimeMs: 4000,
            contentSize: 40,
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const remoteTask = cloneAppData(createData([localTask])).tasks[0]!;
        remoteTask.attachments![0] = {
            ...remoteTask.attachments![0]!,
            uri: '',
            cloudKey: 'attachments/candidate.txt',
            fileHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            contentRev: 3,
            contentMtimeMs: undefined,
            contentSize: undefined,
            localStatus: 'missing',
        };
        const syncAttachments = vi.fn(async (data: AppData) => {
            const attachment = data.tasks[0]?.attachments?.[0];
            expect(attachment?.cloudKey).toBe('attachments/candidate.txt');
            expect(attachment?.fileHash).toBe('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
            expect(attachment?.contentRev).toBe(4);
            expect(attachment?.pendingContentUpload).toBe(true);
            if (attachment) {
                attachment.pendingContentUpload = undefined;
                attachment.localStatus = 'available';
            }
            return data;
        });
        const { harness, io, run } = createHarness({
            local: createData([localTask]),
            remote: createData([remoteTask]),
            activationProbe: true,
            io: { syncAttachments },
        });

        const result = await run();

        expect(result).toMatchObject({ success: true });
        expect(syncAttachments).toHaveBeenCalledTimes(1);
        expect(harness.remote?.tasks[0]?.attachments?.[0]).toMatchObject({
            cloudKey: 'attachments/candidate.txt',
            fileHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            contentRev: 4,
        });
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
    });

    it('keeps a candidate-proven attachment key when newer remote metadata points to a missing object', async () => {
        const localTask = createTask('t-attached-conflict', 'Local title');
        localTask.attachments = [{
            id: 'attachment-conflict',
            kind: 'file',
            title: 'Local notes',
            uri: '/local/notes.txt',
            cloudKey: 'cloudkit:old-backend',
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const remoteTask = cloneAppData(createData([localTask])).tasks[0]!;
        remoteTask.title = 'Newer remote title';
        remoteTask.updatedAt = '2026-07-02T00:00:00.000Z';
        remoteTask.attachments![0] = {
            ...remoteTask.attachments![0]!,
            title: 'Newer remote notes',
            uri: '',
            cloudKey: 'attachments/missing-on-candidate.txt',
            localStatus: 'missing',
            updatedAt: '2026-07-02T00:00:00.000Z',
        };
        const syncAttachments = vi.fn(async (data: AppData) => {
            const attachment = data.tasks[0]?.attachments?.[0];
            // The key came from the candidate document just read. Keeping it is
            // what prevents stale local bytes from replacing that remote winner;
            // the old-backend key never reaches the candidate adapter.
            expect(attachment?.cloudKey).toBe('attachments/missing-on-candidate.txt');
            expect(attachment?.pendingContentUpload).toBeUndefined();
            expect(attachment?.uri).toBe('');
            if (attachment) {
                attachment.cloudKey = 'attachments/proven-on-candidate.txt';
                attachment.localStatus = 'available';
            }
            return data;
        });
        const { harness, storage, run } = createHarness({
            local: createData([localTask]),
            remote: createData([remoteTask]),
            activationProbe: true,
            io: { syncAttachments },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(harness.remote?.tasks[0]).toMatchObject({
            title: 'Newer remote title',
            attachments: [expect.objectContaining({
                title: 'Newer remote notes',
                cloudKey: 'attachments/proven-on-candidate.txt',
            })],
        });
        expect(harness.persisted.tasks[0]?.attachments?.[0]?.cloudKey).toBe('cloudkit:old-backend');
        expect(storage.persistLocal).not.toHaveBeenCalled();
    });

    it('rejects activation when a candidate-remote-only attachment object cannot be proved', async () => {
        const remoteTask = createTask('t-remote-only', 'Remote-only attachment');
        remoteTask.attachments = [{
            id: 'attachment-remote-only',
            kind: 'file',
            title: 'Remote notes',
            uri: '',
            cloudKey: 'attachments/missing-remote-only.txt',
            localStatus: 'missing',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const syncAttachments = vi.fn(async (data: AppData) => data);
        const { io, storage, run } = createHarness({
            local: createData(),
            remote: createData([remoteTask]),
            activationProbe: true,
            io: { syncAttachments },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: false,
            error: '[cloud] Candidate attachment proof failed for attachment-remote-only',
        });
        expect(syncAttachments).toHaveBeenCalledTimes(1);
        expect(io.writeRemote).not.toHaveBeenCalled();
        expect(storage.persistLocal).not.toHaveBeenCalled();
    });

    it('preserves an incoming owner deletion without probing its former local attachment', async () => {
        const localTask = createTask('t-deleted-remotely', 'Delete me');
        localTask.attachments = [{
            id: 'attachment-deleted-owner',
            kind: 'file',
            title: 'Old notes',
            uri: '/local/old-notes.txt',
            cloudKey: 'cloudkit:old-notes',
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const remoteTask = cloneAppData(createData([localTask])).tasks[0]!;
        remoteTask.updatedAt = '2026-07-02T00:00:00.000Z';
        remoteTask.deletedAt = '2026-07-02T00:00:00.000Z';
        const syncAttachments = vi.fn(async (data: AppData) => data);
        const { harness, run } = createHarness({
            local: createData([localTask]),
            remote: createData([remoteTask]),
            activationProbe: true,
            io: { syncAttachments },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(harness.remote?.tasks[0]).toMatchObject({
            id: 't-deleted-remotely',
            deletedAt: '2026-07-02T00:00:00.000Z',
        });
        expect(syncAttachments).not.toHaveBeenCalled();
    });

    it('rejects activation when an existing cloud key is not proved on the candidate', async () => {
        const localTask = createTask('t-attached', 'Attached task');
        localTask.attachments = [{
            id: 'attachment-1',
            kind: 'file',
            title: 'Notes',
            uri: '/local/notes.txt',
            cloudKey: 'attachments/from-old-backend.txt',
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const { io, storage, run } = createHarness({
            local: createData([localTask]),
            activationProbe: true,
            io: { syncAttachments: vi.fn(async () => false) },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: false,
            error: '[cloud] Candidate attachment proof failed for attachment-1',
        });
        expect(io.writeRemote).not.toHaveBeenCalled();
        expect(storage.persistLocal).not.toHaveBeenCalled();
    });

    it('does not let the proven backend retry state block an activation probe', async () => {
        const retryAt = '2999-01-01T00:00:00.000Z';
        const local = createData([createTask('t-local', 'Local task')], {
            pendingRemoteWriteAt: STAMP,
            pendingRemoteWriteRetryAt: retryAt,
            pendingRemoteWriteAttempts: 2,
            lastSyncStatus: 'error',
            lastSyncError: 'Previous backend write failed.',
        });
        const { harness, io, storage, run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            activationProbe: true,
        });

        const result = await run();

        expect(result).toMatchObject({ success: true });
        expect(result.skipped).toBeUndefined();
        expect(io.readRemote).toHaveBeenCalledTimes(1);
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(harness.persisted.settings.pendingRemoteWriteAt).toBe(STAMP);
        expect(harness.persisted.settings.pendingRemoteWriteRetryAt).toBe(retryAt);
        expect(harness.persisted.settings.pendingRemoteWriteAttempts).toBe(2);
    });

    it('adopts candidate attachment keys on the first durable post-activation sync', async () => {
        const localTask = createTask('t-post-activation', 'Attached task');
        localTask.attachments = [{
            id: 'attachment-post-activation',
            kind: 'file',
            title: 'Notes',
            uri: '/local/notes.txt',
            cloudKey: 'cloudkit:a',
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const remoteTask = cloneAppData(createData([localTask])).tasks[0]!;
        remoteTask.attachments![0] = {
            ...remoteTask.attachments![0]!,
            uri: '',
            cloudKey: 'attachments/a.txt',
            localStatus: 'missing',
        };
        const { harness, run } = createHarness({
            local: createData([localTask]),
            remote: createData([remoteTask]),
            ignorePendingRemoteWriteBackoff: true,
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(harness.persisted.tasks[0]?.attachments?.[0]).toMatchObject({
            cloudKey: 'attachments/a.txt',
            uri: '/local/notes.txt',
            localStatus: 'available',
        });
        expect(harness.remote?.tasks[0]?.attachments?.[0]?.cloudKey).toBe('attachments/a.txt');
    });

    it('applies and publishes the canonical snapshot returned by local persistence', async () => {
        const concurrentTask = createTask('t-concurrent', 'Concurrent local task');
        const applyDataToStore = vi.fn();
        const { harness, hooks, run } = createHarness({
            storage: {
                persistLocal: vi.fn(async (data: AppData) => (
                    data.tasks.some((task) => task.id === concurrentTask.id)
                        ? data
                        : { ...data, tasks: [...data.tasks, concurrentTask] }
                )),
                applyDataToStore,
            },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(harness.remote?.tasks.some((task) => task.id === concurrentTask.id)).toBe(true);
        expect(applyDataToStore).toHaveBeenCalledWith(expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: concurrentTask.id })]),
        }));
        expect(hooks.finalizeSuccess).toHaveBeenCalledWith(expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: concurrentTask.id })]),
        }), expect.anything());
    });

    it('completes a fresh file sync when the remote payload is missing sections and people (#990)', async () => {
        const local = createData([createTask('t-local', 'Local task')]);
        // Exact synthetic "no remote yet" payload Rust's read_sync_file returns
        // for a brand-new sync folder (apps/desktop/src-tauri/src/sync.rs)
        // before the #990 fix — missing `sections` and `people`.
        const remote = { tasks: [], projects: [], areas: [], settings: {} } as unknown as AppData;
        const { harness, hooks, run } = createHarness({ local, remote, backend: 'file' });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
        expect(harness.persisted.settings.lastSyncHistory?.at(-1)).toMatchObject({ status: 'success' });
    });

    it('normalizes a partial remote payload before the pre-write remote comparison (#990 guard)', async () => {
        const local = createData([createTask('t-local', 'Local task')]);
        const partialRemote = { tasks: [], projects: [], areas: [], settings: {} } as unknown as AppData;
        const { io, run } = createHarness({
            local,
            backend: 'file',
            io: { readRemote: vi.fn(async () => partialRemote) },
        });

        const result = await run();

        expect(result.success).toBe(true);
        // writeRemoteForCycle computes a throwaway sanitized copy of the raw
        // remote snapshot to compare against the merged payload before
        // writing; on the un-normalized partial remote this used to throw
        // inside sanitizeAppDataForRemote/compactSectionsForPurgedProjects
        // before ever reaching writeRemote.
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
    });

    it('skips the second run as unchanged via the recorded fast-sync state', async () => {
        const { harness, io, run } = createHarness({ fastSyncScope: 'scope-1' });

        const first = await run();
        expect(first.skipped).toBeUndefined();
        const readsAfterFirst = vi.mocked(io.readRemote).mock.calls.length;

        const second = await run();
        expect(second).toMatchObject({ success: true, skipped: 'unchanged' });
        expect(vi.mocked(io.readRemote).mock.calls.length).toBe(readsAfterFirst);
        expect(harness.statusUpdates.at(-1)).toMatchObject({ lastSyncStatus: 'success' });
        expect(harness.uiErrors.at(-1)).toBeNull();
        expect(harness.infos.some((info) => info.message === 'Sync fast check found no changes')).toBe(true);
    });

    it('keeps a genuine unchanged fast-check lock-free', async () => {
        const aligned = createData([createTask('t-aligned', 'Aligned task')]);
        const acquireRemoteMutationFence = vi.fn().mockResolvedValue(createFenceLease());
        const { run } = createHarness({
            local: aligned,
            remote: aligned,
            fastSyncScope: 'scope-fence-fast-skip',
            io: { acquireRemoteMutationFence },
        });

        expect((await run()).skipped).toBeUndefined();
        expect(acquireRemoteMutationFence).toHaveBeenCalledTimes(1);

        expect(await run()).toMatchObject({ success: true, skipped: 'unchanged' });
        expect(acquireRemoteMutationFence).toHaveBeenCalledTimes(1);
    });

    it('holds the remote mutation fence from the authoritative read through finalization', async () => {
        const callOrder: string[] = [];
        const lease = createFenceLease({
            assertHeld: vi.fn(async () => { callOrder.push('assert-held'); }),
            release: vi.fn(async () => { callOrder.push('release'); }),
        });
        const bundle = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                acquireRemoteMutationFence: vi.fn(async () => {
                    callOrder.push('acquire');
                    return lease;
                }),
                readRemote: vi.fn(async () => {
                    callOrder.push('read-remote');
                    return cloneAppData(bundle.harness.remote!);
                }),
                writeRemote: vi.fn(async () => {
                    callOrder.push('write-remote');
                }),
            },
            hooks: {
                finalizeSuccess: vi.fn(async () => { callOrder.push('finalize'); }),
            },
        });

        expect((await bundle.run()).success).toBe(true);
        expect(callOrder.indexOf('acquire')).toBeLessThan(callOrder.indexOf('read-remote'));
        expect(callOrder.indexOf('read-remote')).toBeLessThan(callOrder.indexOf('write-remote'));
        expect(callOrder.indexOf('write-remote')).toBeLessThan(callOrder.indexOf('finalize'));
        expect(callOrder.indexOf('finalize')).toBeLessThan(callOrder.indexOf('release'));
        expect(lease.assertHeld).toHaveBeenCalled();
    });

    it('discards a read-check snapshot and rereads after acquiring the fence', async () => {
        const staleRemote = createData([createTask('t-stale', 'Stale remote task')]);
        const authoritativeRemote = createData([createTask('t-current', 'Current remote task')]);
        const bundle = createHarness({
            local: createData([createTask('t-local', 'Local task')]),
            remote: staleRemote,
            policy: { enableReadCheckSkip: true },
            io: {
                acquireRemoteMutationFence: vi.fn(async () => {
                    bundle.harness.remote = cloneAppData(authoritativeRemote);
                    return createFenceLease();
                }),
            },
        });

        expect((await bundle.run()).success).toBe(true);
        expect(bundle.io.readRemote).toHaveBeenCalledTimes(2);
        expect(bundle.harness.persisted.tasks.map((task) => task.id).sort()).toEqual(['t-current', 't-local']);
        expect(bundle.harness.persisted.tasks.some((task) => task.id === 't-stale')).toBe(false);
    });

    it('defers a busy fence without recording an error or touching data', async () => {
        const { io, storage, hooks, run } = createHarness({
            io: {
                acquireRemoteMutationFence: vi.fn(async () => {
                    throw new SyncRemoteMutationFenceBusyError(5_000);
                }),
            },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: true,
            skipped: 'remoteFenceBusy',
            remoteFenceDeferred: 'busy',
            retryAfterMs: 5_000,
        });
        expect(hooks.requestFollowUpAfter).toHaveBeenCalledWith(5_000);
        expect(io.readRemote).not.toHaveBeenCalled();
        expect(io.writeRemote).not.toHaveBeenCalled();
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(hooks.finalizeSuccess).not.toHaveBeenCalled();
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
    });

    it('defers a busy File Sync lock with a bounded follow-up and no persisted error', async () => {
        const requestFileSyncLockBusyFollowUpAfter = vi.fn();
        const { io, storage, hooks, run } = createHarness({
            backend: 'file',
            hooks: {
                setupCycle: vi.fn(async () => {
                    throw new SyncFileLockBusyError(5_000);
                }),
                requestFileSyncLockBusyFollowUpAfter,
            },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: true,
            skipped: 'fileSyncLockBusy',
            fileSyncLockDeferred: 'busy',
            retryAfterMs: 5_000,
        });
        expect(requestFileSyncLockBusyFollowUpAfter).toHaveBeenCalledWith(5_000, 1);
        expect(hooks.requestFollowUpAfter).not.toHaveBeenCalled();
        expect(io.readRemote).not.toHaveBeenCalled();
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
    });

    it('does not auto-retry File Sync contention when the platform omits the bounded-retry hook', async () => {
        const { hooks, run } = createHarness({
            backend: 'file',
            hooks: {
                setupCycle: vi.fn(async () => {
                    throw new SyncFileLockBusyError(5_000);
                }),
            },
        });

        await expect(run()).resolves.toMatchObject({
            success: true,
            skipped: 'fileSyncLockBusy',
            fileSyncLockDeferred: 'busy',
        });
        expect(hooks.requestFollowUpAfter).not.toHaveBeenCalled();
    });

    it('does not retain a transient activation candidate when its File Sync lock is busy', async () => {
        const { hooks, run } = createHarness({
            backend: 'file',
            activationProbe: true,
            hooks: {
                setupCycle: vi.fn(async () => {
                    throw new SyncFileLockBusyError(5_000);
                }),
            },
        });

        await expect(run()).resolves.toMatchObject({
            success: true,
            skipped: 'fileSyncLockBusy',
            fileSyncLockDeferred: 'busy',
        });
        expect(hooks.requestFollowUpAfter).not.toHaveBeenCalled();
    });

    it('stops after one deferred File Sync lock retry while remaining neutral', async () => {
        const { hooks, run } = createHarness({
            backend: 'file',
            hooks: {
                setupCycle: vi.fn(async () => {
                    throw new SyncFileLockBusyError(5_000);
                }),
            },
        });

        await expect(run({ fileSyncLockBusyRetryAttempt: 1 })).resolves.toMatchObject({
            success: true,
            skipped: 'fileSyncLockBusy',
            fileSyncLockDeferred: 'busy',
        });
        expect(hooks.requestFollowUpAfter).not.toHaveBeenCalled();
    });

    it('fails closed with an actionable outcome when safe File Sync locking is unavailable', async () => {
        const { hooks, run } = createHarness({
            backend: 'file',
            hooks: {
                setupCycle: vi.fn(async () => {
                    throw new SyncFileLockUnavailableError();
                }),
            },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: false,
            fileSyncLockUnavailable: true,
        });
        expect(result.error).toContain('Safe File Sync locking is unavailable');
        expect(hooks.requestFollowUpAfter).not.toHaveBeenCalled();
        expect(hooks.finalizeErrorStatus).toHaveBeenCalledTimes(1);
    });

    it('marks a successful run cleanup-deferred when conditional fence release fails', async () => {
        const lease = createFenceLease({
            release: vi.fn().mockRejectedValue(new Error('Dropbox versioned file delete timed out')),
            retryAfterMs: vi.fn(() => 12_345),
        });
        const { hooks, run } = createHarness({
            io: { acquireRemoteMutationFence: vi.fn().mockResolvedValue(lease) },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: true,
            remoteFenceDeferred: 'cleanup',
            retryAfterMs: 12_345,
        });
        expect(hooks.requestFollowUpAfter).toHaveBeenCalledWith(12_345);
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
    });

    it('does not downgrade fence loss during attachment pre-sync into a warning', async () => {
        const lost = new SyncRemoteMutationFenceLostError();
        const lease = createFenceLease({ assertHeld: vi.fn().mockRejectedValue(lost) });
        const { io, storage, run } = createHarness({
            io: {
                acquireRemoteMutationFence: vi.fn().mockResolvedValue(lease),
                syncAttachments: vi.fn().mockResolvedValue(false),
            },
        });

        const result = await run();

        expect(result).toMatchObject({ success: false });
        expect(io.readRemote).not.toHaveBeenCalled();
        expect(io.writeRemote).not.toHaveBeenCalled();
        expect(storage.persistLocal).not.toHaveBeenCalled();
        expect(result.hadAttachmentWarning).toBeUndefined();
    });

    it('does not record an unchanged fast sync when local data changes during the remote fingerprint read', async () => {
        let editDuringFingerprintRead = false;
        const bundle = createHarness({
            fastSyncScope: 'scope-1',
            io: {
                readRemoteFingerprint: vi.fn(async () => {
                    const remote = bundle.harness.remote;
                    const fingerprint = remote
                        ? `remote-fp-${JSON.stringify(remote.tasks.map((task) => task.id).sort())}`
                        : null;
                    // The user edits while the fingerprint round trip is in flight.
                    if (editDuringFingerprintRead) bundle.harness.lastDataChangeAt += 1;
                    return fingerprint;
                }),
            },
        });
        const { harness, storage, hooks, run } = bundle;

        const first = await run();
        expect(first.skipped).toBeUndefined();
        const staleLocalFingerprint = harness.fastStates.get('scope-1')?.localFingerprint;
        expect(staleLocalFingerprint).toBeDefined();
        vi.mocked(storage.writeFastSyncState).mockClear();
        vi.mocked(hooks.requestFollowUp).mockClear();

        editDuringFingerprintRead = true;
        const second = await run();

        // Option B: the freshness re-check throws LocalSyncAbort, so the cycle
        // requeues instead of reporting the mid-check edit as already synced.
        expect(second).toMatchObject({ success: true, skipped: 'requeued' });
        expect(hooks.requestFollowUp).toHaveBeenCalled();
        expect(storage.writeFastSyncState).not.toHaveBeenCalledWith(
            expect.objectContaining({ localFingerprint: staleLocalFingerprint }),
        );
        expect(harness.statusUpdates.at(-1)?.lastSyncStatus).not.toBe('success');
    });

    it('never takes the fingerprint fast-check for manual syncs', async () => {
        const { io, run } = createHarness({ fastSyncScope: 'scope-1' });

        await run();
        await run({ manual: true });

        // The manual second run performed a full cycle including the remote read.
        expect(vi.mocked(io.readRemote).mock.calls.length).toBe(2);
    });

    it('skips via the read-check when the remote payload equals local (no fingerprint scope)', async () => {
        const { io, run } = createHarness({ fastSyncScope: null, policy: { enableReadCheckSkip: true } });

        const first = await run();
        expect(first.skipped).toBeUndefined();
        const writesAfterFirst = vi.mocked(io.writeRemote).mock.calls.length;

        const second = await run();
        expect(second).toMatchObject({ success: true, skipped: 'unchanged' });
        expect(vi.mocked(io.writeRemote).mock.calls.length).toBe(writesAfterFirst);
    });

    it('rewrites legacy full tombstones once before treating sync as unchanged', async () => {
        const local = createData([{
            id: 'purged-task',
            title: '(deleted)',
            status: 'inbox',
            tags: [],
            contexts: [],
            rev: 2,
            revBy: 'device-a',
            createdAt: STAMP,
            updatedAt: STAMP,
            deletedAt: STAMP,
            purgedAt: STAMP,
        }]);
        const remote = createData([{
            ...local.tasks[0],
            title: 'Private task',
            description: 'Private task notes',
        }]);
        const { harness, io, run } = createHarness({
            local,
            remote,
            fastSyncScope: null,
            policy: { enableReadCheckSkip: true },
        });

        const first = await run();

        expect(first.skipped).toBeUndefined();
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
        expect(harness.remote?.tasks[0]?.title).toBe('(deleted)');
        expect(harness.remote?.tasks[0]?.description).toBeUndefined();

        const second = await run();
        expect(second).toMatchObject({ success: true, skipped: 'unchanged' });
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
    });

    it('reuses the read-check remote payload in the merge phase instead of reading twice', async () => {
        const local = createData([createTask('t-local', 'Local task')]);
        const remote = createData([createTask('t-remote', 'Remote task')]);
        const { io, run } = createHarness({
            local,
            remote,
            fastSyncScope: null,
            policy: { enableReadCheckSkip: true },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.skipped).toBeUndefined();
        expect(io.readRemote).toHaveBeenCalledTimes(1);
    });

    it('requests a follow-up and skips fast-state recording when the server merged remote data', async () => {
        const { harness, hooks, run } = createHarness({
            fastSyncScope: 'scope-1',
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                writeRemote: vi.fn(async () => ({ fingerprint: 'fp-1', serverMergedRemoteData: true })),
            },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(hooks.requestFollowUp).toHaveBeenCalled();
        expect(harness.fastStates.size).toBe(0);
    });

    it('requeues on a remote write conflict and clears the pending-remote-write flag', async () => {
        const { harness, hooks, run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                writeRemote: vi.fn(async () => {
                    throw new SyncRemoteWriteConflict();
                }),
            },
        });

        const result = await run();

        expect(result).toMatchObject({ success: true, skipped: 'requeued' });
        expect(hooks.requestFollowUp).toHaveBeenCalled();
        expect(harness.persisted.settings.pendingRemoteWriteAt).toBeUndefined();
        expect(harness.diagnostics).toContain('requeued');
    });

    it('marks the retry backoff locally and reports the error when the remote write fails', async () => {
        const { harness, hooks, notifier, run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                writeRemote: vi.fn(async () => {
                    throw new Error('boom');
                }),
            },
        });

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.error).toContain('[cloud] boom');
        expect(result.error).toContain('(log: /tmp/sync-error.log)');
        expect(harness.persisted.settings.pendingRemoteWriteAt).toBeDefined();
        expect(harness.persisted.settings.pendingRemoteWriteRetryAt).toBeDefined();
        expect(harness.persisted.settings.pendingRemoteWriteAttempts).toBe(1);
        expect(notifier.logSyncError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ backend: 'cloud' }));
        expect(hooks.finalizeErrorStatus).toHaveBeenCalledWith(expect.objectContaining({
            message: result.error,
            history: expect.arrayContaining([expect.objectContaining({ status: 'error' })]),
        }));
    });

    it('skips the cycle while the pending-remote-write backoff is active and surfaces the deferred write', async () => {
        const retryAt = new Date(Date.now() + 60_000).toISOString();
        const local = createData([createTask('t-local', 'Local task')], {
            pendingRemoteWriteAt: STAMP,
            pendingRemoteWriteRetryAt: retryAt,
            pendingRemoteWriteAttempts: 2,
            lastSyncStatus: 'error',
            lastSyncError: 'Remote write failed. Retrying in the background.',
        });
        const { io, run } = createHarness({ local });

        const result = await run();

        expect(result).toMatchObject({
            success: true,
            skipped: 'pendingRemoteWriteBackoff',
            remoteWriteDeferred: true,
            error: 'Remote write failed. Retrying in the background.',
        });
        expect(io.readRemote).not.toHaveBeenCalled();
    });

    it('retries inherited pending work immediately on the first durable post-activation cycle', async () => {
        const retryAt = '2999-01-01T00:00:00.000Z';
        const local = createData([createTask('t-local', 'Local task')], {
            pendingRemoteWriteAt: STAMP,
            pendingRemoteWriteRetryAt: retryAt,
            pendingRemoteWriteAttempts: 2,
            lastSyncStatus: 'error',
            lastSyncError: 'Previous backend write failed.',
        });
        const { harness, io, run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            ignorePendingRemoteWriteBackoff: true,
        });

        const result = await run();

        expect(result).toMatchObject({ success: true });
        expect(result.skipped).toBeUndefined();
        expect(io.readRemote).toHaveBeenCalledTimes(1);
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
        expect(harness.persisted.settings.pendingRemoteWriteAt).toBeUndefined();
        expect(harness.persisted.settings.pendingRemoteWriteRetryAt).toBeUndefined();
        expect(harness.persisted.settings.pendingRemoteWriteAttempts).toBeUndefined();
    });

    it('surfaces a deferred remote write on a completed merge without failing the run', async () => {
        const { run } = createHarness({
            performSyncCycle: async (io) => {
                const result = await performSyncCycle(io);
                if (result.status === 'skipped') return result;
                return {
                    ...result,
                    data: {
                        ...result.data,
                        settings: {
                            ...result.data.settings,
                            pendingRemoteWriteRetryAt: new Date(NOW.getTime() + 30_000).toISOString(),
                            pendingRemoteWriteAttempts: 1,
                            lastSyncStatus: 'error',
                            lastSyncError: 'Remote write failed. Retrying in the background.',
                        },
                    },
                };
            },
        });

        const result = await run();

        expect(result).toMatchObject({
            success: true,
            remoteWriteDeferred: true,
            error: 'Remote write failed. Retrying in the background.',
        });
    });

    it('leaves remoteWriteDeferred falsy on a clean successful run', async () => {
        const { run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.remoteWriteDeferred).toBeFalsy();
        expect(result.attachmentWriteDeferred).toBeFalsy();
    });

    it('reports durable attachment work without hiding synced task and project data or queuing retries', async () => {
        const task = createTask('t-attachment-deferred', 'Task data still syncs');
        task.attachments = [{
            id: 'attachment-deferred',
            kind: 'file',
            title: 'notes.txt',
            uri: '/local/notes.txt',
            cloudKey: 'attachments/notes.txt',
            fileHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            contentRev: 1,
            contentMtimeMs: 1000,
            contentSize: 10,
            localStatus: 'available',
            createdAt: STAMP,
            updatedAt: STAMP,
        }];
        const local = createData([task]);
        local.projects = [{
            id: 'p-attachment-deferred',
            title: 'Project data still syncs',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: STAMP,
            updatedAt: STAMP,
        } satisfies Project];
        let attachmentPass = 0;
        const syncAttachments = vi.fn(async (data: AppData) => {
            attachmentPass += 1;
            if (attachmentPass === 1) return data;
            const next = cloneAppData(data);
            const attachment = next.tasks[0]?.attachments?.[0];
            if (attachment) {
                attachment.pendingContentUpload = true;
                attachment.localStatus = 'missing';
            }
            return next;
        });
        const { harness, hooks, run } = createHarness({
            local,
            remote: null,
            io: { syncAttachments },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.attachmentWriteDeferred).toBe(true);
        expect(syncAttachments).toHaveBeenCalledTimes(2);
        expect(harness.remote?.tasks[0]?.title).toBe('Task data still syncs');
        expect(harness.remote?.projects[0]?.title).toBe('Project data still syncs');
        expect(harness.persisted.tasks[0]?.attachments?.[0]).toMatchObject({
            pendingContentUpload: true,
            localStatus: 'missing',
        });
        expect(hooks.requestFollowUp).not.toHaveBeenCalled();
        expect(hooks.requestFollowUpAfter).not.toHaveBeenCalled();
    });

    it('aborts to a requeued skip when local data changes mid-cycle', async () => {
        const staleEvents: unknown[] = [];
        const { harness, hooks, io, run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: {
                onStaleSnapshot: (details) => staleEvents.push(details),
            },
        });
        // Simulate a user edit while the remote read is in flight.
        vi.mocked(io.readRemote).mockImplementation(async () => {
            harness.lastDataChangeAt += 1;
            return cloneAppData(harness.remote!);
        });

        const result = await run();

        expect(result).toMatchObject({ success: true, skipped: 'requeued' });
        expect(hooks.requestFollowUp).toHaveBeenCalled();
        expect(staleEvents.length).toBeGreaterThan(0);
    });

    it('does not silently drop a local write that lands during the first local read (#910)', async () => {
        // Reproduces the recurring-task completion race: the cycle's very
        // first local read (readPersistedLocal, awaited inside
        // readLocalDataForSyncCycle) is already in flight when the user
        // completes a recurring task, which both updates the existing task
        // and spawns a brand-new next-occurrence task. Before the fix, the
        // snapshot was stamped as "fresh as of" the change stamp read AFTER
        // the await, so the race was invisible to every later
        // ensureLocalSnapshotFresh check and the stale, completion-less data
        // was persisted and pushed back into the live store unchanged.
        const local = createData([createTask('t-recurring', 'Recurring task')]);
        let raceMidRead: () => void = () => {
            throw new Error('Harness mutation was not initialized');
        };
        const { harness, hooks, run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            storage: {
                readPersistedLocal: vi.fn(async () => {
                    raceMidRead();
                    return cloneAppData(harness.persisted);
                }),
            },
        });
        let raced = false;
        raceMidRead = () => {
            if (raced) return;
            raced = true;
            harness.inMemory.tasks[0] = {
                ...harness.inMemory.tasks[0],
                status: 'done',
                completedAt: '2026-07-13T10:00:01.000Z',
                updatedAt: '2026-07-13T10:00:01.000Z',
            };
            harness.inMemory.tasks.push(createTask('t-recurring-next', 'Recurring task'));
            harness.lastDataChangeAt += 1;
        };

        const result = await run();

        expect(result.success).toBe(true);
        // Both the completion and the newly spawned recurring follow-up must
        // survive the cycle instead of being overwritten by a stale merge.
        expect(harness.persisted.tasks.find((task) => task.id === 't-recurring')?.status).toBe('done');
        expect(harness.persisted.tasks.some((task) => task.id === 't-recurring-next')).toBe(true);
        expect(hooks.finalizeSuccess).toHaveBeenCalledWith(
            expect.objectContaining({
                tasks: expect.arrayContaining([
                    expect.objectContaining({ id: 't-recurring-next' }),
                ]),
            }),
            expect.anything(),
        );
    });

    it('requeues before applying or uploading data when a local edit lands during persistence', async () => {
        const local = createData([createTask('t-local', 'Before sync')]);
        let raceMidPersist: () => void = () => {
            throw new Error('Harness mutation was not initialized');
        };
        const applyDataToStore = vi.fn((data: AppData) => {
            harness.inMemory = cloneAppData(data);
        });
        const { harness, hooks, io, run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: {
                onStaleSnapshot: vi.fn(),
            },
            storage: {
                persistLocal: vi.fn(async (data: AppData) => {
                    harness.persisted = cloneAppData(data);
                    raceMidPersist();
                }),
                applyDataToStore,
            },
        });
        let raced = false;
        raceMidPersist = () => {
            if (raced) return;
            raced = true;
            harness.inMemory.tasks[0] = {
                ...harness.inMemory.tasks[0],
                title: 'Edited while saving',
                updatedAt: '2026-07-13T10:00:01.000Z',
            };
            harness.lastDataChangeAt += 1;
        };

        const result = await run();

        expect(result).toMatchObject({ success: true, skipped: 'requeued' });
        expect(harness.inMemory.tasks[0]?.title).toBe('Edited while saving');
        expect(applyDataToStore).not.toHaveBeenCalled();
        expect(io.writeRemote).not.toHaveBeenCalled();
        expect(hooks.requestFollowUp).toHaveBeenCalled();
        expect(hooks.onStaleSnapshot).toHaveBeenCalled();
    });

    it('accepts a covered snapshot instead of aborting when the platform hook approves it', async () => {
        const { harness, hooks, io, run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: {
                acceptCoveredSnapshot: vi.fn(() => true),
            },
        });
        vi.mocked(io.readRemote).mockImplementation(async () => {
            harness.lastDataChangeAt += 1;
            return cloneAppData(harness.remote!);
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.skipped).toBeUndefined();
        expect(hooks.acceptCoveredSnapshot).toHaveBeenCalled();
    });

    it('runs the attachment pre-sync before the fast-check only under the mobile ordering policy', async () => {
        const syncAttachments = vi.fn(async () => false);
        const desktop = createHarness({
            fastSyncScope: 'scope-1',
            io: { syncAttachments },
        });
        await desktop.run();
        const callsAfterFirstMerge = syncAttachments.mock.calls.length;
        await desktop.run();
        // Desktop order: the second run fast-skips before the attachment phase.
        expect(syncAttachments.mock.calls.length).toBe(callsAfterFirstMerge);

        const mobileAttachments = vi.fn(async () => false);
        const mobile = createHarness({
            fastSyncScope: 'scope-1',
            policy: { preSyncAttachmentsBeforeFastCheck: true },
            io: { syncAttachments: mobileAttachments },
        });
        await mobile.run();
        const mobileCalls = mobileAttachments.mock.calls.length;
        const second = await mobile.run();
        expect(second.skipped).toBe('unchanged');
        // Mobile order: the pre-sync ran again even though the cycle then skipped.
        expect(mobileAttachments.mock.calls.length).toBeGreaterThan(mobileCalls);
    });

    it('persists attachment pre-sync mutations when the cycle aborts before writing locally', async () => {
        const local = createData([createTask('t-local', 'Local task')]);
        const mutated = createData([createTask('t-local', 'Local task'), createTask('t-presync', 'Uploaded attachment task')]);
        const { harness, run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            policy: { preSyncAttachmentsBeforeFastCheck: true },
            io: {
                syncAttachments: vi.fn(async () => cloneAppData(mutated)),
                readRemote: vi.fn(async () => {
                    harness.lastDataChangeAt += 1;
                    return cloneAppData(harness.remote!);
                }),
            },
        });

        const result = await run();

        expect(result).toMatchObject({ success: true, skipped: 'requeued' });
        expect(harness.persisted.tasks.map((task) => task.id)).toContain('t-presync');
    });

    it('continues with a warning when the attachment pre-sync fails', async () => {
        const { harness, run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                syncAttachments: vi.fn(async () => {
                    throw new Error('upload failed');
                }),
            },
            // Restrict the failure to the pre-sync phase.
            hooks: {
                shouldRunAttachmentPhase: vi.fn(async (_data, phase) => phase === 'prepare'),
            },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.hadAttachmentWarning).toBe(true);
        expect(harness.warnings.some((warning) => warning.message === 'Attachment pre-sync warning')).toBe(true);
    });

    it('rethrows attachment pre-sync errors when the cycle was aborted', async () => {
        const { run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                syncAttachments: vi.fn(async () => {
                    throw new Error('aborted mid-upload');
                }),
            },
            hooks: {
                isCycleAborted: () => true,
                shouldRunAttachmentPhase: vi.fn(async (_data, phase) => phase === 'prepare'),
            },
        });

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.error).toContain('aborted mid-upload');
    });

    it('persists post-merge attachment mutations and skips fast-state recording', async () => {
        const { harness, run } = createHarness({
            fastSyncScope: 'scope-1',
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                syncAttachments: vi.fn(async (data: AppData) => {
                    data.tasks.push(createTask('t-downloaded', 'Downloaded attachment task'));
                    return true;
                }),
            },
            hooks: {
                shouldRunAttachmentPhase: vi.fn(async (_data, phase) => phase === 'post-merge'),
            },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(harness.persisted.tasks.map((task) => task.id)).toContain('t-downloaded');
        expect(harness.fastStates.size).toBe(0);
        expect(harness.diagnostics).toContain('attachment-sync-applied');
    });

    it('applies the platform post-merge attachment error policy', async () => {
        const failingIo = {
            syncAttachments: vi.fn(async () => {
                throw new Error('download failed');
            }),
        };
        const postMergeOnly = {
            shouldRunAttachmentPhase: vi.fn(async (_data: AppData, phase: string) => phase === 'post-merge'),
        };

        const warn = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: failingIo,
            hooks: postMergeOnly,
            policy: { postMergeAttachmentErrorPolicy: 'warn' },
        });
        const warnResult = await warn.run();
        expect(warnResult.success).toBe(true);
        expect(warnResult.hadAttachmentWarning).toBe(true);
        expect(warn.harness.warnings.some((warning) => warning.message === 'Attachment sync warning')).toBe(true);

        const fail = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: failingIo,
            hooks: postMergeOnly,
            policy: { postMergeAttachmentErrorPolicy: 'fail' },
        });
        const failResult = await fail.run();
        expect(failResult.success).toBe(false);
        expect(failResult.error).toContain('download failed');
    });

    it('runs the periodic attachment cleanup through the platform hook and persists its result', async () => {
        const local = createData([createTask('t-local', 'Local task')], {
            attachments: { lastCleanupAt: '2026-01-01T00:00:00.000Z' },
        });
        const cleaned = createData([createTask('t-local', 'Local task')], {
            attachments: { lastCleanupAt: NOW.toISOString() },
        });
        const runAttachmentCleanup = vi.fn(async () => ({ data: cloneAppData(cleaned), invalidateFastSyncState: true }));
        const { harness, run } = createHarness({
            local,
            fastSyncScope: 'scope-1',
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: { runAttachmentCleanup },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(runAttachmentCleanup).toHaveBeenCalledTimes(1);
        expect(harness.persisted.settings.attachments?.lastCleanupAt).toBe(NOW.toISOString());
        // invalidateFastSyncState suppressed the fast-state record.
        expect(harness.fastStates.size).toBe(0);
    });

    it('runs cleanup before the interval elapses when an attachment was just removed (#1064)', async () => {
        const task = createTask('t-local', 'Local task');
        task.attachments = [{
            id: 'attachment-1',
            kind: 'file',
            title: 'removed',
            uri: '/tmp/removed.pdf',
            createdAt: STAMP,
            updatedAt: STAMP,
            deletedAt: STAMP,
        }];
        // The throttle only blocks while the interval has not elapsed, and it
        // compares against the real clock — stamp the last cleanup as "now".
        const local = createData([task], {
            attachments: { lastCleanupAt: new Date().toISOString() },
        });
        const runAttachmentCleanup = vi.fn(async (data: AppData) => ({
            data: cloneAppData(data),
            invalidateFastSyncState: false,
        }));
        const { run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: { runAttachmentCleanup },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(runAttachmentCleanup).toHaveBeenCalledTimes(1);
    });

    it('keeps the cleanup interval throttle when there is no orphaned attachment work', async () => {
        const local = createData([createTask('t-local', 'Local task')], {
            attachments: { lastCleanupAt: new Date().toISOString() },
        });
        const runAttachmentCleanup = vi.fn(async (data: AppData) => ({
            data: cloneAppData(data),
            invalidateFastSyncState: false,
        }));
        const { run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: { runAttachmentCleanup },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(runAttachmentCleanup).not.toHaveBeenCalled();
    });

    it('keeps File Sync cleanup interval-gated when there is no tombstone work', async () => {
        const local = createData([createTask('t-local', 'Local task')], {
            attachments: { lastCleanupAt: new Date().toISOString() },
        });
        const runAttachmentCleanup = vi.fn(async () => null);
        const { run } = createHarness({
            backend: 'file',
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: { runAttachmentCleanup },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(runAttachmentCleanup).not.toHaveBeenCalled();
    });

    it('keeps local purge metadata through merge until attachment cleanup removes it', async () => {
        const local = createData([{
            id: 'purged-task',
            title: '(deleted)',
            status: 'inbox',
            tags: [],
            contexts: [],
            attachments: [{
                id: 'attachment-1',
                kind: 'file',
                title: '',
                uri: '/tmp/private.pdf',
                createdAt: STAMP,
                updatedAt: STAMP,
            }],
            createdAt: STAMP,
            updatedAt: STAMP,
            deletedAt: STAMP,
            purgedAt: STAMP,
        }], {
            attachments: { lastCleanupAt: '2026-01-01T00:00:00.000Z' },
        });
        const remote = createData([{
            ...local.tasks[0],
            attachments: undefined,
        }]);
        const runAttachmentCleanup = vi.fn(async (data: AppData) => {
            expect(data.tasks[0].attachments?.[0]?.uri).toBe('/tmp/private.pdf');
            const cleaned = cloneAppData(data);
            cleaned.tasks[0].attachments = undefined;
            return { data: cleaned, invalidateFastSyncState: true };
        });
        const { harness, run } = createHarness({
            local,
            remote,
            hooks: { runAttachmentCleanup },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(runAttachmentCleanup).toHaveBeenCalledTimes(1);
        expect(harness.persisted.tasks[0].attachments).toBeUndefined();
    });

    it('requeues instead of persisting a cleanup snapshot when local data changes inside the hook', async () => {
        const previousCleanupAt = '2026-01-01T00:00:00.000Z';
        const local = createData([createTask('t-local', 'Local task')], {
            attachments: { lastCleanupAt: previousCleanupAt },
        });
        const cleaned = createData([createTask('t-local', 'Local task')], {
            attachments: { lastCleanupAt: NOW.toISOString() },
        });
        let mutateLocalData: () => void = () => {
            throw new Error('Harness mutation was not initialized');
        };
        const runAttachmentCleanup = vi.fn(async () => {
            mutateLocalData();
            return { data: cloneAppData(cleaned), invalidateFastSyncState: true };
        });
        const { harness, hooks, storage, run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: { runAttachmentCleanup },
        });
        mutateLocalData = () => {
            harness.inMemory.tasks[0] = {
                ...harness.inMemory.tasks[0],
                title: 'Edited during cleanup',
                updatedAt: '2026-07-13T10:00:01.000Z',
            };
            harness.lastDataChangeAt += 1;
        };

        const result = await run();

        expect(result).toMatchObject({ success: true, skipped: 'requeued' });
        expect(hooks.requestFollowUp).toHaveBeenCalled();
        expect(hooks.finalizeSuccess).not.toHaveBeenCalled();
        expect(vi.mocked(storage.persistLocal).mock.calls.some(
            ([data]) => data.settings.attachments?.lastCleanupAt === NOW.toISOString(),
        )).toBe(false);
        expect(harness.inMemory.tasks[0]?.title).toBe('Edited during cleanup');
    });

    it('skips the attachment cleanup inside the interval window', async () => {
        const local = createData([createTask('t-local', 'Local task')], {
            attachments: { lastCleanupAt: new Date(Date.now() - 60_000).toISOString() },
        });
        const runAttachmentCleanup = vi.fn(async () => null);
        const { run } = createHarness({
            local,
            remote: createData([createTask('t-remote', 'Remote task')]),
            hooks: { runAttachmentCleanup },
        });

        await run();

        expect(runAttachmentCleanup).not.toHaveBeenCalled();
    });

    it('lets the pre-requeue platform hook short-circuit error handling (mobile lifecycle abort)', async () => {
        const { hooks, run } = createHarness({
            hooks: {
                setupCycle: vi.fn(async () => {
                    throw new Error('aborted');
                }),
                handleRunErrorBeforeRequeue: vi.fn(async () => ({ success: true })),
            },
        });

        const result = await run();

        expect(result).toEqual({ success: true });
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
    });

    it('lets the post-requeue platform hook classify offline skips (mobile)', async () => {
        const { hooks, run } = createHarness({
            io: {
                readRemote: vi.fn(async () => {
                    throw new Error('network request failed');
                }),
            },
            hooks: {
                handleRunErrorAfterRequeue: vi.fn(async (error) => (
                    error instanceof Error && error.message.includes('network')
                        ? { success: true, skipped: 'offline' as const }
                        : null
                )),
            },
        });

        const result = await run();

        expect(result).toMatchObject({ success: true, skipped: 'offline' });
        expect(hooks.finalizeErrorStatus).not.toHaveBeenCalled();
    });

    it('treats a corrupted WebDAV remote as missing and repairs it with the merged data', async () => {
        const { harness, io, run } = createHarness({
            backend: 'webdav',
            io: {
                readRemote: vi.fn(async () => {
                    throw new Error('WebDAV get failed: invalid JSON');
                }),
            },
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(io.writeRemote).toHaveBeenCalledTimes(1);
        expect(harness.remote?.tasks.map((task) => task.id)).toContain('t-local');
        expect(harness.warnings.some((warning) => warning.message.includes('appears corrupted'))).toBe(true);
        expect(harness.infos.some((info) => info.message.includes('Repairing corrupted WebDAV'))).toBe(true);
    });

    it('still reports the unchanged skip when persisting the status fails', async () => {
        const failing = createHarness({
            fastSyncScope: 'scope-1',
            storage: {
                persistSyncStatus: vi.fn(async () => {
                    throw new Error('disk full');
                }),
            },
        });

        const first = await failing.run();
        expect(first.success).toBe(true);
        const second = await failing.run();

        expect(second).toMatchObject({ success: true, skipped: 'unchanged' });
        expect(failing.harness.warnings.some((warning) => warning.message === 'Failed to persist unchanged sync status')).toBe(true);
    });

    it('surfaces the attachment warning flag on failed runs too', async () => {
        const { run } = createHarness({
            remote: createData([createTask('t-remote', 'Remote task')]),
            io: {
                syncAttachments: vi.fn(async () => {
                    throw new Error('upload failed');
                }),
                writeRemote: vi.fn(async () => {
                    throw new Error('server exploded');
                }),
            },
            hooks: {
                shouldRunAttachmentPhase: vi.fn(async (_data, phase) => phase === 'prepare'),
            },
        });

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.hadAttachmentWarning).toBe(true);
    });
});

describe('normalizeRemoteWriteResult', () => {
    it('prefers an explicit fingerprint and reads the server-merge flag', () => {
        expect(normalizeRemoteWriteResult('cloud', {
            fingerprint: 'fp-explicit',
            serverMergedRemoteData: true,
        })).toEqual({ fingerprint: 'fp-explicit', serverMergedRemoteData: true });
    });

    it('builds an HTTP fingerprint from headers when none is provided', () => {
        const normalized = normalizeRemoteWriteResult('webdav', {
            etag: '"abc"',
            lastModified: 'Mon, 13 Jul 2026 10:00:00 GMT',
            contentLength: '123',
        });
        expect(normalized.fingerprint).toBeTruthy();
        expect(normalized.serverMergedRemoteData).toBe(false);
    });

    it('handles boolean and missing results', () => {
        expect(normalizeRemoteWriteResult('webdav', true)).toEqual({ fingerprint: null, serverMergedRemoteData: false });
        expect(normalizeRemoteWriteResult('cloud', null)).toEqual({ fingerprint: null, serverMergedRemoteData: false });
    });
});
