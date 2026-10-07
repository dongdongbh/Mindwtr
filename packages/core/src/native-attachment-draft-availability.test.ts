import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeAttachmentDraftAvailability, readNativeAttachmentDraftAvailabilityFrozen,
    readNativeAttachmentDraftFrozen, readNativeAttachmentDraftFrozenV2, readNativeAttachmentDraftRemoveFrozen,
    validateNativeAttachmentDraftLineage, validateNativeAttachmentDraftLineageV2,
    validateNativeAttachmentDraftLineageV3, validateNativeAttachmentDraftLineageV4,
    type NativeAttachmentDraftAvailabilityInput } from './native-attachment-draft';
import { getAttachmentAvailabilityPatch, getAttachmentDownloadIdentity } from './mobile-attachment-availability';
import { computeSha256Hex } from './attachment-hash';
import { createMobileAttachmentCommon } from './mobile-attachment-common';
import { createMobileAttachmentFiles } from './mobile-attachment-files';
import { readNativeAttachments } from './native-host-contract-attachments';
import { defaultSyncCryptoPrimitives } from './sync-crypto';
import { createMemoryFileSystem, createMemoryStorage, createRecordingLog, MANAGED } from './__fixtures__/mobile-attachment-fakes';
import type { Attachment } from './types';

const AT = '2026-10-07T00:00:00.000Z', LATER = '2026-10-07T01:00:00.000Z';
const ROOT = 'file:///owned/documents/attachments/', HASH = 'a'.repeat(64);
const REQUEST = '11111111-2222-4333-8444-555555555555';
const remote: Attachment = { id: 'synced-file', kind: 'file', title: 'Current title.pdf', uri: 'files/attachments/synced-file.pdf',
    mimeType: 'application/pdf', size: 17, createdAt: AT, updatedAt: AT, cloudKey: 'attachments/synced-file.pdf',
    contentRev: 7, contentSize: 17, contentMtimeMs: 100, pendingContentUpload: false, localStatus: 'missing' };
const link: Attachment = { id: 'link', kind: 'link', title: 'Keep link', uri: 'https://example.test/', createdAt: AT, updatedAt: AT };
const other: Attachment = { ...remote, id: 'other', uri: ROOT + 'other.pdf', fileHash: 'b'.repeat(64), localStatus: 'available' };
const tombstone: Attachment = { ...remote, id: 'deleted', deletedAt: AT };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opening = (selected = remote) => JSON.stringify({ version: 2, taskID: 'task', attachmentsOwned: true,
    attachmentsBase: [selected, link, tombstone, other], attachments: [link, selected, tombstone, other],
    touchedBase: { title: 'Saved title', description: null }, edited: { title: 'Dirty title', description: 'Draft note' },
    raw: { title: '  Dirty @title ', note: '保留\n@literal e\u0301', tokens: { contexts: '@literal, ', tags: '#pending' },
        checklistInputs: { '1': 'unfinished @input' }, falseValue: false, nullValue: null, opaque: [{ untouched: 'é' }, 4] },
    checklistBase: [], checklistValue: [{ id: 'check', title: 'Draft checklist', isCompleted: false }],
    scheduleEdits: [{ id: 'schedule', raw: 'tomorrow at' }], linkSheet: {} }, null, 2);
const available = (selected = remote): Attachment => ({ ...selected, title: 'Stale captured title', mimeType: 'application/x-stale',
    size: 999, updatedAt: LATER, uri: ROOT + 'synced-file.pdf', localStatus: 'available', fileHash: selected.fileHash ?? HASH });
const terminal = (selected = remote): Attachment => ({ ...selected, title: 'Stale captured title', uri: ROOT + 'stale.pdf',
    cloudKey: undefined, fileHash: undefined, localStatus: 'missing', deletedAt: LATER, updatedAt: LATER });
const input = (status: 'available' | 'unrecoverable' = 'available', selected = remote): NativeAttachmentDraftAvailabilityInput => ({
    version: 1, taskID: 'task', requestId: REQUEST, attachmentId: selected.id,
    identity: getAttachmentDownloadIdentity(selected), beforePayloadJSON: ` \n${opening(selected)}\n`, status,
    resolvedAttachmentJSON: JSON.stringify(status === 'available' ? available(selected) : terminal(selected)),
});

