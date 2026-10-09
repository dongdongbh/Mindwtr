import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    iosPruneReceipts(rawRetentionJSON: string): string {');
const end = entry.indexOf('    /** `name` is one of AI_REQUESTS;', start);
if (start < 0 || end < 0) throw new Error('Private receipt retention bridge unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);
const id = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
const fixture = (platform = 'ios', failLog = false) => {
    const calls: unknown[][] = [], logs: unknown[] = [];
    const state = { TextEncoder, __mindwtrHostPlatform: platform, port: undefined as unknown as {
        iosPruneReceipts(raw: string): Promise<{ pruned: number }>;
    }, sqlite: {}, submit: (work: () => Promise<unknown>) => work(),
    pruneNativeRequestReceipts: async (...args: unknown[]) => { calls.push(args); return 7; },
    diagnosticsLog: { append: async (value: unknown) => { if (failLog) throw new Error('PRIVATE_ERROR'); logs.push(value); } } };
    vm.runInNewContext(source, state);
    return { port: state.port, calls, logs };
};

describe('private iOS receipt retention bridge seam', () => {
    it.each(['null', '[]', JSON.stringify([id])])('forwards %s before a content-free policy marker', async (raw) => {
        const f = fixture();
        expect(await f.port.iosPruneReceipts(raw)).toEqual({ pruned: 7 });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0][2]).toEqual(raw === 'null'
            ? { retainedCommands: ['reminderComplete', 'reminderSnooze'] }
            : { retainedRequestIds: JSON.parse(raw) });
        expect(f.logs).toHaveLength(1);
        expect(f.logs[0]).toMatchObject({ scope: 'native-ios', message: 'Native iOS reminder receipt retention applied',
            context: { releaseCheck: 'v1.3.5/ios-reminder-receipt-retention', outcome: raw === 'null' ? 'conservative' : 'snapshot' } });
        expect(JSON.stringify(f.logs)).not.toContain(id);
    });
    it('accepts the 128-ID boundary and survives log failure', async () => {
        const ids = Array.from({ length: 128 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
        const f = fixture('ios', true);
        expect(await f.port.iosPruneReceipts(JSON.stringify(ids))).toEqual({ pruned: 7 });
        expect(f.calls[0][2]).toEqual({ retainedRequestIds: ids }); expect(f.logs).toEqual([]);
    });
    it.each([['malformed', 'undefined'], ['object', '{}'], ['null entry', '[null]'], ['numeric entry', '[1]'],
        ['duplicate', JSON.stringify([id, id])], ['uppercase', JSON.stringify([id.toUpperCase()])],
        ['129 entries', JSON.stringify(Array.from({ length: 129 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`))], ['invalid UUID', JSON.stringify(['not-a-uuid'])],
        ['oversize bytes', ' '.repeat(8193) + 'null']])('refuses %s before pruning or logging', async (_label, raw) => {
        const f = fixture();
        await expect(f.port.iosPruneReceipts(raw)).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toEqual([]); expect(f.logs).toEqual([]);
    });
    it('refuses the Android platform without invoking its existing prune port', async () => {
        const f = fixture('android');
        await expect(f.port.iosPruneReceipts('null')).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toEqual([]);
        expect(entry).toContain('return submit(async () => ({ pruned: await pruneNativeRequestReceipts(sqlite) }));');
    });
    it('seals the private selector from generic native dispatch and forwards both start branches', () => {
        const swift = readFileSync(new URL('../../ios-native/Sources/MindwtrNativeCore/CoreHost.swift', import.meta.url), 'utf8');
        expect(swift.match(/guard method != "iosPruneReceipts"/g)).toHaveLength(2);
        expect(swift.match(/startupWindow\(retentionJSON: retentionJSON\)/g)).toHaveLength(2);
        expect(swift).toContain('invoke("iosPruneReceipts", arguments: [retentionJSON])');
        const retry = swift.slice(swift.indexOf('    func retryPending() throws'), swift.indexOf('    private func validateDraftAcknowledgment'));
        expect(retry).not.toContain('PruneReceipts'); expect(retry).not.toContain('startupWindow');
    });
});
