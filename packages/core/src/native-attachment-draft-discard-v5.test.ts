import { describe, expect, it } from 'vitest';
import { prepareNativeAttachmentDraftAvailability, type NativeAttachmentDraftAvailabilityPrepared } from './native-attachment-draft';
import { prepareNativeAttachmentDraftDiscardCandidates, prepareNativeAttachmentDraftDiscardCandidatesV3,
    prepareNativeAttachmentDraftDiscardCandidatesV4, prepareNativeAttachmentDraftDiscardCandidatesV5,
    type NativeAttachmentDraftDiscardInputV5 } from './native-attachment-draft-discard';
import { getAttachmentDownloadIdentity } from './mobile-attachment-availability';
import type { Attachment } from './types';

const AT = '2026-10-07T00:00:00.000Z', LATER = '2026-10-07T01:00:00.000Z';
const ROOT = 'file:///owned/documents/attachments/', HASH = 'a'.repeat(64);
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const file: Attachment = { id: 'existing-file', kind: 'file', title: 'Existing file', uri: 'files/attachments/old.pdf',
    cloudKey: 'attachments/old.pdf', fileHash: HASH, contentRev: 7, size: 3, createdAt: AT, updatedAt: AT, localStatus: 'missing' };
const link: Attachment = { id: 'existing-link', kind: 'link', title: 'Link', uri: 'https://example.test/', createdAt: AT, updatedAt: AT };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opening = (attachments: Attachment[] = [file, link, { ...file, id: 'old-tombstone', deletedAt: AT }], note = 'Dirty @raw 🧪') => JSON.stringify({
    version: 2, taskID: 'task', attachmentsOwned: true, attachmentsBase: attachments, attachments,
    raw: { note, unresolved: ['保留', null, false] } });
