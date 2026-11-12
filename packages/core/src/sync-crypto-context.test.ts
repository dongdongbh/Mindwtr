import { describe, expect, it } from 'vitest';
import { defaultSyncCryptoPrimitives, decryptSyncArtifact, encryptSyncArtifact } from './sync-crypto';
import { webdavGetSyncDocument } from './webdav';
import contextVectors from './__fixtures__/sync-crypto/context-vectors.json';
import { deriveSyncKeyMaterial, type SyncArtifactContext } from './sync-crypto';

const material = {
    key: new Uint8Array(32).fill(7),
    salt: new Uint8Array(16).fill(8),
    params: { mKib: 64, t: 1, p: 1 },
};
const plaintext = new TextEncoder().encode(JSON.stringify({ tasks: [], projects: [], settings: {} }));

describe('sync artifact context authentication', () => {
    it('matches document and attachment context vectors shared with Rust', async () => {
        for (const vector of contextVectors) {
            const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
            const material = await deriveSyncKeyMaterial(vector.passphrase, bytes(vector.saltB64), vector.params);
            const context: SyncArtifactContext = vector.cloudKey
                ? { kind: 'attachment', cloudKey: vector.cloudKey } : { kind: 'document' };
            const sealed = await encryptSyncArtifact(bytes(vector.plaintextB64), material,
                { ...defaultSyncCryptoPrimitives, randomBytes: () => bytes(vector.nonceB64) }, context);
            expect(sealed).toEqual(bytes(vector.encryptedB64));
            expect(await decryptSyncArtifact(sealed, material.key, defaultSyncCryptoPrimitives, context)).toEqual(bytes(vector.plaintextB64));
        }
    });
    it('refuses an encrypted attachment at the production document transport boundary', async () => {
        const attachment = await encryptSyncArtifact(plaintext, material, defaultSyncCryptoPrimitives,
            { kind: 'attachment', cloudKey: 'attachments/chosen.json' });
        await expect(webdavGetSyncDocument('https://audit.invalid/data.json', {
            material,
            fetcher: async () => new Response(attachment.slice().buffer, { headers: { etag: '"audit"' } }),
        })).rejects.toThrow();
    });

    it('binds an attachment to its exact canonical identity', async () => {
        const encrypted = await encryptSyncArtifact(plaintext, material, defaultSyncCryptoPrimitives,
            { kind: 'attachment', cloudKey: 'attachments/a.json' });
        await expect(decryptSyncArtifact(encrypted, material.key, defaultSyncCryptoPrimitives,
            { kind: 'attachment', cloudKey: 'attachments/b.json' })).rejects.toThrow();
        await expect(decryptSyncArtifact(encrypted, material.key, undefined, { kind: 'document' })).rejects.toThrow();
        expect(await decryptSyncArtifact(encrypted, material.key, defaultSyncCryptoPrimitives,
            { kind: 'attachment', cloudKey: 'attachments/a.json' })).toEqual(plaintext);
    });

    it('isolates authenticated recovery bytes from documents and attachments', async () => {
        const sealed = await encryptSyncArtifact(plaintext, material, defaultSyncCryptoPrimitives,
            { kind: 'recovery', artifactName: 'opaque-archive' });
        await expect(decryptSyncArtifact(sealed, material.key, defaultSyncCryptoPrimitives, { kind: 'document' })).rejects.toThrow();
        await expect(decryptSyncArtifact(sealed, material.key, defaultSyncCryptoPrimitives,
            { kind: 'attachment', cloudKey: 'attachments/chosen.json' })).rejects.toThrow();
        await expect(decryptSyncArtifact(sealed, material.key, defaultSyncCryptoPrimitives,
            { kind: 'recovery', artifactName: 'other-archive' })).rejects.toThrow();
        expect(await decryptSyncArtifact(sealed, material.key, defaultSyncCryptoPrimitives,
            { kind: 'recovery', artifactName: 'opaque-archive' })).toEqual(plaintext);
    });

    it('refuses a legacy header-only ciphertext before document parsing', async () => {
        const header = new Uint8Array(54);
        header.set(new TextEncoder().encode('MWENC1'));
        header[6] = 1;
        header[7] = 1;
        header[8] = 64;
        header[12] = 1;
        header[16] = 1;
        header[17] = 1;
        header.set(material.salt, 18);
        const nonce = new Uint8Array(12).fill(2);
        header.set(nonce, 34);
        new DataView(header.buffer).setBigUint64(46, BigInt(plaintext.length + 16), true);
        const sealed = await defaultSyncCryptoPrimitives.aesGcmSeal(material.key, nonce, plaintext, header);
        const legacy = new Uint8Array(54 + sealed.length);
        legacy.set(header);
        legacy.set(sealed, 54);
        await expect(webdavGetSyncDocument('https://audit.invalid/data.json', {
            material,
            fetcher: async () => new Response(legacy.slice().buffer, { headers: { etag: '"audit"' } }),
        })).rejects.toThrow(/legacy|upgrade/i);
    });
});
