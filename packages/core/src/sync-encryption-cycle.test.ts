// S4 (correction pass on encwire-20260821-03): the two "Required tests" the original
// handoff named but the first pass never wrote. Encryption wraps already-serialized bytes
// at the storage seam only — merge stays plaintext-in-memory and untouched (pinned
// architecture) — so this proves that wrapping is fully transparent to a real merge cycle
// using core's actual `mergeAppDataWithStats`, not a hand-rolled equality check.

import { describe, expect, it } from 'vitest';
import { mergeAppDataWithStats } from './sync';
import { createMockTask, mockAppData } from './sync-test-utils';
import {
    decryptRemoteArtifactOrThrow,
    runEnableSyncEncryptionOverRemote,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemotePort,
} from './sync-encryption';
import { encryptSyncArtifact, type SyncKeyMaterial } from './sync-crypto';
import type { AppData } from './types';

function createFakeRemote(): SyncEncryptionRemotePort & { store: Map<string, Uint8Array> } {
    const store = new Map<string, Uint8Array>();
    const versions = new Map<string, number>();
    const versionFor = (name: string): string | null => store.has(name) ? `v${versions.get(name) ?? 1}` : null;
    return {
        store,
        async list(): Promise<SyncEncryptionRemoteEntry[]> {
            return [...store.keys()].map((name) => ({ name, kind: 'document' as const }));
        },
        async read(name) {
            return { bytes: store.has(name) ? store.get(name)! : null, version: versionFor(name) };
        },
        async write(name, bytes, expectedVersion) {
            if (versionFor(name) !== expectedVersion) throw new Error(`${name} changed`);
            store.set(name, bytes);
            versions.set(name, (versions.get(name) ?? 0) + 1);
        },
        async remove(name, expectedVersion) {
            if (versionFor(name) !== expectedVersion) throw new Error(`${name} changed`);
            store.delete(name);
            versions.delete(name);
        },
    };
}

function createFakeKeyCache(): SyncEncryptionKeyCachePort {
    let current: Uint8Array | null = null;
    return {
        async getKey() { return current; },
        async setKey(key) { current = key; },
        async clearKey() { current = null; },
    };
}

function createFakeLocalState(): SyncEncryptionLocalStatePort {
    let value: ReturnType<SyncEncryptionLocalStatePort['read']> = null;
    return { read: () => value, write: (state) => { value = state; } };
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array): AppData => JSON.parse(new TextDecoder().decode(b)) as AppData;

/** One "sync cycle" against an already-encrypted remote: decrypt -> merge with `local` ->
 *  re-encrypt -> write back. Exactly the seam-then-merge composition a real sync run does,
 *  minus the platform IO plumbing (webdav/dropbox/file), which is already covered
 *  elsewhere (webdav-sync-document.test.ts, dropbox.test.ts) — this test's job is the
 *  merge-under-encryption claim specifically. */
async function runEncryptedCycle(
    remote: ReturnType<typeof createFakeRemote>,
    material: SyncKeyMaterial,
    local: AppData,
) {
    const remoteBytes = remote.store.get('data.json.enc');
    const remoteData = remoteBytes ? decode(await decryptRemoteArtifactOrThrow(remoteBytes, material.key)) : local;
    const { data: merged, stats } = mergeAppDataWithStats(local, remoteData);
    const sealed = await encryptSyncArtifact(utf8(JSON.stringify(merged)), material);
    remote.store.set('data.json.enc', sealed);
    return { merged, stats };
}

describe('encrypted sync cycle convergence (S4, required test 4)', () => {
    it('encrypt -> write -> read -> decrypt -> merge, run twice with aligned data, converges with zero diffs', async () => {
        const remote = createFakeRemote();
        const keyCache = createFakeKeyCache();
        const localState = createFakeLocalState();
        const initial = mockAppData([createMockTask('t1', '2026-08-01T00:00:00.000Z')]);
        await remote.write('data.json', utf8(JSON.stringify(initial)), null);

        await runEnableSyncEncryptionOverRemote('correct horse', remote, keyCache, localState, undefined, undefined, { mKib: 8, t: 1, p: 1 });
        const material: SyncKeyMaterial = {
            key: (await keyCache.getKey())!,
            salt: new Uint8Array(16),
            params: { mKib: 8, t: 1, p: 1 },
        };

        const first = await runEncryptedCycle(remote, material, initial);
        expect(first.stats.tasks.conflicts).toBe(0);
        expect(first.merged.tasks).toHaveLength(1);
        expect(first.merged.tasks[0]).toMatchObject({ id: 't1', title: 'Task t1' });

        // Second cycle: local is exactly what the first cycle produced and uploaded —
        // the "nothing changed anywhere" steady state a real device settles into. The
        // merge normalizes tasks (fills default fields), so the meaningful "zero diffs"
        // claim is that a SECOND pass over already-normalized, already-aligned data is a
        // byte-for-byte no-op — not that it matches the original, pre-normalization fixture.
        const second = await runEncryptedCycle(remote, material, first.merged);
        expect(second.stats.tasks.conflicts).toBe(0);
        expect(second.stats.tasks.localOnly).toBe(0);
        expect(second.stats.tasks.incomingOnly).toBe(0);
        expect(second.merged).toEqual(first.merged);
    });

    it('a fresh sync of already-aligned data produces zero conflicts on the very first cycle', async () => {
        const remote = createFakeRemote();
        const keyCache = createFakeKeyCache();
        const localState = createFakeLocalState();
        const aligned = mockAppData([
            createMockTask('t1', '2026-08-01T00:00:00.000Z'),
            createMockTask('t2', '2026-08-02T00:00:00.000Z'),
        ]);
        // Two devices that happen to hold byte-identical data (e.g. a fresh clone) —
        // the remote is seeded with the SAME content this "device" already has locally.
        await remote.write('data.json', utf8(JSON.stringify(aligned)), null);
        await runEnableSyncEncryptionOverRemote('correct horse', remote, keyCache, localState, undefined, undefined, { mKib: 8, t: 1, p: 1 });
        const material: SyncKeyMaterial = {
            key: (await keyCache.getKey())!,
            salt: new Uint8Array(16),
            params: { mKib: 8, t: 1, p: 1 },
        };

        const { merged, stats } = await runEncryptedCycle(remote, material, aligned);
        expect(stats.tasks.conflicts).toBe(0);
        expect(stats.tasks.localOnly).toBe(0);
        expect(stats.tasks.incomingOnly).toBe(0);
        expect(merged.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2']);
        expect(merged.tasks.map((t) => t.title).sort()).toEqual(['Task t1', 'Task t2']);
    });
});
