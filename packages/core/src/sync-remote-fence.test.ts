import { describe, expect, it, vi } from 'vitest';
import {
    acquireSyncRemoteMutationFence,
    SyncRemoteMutationFenceBusyError,
    SyncRemoteMutationFenceLostError,
    SyncRemoteMutationFenceUnavailableError,
    type SyncRemoteMutationFencePort,
} from './sync-remote-fence';
import { consoleLogger, setLogger, type LogPayload } from './logger';

const text = (value: Uint8Array | null): string | null => value ? new TextDecoder().decode(value) : null;

const createPort = (initial?: { bytes: Uint8Array; version: string }) => {
    let current = initial ?? null;
    let serverNowMs = 1_000_000;
    let revision = initial ? Number(initial.version.slice(1)) : 0;
    const writes: Array<{ expected: string | null; value: string }> = [];
    const removes: string[] = [];
    const conflict = new Error('conflict');
    const port: SyncRemoteMutationFencePort = {
        read: async () => ({
            bytes: current?.bytes ? new Uint8Array(current.bytes) : null,
            version: current?.version ?? null,
            serverNowMs,
        }),
        write: async (bytes, expected) => {
            if (expected === null ? current !== null : current?.version !== expected) throw conflict;
            revision += 1;
            current = { bytes: new Uint8Array(bytes), version: `v${revision}` };
            writes.push({ expected, value: text(bytes)! });
        },
        remove: async (expected) => {
            if (current?.version !== expected) throw conflict;
            current = null;
            removes.push(expected);
        },
        isConflict: (error) => error === conflict,
    };
    return {
        port,
        writes,
        removes,
        setServerNow: (value: number) => { serverNowMs = value; },
        replace: (value: Record<string, unknown>) => {
            revision += 1;
            current = { bytes: new TextEncoder().encode(JSON.stringify(value)), version: `v${revision}` };
        },
        snapshot: () => current,
    };
};

const acquire = (port: SyncRemoteMutationFencePort, overrides = {}) => acquireSyncRemoteMutationFence(port, {
    ownerId: 'device-a',
    purpose: 'ordinary-sync',
    ttlMs: 10_000,
    heartbeatMs: 0,
    leaseId: 'lease-aaaaaaaa',
    ...overrides,
});

