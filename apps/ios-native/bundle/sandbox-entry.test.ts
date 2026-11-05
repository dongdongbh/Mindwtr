import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import type { sandboxHost } from './sandbox-entry';

const root = resolve(import.meta.dirname, '../../..');
let bundle = '';
beforeAll(async () => {
    const result = await build({ entryPoints: [resolve(import.meta.dirname, 'sandbox-entry.ts')], bundle: true,
        write: false, format: 'iife', platform: 'browser', target: 'es2020', tsconfigRaw: {},
        alias: { '@mindwtr/core': resolve(root, 'packages/core/src/index.ts') } });
    bundle = readFileSync(resolve(root, 'apps/android-native/bundle/host-polyfills.js'), 'utf8') + '\n' + result.outputFiles[0].text;
}, 30_000);

function runtime() {
    const effects: string[] = [];
    const native = new Proxy({ nowMs: () => Date.now(), log: () => undefined,
        randomBytes: (length: number) => JSON.stringify([...randomBytes(length)]) }, {
        get(target, name, receiver) {
            if (name === 'trace') return undefined;
            if (Reflect.has(target, name)) return Reflect.get(target, name, receiver);
            return () => { effects.push(String(name)); throw new Error(`Forbidden sample port: ${String(name)}`); };
        },
    });
    const context = createContext({ __mindwtrNative: native, __mindwtrHostPlatform: 'ios',
        __mindwtrSkipSaveRetryWait: true });
    runInContext(bundle, context);
    const host: typeof sandboxHost = runInContext('MindwtrSandboxHost', context);
    async function poll(ticket: string) {
        for (let turn = 0; turn < 1000; turn++) {
            await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
            runInContext('__pumpTimers()', context);
            const reply = host.poll(ticket);
            if (reply !== null) return JSON.parse(reply);
        }
        throw new Error('Sample ticket did not settle');
    }
    const call = (method: string, args: unknown = {}) => poll(host.call(method, JSON.stringify(args)));
    const start = (settings: unknown = {}) => poll(host.start(JSON.stringify(settings)));
    return { host, effects, context, poll, call, start };
}

