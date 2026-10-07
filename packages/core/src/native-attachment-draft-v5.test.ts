import { describe, expect, it, vi } from 'vitest';
import { prepareNativeAttachmentDraftAvailability, readNativeAttachmentDraftAvailabilityFrozen,
    validateNativeAttachmentDraftBegin, validateNativeAttachmentDraftBeginV2,
    validateNativeAttachmentDraftBeginV3, validateNativeAttachmentDraftBeginV4, validateNativeAttachmentDraftBeginV5,
    validateNativeAttachmentDraftLineage, validateNativeAttachmentDraftLineageV2,
    validateNativeAttachmentDraftLineageV3, validateNativeAttachmentDraftLineageV4, validateNativeAttachmentDraftLineageV5,
    prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftRemoveV3,
    type NativeAttachmentDraftAvailabilityPrepared, type NativeAttachmentDraftLineageInputV5,
    type NativeAttachmentDraftOperationV5 } from './native-attachment-draft';
import { getAttachmentDownloadIdentity } from './mobile-attachment-availability';
import type { Attachment } from './types';

const AT = '2026-10-07T00:00:00.000Z', LATER = '2026-10-07T01:00:00.000Z';
const ROOT = 'file:///owned/documents/attachments/', HASH = 'a'.repeat(64);
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const file: Attachment = { id: 'saved-file', kind: 'file', title: 'Current file.pdf', uri: 'files/attachments/saved-file.pdf',
    cloudKey: 'attachments/saved-file.pdf', contentRev: 7, mimeType: 'application/pdf', size: 17,
    createdAt: AT, updatedAt: AT, localStatus: 'missing' };
const link: Attachment = { id: 'saved-link', kind: 'link', title: 'Link', uri: 'https://example.test/', createdAt: AT, updatedAt: AT };
const other: Attachment = { ...file, id: 'other-file', cloudKey: 'attachments/other-file.pdf', fileHash: 'b'.repeat(64) };
const ports = () => ({ assertEditable: vi.fn(), t: (key: string) => key });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opening = () => JSON.stringify({ version: 2, taskID: 'task', attachmentsOwned: true,
    attachmentsBase: [file, link, other], attachments: [file, link, other], raw: { note: 'Opening @literal', opaque: ['保留', false, null] } });
const edit = (encoded: string, patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(encoded), ...patch });
const lineage = (beforePayloadJSON = opening(), priorOperations: NativeAttachmentDraftOperationV5[] = [], initialPayloadJSON = opening()):
NativeAttachmentDraftLineageInputV5 => ({ version: 5, taskID: 'task', initialPayloadJSON, beforePayloadJSON,
    priorOperations, managedDirectoryURI: ROOT });
const tagged = (operation: NativeAttachmentDraftAvailabilityPrepared): NativeAttachmentDraftOperationV5 => ({ kind: 'availability', operation });
function outcome(beforePayloadJSON = opening(), requestId = id(1), status: 'available' | 'unrecoverable' = 'available',
    attachmentId = file.id, targetURI = ROOT + attachmentId + '.pdf') {
    const current: Attachment = JSON.parse(beforePayloadJSON).attachments.find((row: Attachment) => row.id === attachmentId);
    const resolved: Attachment = status === 'available'
        ? { ...current, uri: targetURI, localStatus: 'available', fileHash: current.fileHash ?? HASH }
        : { ...current, cloudKey: undefined, fileHash: undefined, localStatus: 'missing', deletedAt: LATER, updatedAt: LATER };
    return prepareNativeAttachmentDraftAvailability({ version: 1, taskID: JSON.parse(beforePayloadJSON).taskID,
        requestId, attachmentId, identity: getAttachmentDownloadIdentity(current), beforePayloadJSON,
        status, resolvedAttachmentJSON: JSON.stringify(resolved) });
}