describe('remote sync mutation fence', () => {
    it('acquires an absent generation create-only and releases its exact version', async () => {
        const remote = createPort();
        const lease = await acquire(remote.port);

        expect(remote.writes).toHaveLength(1);
        expect(remote.writes[0]?.expected).toBeNull();
        expect(JSON.parse(remote.writes[0]!.value)).toMatchObject({
            schema: 1,
            leaseId: 'lease-aaaaaaaa',
            ownerId: 'device-a',
            purpose: 'ordinary-sync',
            expiresAt: 1_010_000,
        });

        await lease.release();
        expect(remote.removes).toEqual(['v1']);
        expect(remote.snapshot()).toBeNull();
    });

    it('reclaims a lease whose holder stopped renewing, by CAS over its exact version', async () => {
        // Holder advertised a 5s heartbeat and last renewed 60s ago (server time),
        // yet its 5-minute expiry is still far away: dead, not busy.
        const remote = createPort({
            version: 'v1',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-dead-0001',
                ownerId: 'mindwtr-desktop',
                purpose: 'ordinary-sync',
                expiresAt: 1_240_000,
                heartbeatMs: 5_000,
                renewedAt: 940_000,
            })),
        });

        const lease = await acquire(remote.port);
        expect(remote.writes).toHaveLength(1);
        expect(remote.writes[0]?.expected).toBe('v1');
        expect(lease.reclaimedFrom).toMatchObject({ ownerId: 'mindwtr-desktop', leaseId: 'lease-dead-0001' });
        expect(JSON.parse(remote.writes[0]!.value)).toMatchObject({ leaseId: 'lease-aaaaaaaa', renewedAt: 1_000_000 });
        await lease.release();
    });

    it('does not reclaim a lease whose holder renewed within its heartbeat window', async () => {
        const remote = createPort({
            version: 'v1',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-live-0001',
                ownerId: 'mindwtr-desktop',
                purpose: 'ordinary-sync',
                expiresAt: 1_240_000,
                heartbeatMs: 20_000,
                renewedAt: 990_000,
            })),
        });

        await expect(acquire(remote.port)).rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);
        expect(remote.writes).toHaveLength(0);
    });

    it('only waits out records from clients that do not advertise a heartbeat', async () => {
        const remote = createPort({
            version: 'v1',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-old-00001',
                ownerId: 'mindwtr-mobile',
                purpose: 'ordinary-sync',
                expiresAt: 1_240_000,
            })),
        });

        await expect(acquire(remote.port)).rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);
        expect(remote.writes).toHaveLength(0);
    });

    it('loses a reclaim race to a holder that renews in between and reports busy', async () => {
        const remote = createPort({
            version: 'v1',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-slow-0001',
                ownerId: 'mindwtr-desktop',
                purpose: 'ordinary-sync',
                expiresAt: 1_240_000,
                heartbeatMs: 5_000,
                renewedAt: 940_000,
            })),
        });
        // The paused holder wakes up and renews right after our read.
        const originalRead = remote.port.read;
        let reads = 0;
        remote.port.read = async () => {
            const snapshot = await originalRead();
            reads += 1;
            if (reads === 1) {
                remote.replace({
                    schema: 1,
                    leaseId: 'lease-slow-0001',
                    ownerId: 'mindwtr-desktop',
                    purpose: 'ordinary-sync',
                    expiresAt: 1_300_000,
                    heartbeatMs: 5_000,
                    renewedAt: 1_000_000,
                });
            }
            return snapshot;
        };

        await expect(acquire(remote.port)).rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);
        expect(remote.writes).toHaveLength(0);
    });

    it('returns a bounded busy error for a live peer lease without writing', async () => {
        const remote = createPort({
            version: 'v1',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-peer-1',
                ownerId: 'peer',
                purpose: 'encryption-transition',
                expiresAt: 1_004_000,
            })),
        });

        const error = await acquire(remote.port).then(() => null, (value) => value);
        expect(error).toBeInstanceOf(SyncRemoteMutationFenceBusyError);
        expect((error as SyncRemoteMutationFenceBusyError).retryAfterMs).toBe(4_000);
        // The holder rides along so a stall is attributable in the app log:
        // seconds left means a dead lease, not a device actively syncing.
        expect((error as SyncRemoteMutationFenceBusyError).holder).toMatchObject({
            ownerId: expect.any(String),
            leaseId: expect.any(String),
            purpose: expect.any(String),
            remainingMs: 4_000,
        });
        expect((error as SyncRemoteMutationFenceBusyError).message).toContain('4s left');
        expect(remote.writes).toHaveLength(0);
    });

    it('takes over an expired lease only through its observed version', async () => {
        const remote = createPort({
            version: 'v4',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-peer-1',
                ownerId: 'peer',
                purpose: 'ordinary-sync',
                expiresAt: 999_999,
            })),
        });

        const lease = await acquire(remote.port);
        expect(remote.writes[0]?.expected).toBe('v4');
        await lease.release();
    });

    it('reclaims an impossible future lease only through its observed version', async () => {
        const remote = createPort({
            version: 'v7',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-peer-1',
                ownerId: 'peer',
                purpose: 'ordinary-sync',
                expiresAt: 1_000_000 + (16 * 60_000) + 1,
            })),
        });

        const lease = await acquire(remote.port);
        expect(remote.writes[0]?.expected).toBe('v7');
        await lease.release();
    });

    it('keeps a maximum legal future lease busy within the provider-time tolerance', async () => {
        const remote = createPort({
            version: 'v1',
            bytes: new TextEncoder().encode(JSON.stringify({
                schema: 1,
                leaseId: 'lease-peer-1',
                ownerId: 'peer',
                purpose: 'ordinary-sync',
                expiresAt: 1_000_000 + (16 * 60_000),
            })),
        });

        await expect(acquire(remote.port)).rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);
        expect(remote.writes).toHaveLength(0);
    });

    it('renews by CAS and refuses to release a peer replacement', async () => {
        const remote = createPort();
        const lease = await acquire(remote.port);
        remote.setServerNow(1_008_000);

        await lease.assertHeld(3_000);
        expect(remote.writes[1]?.expected).toBe('v1');
        expect(JSON.parse(remote.writes[1]!.value).expiresAt).toBe(1_018_000);

        remote.replace({
            schema: 1,
            leaseId: 'lease-peer-2',
            ownerId: 'peer',
            purpose: 'ordinary-sync',
            expiresAt: 1_020_000,
        });
        await expect(lease.release()).rejects.toBeInstanceOf(SyncRemoteMutationFenceLostError);
        expect(remote.removes).toHaveLength(0);
    });

    it('renews for the requested mutation horizon before a peer can reclaim it', async () => {
        const remote = createPort();
        const lease = await acquire(remote.port, { ttlMs: 300_000, heartbeatMs: 20_000 });
        remote.setServerNow(1_064_000);

        const logs: LogPayload[] = [];
        setLogger((payload) => logs.push(payload));
        try {
            await lease.assertHeld(35_000);
        } finally {
            setLogger(consoleLogger);
        }

        expect(remote.writes).toHaveLength(2);
        expect(JSON.parse(remote.writes[1]!.value)).toMatchObject({
            renewedAt: 1_064_000,
            expiresAt: 1_364_000,
        });
        expect(logs).toContainEqual(expect.objectContaining({
            level: 'info',
            message: 'Remote sync mutation fence renewed for mutation horizon',
            scope: 'sync',
            category: 'sync',
            context: {
                releaseCheck: 'v1.2.8/fence-mutation-horizon',
                horizonMs: 35_000,
                remainingMs: 65_000,
            },
        }));

        remote.setServerNow(1_066_000);
        await expect(acquire(remote.port, {
            ownerId: 'device-b',
            leaseId: 'lease-bbbbbbbb',
            ttlMs: 300_000,
            heartbeatMs: 20_000,
        })).rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);

        remote.setServerNow(1_098_999);
        await expect(acquire(remote.port, {
            ownerId: 'device-b',
            leaseId: 'lease-bbbbbbbb',
            ttlMs: 300_000,
            heartbeatMs: 20_000,
        })).rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);
        await lease.release();
    });

    it.each([
        ['legacy record', {}],
        ['disabled heartbeat', { heartbeatMs: 0, renewedAt: 1_000_000 }],
    ])('uses expiry as the authority horizon for a %s', async (_label, liveness) => {
        const remote = createPort();
        const lease = await acquire(remote.port, { ttlMs: 300_000, heartbeatMs: 20_000 });
        remote.replace({
            schema: 1,
            leaseId: 'lease-aaaaaaaa',
            ownerId: 'device-a',
            purpose: 'ordinary-sync',
            expiresAt: 1_300_000,
            ...liveness,
        });
        remote.setServerNow(1_064_000);

        await lease.assertHeld(35_000);

        expect(remote.writes).toHaveLength(1);
        await lease.release();
    });

    it('fails closed when the advertised heartbeat window cannot cover the mutation horizon', async () => {
        const remote = createPort();
        const lease = await acquire(remote.port, { ttlMs: 300_000, heartbeatMs: 5_000 });

        await expect(lease.assertHeld(35_000)).rejects.toThrow(
            'Remote sync mutation fence cannot cover the requested mutation horizon',
        );
        expect(remote.writes).toHaveLength(2);
        await lease.release();
    });

    it('fails closed when renewal verification consumes the mutation horizon', async () => {
        const remote = createPort();
        const originalWrite = remote.port.write;
        remote.port.write = async (bytes, expectedVersion) => {
            await originalWrite(bytes, expectedVersion);
            if (remote.writes.length === 2) remote.setServerNow(1_095_001);
        };
        const lease = await acquire(remote.port, { ttlMs: 300_000, heartbeatMs: 20_000 });
        remote.setServerNow(1_064_000);

        await expect(lease.assertHeld(35_000)).rejects.toThrow(
            'Remote sync mutation fence cannot cover the requested mutation horizon',
        );
        await lease.release();
    });

    it('fails closed when server time or a safe existing version is unavailable', async () => {
        const noDate: SyncRemoteMutationFencePort = {
            read: async () => ({ bytes: null, version: null, serverNowMs: null }),
            write: async () => undefined,
            remove: async () => undefined,
            isConflict: () => false,
        };
        await expect(acquire(noDate)).rejects.toBeInstanceOf(SyncRemoteMutationFenceUnavailableError);

        const noVersion: SyncRemoteMutationFencePort = {
            ...noDate,
            read: async () => ({
                bytes: new TextEncoder().encode('{}'),
                version: null,
                serverNowMs: 1,
            }),
        };
        await expect(acquire(noVersion)).rejects.toBeInstanceOf(SyncRemoteMutationFenceUnavailableError);
    });

    it('fails acquisition when the created lease is already expired at verification time', async () => {
        let reads = 0;
        let bytes: Uint8Array | null = null;
        const port: SyncRemoteMutationFencePort = {
            read: async () => ({
                bytes,
                version: bytes ? 'v1' : null,
                serverNowMs: reads++ === 0 ? 1_000_000 : 1_010_001,
            }),
            write: async (value) => { bytes = new Uint8Array(value); },
            remove: async () => undefined,
            isConflict: () => false,
        };

        await expect(acquire(port)).rejects.toBeInstanceOf(SyncRemoteMutationFenceLostError);
    });

    it('reports the remaining server-observed expiry for deferred cleanup', async () => {
        const remote = createPort();
        const lease = await acquire(remote.port);

        expect(lease.retryAfterMs()).toBeGreaterThan(9_000);
        expect(lease.retryAfterMs()).toBeLessThanOrEqual(10_000);
        await lease.release();
    });

    it('stops heartbeats after a bounded provider request fails', async () => {
        const remote = createPort();
        let failReads = false;
        let readCalls = 0;
        const port: SyncRemoteMutationFencePort = {
            ...remote.port,
            read: async () => {
                readCalls += 1;
                if (failReads) throw new Error('Dropbox versioned file download timed out');
                return remote.port.read();
            },
        };
        const lease = await acquire(port, { heartbeatMs: 10 });
        failReads = true;

        await new Promise((resolve) => setTimeout(resolve, 30));
        const readsAfterFailure = readCalls;
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(readCalls).toBe(readsAfterFailure);
        await expect(lease.assertHeld()).rejects.toThrow('timed out');
        await expect(lease.release()).rejects.toThrow('timed out');
    });
});

describe('module load', () => {
    it('loads without a global TextDecoder', async () => {
        // React Native installs TextDecoder from Expo's winter runtime, which runs
        // after this module is first imported; a module-scope instance crashed the
        // Android app before it could boot.
        const original = globalThis.TextDecoder;
        delete (globalThis as { TextDecoder?: unknown }).TextDecoder;
        try {
            vi.resetModules();
            await expect(import('./sync-remote-fence')).resolves.toBeDefined();
        } finally {
            globalThis.TextDecoder = original;
        }
    });
});
