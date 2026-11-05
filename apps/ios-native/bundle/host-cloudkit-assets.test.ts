import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNativeCloudKitAssets, type NativeCloudKitTransportCall, type NativeCloudKitTransportRequest } from './host-cloudkit-assets';

const at = '2026-10-30T12:00:00.000Z';
const metadata = () => ({ attachmentId: 'asset-é', ownerType: 'task' as const, ownerId: 'legacy/😀', title: '\uFEFFSynthetic asset',
    updatedAt: at, mimeType: 'text/plain', size: 3, fileHash: 'abc', deletedAt: at });
const reply = (recordName = 'cloudkit-record') => ({ recordName, ...metadata() });
const fixture = (respond: (input: NativeCloudKitTransportRequest, signal?: AbortSignal) => string | Promise<string> = () => JSON.stringify(reply())) => {
    const calls: NativeCloudKitTransportRequest[] = [], signals: (AbortSignal | undefined)[] = [];
    const call: NativeCloudKitTransportCall = async (input, signal) => { calls.push(input); signals.push(signal); return respond(input, signal); };
    return { port: createNativeCloudKitAssets(call), calls, signals };
};
const polyfill = () => {
    const answers: string[] = [], calls: { id: string; input: unknown }[] = [], aborted: string[] = [];
    let sequence = 0;
    const context = vm.createContext({ __mindwtrNative: {
        nowMs: () => 0, log: () => {}, ioNext: () => answers.shift() ?? '',
        cloudKitCall: (raw: string) => { const id = 'cloud-' + ++sequence; calls.push({ id, input: JSON.parse(raw) }); return id; },
        cloudKitAbort: (id: string) => { aborted.push(id); },
        fileCall: () => 'file-1', installerCall: () => 'installer-1', fileAbort: (id: string) => { aborted.push(id); },
        calendarCall: () => 'calendar-1', calendarAbort: (id: string) => { aborted.push(id); },
    } });
    vm.runInContext(readFileSync(import.meta.dir + '/../../android-native/bundle/host-polyfills.js', 'utf8'), context);
    const call: NativeCloudKitTransportCall = vm.runInContext('__mindwtrCloudKitCall', context);
    return { call, calls, aborted, context,
        answer: (id: string, value: Record<string, unknown>) => { answers.push(JSON.stringify({ id, ...value })); },
        pump: () => vm.runInContext('__pumpTimers()', context),
    };
};