describe('selected V5 availability-only lineage', () => {
    it('accepts available→ordinary input/link edits→terminal with exact base, order and final raw checkpoint', () => {
        const initial = opening(), first = outcome(initial), rows: Attachment[] = JSON.parse(first.afterPayloadJSON).attachments;
        rows[1] = { ...link, title: 'Edited link', uri: 'https://example.test/edited', updatedAt: LATER };
        const before = ` \n${edit(first.afterPayloadJSON, { attachments: rows,
            raw: { note: 'Draft e\u0301 @literal', tokens: '#pending, ', checklistInputs: { 0: 'unfinished' }, opaque: ['保留', false, null] },
            edited: { title: 'Dirty title', description: 'Dirty notes' }, checklistValue: [{ id: 'check', title: 'Draft', isCompleted: false }] })}\n`;
        const terminal = outcome(before, id(2), 'unrecoverable');
        const latest = ` \n${edit(terminal.afterPayloadJSON, { raw: { note: 'Last @unfinished', opaque: { keep: true } } })}\n`;
        const operations = [tagged(first), tagged(terminal)], frozen = JSON.stringify(operations);
        const result = validateNativeAttachmentDraftLineageV5(lineage(latest, operations, initial));
        expect(result).toEqual({ version: 5, taskID: 'task', payloadJSON: latest });
        expect(Object.isFrozen(result)).toBe(true);
        expect(JSON.stringify(operations)).toBe(frozen);
        expect(terminal.beforePayloadJSON).toBe(before);
        const after = JSON.parse(terminal.afterPayloadJSON);
        expect(after.attachmentsBase).toEqual([file, link, other]);
        expect(after.raw).toEqual(JSON.parse(before).raw);
        expect(after.attachments.map((row: Attachment) => row.id)).toEqual([file.id, link.id, other.id]);
        expect(after.attachments[0]).not.toHaveProperty('cloudKey');
        expect(after.attachments[0]).not.toHaveProperty('fileHash');
        expect(after.attachments[0]).toMatchObject({ uri: ROOT + file.id + '.pdf', deletedAt: LATER, updatedAt: LATER });
        expect(after.attachments[1]).toEqual(rows[1]); expect(after.attachments[2]).toEqual(other);
    });

    it('uses the existing editable Begin policy and permits empty histories with ordinary link/raw changes', () => {
        const initial = opening(), rows: Attachment[] = JSON.parse(initial).attachments;
        rows[1] = { ...link, title: 'Edited before Begin', uri: 'https://example.test/begin', updatedAt: LATER };
        rows.push({ ...link, id: id(20), title: 'New link', uri: 'https://example.test/new' });
        const payloadJSON = ` \n${edit(initial, { attachments: rows, raw: { notes: 'Unfinished @input' } })}\n`, deps = ports();
        expect(validateNativeAttachmentDraftBeginV5({ taskID: 'task', payloadJSON }, deps))
            .toEqual({ version: 5, taskID: 'task', payloadJSON });
        expect(deps.assertEditable).toHaveBeenCalledExactlyOnceWith('task');
        expect(validateNativeAttachmentDraftLineageV5(lineage(payloadJSON, [], payloadJSON))).toEqual({ version: 5, taskID: 'task', payloadJSON });
        expect(() => validateNativeAttachmentDraftBeginV5({ taskID: 'task', payloadJSON }, {
            ...ports(), assertEditable: () => { throw new Error('Not editable'); } })).toThrow('Not editable');
    });

    it('rejects a duplicate request UUID even when both standalone proofs are valid', () => {
        const first = outcome(), second = outcome(first.afterPayloadJSON, first.requestId, 'available', other.id);
        expect(readNativeAttachmentDraftAvailabilityFrozen(copy(second))).toEqual(second);
        expect(() => validateNativeAttachmentDraftLineageV5(lineage(second.afterPayloadJSON, [tagged(first), tagged(second)])))
            .toThrow('INVALID_INPUT');
    });

    it.each(['initial', 'between', 'final'])('rejects a forged file gap at %s while inner proofs remain valid', (position) => {
        const initial = opening(), first = outcome(initial);
        const drift = (encoded: string) => {
            const value = JSON.parse(encoded); value.attachments[0].title = 'Unproved file edit'; return JSON.stringify(value);
        };
        if (position === 'initial') {
            const changed = drift(initial), proof = outcome(changed);
            expect(readNativeAttachmentDraftAvailabilityFrozen(proof)).toEqual(proof);
            expect(() => validateNativeAttachmentDraftBeginV5({ taskID: 'task', payloadJSON: changed }, ports())).toThrow('INVALID_INPUT');
            expect(() => validateNativeAttachmentDraftLineageV5(lineage(proof.afterPayloadJSON, [tagged(proof)], changed))).toThrow('INVALID_INPUT');
        } else if (position === 'between') {
            const second = outcome(drift(first.afterPayloadJSON), id(2), 'available', other.id);
            expect(readNativeAttachmentDraftAvailabilityFrozen(second)).toEqual(second);
            expect(() => validateNativeAttachmentDraftLineageV5(lineage(second.afterPayloadJSON, [tagged(first), tagged(second)], initial))).toThrow('INVALID_INPUT');
        } else expect(() => validateNativeAttachmentDraftLineageV5(lineage(drift(first.afterPayloadJSON), [tagged(first)], initial))).toThrow('INVALID_INPUT');
    });

    it('binds the operation Task and original attachment base, and invokes the existing inner reader', () => {
        const initial = opening(), first = outcome(initial);
        const foreignBefore = edit(first.afterPayloadJSON, { taskID: 'other-task' }), foreign = outcome(foreignBefore, id(2), 'available', other.id);
        expect(readNativeAttachmentDraftAvailabilityFrozen(foreign)).toEqual(foreign);
        expect(() => validateNativeAttachmentDraftLineageV5(lineage(first.afterPayloadJSON, [tagged(foreign)], initial))).toThrow('INVALID_INPUT');
        const changed = JSON.parse(first.afterPayloadJSON); changed.attachmentsBase[0].title = 'Different opening';
        const second = outcome(JSON.stringify(changed), id(2), 'available', other.id);
        expect(readNativeAttachmentDraftAvailabilityFrozen(second)).toEqual(second);
        expect(() => validateNativeAttachmentDraftLineageV5(lineage(second.afterPayloadJSON, [tagged(first), tagged(second)], initial))).toThrow('INVALID_INPUT');
        const forged = { ...first, afterPayloadJSON: edit(first.afterPayloadJSON, { raw: { note: 'Changed inside proof' } }) };
        expect(() => validateNativeAttachmentDraftLineageV5(lineage(forged.afterPayloadJSON, [tagged(forged)], initial))).toThrow('INVALID_INPUT');
        const changedFinalBase = edit(first.afterPayloadJSON, { attachmentsBase: [other, link, file] });
        expect(() => validateNativeAttachmentDraftLineageV5(lineage(changedFinalBase, [tagged(first)], initial))).toThrow('INVALID_INPUT');
    });

    it('rejects real historical Add/Remove proofs and all historical history versions', async () => {
        const historical = { ...lineage(), version: 3, priorOperations: [] }, deps = ports();
        const added = await prepareNativeAttachmentDraftAddV3({ ...historical, requestId: id(3),
            picked: { uri: 'file:///cache/picked.pdf', name: 'Picked.pdf', mimeType: null, size: null }, measuredSize: 3 }, deps);
        expect(added.kind).toBe('prepared');
        if (added.kind !== 'prepared') throw Error('Fixture refused');
        const removed = prepareNativeAttachmentDraftRemoveV3({ ...historical, requestId: id(4), attachmentId: file.id }, deps);
        for (const entry of [{ kind: 'add', operation: added }, { kind: 'remove', operation: removed },
            { kind: 'availability', operation: added }, { kind: 'availability', operation: removed }]) {
            expect(() => validateNativeAttachmentDraftLineageV5({ ...lineage(), priorOperations: [entry] })).toThrow('INVALID_INPUT');
        }
        for (const version of [1, 2, 3, 4]) expect(() => validateNativeAttachmentDraftLineageV5({ ...lineage(), version })).toThrow('INVALID_INPUT');
    });

    it('keeps all prior empty lineage/Begin controls sealed against V5 and availability', () => {
        const initial = opening(), first = outcome(initial);
        for (const [version, reader] of [[1, validateNativeAttachmentDraftLineage], [2, validateNativeAttachmentDraftLineageV2]] as const) {
            expect(reader({ version, taskID: 'task', initialPayloadJSON: initial, beforePayloadJSON: initial,
                managedDirectoryURI: ROOT, priorAdditions: [] }).version).toBe(version);
            expect(() => reader(lineage(first.afterPayloadJSON, [tagged(first)], initial))).toThrow('INVALID_INPUT');
        }
        for (const [version, reader] of [[3, validateNativeAttachmentDraftLineageV3], [4, validateNativeAttachmentDraftLineageV4]] as const) {
            expect(reader({ ...lineage(), version }).version).toBe(version);
            expect(() => reader(lineage(first.afterPayloadJSON, [tagged(first)], initial))).toThrow('INVALID_INPUT');
            expect(() => reader({ ...lineage(first.afterPayloadJSON, [tagged(first)], initial), version })).toThrow('INVALID_INPUT');
        }
        for (const [version, begin] of [[1, validateNativeAttachmentDraftBegin], [2, validateNativeAttachmentDraftBeginV2],
            [3, validateNativeAttachmentDraftBeginV3], [4, validateNativeAttachmentDraftBeginV4]] as const) {
            expect(begin({ taskID: 'task', payloadJSON: initial }, ports()).version).toBe(version);
            expect(() => begin({ version: 5, taskID: 'task', payloadJSON: initial }, ports())).toThrow('INVALID_INPUT');
        }
    });

    it('isolates the 128/129 count cap using valid unique proofs and a complete history below the byte cap', () => {
        const initial = opening(), operations: NativeAttachmentDraftOperationV5[] = []; let before = initial;
        for (let n = 1; n <= 129; n++) {
            const proof = outcome(before, id(n), 'available', file.id, ROOT + `generation-${n}.pdf`);
            operations.push(tagged(proof)); before = proof.afterPayloadJSON;
        }
        expect(Buffer.byteLength(JSON.stringify(lineage(before, operations, initial)))).toBeLessThan(8 * 1024 * 1024);
        expect(readNativeAttachmentDraftAvailabilityFrozen(operations[128].operation)).toEqual(operations[128].operation);
        expect(validateNativeAttachmentDraftLineageV5(lineage(operations[127].operation.afterPayloadJSON, operations.slice(0, 128), initial)).version).toBe(5);
        expect(() => validateNativeAttachmentDraftLineageV5(lineage(before, operations, initial))).toThrow('INVALID_INPUT');
    });

    it('bounds actual escaped aggregate bytes independently of operation count and per-proof caps', () => {
        const initial = edit(opening(), { raw: { note: '"'.repeat(80_000) } }), operations: NativeAttachmentDraftOperationV5[] = [];
        let before = initial;
        for (let n = 1; n <= 14; n++) {
            const proof = outcome(before, id(n), 'available', file.id, ROOT + `generation-${n}.pdf`);
            expect(Buffer.byteLength(JSON.stringify(tagged(proof)))).toBeLessThan(2 * 1024 * 1024);
            operations.push(tagged(proof)); before = proof.afterPayloadJSON;
        }
        const short = lineage(operations[7].operation.afterPayloadJSON, operations.slice(0, 8), initial);
        expect(Buffer.byteLength(JSON.stringify(short))).toBeLessThan(8 * 1024 * 1024);
        expect(validateNativeAttachmentDraftLineageV5(short).version).toBe(5);
        const oversized = lineage(before, operations, initial);
        expect(operations.length).toBeLessThan(128);
        expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(8 * 1024 * 1024);
        expect(() => validateNativeAttachmentDraftLineageV5(oversized)).toThrow('INVALID_INPUT');
    });

    it('rejects malformed exact descriptors without invoking getters or custom array behavior', () => {
        const proof = outcome(), entry = tagged(proof), accessor = vi.fn(() => { throw Error('Getter invoked'); });
        const root = { ...lineage() }; Object.defineProperty(root, 'priorOperations', { enumerable: true, get: accessor });
        expect(() => validateNativeAttachmentDraftLineageV5(root)).toThrow('INVALID_INPUT');
        const badEntry = { ...entry }; Object.defineProperty(badEntry, 'operation', { enumerable: true, get: accessor });
        expect(() => validateNativeAttachmentDraftLineageV5({ ...lineage(), priorOperations: [badEntry] })).toThrow('INVALID_INPUT');
        const slots: unknown[] = [entry]; Object.defineProperty(slots, '0', { enumerable: true, get: accessor });
        expect(() => validateNativeAttachmentDraftLineageV5({ ...lineage(), priorOperations: slots })).toThrow('INVALID_INPUT');
        expect(accessor).not.toHaveBeenCalled();
        const extra = [entry] as unknown[] & { extra?: boolean }; extra.extra = true;
        for (const operations of [new Array(1), extra, [{ ...entry, extra: true }], [{ kind: 'availability' }]]) {
            expect(() => validateNativeAttachmentDraftLineageV5({ ...lineage(), priorOperations: operations })).toThrow('INVALID_INPUT');
        }
        for (const patch of [{ extra: true }, { taskID: '' }, { managedDirectoryURI: 'https://example.test/' }, { version: 6 }]) {
            expect(() => validateNativeAttachmentDraftLineageV5({ ...lineage(), ...patch })).toThrow('INVALID_INPUT');
        }
    });
});