describe('selected metadata-only Task availability proof', () => {
    afterEach(() => vi.restoreAllMocks());

    it('adds only availability and an absent verified hash, preserving the complete dirty draft and row order', () => {
        const captured = input(), original = copy(captured);
        const proof = prepareNativeAttachmentDraftAvailability(captured);
        const before = JSON.parse(captured.beforePayloadJSON);
        expect(JSON.parse(proof.afterPayloadJSON)).toEqual({ ...before,
            attachments: [link, { ...remote, uri: ROOT + 'synced-file.pdf', localStatus: 'available', fileHash: HASH }, tombstone, other] });
        expect(proof.beforePayloadJSON).toBe(captured.beforePayloadJSON);
        expect(captured).toEqual(original);
        expect(Object.isFrozen(proof)).toBe(true);
        expect(readNativeAttachmentDraftAvailabilityFrozen(copy(proof))).toEqual(proof);
    });

    it('clears terminal cloudKey/fileHash through an actual frozen JSON round trip without overwriting descriptive fields', () => {
        const selected = { ...remote, fileHash: HASH }, captured = input('unrecoverable', selected);
        const proof = prepareNativeAttachmentDraftAvailability(captured);
        const wire = JSON.stringify(proof), cold = readNativeAttachmentDraftAvailabilityFrozen(JSON.parse(wire));
        const after = JSON.parse(cold.afterPayloadJSON), before = JSON.parse(captured.beforePayloadJSON);
        const expected = { ...selected, localStatus: 'missing', deletedAt: LATER, updatedAt: LATER } as Partial<Attachment>;
        delete expected.cloudKey; delete expected.fileHash;
        expect(after).toEqual({ ...before, attachments: [link, expected, tombstone, other] });
        expect(after.attachments[1]).not.toHaveProperty('cloudKey');
        expect(after.attachments[1]).not.toHaveProperty('fileHash');
        expect(after.attachments[1].uri).toBe(selected.uri);
        expect(after.attachmentsBase[0]).toEqual(selected);
        expect(JSON.stringify(cold)).toBe(wire);
    });

    it('replays captured outcome without fresh clock/UUID work or input mutation', () => {
        const proof = prepareNativeAttachmentDraftAvailability(input('unrecoverable', { ...remote, fileHash: HASH }));
        const wire = JSON.stringify(proof);
        const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Clock used'); });
        const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('UUID work used'); });
        expect(readNativeAttachmentDraftAvailabilityFrozen(JSON.parse(wire))).toEqual(proof);
        expect(now).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled();
        expect(JSON.stringify(proof)).toBe(wire);
    });

    it('retains a known hash and refuses changed immutable resolved identities', () => {
        const selected = { ...remote, fileHash: HASH }, captured = input('available', selected);
        const proof = prepareNativeAttachmentDraftAvailability(captured);
        expect(JSON.parse(proof.afterPayloadJSON).attachments[1].fileHash).toBe(HASH);
        for (const patch of [{ id: 'different' }, { kind: 'link' }, { contentRev: 8 }, { cloudKey: 'different' },
            { fileHash: 'b'.repeat(64) }, { fileHash: undefined }]) {
            expect(() => prepareNativeAttachmentDraftAvailability({ ...captured,
                resolvedAttachmentJSON: JSON.stringify({ ...available(selected), ...patch }) })).toThrow('INVALID_INPUT');
        }
    });

    it('accepts the common installer lowercase digest while preserving a known uppercase draft hash', async () => {
        const bytes = new TextEncoder().encode('abc'), digest = await computeSha256Hex(bytes);
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
        const selected = { ...remote, fileHash: digest!.toUpperCase() };
        expect(readNativeAttachments([selected])?.[0].fileHash).toBe(selected.fileHash);
        const memory = createMemoryFileSystem(), { log } = createRecordingLog();
        const files = createMobileAttachmentFiles({ fs: memory.fs, storage: createMemoryStorage().storage,
            getSecureConfigValue: async () => null, log, fetch: vi.fn() as unknown as typeof fetch,
            dropboxAuth: { getValidAccessToken: async () => '', forceRefreshAccessToken: async () => '' },
            core: { isSandboxMode: () => false } });
        const install = vi.fn(async (staged: string, target: string) => {
            await memory.fs.move(staged, target); return { status: 'installed' as const };
        });
        const common = createMobileAttachmentCommon({ fs: memory.fs, files, crypto: defaultSyncCryptoPrimitives,
            encryption: { logSyncEncryptionEvent: async () => undefined },
            installer: { installAttachmentFileGeneration: install }, installerMayBeMissing: () => false,
            timersPaused: () => false, uploads: { createUploadTask: () => null } });
        const target = MANAGED + 'synced-file.pdf', downloaded = copy(selected);
        await expect(common.installAttachmentDownloadBytes(downloaded, MANAGED, target, bytes, { kind: 'absent' }))
            .resolves.toBe(true);
        expect(install).toHaveBeenCalledOnce();
        expect(install.mock.calls[0]).toEqual([expect.any(String), target, { kind: 'absent' }, digest]);
        expect(memory.read(target)).toEqual(bytes);
        expect(downloaded.fileHash).toBe(digest);
        const resolved: Attachment = { ...downloaded, uri: target, localStatus: 'available' };
        const patch = getAttachmentAvailabilityPatch(selected, resolved);
        expect(patch).not.toHaveProperty('fileHash');
        const captured = { ...input('available', selected), resolvedAttachmentJSON: JSON.stringify(resolved) };
        const proof = prepareNativeAttachmentDraftAvailability(captured);
        const after = JSON.parse(proof.afterPayloadJSON), before = JSON.parse(captured.beforePayloadJSON);
        expect(after).toEqual({ ...before, attachments: [link, { ...selected, ...patch }, tombstone, other] });
        expect(selected.fileHash).toBe(digest!.toUpperCase());
        expect(readNativeAttachmentDraftAvailabilityFrozen(copy(proof))).toEqual(proof);
        expect(() => prepareNativeAttachmentDraftAvailability({ ...captured,
            identity: getAttachmentDownloadIdentity({ ...selected, fileHash: digest! }) })).toThrow('INVALID_INPUT');
        after.attachments[1].fileHash = digest;
        expect(() => readNativeAttachmentDraftAvailabilityFrozen({ ...proof, afterPayloadJSON: JSON.stringify(after) }))
            .toThrow('INVALID_INPUT');
    });

    it('keeps non-SHA hash agreement exact instead of normalizing legacy strings', () => {
        for (const hash of ['legacy-hash', ` ${HASH}`, `${HASH} `]) {
            const selected = { ...remote, fileHash: hash }, captured = input('available', selected);
            expect(JSON.parse(prepareNativeAttachmentDraftAvailability(captured).afterPayloadJSON).attachments[1].fileHash)
                .toBe(hash);
            for (const changed of [hash.toUpperCase(), HASH, undefined]) {
                expect(() => prepareNativeAttachmentDraftAvailability({ ...captured,
                    resolvedAttachmentJSON: JSON.stringify({ ...available(selected), fileHash: changed }) })).toThrow('INVALID_INPUT');
            }
        }
    });

    it.each(['raw', 'base', 'order', 'other', 'description', 'extra', 'selected', 'whitespace'])(
        'refuses forged after-payload %s changes', (mode) => {
            const proof = prepareNativeAttachmentDraftAvailability(input()), after = JSON.parse(proof.afterPayloadJSON);
            if (mode === 'raw') after.raw.note = 'Changed raw buffer';
            else if (mode === 'base') after.attachmentsBase[0].localStatus = 'available';
            else if (mode === 'order') after.attachments.reverse();
            else if (mode === 'other') after.attachments[3].title = 'Changed other file';
            else if (mode === 'description') after.edited.description = 'Changed note';
            else if (mode === 'extra') after.attachments.push({ ...other, id: 'extra-file' });
            else if (mode === 'selected') after.attachments[1].title = 'Changed selected title';
            const afterPayloadJSON = mode === 'whitespace' ? ` ${proof.afterPayloadJSON}` : JSON.stringify(after);
            expect(() => readNativeAttachmentDraftAvailabilityFrozen({ ...proof, afterPayloadJSON })).toThrow('INVALID_INPUT');
        });

    it('refuses missing, deleted or non-file current selection and a mismatched captured identity', () => {
        for (const selected of [{ ...remote, deletedAt: AT }, { ...remote, kind: 'link' as const }]) {
            expect(() => prepareNativeAttachmentDraftAvailability(input('available', selected))).toThrow('INVALID_INPUT');
        }
        expect(() => prepareNativeAttachmentDraftAvailability({ ...input(), attachmentId: 'absent' })).toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftAvailability({ ...input(), identity: getAttachmentDownloadIdentity({ ...remote, contentRev: 8 }) }))
            .toThrow('INVALID_INPUT');
        const proof = prepareNativeAttachmentDraftAvailability(input());
        expect(() => readNativeAttachmentDraftAvailabilityFrozen({ ...proof, identity: 'forged' })).toThrow('INVALID_INPUT');
        expect(() => readNativeAttachmentDraftAvailabilityFrozen({ ...proof, taskID: 'different-task' })).toThrow('INVALID_INPUT');
    });

    it('refuses malformed or incompatible available and terminal outcomes', () => {
        for (const patch of [{ localStatus: 'missing' }, { deletedAt: LATER }, { uri: '' }, { uri: 'https://example.test/file' },
            { fileHash: 'not-a-verified-sha256' }, { unexpected: true }]) {
            expect(() => prepareNativeAttachmentDraftAvailability({ ...input(),
                resolvedAttachmentJSON: JSON.stringify({ ...available(), ...patch }) })).toThrow('INVALID_INPUT');
        }
        for (const patch of [{ cloudKey: remote.cloudKey }, { fileHash: HASH }, { localStatus: 'available' },
            { deletedAt: undefined }, { deletedAt: 'not-a-date' }, { updatedAt: AT }, { contentRev: 8 }]) {
            expect(() => prepareNativeAttachmentDraftAvailability({ ...input('unrecoverable'),
                resolvedAttachmentJSON: JSON.stringify({ ...terminal(), ...patch }) })).toThrow('INVALID_INPUT');
        }
        expect(() => prepareNativeAttachmentDraftAvailability({ ...input(), resolvedAttachmentJSON: '{' })).toThrow('INVALID_INPUT');
    });

    it('bounds exact scalar shape without invoking caller accessors', () => {
        for (const patch of [{ version: 2 }, { status: 'unavailable' }, { status: 'generation-conflict' }, { status: 'stale' },
            { requestId: null }, { requestId: REQUEST.toUpperCase().replace('11111111', 'AAAAAAAA') }, { attachmentId: '' },
            { identity: '' }, { resolvedAttachmentJSON: available() }, { extra: true }]) {
            expect(() => prepareNativeAttachmentDraftAvailability({ ...input(), ...patch })).toThrow('INVALID_INPUT');
        }
        const accessor = vi.fn(() => { throw Error('Accessor invoked'); }), value = { ...input() };
        Object.defineProperty(value, 'status', { enumerable: true, get: accessor });
        expect(() => prepareNativeAttachmentDraftAvailability(value)).toThrow('INVALID_INPUT');
        expect(accessor).not.toHaveBeenCalled();
        const proof = prepareNativeAttachmentDraftAvailability(input());
        expect(() => readNativeAttachmentDraftAvailabilityFrozen({ ...proof, kind: 'prepared-file-remove' })).toThrow('INVALID_INPUT');
        const missing = { ...proof } as Record<string, unknown>; delete missing.resolvedAttachmentJSON;
        expect(() => readNativeAttachmentDraftAvailabilityFrozen(missing)).toThrow('INVALID_INPUT');
    });

    it('enforces payload UTF-8 and whole escaped proof byte caps', () => {
        const captured = input(), before = JSON.parse(captured.beforePayloadJSON);
        before.raw.note = '保'.repeat(334_000);
        const oversized = JSON.stringify(before);
        expect(oversized.length).toBeLessThan(1_000_000);
        expect(Buffer.byteLength(oversized)).toBeGreaterThan(1_000_000);
        expect(() => prepareNativeAttachmentDraftAvailability({ ...captured, beforePayloadJSON: oversized })).toThrow('INVALID_INPUT');
        before.raw.note = '"'.repeat(490_000);
        const escaped = JSON.stringify(before);
        expect(Buffer.byteLength(escaped)).toBeLessThan(1_000_000);
        // Each embedded payload is escaped again in the frozen operation.
        expect(Buffer.byteLength(JSON.stringify({ beforePayloadJSON: escaped, afterPayloadJSON: escaped }))).toBeGreaterThan(2 * 1024 * 1024);
        expect(() => prepareNativeAttachmentDraftAvailability({ ...captured, beforePayloadJSON: escaped })).toThrow('INVALID_INPUT');
    });

    it('does not introduce an operation into any historical Add/Remove or lineage grammar', () => {
        const proof = prepareNativeAttachmentDraftAvailability(input());
        for (const reader of [readNativeAttachmentDraftFrozen, readNativeAttachmentDraftFrozenV2, readNativeAttachmentDraftRemoveFrozen]) {
            expect(() => reader(proof)).toThrow('INVALID_INPUT');
        }
        const beforePayloadJSON = opening();
        for (const [version, reader] of [[1, validateNativeAttachmentDraftLineage], [2, validateNativeAttachmentDraftLineageV2]] as const) {
            expect(() => reader({ version, taskID: 'task', initialPayloadJSON: beforePayloadJSON, beforePayloadJSON,
                managedDirectoryURI: ROOT, priorAdditions: [proof] })).toThrow('INVALID_INPUT');
        }
        for (const [version, reader] of [[3, validateNativeAttachmentDraftLineageV3], [4, validateNativeAttachmentDraftLineageV4]] as const) {
            expect(reader({ version, taskID: 'task', initialPayloadJSON: beforePayloadJSON, beforePayloadJSON,
                managedDirectoryURI: ROOT, priorOperations: [] }).version).toBe(version);
            expect(() => reader({ version, taskID: 'task', initialPayloadJSON: beforePayloadJSON, beforePayloadJSON,
                managedDirectoryURI: ROOT, priorOperations: [{ kind: 'availability', operation: proof }] })).toThrow('INVALID_INPUT');
        }
    });
});
