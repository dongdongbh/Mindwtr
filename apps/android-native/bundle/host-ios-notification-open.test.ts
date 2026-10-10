import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNativeHostContract, type NativeHostResult } from '../../../packages/core/src/native-host-contract';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    iosNotificationOpen(rawJSON: string): string {');
const end = entry.indexOf('    reminderSnoozePrepare(', start);
if (start < 0 || end < 0) throw new Error('Notification Open bridge unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);
const fixture = (platform = 'ios') => {
    const host = createNativeHostContract({ reminderPlatform: 'ios' });
    const calls: Record<string, unknown>[] = [];
    const state = { TextEncoder, __mindwtrHostPlatform: platform,
        port: undefined as unknown as { iosNotificationOpen(raw: string): Promise<unknown> },
        submit: (work: () => Promise<unknown>) => work(),
        unwrap: (reply: NativeHostResult<unknown>) => { if (!reply.ok) throw new Error(reply.error.code); return reply.value; },
        contract: { routeNotificationOpen: (payload: Record<string, unknown>) => {
            calls.push(payload); return host.routeNotificationOpen(payload);
        } },
    };
    vm.runInNewContext(source, state);
    return { port: state.port, calls };
};

describe('iOS notification Open bridge with actual shared contract routing', () => {
    it.each([
        ['task review precedes task', { kind: 'task-review', taskId: 't', notificationId: 'review:t' }, { type: 'review', taskId: 't', openToken: 'review:t' }],
        ['project review precedes project', { kind: 'project-review', projectId: 'p', notificationId: 'review:p' }, { type: 'review', projectId: 'p', openToken: 'review:p' }],
        ['project', { projectId: 'p' }, { type: 'project', projectId: 'p' }],
        ['context', { context: '@home', kind: 'context-automation' }, { type: 'contexts', token: '@home' }],
        ['daily digest', { notificationId: 'digest:morning' }, { type: 'daily-review', openToken: 'digest:morning' }],
        ['weekly digest', { notificationId: 'digest:weekly-review' }, { type: 'weekly-review', openToken: 'digest:weekly-review' }],
        ['none', {}, { type: 'none' }],
    ])('forwards %s without adding mutation or Android work', async (_label, fields, expected) => {
        const f = fixture(), payload = { ...fields as Record<string, string>, actionIdentifier: 'open' };
        expect(await f.port.iosNotificationOpen(JSON.stringify(payload))).toEqual(expected);
        expect(f.calls).toEqual([payload]);
    });
    it('preserves task routes and distinct shared open tokens', async () => {
        const f = fixture(), payload = { actionIdentifier: 'open', taskId: 't', notificationId: 'task:t' };
        const first = await f.port.iosNotificationOpen(JSON.stringify(payload));
        const second = await f.port.iosNotificationOpen(JSON.stringify(payload));
        expect(first).toMatchObject({ type: 'task', taskId: 't', openToken: expect.stringMatching(/^task:t:\d+:1$/) });
        expect(second).toMatchObject({ type: 'task', taskId: 't', openToken: expect.stringMatching(/^task:t:\d+:2$/) });
        expect(f.calls).toEqual([payload, payload]);
    });
    it('accepts exactly 65536 UTF8 bytes and refuses the next byte before routing', async () => {
        const f = fixture(), raw = JSON.stringify({ actionIdentifier: 'open', context: '漢' });
        const exact = raw + ' '.repeat(65_536 - new TextEncoder().encode(raw).byteLength);
        expect(new TextEncoder().encode(exact).byteLength).toBe(65_536);
        expect(await f.port.iosNotificationOpen(exact)).toEqual({ type: 'none' });
        await expect(f.port.iosNotificationOpen(exact + ' ')).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toHaveLength(1);
    });
    it('accepts one leading BOM while preserving embedded field BOM bytes', async () => {
        const f = fixture(), payload = { actionIdentifier: 'open', projectId: '\uFEFFp', context: '@\uFEFFhome' };
        expect(await f.port.iosNotificationOpen('\uFEFF' + JSON.stringify(payload))).toEqual({ type: 'project', projectId: '\uFEFFp' });
        expect(f.calls).toEqual([payload]);
        await expect(f.port.iosNotificationOpen('\uFEFF\uFEFF' + JSON.stringify(payload))).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toHaveLength(1);
    });
    it.each([
        ['malformed', 'PRIVATE_BAD_JSON'], ['null', 'null'], ['array', '[]'], ['number', '1'], ['missing action', '{}'],
        ['complete action', '{"actionIdentifier":"complete","taskId":"t"}'], ['nonexact action', '{"actionIdentifier":" OPEN "}'],
        ['unknown field', '{"actionIdentifier":"open","extra":"PRIVATE"}'], ['wrong type', '{"actionIdentifier":"open","taskId":1}'],
        ['null field', '{"actionIdentifier":"open","context":null}'], ['nested field', '{"actionIdentifier":"open","kind":{}}'],
        ['multibyte oversize', JSON.stringify({ actionIdentifier: 'open', context: '漢'.repeat(22_000) })],
    ])('refuses %s before shared routing', async (_label, raw) => {
        const f = fixture();
        await expect(f.port.iosNotificationOpen(raw)).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toEqual([]);
    });
    it('refuses Android before shared routing', async () => {
        const f = fixture('android');
        await expect(f.port.iosNotificationOpen('{"actionIdentifier":"open","taskId":"t"}')).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toEqual([]);
    });
});
