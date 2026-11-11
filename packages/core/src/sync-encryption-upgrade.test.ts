import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    defaultSyncCryptoPrimitives, decryptSyncArtifact, deriveSyncKeyMaterial,
    encryptSyncArtifact, decryptLegacySyncArtifactForUpgrade,
} from './sync-crypto';
import {
    isLegacySyncPreservationName, runUpgradeSyncEncryptionOverRemote,
    type SyncEncryptionLocalState, type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemotePort,
} from './sync-encryption';
import { toRemoteSyncDocument } from './sync-document';
import type { AppData } from './types';
import legacyVectors from './__fixtures__/sync-crypto/legacy-vectors.json';

const utf8 = (value: string) => new TextEncoder().encode(value);
const params = { mKib: 64, t: 1, p: 1 };
const attachmentBytes = utf8('trusted attachment');
const archiveIdentifier = (key: Uint8Array, original: Uint8Array) => bytesToHex(hmac.create(sha256, key)
    .update(utf8('mindwtr-legacy-archive:2\u0000')).update(original).digest());
const local: AppData = {
    tasks: [{
        id: 'trusted-task', title: 'Trusted', status: 'inbox', tags: [], contexts: [],
        createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
        attachments: [{
            id: 'file', kind: 'file', title: 'note.txt', uri: '/trusted/note.txt', cloudKey: 'attachments/file.txt',
            fileHash: bytesToHex(sha256(attachmentBytes)), createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
        }],
    }],
    projects: [], areas: [], sections: [], people: [], settings: {},
};

async function legacySeal(plaintext: Uint8Array, key: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    const header = new Uint8Array(54);
    header.set(utf8('MWENC1'));
    header.set([1, 1, 64, 0, 0, 0, 1, 0, 0, 0, 1, 1], 6);
    header.set(salt, 18);
    const nonce = defaultSyncCryptoPrimitives.randomBytes(12);
    header.set(nonce, 34);
    new DataView(header.buffer).setBigUint64(46, BigInt(plaintext.length + 16), true);
    const cipher = await defaultSyncCryptoPrimitives.aesGcmSeal(key, nonce, plaintext, header);
    const bytes = new Uint8Array(54 + cipher.length);
    bytes.set(header);
    bytes.set(cipher, 54);
    return bytes;
}

async function fixture(source: AppData = local, plaintextAttachment = false) {
    const material = await deriveSyncKeyMaterial('phrase', new Uint8Array(16).fill(4), params);
    const originalDocument = await legacySeal(utf8(JSON.stringify(toRemoteSyncDocument(source))), material.key, material.salt);
    const originalAttachment = plaintextAttachment ? attachmentBytes : await legacySeal(attachmentBytes, material.key, material.salt);
    const files = new Map([['data.json.enc', originalDocument], ['attachments/file.txt', originalAttachment],
        ['data.json.enc.bak', utf8('untrusted old backup bytes')]]);
    const revision = new Map([...files.keys()].map((name) => [name, 1]));
    const writes: string[] = [];
    let failAfterCanonical = false;
    let failWrite: number | null = null;
    let failStateCommit = false;
    let state: SyncEncryptionLocalState | null = { state: 'enabled' };
    const version = (name: string) => files.has(name) ? String(revision.get(name)) : null;
    const remote: SyncEncryptionRemotePort = {
        list: async () => [...files.keys()].filter((name) => !isLegacySyncPreservationName(name))
            .map((name): SyncEncryptionRemoteEntry => ({ name, kind: name.startsWith('attachments/') ? 'attachment' : 'document' })),
        read: async (name) => ({ bytes: files.get(name) ?? null, version: version(name) }),
        write: async (name, bytes, expected) => {
            if (version(name) !== expected) throw new Error('CAS conflict');
            files.set(name, bytes);
            revision.set(name, (revision.get(name) ?? 0) + 1);
            writes.push(name);
            if (failWrite === writes.length) throw new Error('interrupted write acknowledgement');
        },
        remove: async (name, expected) => {
            if (failAfterCanonical) throw new Error('interrupted cleanup');
            if (version(name) !== expected) throw new Error('CAS conflict');
            files.delete(name);
        },
    };
    const cache = { getKey: async () => material.key, setKey: async () => {}, clearKey: async () => {} };
    const statePort = { read: () => state, write: async (next: SyncEncryptionLocalState | null) => {
        if (failStateCommit && next?.state === 'enabled' && !next.incompleteTransition) throw new Error('state commit failed');
        state = next;
    } };
    return { material, files, writes, remote, cache, statePort, originalDocument, originalAttachment,
        interruptCleanup: (value: boolean) => { failAfterCanonical = value; },
        interruptWrite: (value: number | null) => { failWrite = value; },
        interruptState: (value: boolean) => { failStateCommit = value; } };
}


