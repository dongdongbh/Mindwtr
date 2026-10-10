import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isEntityOpenUrl, parseEntityOpenUrl } from '../../../packages/core/src/capture-deeplink';
import { createNativeHostContract, type NativeHostResult } from '../../../packages/core/src/native-host-contract';
import { openScreenHost } from '../../../packages/core/src/screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from '../../../packages/core/src/store';
import type { Project, Task } from '../../../packages/core/src/types';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    iosEntityOpen(url: string): string {');
const end = entry.indexOf('    iosNotificationOpen(', start);
if (start < 0 || end < 0) throw new Error('Entity Open bridge unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);
const nativeParserSource = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    readFileSync(new URL('../../../packages/core/src/capture-deeplink.ts', import.meta.url), 'utf8').replace(/^export /gm, '')
    + '\nglobalThis.isEntityOpenUrl = isEntityOpenUrl; globalThis.parseEntityOpenUrl = parseEntityOpenUrl;',
);
const at = '2026-10-09T00:00:00.000Z';
const taskId = 'opaque task/漢+😀', projectId = 'opaque project:漢/+';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: 'PRIVATE_TASK', status: 'inbox', contexts: [], tags: [], createdAt: at, updatedAt: at, ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: 'PRIVATE_PROJECT', status: 'active', color: '#123456', order: 0, tagIds: [],
    createdAt: at, updatedAt: at, ...extra,
});
const fixture = async (platform = 'ios', ready = true, hostURL = false) => {
    const writes: unknown[] = [], calls: unknown[] = [];
    const host = ready ? await openScreenHost({ data: {
        tasks: [task(taskId), task('deleted-task', { deletedAt: at }), task('reference-task', { status: 'reference' }),
            task('😀'.repeat(250)), task('😀'.repeat(250) + 'x')],
        projects: [project(projectId), project('deleted-project', { deletedAt: at }),
            project('archived-project', { status: 'archived' }), project('p'.repeat(500)), project('p'.repeat(501))],
        settings: { gtd: { taskEditor: { hidden: ['contexts'] } } },
    }, record: {}, log: [], saveData: async (data) => { writes.push(data); } }) : createNativeHostContract();
    writes.length = 0;
    const state = { __mindwtrHostPlatform: platform, isEntityOpenUrl, parseEntityOpenUrl,
        port: undefined as unknown as { iosEntityOpen(url: unknown): Promise<unknown> },
        submit: (work: () => Promise<unknown>) => work(),
        unwrap: (reply: NativeHostResult<unknown>) => { if (!reply.ok) throw new Error(reply.error.code); return reply.value; },
        contract: { resolveNativeEntryPoint: (input: Parameters<typeof host.resolveNativeEntryPoint>[0]) => {
            calls.push(input); return host.resolveNativeEntryPoint(input);
        } },
    };
    if (hostURL) {
        vm.runInNewContext(readFileSync(new URL('./host-polyfills.js', import.meta.url), 'utf8'), state);
        vm.runInNewContext(nativeParserSource, state);
    }
    vm.runInNewContext(source, state);
    return { port: state.port, calls, writes };
};
const link = (query: string) => `mindwtr-native-dev://open?${query}`;

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('iOS entity Open bridge with actual shared parser and canonical lookup', () => {
    it.each([
        ['task', link(`task=${encodeURIComponent(taskId)}`), { type: 'task', taskId }],
        ['project', link(`project=${encodeURIComponent(projectId)}`), { type: 'project', projectId }],
        ['triple slash and case', `MINDWTR-NATIVE-DEV:///OPEN?task=${encodeURIComponent(taskId)}`, { type: 'task', taskId }],
        ['reference task outside Focus', link('task=reference-task'), { type: 'task', taskId: 'reference-task' }],
        ['archived project', link('project=archived-project'), { type: 'project', projectId: 'archived-project' }],
        ['task before project', link(`project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(taskId)}`), { type: 'task', taskId }],
        ['first duplicate', link(`task=${encodeURIComponent(taskId)}&task=missing`), { type: 'task', taskId }],
        ['empty first task allows project', link(`task=&task=${encodeURIComponent(taskId)}&project=${encodeURIComponent(projectId)}`), { type: 'project', projectId }],
        ['blank task allows project', link(`task=%20&project=${encodeURIComponent(projectId)}`), { type: 'project', projectId }],
        ['trimmed decoded ID', link(`task=%20${encodeURIComponent(taskId)}%20`), { type: 'task', taskId }],
        ['foreign library params have no authority', link(`task=${encodeURIComponent(taskId)}&library=other&mode=rehearsal`), { type: 'task', taskId }],
        ['missing', link('task=missing'), { type: 'inbox' }],
        ['missing selected task never falls back to project', link(`task=missing&project=${encodeURIComponent(projectId)}`), { type: 'inbox' }],
        ['deleted task', link('task=deleted-task'), { type: 'inbox' }],
        ['deleted project', link('project=deleted-project'), { type: 'inbox' }],
        ['empty payload', link('task=%20&project='), { type: 'inbox' }],
        ['malformed percent payload', link('task=%E0%A4%A'), { type: 'inbox' }],
        ['exact UTF16 task bound', link(`task=${encodeURIComponent('😀'.repeat(250))}`), { type: 'task', taskId: '😀'.repeat(250) }],
        ['oversize live task output', link(`task=${encodeURIComponent('😀'.repeat(250) + 'x')}`), { type: 'none' }],
        ['exact project bound', link(`project=${'p'.repeat(500)}`), { type: 'project', projectId: 'p'.repeat(500) }],
        ['oversize live project output', link(`project=${'p'.repeat(501)}`), { type: 'none' }],
    ])('resolves %s read-only with a closed result', async (_label, url, expected) => {
        const f = await fixture(), before = useTaskStore.getState();
        expect(await f.port.iosEntityOpen(url)).toEqual(expected);
        expect(f.calls).toEqual([{ kind: 'link', url, scheme: 'mindwtr-native-dev' }]);
        await flushPendingSave();
        const after = useTaskStore.getState();
        for (const field of ['_allTasks', '_allProjects', 'settings'] as const) expect(after[field]).toBe(before[field]);
        expect(f.writes).toEqual([]);
    });
    it.each([
        'mindwtr://open?task=reference-task', 'https://open?task=reference-task', 'mindwtr-native-row://open?task=reference-task',
        'mindwtr-native-dev://capture?title=PRIVATE', 'mindwtr-native-dev://open-feature?feature=capture',
        'mindwtr-native-dev://global-search?q=PRIVATE', 'mindwtr-native-dev://share', 'mindwtr-native-dev://oauth',
        'mindwtr-native-dev://focus', 'mindwtr-native-dev://open/other?area=a',
        link('area=a'), link('task=&project=%20&area=a'), '', 'PRIVATE_BAD_URL',
    ])('refuses unsupported URL without broad routing: %s', async (url) => {
        const f = await fixture();
        expect(await f.port.iosEntityOpen(url)).toEqual({ type: 'none' });
        expect(f.calls).toEqual([]);
        expect(f.writes).toEqual([]);
    });
    it('propagates readiness and later resolves the same delivery against loaded state', async () => {
        const cold = await fixture('ios', false);
        await expect(cold.port.iosEntityOpen(link('task=missing'))).rejects.toThrow('NOT_READY');
        await expect(cold.port.iosEntityOpen(link('task=reference-task'))).rejects.toThrow('NOT_READY');
        const warm = await fixture();
        expect(await warm.port.iosEntityOpen(link('task=reference-task'))).toEqual({ type: 'task', taskId: 'reference-task' });
    });
    it('accepts exactly 16000 UTF16 URL units and refuses the next unit before routing', async () => {
        const f = await fixture(), prefix = link('task=reference-task&ignored=');
        const exact = prefix + '😀'.repeat(Math.floor((16_000 - prefix.length) / 2)) + 'x'.repeat((16_000 - prefix.length) % 2);
        expect(exact.length).toBe(16_000);
        expect(await f.port.iosEntityOpen(exact)).toEqual({ type: 'task', taskId: 'reference-task' });
        await expect(f.port.iosEntityOpen(exact + 'x')).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toHaveLength(1);
    });
    it.each([null, undefined, 1, true, {}, [], 'x'.repeat(16_001)])('refuses invalid input before routing', async (url) => {
        const f = await fixture();
        await expect(f.port.iosEntityOpen(url)).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toEqual([]);
    });
    it('refuses Android before any shared route or Android entry-point diagnostic', async () => {
        const f = await fixture('android');
        await expect(f.port.iosEntityOpen(link('task=reference-task'))).rejects.toThrow('INVALID_INPUT');
        expect(f.calls).toEqual([]);
    });
    it.each(['task=%E0%A4%A', 'task=%GG', 'task=%80', 'task=%', 'task=%A'])('keeps malformed native-host entity payloads on the ready Inbox: %s', async (query) => {
        const f = await fixture('ios', true, true), url = link(query);
        expect(await f.port.iosEntityOpen(url)).toEqual({ type: 'inbox' });
        expect(f.calls).toEqual([{ kind: 'link', url, scheme: 'mindwtr-native-dev' }]);
        expect(f.writes).toEqual([]);
    });
    it('preserves the shared sandbox Inbox policy in an isolated runtime', async () => {
        const script = `
            import assert from 'node:assert/strict';
            import vm from 'node:vm';
            import { isEntityOpenUrl, parseEntityOpenUrl } from ${JSON.stringify(new URL('../../../packages/core/src/capture-deeplink.ts', import.meta.url).href)};
            import { initializeSandboxRuntime } from ${JSON.stringify(new URL('../../../packages/core/src/sandbox.ts', import.meta.url).href)};
            import { openScreenHost, value } from ${JSON.stringify(new URL('../../../packages/core/src/screen-parity.replay.ts', import.meta.url).href)};
            initializeSandboxRuntime(true);
            const host = await openScreenHost({ data: { tasks: [${JSON.stringify(task(taskId))}], projects: [${JSON.stringify(project(projectId))}] }, record: {}, log: [] });
            const state = { __mindwtrHostPlatform: 'ios', isEntityOpenUrl, parseEntityOpenUrl,
                submit: work => work(), unwrap: value, contract: host };
            vm.runInNewContext(${JSON.stringify(source)}, state);
            for (const url of ${JSON.stringify([link(`task=${encodeURIComponent(taskId)}`), link(`project=${encodeURIComponent(projectId)}`)])}) {
                assert.equal(JSON.stringify(await state.port.iosEntityOpen(url)), '{"type":"inbox"}');
            }
        `;
        const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
        const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    });
});