describe('effect-free sample facade over real core memory storage', () => {
    it('activates, reads every local screen, captures, edits, completes, and creates/renames projects', async () => {
        const app = runtime();
        expect(await app.start()).toEqual({ ok: true, value: { version: 1, workspace: 'sandbox', volatile: true } });
        for (const method of ['inbox', 'next', 'today']) {
            const reply = await app.call(method, { offset: 0, limit: 100 });
            expect(reply.ok, JSON.stringify(reply)).toBe(true);
            expect(reply.value.rows.length).toBeGreaterThan(0);
        }
        const projects = await app.call('projects');
        expect(projects.ok).toBe(true);
        const project = await app.call('createProject', { title: 'Sample project', areaId: null, requestId: randomUUID() });
        expect(project.ok).toBe(true);
        expect((await app.call('project', { projectId: project.value.id, offset: 0, limit: 100 })).ok).toBe(true);
        const options = await app.call('renameOptions', { projectId: project.value.id });
        const { id: _id, ...expected } = options.value.project;
        const rename = { projectId: project.value.id, title: 'Renamed sample', expected, requestId: randomUUID() };
        const renamed = await app.call('renameProject', rename);
        expect(renamed).toEqual({ ok: true, value: { id: project.value.id, title: 'Renamed sample' } });
        expect(await app.call('renameProject', rename)).toEqual(renamed);

        const captured = await app.call('capture', { title: 'Sample capture', captureId: randomUUID() });
        expect(captured.ok).toBe(true);
        const taskId = captured.value.id;
        const editor = await app.call('editor', { id: taskId });
        const edited = await app.call('editDraft', { id: taskId, draft: editor.value.draft,
            edit: { type: 'fields', patch: { title: 'Edited sample', projectId: project.value.id } } });
        expect(edited.ok).toBe(true);
        const saved = await app.call('saveDraft', { id: taskId,
            base: { title: editor.value.draft.title, projectId: editor.value.draft.projectId },
            patch: { title: edited.value.draft.title, projectId: edited.value.draft.projectId }, requestId: randomUUID() });
        expect(saved.ok).toBe(true);
        const task = await app.call('task', { id: taskId });
        expect(task.ok).toBe(true);
        const completion = { id: taskId, taskRevision: task.value.taskRevision, requestId: randomUUID() };
        const completed = await app.call('complete', completion);
        expect(completed.ok).toBe(true);
        expect(await app.call('complete', completion)).toEqual(completed);
        expect((await app.call('editor', { id: taskId })).value.draft.status).toBe('done');
        expect(app.effects).toEqual([]);
        expect(await app.poll(app.host.close())).toEqual({ ok: true, value: { closed: true } });
    });

    it('retains exact request retry and stale task/project/list guards', async () => {
        const app = runtime();
        await app.start();
        const window = (await app.call('inbox', { offset: 0, limit: 100 })).value;
        const next = (await app.call('next', { offset: 0, limit: 100 })).value;
        const today = (await app.call('today', { offset: 0, limit: 100 })).value;
        const capture = { title: 'Capture exactly once', captureId: randomUUID() };
        const captured = await app.call('capture', capture);
        expect(await app.call('capture', capture)).toEqual(captured);
        expect(await app.call('capture', { ...capture, title: 'Changed capture draft' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await app.call('createProject', { title: 'Wrong action', areaId: null, requestId: capture.captureId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const projectIdentity = randomUUID();
        expect((await app.call('createProject', { title: 'Identity owner', areaId: null, requestId: projectIdentity })).ok).toBe(true);
        expect(await app.call('capture', { title: 'Wrong identity', captureId: projectIdentity })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const currentWindow = (await app.call('inbox', { offset: 0, limit: 100 })).value;
        expect(currentWindow.total).toBe(window.total + 1);
        expect((await app.call('inbox', { offset: 0, limit: 100, revision: window.revision })).error.code).toBe('STALE_REVISION');
        expect((await app.call('next', { offset: 0, limit: 100, revision: next.revision })).error.code).toBe('STALE_REVISION');
        expect((await app.call('today', { offset: 0, limit: 100, revision: today.revision })).error.code).toBe('STALE_REVISION');
        const id = captured.value.id;
        const task = (await app.call('task', { id })).value;
        const save = { id, base: { title: 'Capture exactly once' }, patch: { title: 'First edit' }, requestId: randomUUID() };
        const saved = await app.call('saveDraft', save);
        expect(saved.ok).toBe(true);
        expect(await app.call('saveDraft', save)).toEqual(saved);
        expect((await app.call('saveDraft', { ...save, patch: { title: 'Changed request' } })).error.code).toBe('INVALID_INPUT');
        expect((await app.call('saveDraft', { ...save, patch: { title: 'Stale edit' }, requestId: randomUUID() })).error.code).toBe('STALE_REVISION');
        expect((await app.call('complete', { id, taskRevision: task.taskRevision, requestId: randomUUID() })).error.code).toBe('STALE_REVISION');
        const project = await app.call('createProject', { title: 'Original', areaId: null, requestId: randomUUID() });
        const { id: _id, ...expected } = (await app.call('renameOptions', { projectId: project.value.id })).value.project;
        const rename = { projectId: project.value.id, expected, title: 'One', requestId: randomUUID() };
        expect((await app.call('renameProject', rename)).ok).toBe(true);
        expect((await app.call('renameProject', { ...rename, title: 'Stale', requestId: randomUUID() })).error.code).toBe('STALE_REVISION');
        expect(app.effects).toEqual([]);
        await app.poll(app.host.close());
    });

    it('denies all non-local operations and rejects malformed/oversized inputs without effects', async () => {
        const app = runtime();
        expect((await app.call('projects')).error.code).toBe('NOT_READY');
        await app.start();
        for (const method of ['boot', 'sync', 'fetch', 'settings', 'attachments', 'openURL', 'activate', '__proto__', 'constructor', 'getTaskShare']) {
            expect((await app.call(method)).error.code).toBe('METHOD_DENIED');
        }
        expect((await app.call('capture', { title: 'No', captureId: randomUUID(), url: 'https://invalid.test' })).error.code).toBe('INVALID_INPUT');
        expect((await app.poll(app.host.call('projects', '[]'))).error.code).toBe('INVALID_INPUT');
        expect((await app.poll(app.host.call('projects', '{'))).error.code).toBe('INVALID_INPUT');
        expect((await app.call('capture', { title: 'x'.repeat(128 * 1024), captureId: randomUUID() })).error.code).toBe('INVALID_INPUT');
        expect((await app.call('next', { offset: 1, limit: 100 })).error.code).toBe('INVALID_INPUT');
        expect(app.effects).toEqual([]);
        await app.poll(app.host.close());
    });

    it('cancels queued capture, bounds unconsumed tickets, closes terminally, and resets only in a fresh context', async () => {
        const app = runtime();
        await app.start();
        const before = (await app.call('inbox', { offset: 0, limit: 100 })).value.total;
        const capture = app.host.call('capture', JSON.stringify({ title: 'Cancelled', captureId: randomUUID() }));
        app.host.abort(capture);
        expect((await app.poll(capture)).error.code).toBe('CANCELLED');
        expect((await app.call('inbox', { offset: 0, limit: 100 })).value.total).toBe(before);
        expect((await app.call('capture', { title: 'Discard on reset', captureId: randomUUID() })).ok).toBe(true);
        expect((await app.call('inbox', { offset: 0, limit: 100 })).value.total).toBe(before + 1);
        for (let i = 0; i < 64; i++) app.host.call('projects', '{}');
        expect(() => app.host.call('projects', '{}')).toThrow('BUSY');
        expect(await app.poll(app.host.close())).toEqual({ ok: true, value: { closed: true } });
        expect((await app.call('projects')).error.code).toBe('CLOSED');
        expect((await app.start()).error.code).toBe('CLOSED');
        expect(await app.poll(app.host.close())).toEqual({ ok: true, value: { closed: true } });
        expect(JSON.parse(app.host.poll('unknown')!)).toMatchObject({ ok: false, error: { code: 'INVALID_TICKET' } });
        const fresh = runtime();
        await fresh.start();
        expect((await fresh.call('inbox', { offset: 0, limit: 100 })).value.total).toBe(before);
        await fresh.poll(fresh.host.close());
        expect(app.effects).toEqual([]);
    });

    it('accepts only display settings on boot and does not resurrect a closed starting runtime', async () => {
        const invalid = runtime();
        expect((await invalid.start({ sync: { token: 'forbidden' } })).error.code).toBe('INVALID_INPUT');
        expect((await invalid.start()).error.code).toBe('NOT_READY');
        await invalid.poll(invalid.host.close());
        const app = runtime();
        app.host.start('{}');
        const close = app.host.close();
        expect(await app.poll(close)).toEqual({ ok: true, value: { closed: true } });
        expect((await app.call('projects')).error.code).toBe('CLOSED');
        expect(app.effects).toEqual([]);
    });

    it('does not consume fresh start authority when the ticket table is full', async () => {
        const app = runtime();
        const tickets = Array.from({ length: 64 }, () => app.host.call('projects', '{}'));
        expect(() => app.host.start('{}')).toThrow('BUSY');
        for (const ticket of tickets) expect((await app.poll(ticket)).error.code).toBe('NOT_READY');
        expect((await app.start({ language: 'zh', theme: 'dark', appearance: { textSize: 'large' } })).ok).toBe(true);
        expect((await app.call('inbox', { offset: 0, limit: 100 })).ok).toBe(true);
        await app.poll(app.host.close());
        expect(app.effects).toEqual([]);
    });
});
