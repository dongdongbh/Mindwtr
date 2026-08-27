import { describe, expect, it } from 'vitest';
import {
    acquireSyncRemoteMutationFence,
    SyncRemoteMutationFenceBusyError,
    SyncRemoteMutationFenceLostError,
    SyncRemoteMutationFenceUnavailableError,
    type SyncRemoteMutationFencePort,
} from './sync-remote-fence';

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
});