describe('explicit trusted-local encryption upgrade', () => {
    it('retains every old generation, binds attachment identity and publishes trusted local data last', async () => {
        const f = await fixture();
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort);
        for (const original of [f.originalDocument, f.originalAttachment, utf8('untrusted old backup bytes')]) {
            const digest = archiveIdentifier(f.material.key, original);
            const archive = f.files.get(`.mindwtr-legacy-${digest}.bin`)!;
            expect(archive).not.toEqual(original);
            expect(await decryptSyncArtifact(archive, f.material.key, defaultSyncCryptoPrimitives, { kind: 'recovery', artifactName: digest })).toEqual(original);
            await expect(decryptSyncArtifact(archive, f.material.key, defaultSyncCryptoPrimitives, { kind: 'document' })).rejects.toThrow();
        }
        expect(f.writes.at(-1)).toBe('data.json.enc');
        const attachment = f.files.get('attachments/file.txt')!;
        expect(await decryptSyncArtifact(attachment, f.material.key, defaultSyncCryptoPrimitives,
            { kind: 'attachment', cloudKey: 'attachments/file.txt' })).toEqual(attachmentBytes);
        await expect(decryptSyncArtifact(attachment, f.material.key, undefined, { kind: 'document' })).rejects.toThrow();
        expect(JSON.parse(new TextDecoder().decode(await decryptSyncArtifact(f.files.get('data.json.enc')!, f.material.key, undefined, { kind: 'document' }))))
            .toEqual(toRemoteSyncDocument(local));
        expect(f.statePort.read()?.incompleteTransition).toBeUndefined();
        expect(await f.remote.list()).toHaveLength(2);
        const manifest = [...f.files].find(([name]) => name.startsWith('.mindwtr-legacy-inventory-'))!;
        const mapping = JSON.parse(new TextDecoder().decode(await decryptSyncArtifact(manifest[1], f.material.key, defaultSyncCryptoPrimitives, { kind: 'recovery', artifactName: 'legacy-inventory' })));
        expect(mapping).toContainEqual({ name: 'data.json.enc', preservedName: `.mindwtr-legacy-${archiveIdentifier(f.material.key, f.originalDocument)}.bin`, sourceSha256: bytesToHex(sha256(f.originalDocument)), encoding: 'recovery-v2' });
        expect(mapping).toContainEqual({ name: 'attachments/file.txt', preservedName: `.mindwtr-legacy-${archiveIdentifier(f.material.key, f.originalAttachment)}.bin`, sourceSha256: bytesToHex(sha256(f.originalAttachment)), encoding: 'recovery-v2' });
        expect([...f.files.keys()].join(' ')).not.toContain(bytesToHex(sha256(attachmentBytes)));
        const completedBytes = new Map(f.files);
        const writeCount = f.writes.length;
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort);
        expect(f.files).toEqual(completedBytes);
        expect(f.writes).toHaveLength(writeCount);
    });

    it('refuses missing local data, remote-only changes and missing hashes before writes', async () => {
        for (const source of [
            { ...local, tasks: [] },
            { ...local, tasks: [{ ...local.tasks[0], title: 'different local state' }] },
            { ...local, tasks: [{ ...local.tasks[0], attachments: [{ ...local.tasks[0].attachments![0], fileHash: undefined }] }] },
        ]) {
            const f = await fixture();
            await expect(runUpgradeSyncEncryptionOverRemote('phrase', async () => source, f.remote, f.cache, f.statePort)).rejects.toThrow(/TRUSTED_LOCAL|RECONCILIATION/);
            expect(f.writes).toEqual([]);
            expect(f.files.get('data.json.enc')).toEqual(f.originalDocument);
        }
    });

    it('resumes after canonical publication without promoting legacy backups', async () => {
        const f = await fixture();
        f.interruptCleanup(true);
        await expect(runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort)).rejects.toThrow('interrupted');
        expect(f.statePort.read()?.incompleteTransition).toBe('upgrade');
        const preserved = f.files.get(`.mindwtr-legacy-${archiveIdentifier(f.material.key, f.originalDocument)}.bin`);
        f.interruptCleanup(false);
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort);
        expect(f.files.get(`.mindwtr-legacy-${archiveIdentifier(f.material.key, f.originalDocument)}.bin`)).toEqual(preserved);
        expect(f.files.has('data.json.enc.bak')).toBe(false);
        expect(f.statePort.read()?.incompleteTransition).toBeUndefined();
    });

    it.each([1, 2, 3, 4, 5, 6])('resumes an acknowledged-lost mutation at write %s without replacing retained recovery bytes', async (boundary) => {
        const f = await fixture();
        f.interruptWrite(boundary);
        await expect(runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort))
            .rejects.toThrow('interrupted write acknowledgement');
        expect(f.statePort.read()?.incompleteTransition).toBe('upgrade');
        const retained = [...f.files].filter(([name]) => isLegacySyncPreservationName(name));
        f.interruptWrite(null);
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort);
        for (const [name, bytes] of retained) expect(f.files.get(name)).toEqual(bytes);
        expect(f.statePort.read()?.incompleteTransition).toBeUndefined();
        expect(await decryptSyncArtifact(f.files.get('attachments/file.txt')!, f.material.key,
            defaultSyncCryptoPrimitives, { kind: 'attachment', cloudKey: 'attachments/file.txt' })).toEqual(attachmentBytes);
    });

    it('retains the upgrade journal after a final state failure and completes on retry', async () => {
        const f = await fixture();
        f.interruptState(true);
        await expect(runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort)).rejects.toThrow('state commit failed');
        expect(f.statePort.read()?.incompleteTransition).toBe('upgrade');
        f.interruptState(false);
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort);
        expect(f.statePort.read()?.incompleteTransition).toBeUndefined();
    });

    it('reads old vectors only through the explicit legacy decoder', async () => {
        for (const vector of legacyVectors) {
            const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
            const material = await deriveSyncKeyMaterial(vector.passphrase, bytes(vector.saltB64), vector.params);
            await expect(decryptSyncArtifact(bytes(vector.encryptedB64), material.key, undefined, { kind: 'document' })).rejects.toThrow('LEGACY');
            expect(await decryptLegacySyncArtifactForUpgrade(bytes(vector.encryptedB64), material.key)).toEqual(bytes(vector.plaintextB64));
        }
    });

    it('upgrades a hash-proven legacy plaintext attachment while retaining its exact bytes', async () => {
        const f = await fixture(local, true);
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort);
        expect(await decryptSyncArtifact(f.files.get('attachments/file.txt')!, f.material.key,
            defaultSyncCryptoPrimitives, { kind: 'attachment', cloudKey: 'attachments/file.txt' })).toEqual(attachmentBytes);
        const digest = archiveIdentifier(f.material.key, attachmentBytes);
        const archive = f.files.get(`.mindwtr-legacy-${digest}.bin`)!;
        expect(archive).not.toEqual(attachmentBytes);
        expect(await decryptSyncArtifact(archive, f.material.key, defaultSyncCryptoPrimitives, { kind: 'recovery', artifactName: digest })).toEqual(attachmentBytes);
    });

    it('supports a trusted empty canonical library with settings and refuses an unavailable canonical reader', async () => {
        const empty = { ...local, tasks: [], settings: { language: 'en' as const } };
        const f = await fixture(empty);
        await runUpgradeSyncEncryptionOverRemote('phrase', async () => empty, f.remote, f.cache, f.statePort);
        expect(JSON.parse(new TextDecoder().decode(await decryptSyncArtifact(f.files.get('data.json.enc')!, f.material.key, undefined, { kind: 'document' }))))
            .toEqual(toRemoteSyncDocument(empty));
        const unavailable = await fixture();
        await expect(runUpgradeSyncEncryptionOverRemote('phrase', async () => {
            throw new Error('SYNC_ENCRYPTION_TRUSTED_LOCAL_REQUIRED');
        }, unavailable.remote, unavailable.cache, unavailable.statePort)).rejects.toThrow('TRUSTED_LOCAL_REQUIRED');
        expect(unavailable.writes).toEqual([]);
    });

    it('checks archive and encrypted-inventory capacity before the journal or any remote write', async () => {
        for (const cap of [100, 700]) {
            const f = await fixture();
            f.remote.maxEncryptedArtifactBytes = cap;
            await expect(runUpgradeSyncEncryptionOverRemote('phrase', async () => local, f.remote, f.cache, f.statePort))
                .rejects.toThrow('ARTIFACT_CAPACITY');
            expect(f.writes).toEqual([]);
            expect(f.statePort.read()?.incompleteTransition).toBeUndefined();
            expect(f.files.get('data.json.enc')).toEqual(f.originalDocument);
        }
    });
});