describe('native CloudKit attachment asset transport', () => {
    it('uses exact requests and typed metadata without filesystem or path rewriting', async () => {
        const f = fixture(), controller = new AbortController();
        expect(await f.port.saveAttachmentAsset('cloudkit-record', 'file:///owned/stage', metadata(), { signal: controller.signal })).toEqual(metadata());
        expect(await f.port.fetchAttachmentAsset('cloudkit-record', 'file:///owned/download', { signal: controller.signal })).toEqual(metadata());
        expect(f.calls.map((input) => input.op === 'saveAttachmentAsset' ? { ...input, metadataJSON: JSON.parse(input.metadataJSON) } : input)).toEqual([
            { op: 'saveAttachmentAsset', recordName: 'cloudkit-record', filePath: 'file:///owned/stage', metadataJSON: metadata() },
            { op: 'fetchAttachmentAsset', recordName: 'cloudkit-record', targetPath: 'file:///owned/download' },
        ]);
        expect(f.signals).toEqual([controller.signal, controller.signal]);
        const oldPath = fixture(() => JSON.stringify({ ...reply(), filePath: 'file:///owned/download' }));
        expect(await oldPath.port.fetchAttachmentAsset('cloudkit-record', 'file:///owned/download')).toEqual(metadata());
    });

    it('deletes only attachment records and accepts only literal null for void', async () => {
        const f = fixture(() => 'null'); await f.port.deleteAttachmentAssets(['é', 'e\u0301']);
        expect(f.calls).toEqual([{ op: 'deleteRecords', recordType: 'MindwtrAttachment', recordIDs: ['é', 'e\u0301'] }]);
        for (const bad of ['false', '{}', '[]', '"null"']) await expect(fixture(() => bad).port.deleteAttachmentAssets(['asset'])).rejects.toThrow('invalid');
    });

    it('rejects incomplete, wrong-source or unknown metadata and oversized replies', async () => {
        for (const value of [null, [], {}, { ...reply(), recordName: 'other' }, { ...reply(), ownerType: 'area' },
            { ...reply(), attachmentId: '' }, { ...reply(), ownerId: 7 }, { ...reply(), title: 1 },
            { ...reply(), updatedAt: 'invalid' }, { ...reply(), mimeType: false }, { ...reply(), fileHash: 1 },
            { ...reply(), size: -1 }, { ...reply(), size: 0.5 }, { ...reply(), deletedAt: 'invalid' }, { ...reply(), extra: true }]) {
            await expect(fixture(() => JSON.stringify(value)).port.fetchAttachmentAsset('cloudkit-record', '/owned/stage')).rejects.toThrow('invalid');
        }
        await expect(fixture(() => '{').port.fetchAttachmentAsset('cloudkit-record', '/owned/stage')).rejects.toThrow();
        await expect(fixture(() => ' '.repeat(16 * 1024 * 1024 + 1)).port.fetchAttachmentAsset('cloudkit-record', '/owned/stage')).rejects.toThrow('invalid');
    });

    it('validates all upload metadata and request bytes before native entry', async () => {
        const f = fixture();
        await expect(f.port.saveAttachmentAsset('', '/owned/stage', metadata())).rejects.toThrow('invalid');
        await expect(f.port.saveAttachmentAsset('record', '/owned/stage', { ...metadata(), size: NaN })).rejects.toThrow('invalid');
        await expect(f.port.saveAttachmentAsset('record', '/owned/stage', { ...metadata(), title: '😀'.repeat(4 * 1024 * 1024) })).rejects.toThrow('invalid');
        await expect(f.port.deleteAttachmentAssets(['duplicate', 'duplicate'])).rejects.toThrow('invalid');
        await expect(f.port.deleteAttachmentAssets(['x'.repeat(4097)])).rejects.toThrow('invalid');
        expect(f.calls).toEqual([]);
    });

    it('refuses cancellation before entry or after completion and retains the exact signal/reason', async () => {
        const controller = new AbortController(), reason = new Error('retired'); controller.abort(reason);
        const f = fixture();
        await expect(f.port.saveAttachmentAsset('record', '/owned', metadata(), { signal: controller.signal })).rejects.toBe(reason);
        await expect(f.port.fetchAttachmentAsset('record', '/owned', { signal: controller.signal })).rejects.toBe(reason);
        await expect(f.port.deleteAttachmentAssets(['record'], { signal: controller.signal })).rejects.toBe(reason);
        expect(f.calls).toEqual([]);
        const active = new AbortController(), held = fixture((_input, signal) => {
            expect(signal).toBe(active.signal); active.abort(reason); return JSON.stringify(reply());
        });
        await expect(held.port.fetchAttachmentAsset('cloudkit-record', '/owned', { signal: active.signal })).rejects.toBe(reason);
    });

    it('classifies not-found by the exact typed code alone', () => {
        const f = fixture();
        expect(f.port.isAttachmentNotFoundError(Object.assign(new Error('fixed'), { code: 'ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND' }))).toBe(true);
        for (const value of [null, 'ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND', new Error('Attachment not found'), { code: 'ENOENT' },
            { code: 'ERR_CLOUDKIT_ZONE_GONE' }, { message: 'ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND' }]) expect(f.port.isAttachmentNotFoundError(value)).toBe(false);
    });

    it('uses the actual polyfill IO queue and preserves stable errors/retry delay', async () => {
        const f = polyfill(), port = createNativeCloudKitAssets(f.call);
        const pending = port.fetchAttachmentAsset('cloudkit-record', '/owned/stage');
        expect(f.calls[0].input).toEqual({ op: 'fetchAttachmentAsset', recordName: 'cloudkit-record', targetPath: '/owned/stage' });
        f.answer('cloud-1', { value: JSON.stringify(reply()) }); f.pump(); expect(await pending).toEqual(metadata());
        const denied = port.fetchAttachmentAsset('cloudkit-record', '/owned/stage');
        f.answer('cloud-2', { error: 'Fixed failure', code: 'ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND', retryAfterSeconds: 7 }); f.pump();
        try { await denied; throw new Error('Must refuse'); } catch (error) {
            expect(error).toHaveProperty('code', 'ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND');
            expect(error).toHaveProperty('retryAfterSeconds', 7); expect(port.isAttachmentNotFoundError(error)).toBe(true);
        }
        expect(f.aborted).toEqual([]);
    });

    it('aborts the selected native IO once and suppresses late completion without affecting the next call', async () => {
        const f = polyfill(), controller = new AbortController(), reason = new Error('retired');
        const pending = f.call({ op: 'ensureZone' }, controller.signal); controller.abort(reason); controller.abort(reason);
        await expect(pending).rejects.toBe(reason); expect(f.aborted).toEqual(['cloud-1']);
        f.answer('cloud-1', { value: 'null' }); f.pump();
        const next = f.call({ op: 'ensureZone' }); f.answer('cloud-2', { value: 'null' }); f.pump(); expect(await next).toBe('null');
        const count = f.calls.length; await expect(f.call({ op: 'ensureZone' }, controller.signal)).rejects.toBe(reason);
        expect(f.calls).toHaveLength(count);
    });

    it('handles cancellation during native admission and keeps file/calendar callers compatible', async () => {
        const f = polyfill();
        vm.runInContext(`var selected = new AbortController();
            __mindwtrNative.cloudKitCall = function () { selected.abort('retired-during-admission'); return 'cloud-race'; };
            var raced = __mindwtrCloudKitCall({op:'ensureZone'}, selected.signal);`, f.context);
        const raced: Promise<unknown> = vm.runInContext('raced', f.context);
        await expect(raced).rejects.toBe('retired-during-admission'); expect(f.aborted).toEqual(['cloud-race']);
        const file: Promise<unknown> = vm.runInContext("__mindwtrFileCall({op:'getInfo'})", f.context);
        const calendar: Promise<unknown> = vm.runInContext("__mindwtrCalendarCall({op:'permissions'})", f.context);
        f.answer('file-1', { value: { exists: false } }); f.answer('calendar-1', { value: { status: 'granted' } }); f.pump();
        expect(await file).toEqual({ exists: false }); expect(await calendar).toEqual({ status: 'granted' });
    });
});