function outcome(beforePayloadJSON = opening(), n = 1, status: 'available' | 'unrecoverable' = 'available', targetURI = ROOT + 'downloaded.pdf') {
    const selected: Attachment = JSON.parse(beforePayloadJSON).attachments.find((row: Attachment) => row.id === file.id);
    return prepareNativeAttachmentDraftAvailability({ version: 1, taskID: 'task', requestId: id(n), attachmentId: selected.id,
        identity: getAttachmentDownloadIdentity(selected), beforePayloadJSON, status,
        resolvedAttachmentJSON: JSON.stringify(status === 'available' ? { ...selected, uri: targetURI, localStatus: 'available' }
            : { ...selected, cloudKey: undefined, fileHash: undefined, localStatus: 'missing', deletedAt: LATER, updatedAt: LATER }) });
}
function input(operations: NativeAttachmentDraftAvailabilityPrepared[] = [outcome()], phase: 'intent' | 'checkpointed' = 'checkpointed',
    initialPayloadJSON = opening()): NativeAttachmentDraftDiscardInputV5 {
    const last = operations[operations.length - 1];
    return { version: 4, historyVersion: 5, taskID: 'task', managedDirectoryURI: ROOT, initialPayloadJSON,
        checkpointPayloadJSON: last ? phase === 'intent' ? last.beforePayloadJSON : last.afterPayloadJSON : initialPayloadJSON,
        operations: operations.map((operation, index) => ({ kind: 'availability', phase: index === operations.length - 1 ? phase : 'checkpointed',
            preparedJSON: JSON.stringify(operation) })) };
}
describe('Discard4/history5 availability candidates', () => {
    it('binds the same baseline attachment ID at a new URI to its distinct operation UUID', () => {
        const request = input(), frozen = JSON.stringify(request), result = prepareNativeAttachmentDraftDiscardCandidatesV5(request);
        expect(result).toEqual({ version: 4, kind: 'owned-availability-discard-candidates', taskID: 'task', historyVersion: 5,
            candidates: [{ requestId: id(1), attachmentId: file.id, targetURI: ROOT + 'downloaded.pdf', reason: 'uncommitted-draft' }] });
        expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.candidates)).toBe(true); expect(Object.isFrozen(result.candidates[0])).toBe(true);
        expect(JSON.stringify(request)).toBe(frozen); expect(result.candidates[0].requestId).not.toBe(file.id);
    });
    it('accepts the final intent only with the exact retained before-checkpoint', () => {
        const request = input([outcome()], 'intent');
        expect(prepareNativeAttachmentDraftDiscardCandidatesV5(request).candidates).toHaveLength(1);
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request, checkpointPayloadJSON: outcome().afterPayloadJSON })).toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request, checkpointPayloadJSON: request.checkpointPayloadJSON + ' ' })).toThrow('INVALID_INPUT');
    });
    it('never grants cleanup for baseline URIs, old baseline tombstones, empty or terminal-only history', () => {
        const terminal = outcome(opening(), 1, 'unrecoverable');
        expect(prepareNativeAttachmentDraftDiscardCandidatesV5(input([terminal])).candidates).toEqual([]);
        expect(prepareNativeAttachmentDraftDiscardCandidatesV5(input([])).candidates).toEqual([]);
        const initial = opening([{ ...file, uri: ROOT + 'baseline.pdf' }, link]);
        const unchanged = outcome(initial, 1, 'available', ROOT + 'baseline.pdf');
        expect(prepareNativeAttachmentDraftDiscardCandidatesV5(input([unchanged], 'checkpointed', initial)).candidates).toEqual([]);
    });
    it('uses the prior available proof when a later terminal mark clears metadata for its downloaded URI', () => {
        const available = outcome(), terminal = outcome(available.afterPayloadJSON, 2, 'unrecoverable');
        const result = prepareNativeAttachmentDraftDiscardCandidatesV5(input([available, terminal]));
        expect(result.candidates).toEqual([{ requestId: available.requestId, attachmentId: file.id, targetURI: ROOT + 'downloaded.pdf', reason: 'uncommitted-draft' }]);
        expect(result.candidates[0].requestId).not.toBe(terminal.requestId);
    });
    it('refuses repeated available proofs for the same candidate URI rather than choosing a retry generation', () => {
        const first = outcome(), retry = outcome(first.afterPayloadJSON, 2);
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(input([first, retry]))).toThrow('INVALID_INPUT');
        const second = outcome(first.afterPayloadJSON, 2, 'available', ROOT + 'second.pdf');
        expect(prepareNativeAttachmentDraftDiscardCandidatesV5(input([first, second])).candidates)
            .toEqual([{ requestId: id(2), attachmentId: file.id, targetURI: ROOT + 'second.pdf', reason: 'uncommitted-draft' }]);
    });
    it('refuses a new candidate aliasing another baseline file URI', () => {
        const initial = opening([file, { ...file, id: 'other', uri: ROOT + 'other.pdf', cloudKey: 'attachments/other.pdf' }, link]);
        const proof = outcome(initial, 1, 'available', ROOT + 'other.pdf');
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(input([proof], 'checkpointed', initial))).toThrow('INVALID_INPUT');
    });
    it('rejects unproved checkpoint file changes, forged inner proofs and foreign Task binding', () => {
        const request = input(), payload = JSON.parse(request.checkpointPayloadJSON); payload.attachments[0].uri = ROOT + 'unbound.pdf';
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request, checkpointPayloadJSON: JSON.stringify(payload) })).toThrow('INVALID_INPUT');
        const forged = clone(request), proof = JSON.parse(forged.operations[0].preparedJSON); proof.afterPayloadJSON = JSON.stringify(payload);
        forged.operations = [{ ...forged.operations[0], preparedJSON: JSON.stringify(proof) }];
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(forged)).toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request, taskID: 'other' })).toThrow('INVALID_INPUT');
    });
    it('preserves all historical numeric selectors and refuses crosswired phases and fields', () => {
        const request = input();
        for (const [version, historyVersion] of [[1, 2], [2, 3], [3, 4], [4, 4], [3, 5]])
            expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request, version, historyVersion })).toThrow('INVALID_INPUT');
        for (const reader of [prepareNativeAttachmentDraftDiscardCandidates, prepareNativeAttachmentDraftDiscardCandidatesV3, prepareNativeAttachmentDraftDiscardCandidatesV4])
            expect(() => reader(request)).toThrow('INVALID_INPUT');
        for (const phase of ['published', 'stageFilled', 'resultDurable']) expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request,
            operations: [{ ...request.operations[0], phase }] })).toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request, permission: true })).toThrow('INVALID_INPUT');
        const first = outcome(), second = outcome(first.afterPayloadJSON, 2, 'available', ROOT + 'second.pdf');
        const middleIntent = input([first, second]); middleIntent.operations = [{ ...middleIntent.operations[0], phase: 'intent' }, middleIntent.operations[1]];
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(middleIntent)).toThrow('INVALID_INPUT');
    });
    it('captures descriptors without evaluating getters or permitting sparse/aliased operation arrays', () => {
        const request = input(); let calls = 0;
        const getter = clone(request); Object.defineProperty(getter.operations[0], 'preparedJSON', { enumerable: true, get() { calls++; return request.operations[0].preparedJSON; } });
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(getter)).toThrow('INVALID_INPUT');
        const top = clone(request); Object.defineProperty(top, 'operations', { enumerable: true, get() { calls++; return request.operations; } });
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(top)).toThrow('INVALID_INPUT');
        const sparse = clone(request); sparse.operations = new Array(2);
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(sparse)).toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...request, operations: [request.operations[0], request.operations[0]] })).toThrow('INVALID_INPUT');
        expect(calls).toBe(0);
    });
    it('bounds valid escaped histories independently of the 128-operation count cap', () => {
        const initial = opening([file, link], '"'.repeat(70_000));
        const operations: NativeAttachmentDraftAvailabilityPrepared[] = []; let before = initial;
        for (let n = 1; n <= 20; n++) { const proof = outcome(before, n, 'available', ROOT + `generation-${n}.pdf`); operations.push(proof); before = proof.afterPayloadJSON; }
        const small = input(operations.slice(0, 3), 'checkpointed', initial);
        expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(8 * 1024 * 1024);
        expect(prepareNativeAttachmentDraftDiscardCandidatesV5(small).candidates[0].requestId).toBe(id(3));
        const large = input(operations, 'checkpointed', initial);
        expect(large.operations.length).toBeLessThan(128); expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(8 * 1024 * 1024);
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5(large)).toThrow('INVALID_INPUT');
        expect(() => prepareNativeAttachmentDraftDiscardCandidatesV5({ ...small, operations: Array.from({ length: 129 }, () => ({ ...small.operations[0] })) })).toThrow('INVALID_INPUT');
    });
});
