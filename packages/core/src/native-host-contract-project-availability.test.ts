import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createProjectAvailabilityMethods } from './native-host-contract-project-availability';
import * as preparedAvailability from './native-host-contract-project-availability';
import { openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, getPersistenceStatus, getStorageAdapter, resetForTests, useTaskStore } from './store';
import type { NativeAttachmentsHost } from './native-host-contract-attachments';
import type { Attachment, Project, Task } from './types';

const at = '2026-10-07T12:00:00.000Z';
const id = '852d70cf-303a-47d0-98cb-d16de850a94d';
const directory = 'file:///current/documents/attachments/';
const target = directory + id + '.txt';
const file: Attachment = { id, kind: 'file', title: 'Original.txt', uri: `file:///old/documents/attachments/${id}.txt`,
    cloudKey: `attachments/${id}.txt`, fileHash: 'a'.repeat(64), size: 4, contentRev: 2, contentMtimeMs: 4,
    contentSize: 4, pendingContentUpload: false, localStatus: 'missing', createdAt: at, updatedAt: at };
const sibling: Attachment = { id: 'sibling', kind: 'link', title: 'Keep', uri: 'https://example.invalid/keep', createdAt: at, updatedAt: at };
const project = (key = 'target', change: Partial<Project> = {}): Project => ({ id: key, title: key, status: 'active',
    color: '#3b82f6', order: 0, tagIds: [], isSequential: false, isFocused: false, supportNotes: 'Keep',
    attachments: [file, sibling], rev: 3, revBy: 'old-device', createdAt: at, updatedAt: at, ...change });
const task: Task = { id: 'task', title: 'Keep task', status: 'inbox', tags: [], contexts: [], createdAt: at, updatedAt: at };
const hostFor = (ensure: NativeAttachmentsHost['ensureAttachmentAvailableDetailed']): NativeAttachmentsHost => ({
    persistAttachmentLocally: async (item) => item, ensureAttachmentAvailableDetailed: ensure,
    deleteManagedAttachmentFile: vi.fn(async () => undefined),
});
const allRows = async (env: Awaited<ReturnType<typeof openSqliteHost>>) => ({
    projects: await env.sql('SELECT * FROM projects ORDER BY id'), tasks: await env.sql('SELECT * FROM tasks ORDER BY id'),
    settings: await env.sql('SELECT * FROM settings'),
});
const request = (env: Awaited<ReturnType<typeof openSqliteHost>>) => ({ projectId: 'target', attachmentId: id,
    revision: value(env.host.getProjectAttachmentEditOptions({ projectId: 'target' })).revision, managedDirectoryURI: directory });
async function open(ensure = vi.fn(async (item: Attachment) => ({ status: 'available' as const,
    attachment: { ...item, localStatus: 'available' as const } })), selected = project()) {
    const attachments = hostFor(ensure);
    const env = await openSqliteHost({ projects: [selected, project('other')], tasks: [task], settings: { deviceId: 'device' } },
        undefined, { attachments }, { rejectConcurrentWrites: true });
    // Initial activation can save the display codec while installing defaults.
    // The selected command begins only after that settled startup boundary.
    await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify(selected.attachments), 'target']);
    await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify(project('other').attachments), 'other']);
    return { env, ensure, attachments };
}
const methods = (env: Awaited<ReturnType<typeof openSqliteHost>>, attachments: NativeAttachmentsHost,
    save: () => Promise<{ ok: true; value: null } | { ok: false; error: { code: 'SAVE_FAILED'; message: string } }>) =>
    createProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
        revision: () => value(env.host.getProjectAttachmentEditOptions({ projectId: 'target' })).revision, save, host: () => attachments });
afterEach(async () => { vi.restoreAllMocks(); await flushPendingSave(); resetForTests(); });

describe('selected relocated Project availability durable authority', () => {
    it.each(['active', 'archived'] as const)('commits one %s availability effect and survives actual SQLite recreation', async (status) => {
        const { env, ensure } = await open(undefined, project('target', { status }));
        try {
            const before = await allRows(env), input = request(env);
            const preflight = value(await env.host.getProjectAttachmentAvailabilityPreflight(input));
            expect(preflight).toMatchObject({ revision: input.revision, targetURI: target,
                project: { attachments: [{ ...file }, sibling] } });
            expect(await allRows(env)).toEqual(before);
            expect(await env.host.downloadRelocatedProjectAttachment(input, target)).toEqual({ ok: true,
                value: { status: 'available', message: null, update: null } });
            expect(ensure).toHaveBeenCalledExactlyOnceWith({ ...file, uri: target });
            const after = await allRows(env), saved = (after.projects as Record<string, unknown>[]).find((row) => row.id === 'target')!;
            expect(saved).toEqual({ ...(before.projects as Record<string, unknown>[]).find((row) => row.id === 'target'),
                attachments: JSON.stringify([{ ...file, uri: target, localStatus: 'available' }, sibling]),
                rev: 4, revBy: 'device', updatedAt: expect.any(String) });
            expect((after.projects as Record<string, unknown>[]).find((row) => row.id === 'other'))
                .toEqual((before.projects as Record<string, unknown>[]).find((row) => row.id === 'other'));
            expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
            await env.restart();
            expect(await allRows(env)).toEqual(after);
        } finally { await env.close(); }
    });

    it('preserves exact raw JSON null/empty presence and false metadata while changing only availability', async () => {
        const { env } = await open();
        try {
            await env.client().run('UPDATE projects SET tagIds=NULL, viewSectionIds=? WHERE id=?', ['[]', 'target']);
            await env.restart();
            await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify([file, sibling]), 'target']);
            const input = request(env), before = await allRows(env);
            expect(value(await env.host.getProjectAttachmentAvailabilityPreflight(input)).project.attachments![0].pendingContentUpload).toBe(false);
            expect(await env.host.downloadRelocatedProjectAttachment(input, target)).toMatchObject({ ok: true, value: { status: 'available' } });
            const saved = (await env.sql<Record<string, unknown>>('SELECT * FROM projects WHERE id=?', ['target']))[0];
            expect(saved.tagIds).toBeNull(); expect(saved.viewSectionIds).toBe('[]');
            expect(JSON.parse(saved.attachments as string)[0]).toEqual({ ...file, uri: target, localStatus: 'available' });
            expect((await allRows(env)).tasks).toEqual(before.tasks);
        } finally { await env.close(); }
    });

    it.each(['title', 'order', 'revision', 'revBy', 'time', 'selectedTitle', 'selectedHash', 'false', 'null', 'device', 'rawBoolean'] as const)(
    'refuses an actual raw %s change during the availability await without overwriting it', async (change) => {
        let release!: () => void;
        const ensure = vi.fn((item: Attachment) => new Promise<{ status: 'available'; attachment: Attachment }>((resolve) => {
            release = () => resolve({ status: 'available', attachment: { ...item, localStatus: 'available' } });
        }));
        const { env } = await open(ensure);
        try {
            const before = await allRows(env), input = request(env);
            const pending = env.host.downloadRelocatedProjectAttachment(input, target);
            await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
            expect(await allRows(env)).toEqual(before); // No transient downloading write.
            if (change === 'device') await env.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'different' })]);
            else if (change === 'null') await env.client().run('UPDATE projects SET tagIds=NULL WHERE id=?', ['target']);
            else if (change === 'rawBoolean') await env.client().run('UPDATE projects SET isFocused=NULL WHERE id=?', ['target']);
            else if (['selectedTitle', 'selectedHash', 'false'].includes(change)) {
                const changed = { ...file, ...(change === 'selectedTitle' ? { title: 'Later' }
                    : change === 'selectedHash' ? { fileHash: 'b'.repeat(64) } : { pendingContentUpload: true }) };
                await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify([changed, sibling]), 'target']);
            } else {
                const column = { title: 'title', order: 'orderNum', revision: 'rev', revBy: 'revBy', time: 'updatedAt' }[change as 'title'];
                const changed = change === 'order' || change === 'revision' ? 9 : change === 'time' ? '2026-10-07T13:00:00.000Z' : 'Later';
                await env.client().run(`UPDATE projects SET ${column}=? WHERE id=?`, [changed, 'target']);
            }
            const intervening = await allRows(env);
            release();
            expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await allRows(env)).toEqual(intervening);
        } finally { await env.close(); }
    });

    it('overlays only the target onto fresh unrelated durable rows and preserves newer live edits', async () => {
        let release!: () => void;
        const ensure = vi.fn((item: Attachment) => new Promise<{ status: 'available'; attachment: Attachment }>((resolve) => {
            release = () => resolve({ status: 'available', attachment: { ...item, localStatus: 'available' } });
        }));
        const { env } = await open(ensure);
        try {
            const pending = env.host.downloadRelocatedProjectAttachment(request(env), target);
            await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
            await useTaskStore.getState().updateProject('other', { supportNotes: 'Newer live notes' });
            await flushPendingSave();
            await env.client().run('UPDATE tasks SET title=? WHERE id=?', ['Newer external task', 'task']);
            const unrelated = await allRows(env);
            release(); expect(await pending).toMatchObject({ ok: true, value: { status: 'available' } });
            const after = await allRows(env);
            expect((after.projects as Record<string, unknown>[]).find((row) => row.id === 'other'))
                .toEqual((unrelated.projects as Record<string, unknown>[]).find((row) => row.id === 'other'));
            expect(after.tasks).toEqual(unrelated.tasks);
            expect(useTaskStore.getState()._projectsById.get('other')!.supportNotes).toBe('Newer live notes');
        } finally { await env.close(); }
    });

    it.each(['failed-ack', 'after-drift'] as const)('does not claim available after %s', async (mode) => {
        const { env, attachments } = await open();
        try {
            const selected = methods(env, attachments, async () => {
                await flushPendingSave();
                if (mode === 'failed-ack') return { ok: false, error: { code: 'SAVE_FAILED', message: 'Synthetic ACK failure' } };
                await env.client().run('UPDATE projects SET supportNotes=? WHERE id=?', ['After drift', 'target']);
                return { ok: true, value: null };
            });
            expect(await selected.downloadRelocatedProjectAttachment(request(env), target)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const saved = (await env.sql<Record<string, unknown>>('SELECT * FROM projects WHERE id=?', ['target']))[0];
            expect(JSON.parse(saved.attachments as string)[0].uri).toBe(target);
            expect(saved.rev).toBe(4);
            if (mode === 'after-drift') expect(saved.supportNotes).toBe('After drift');
        } finally { await env.close(); }
    });

    it.each(['disk', 'external-commit'] as const)('refuses %s at the actual SQLite write boundary', async (mode) => {
        let armed = false;
        let other: { prepare: (sql: string) => { run: (...values: unknown[]) => unknown }; close: () => void } | undefined;
        const ensure = vi.fn(async (item: Attachment) => {
            armed = true;
            return { status: 'available' as const, attachment: { ...item, localStatus: 'available' as const } };
        });
        const attachments = hostFor(ensure);
        const env = await openSqliteHost({ projects: [project()], settings: { deviceId: 'device' } }, (client) => ({ ...client,
            run: async (sql, params) => {
                if (armed && sql === 'BEGIN IMMEDIATE'
                    && useTaskStore.getState()._projectsById.get('target')?.attachments?.[0].uri === target) {
                    if (mode === 'disk') throw new Error('Synthetic write failure');
                    armed = false;
                    other!.prepare('UPDATE projects SET supportNotes=? WHERE id=?').run('External commit', 'target');
                }
                return client.run(sql, params);
            },
        }), { attachments }, { rejectConcurrentWrites: true });
        try {
            await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify([file, sibling]), 'target']);
            if (mode === 'external-commit') {
                const Database = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
                other = new Database(join(env.dir, 'mindwtr.db'));
            }
            const before = await allRows(env);
            expect(await env.host.downloadRelocatedProjectAttachment(request(env), target)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const after = await allRows(env);
            expect(after.projects).toEqual(mode === 'disk' ? before.projects
                : (before.projects as Record<string, unknown>[]).map((row) => ({ ...row, supportNotes: 'External commit' })));
        } finally { armed = false; other?.close(); await env.close(); }
    });

    it('refuses unroundtrippable scalar cells before I/O, and does not drain pending writes during preflight', async () => {
        const { env, ensure } = await open();
        try {
            const input = request(env);
            await env.client().run('UPDATE projects SET isSequential=NULL WHERE id=?', ['target']);
            const before = await allRows(env);
            expect(await env.host.downloadRelocatedProjectAttachment(input, target)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(ensure).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(before);
            await env.client().run('UPDATE projects SET isSequential=0 WHERE id=?', ['target']);
            await useTaskStore.getState().updateProject('other', { title: 'Queued' });
            const read = vi.spyOn(getStorageAdapter(), 'getData');
            expect(await env.host.getProjectAttachmentAvailabilityPreflight(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(read).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it.each(['unavailable', 'generation-conflict', 'unrecoverable', 'throw'] as const)('keeps raw BEFORE on local %s refusal', async (status) => {
        const ensure = vi.fn(async (item: Attachment) => {
            if (status === 'throw') throw new Error('Synthetic');
            return status === 'unrecoverable' ? { status, attachment: { ...item, deletedAt: at } } : { status };
        }) as ReturnType<typeof vi.fn<NativeAttachmentsHost['ensureAttachmentAvailableDetailed']>>;
        const { env } = await open(ensure);
        try {
            const before = await allRows(env);
            expect(await env.host.downloadRelocatedProjectAttachment(request(env), target)).not.toMatchObject({ ok: true, value: { status: 'available' } });
            expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it('refuses stale/malformed selection or a different target before I/O', async () => {
        const { env, ensure } = await open();
        try {
            const input = request(env), before = await allRows(env);
            for (const bad of [{ ...input, revision: 'stale' }, { ...input, extra: true },
                { ...input, attachmentId: id.toUpperCase() }, { ...input, managedDirectoryURI: 'file:///current/../attachments/' }])
                expect(await env.host.downloadRelocatedProjectAttachment(bad, target)).toMatchObject({ ok: false });
            expect(await env.host.downloadRelocatedProjectAttachment(input, directory + 'wrong.txt')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(ensure).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it.each(['', target])('leaves ordinary Project download with URI %j on its existing resolver', async (uri) => {
        const ensure = vi.fn(async (item: Attachment) => ({ status: 'available' as const,
            attachment: { ...item, uri: target, localStatus: 'available' as const } }));
        const { env } = await open(ensure, project('target', { attachments: [{ ...file, uri }, sibling] }));
        try {
            expect(await env.host.downloadAttachment({ owner: { kind: 'project', projectId: 'target' }, attachmentId: id }))
                .toMatchObject({ ok: true, value: { status: 'available' } });
            expect(ensure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id, uri }));
        } finally { await env.close(); }
    });
});

const downloadRequest = (env: Awaited<ReturnType<typeof openSqliteHost>>) => ({ ...request(env), version: 1 as const,
    requestId: '40400000-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), size: 4 });
const privateMethods = (env: Awaited<ReturnType<typeof openSqliteHost>>,
    save = vi.fn(async () => { await flushPendingSave(); return { ok: true as const, value: null }; })) =>
    preparedAvailability.createPreparedProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
        revision: () => value(env.host.getProjectAttachmentEditOptions({ projectId: 'target' })).revision, save });

describe('private prepared ordinary Project availability', () => {
    it.each(['', target])('freezes missing URI %j without file, domain, queue or save work', async (uri) => {
        const { env, ensure } = await open(undefined, project('target', { attachments: [{ ...file, uri }, sibling] }));
        try {
            const save = vi.fn(async () => ({ ok: true as const, value: null })), api = privateMethods(env, save);
            const input = downloadRequest(env), before = await allRows(env), state = useTaskStore.getState();
            const persistence = getPersistenceStatus(), { sha256: _hash, size: _size, ...early } = input;
            const preflight = value(await api.getProjectFileAvailabilityPreflight(early));
            const envelope = value(await api.prepareProjectFileAvailability(input));
            expect(preflight).toMatchObject({ version: 1, requestId: input.requestId, targetURI: target, deviceIdBefore: 'device' });
            expect(envelope.prepared.attachmentJSON).toBe(JSON.stringify({ ...file, uri }));
            expect(envelope.prepared.effect.rawBefore).toEqual(preflight.rawBefore);
            expect(envelope.prepared.effect.before).toEqual(preflight.project);
            expect(envelope.prepared.expectation).toEqual({ kind: 'absent' });
            expect(envelope.prepared.effect.after.attachments).toEqual([{ ...file, uri: target, localStatus: 'available' }, sibling]);
            expect(await allRows(env)).toEqual(before); expect(ensure).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
            expect(useTaskStore.getState()._allProjects).toBe(state._allProjects); expect(useTaskStore.getState().settings).toBe(state.settings);
            expect(getPersistenceStatus()).toEqual(persistence);
            expect(api.validatePreparedProjectFileAvailability(envelope)).toEqual({ ok: true,
                value: { status: 'available', message: null, update: null } });
        } finally { await env.close(); }
    });

    it.each(['active', 'archived'] as const)('commits one exact %s patch then cold-replays without revision or save', async (status) => {
        const { env, ensure } = await open(undefined, project('target', { status, attachments: [{ ...file, uri: '' }, sibling] }));
        try {
            await env.client().run('UPDATE projects SET tagIds=NULL,viewSectionIds=? WHERE id=?', ['[]', 'target']);
            await env.restart();
            await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify([{ ...file, uri: '' }, sibling]), 'target']);
            const api = privateMethods(env), envelope = value(await api.prepareProjectFileAvailability(downloadRequest(env)));
            const before = await allRows(env);
            expect(await api.commitPreparedProjectFileAvailability(envelope)).toEqual({ ok: true,
                value: { status: 'available', message: null, update: null } });
            const after = await allRows(env), saved = (after.projects as Record<string, unknown>[]).find(row => row.id === 'target')!;
            expect(saved).toEqual({ ...(before.projects as Record<string, unknown>[]).find(row => row.id === 'target'),
                attachments: JSON.stringify([{ ...file, uri: target, localStatus: 'available' }, sibling]),
                rev: 4, revBy: 'device', updatedAt: envelope.prepared.effect.updateAt });
            expect((after.projects as Record<string, unknown>[]).find(row => row.id === 'other'))
                .toEqual((before.projects as Record<string, unknown>[]).find(row => row.id === 'other'));
            expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings); expect(ensure).not.toHaveBeenCalled();
            const wire = JSON.parse(JSON.stringify(envelope));
            await env.restart();
            const save = vi.fn(async () => ({ ok: true as const, value: null }));
            expect(await privateMethods(env, save).commitPreparedProjectFileAvailability(wire)).toEqual({ ok: true,
                value: { status: 'available', message: null, update: null } });
            expect(save).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(after);
        } finally { await env.close(); }
    });

    it('rejects sameURI alreadyavailable before byte selection without a pointless metadata effect', async () => {
        const { env, ensure } = await open(undefined, project('target', { attachments: [{ ...file, uri: target, localStatus: 'available' }, sibling] }));
        try {
            const before = await allRows(env), api = privateMethods(env), input = downloadRequest(env);
            const { sha256: _hash, size: _size, ...early } = input;
            expect(await api.getProjectFileAvailabilityPreflight(early)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await api.prepareProjectFileAvailability(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await allRows(env)).toEqual(before); expect(ensure).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it('accepts measured size when absent and preserves original upper-case hash metadata', async () => {
        const { size: _size, ...withoutSize } = file;
        const { env } = await open(undefined, project('target', { attachments: [{ ...withoutSize, uri: '', fileHash: 'A'.repeat(64) }, sibling] }));
        try {
            const api = privateMethods(env), input = { ...downloadRequest(env), size: 123 };
            const envelope = value(await api.prepareProjectFileAvailability(input));
            expect(envelope.prepared.effect.after.attachments![0].size).toBeUndefined();
            expect(envelope.prepared.effect.after.attachments![0].fileHash).toBe('A'.repeat(64));
            expect(api.validatePreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true });
        } finally { await env.close(); }
    });

    it('rejects malformed, extra, oversized and source-mismatched input before any effect', async () => {
        const { env, ensure } = await open();
        try {
            const api = privateMethods(env), input = downloadRequest(env), before = await allRows(env);
            for (const bad of [null, [], { ...input, extra: true }, { ...input, version: 2 }, { ...input, requestId: 'invalid' },
                { ...input, attachmentId: id.toUpperCase() }, { ...input, revision: 'stale' },
                { ...input, projectId: 'x'.repeat(501) }, { ...input, managedDirectoryURI: 'file:///current/../attachments/' },
                { ...input, sha256: 'b'.repeat(64) }, { ...input, sha256: 'A'.repeat(64) }, { ...input, size: 3 },
                { ...input, size: -1 }, { ...input, size: 8_388_609 }, { ...input, size: 0.5 }])
                expect(await api.prepareProjectFileAvailability(bad)).toMatchObject({ ok: false });
            expect(await allRows(env)).toEqual(before); expect(ensure).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it('rejects duplicate selected IDs and oversized raw selection without publication', async () => {
        const { env } = await open();
        try {
            const api = privateMethods(env), input = downloadRequest(env);
            for (const list of [[file, file], [{ ...file, title: 'x'.repeat(2_000_001) }]]) {
                await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify(list), 'target']);
                const before = await allRows(env);
                expect(await api.prepareProjectFileAvailability(input)).toMatchObject({ ok: false });
                expect(await allRows(env)).toEqual(before);
            }
        } finally { await env.close(); }
    });

    it('validates only a bounded exact envelope and never reads mutable authority', async () => {
        const { env } = await open();
        try {
            const api = privateMethods(env), envelope = value(await api.prepareProjectFileAvailability(downloadRequest(env)));
            const read = vi.spyOn(getStorageAdapter(), 'getData');
            const copy = () => JSON.parse(JSON.stringify(envelope));
            const variants = [() => ({ ...copy(), extra: true }), () => { const e = copy(); e.prepared.extra = true; return e; },
                () => { const e = copy(); e.prepared.expectation.kind = 'present'; return e; },
                () => { const e = copy(); e.prepared.result.message = 'drift'; return e; },
                () => { const e = copy(); e.request.sha256 = 'b'.repeat(64); return e; },
                () => { const e = copy(); e.request.size = 3; return e; },
                () => { const e = copy(); e.prepared.effect.after.title = 'drift'; return e; },
                () => { const e = copy(); e.prepared.effect.rawBefore[5] = '[] '; return e; },
                () => { const e = copy(); e.prepared.attachmentJSON += ' '; return e; },
                () => { const e = copy(); e.prepared.targetURI = directory + 'foreign.txt'; return e; }];
            for (const change of variants) expect(api.validatePreparedProjectFileAvailability(change())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(api.validatePreparedProjectFileAvailability(copy())).toMatchObject({ ok: true });
            const reorder = (input: unknown): unknown => Array.isArray(input) ? input.map(reorder)
                : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, cell]) => [key, reorder(cell)])) : input;
            expect(api.validatePreparedProjectFileAvailability(reorder(copy()))).toMatchObject({ ok: true });
            expect(read).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it.each(['title', 'attachmentString', 'device'] as const)('refuses changed durable %s at commit and preserves intervening rows', async (change) => {
        const { env } = await open();
        try {
            const api = privateMethods(env), envelope = value(await api.prepareProjectFileAvailability(downloadRequest(env)));
            if (change === 'device') await env.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'changed' })]);
            else if (change === 'title') await env.client().run('UPDATE projects SET title=? WHERE id=?', ['changed', 'target']);
            else await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [' ' + JSON.stringify([file, sibling]), 'target']);
            const before = await allRows(env);
            expect(await api.commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it('preserves unrelated durable changes on commit and refuses a third state on cold replay', async () => {
        const { env } = await open();
        try {
            const api = privateMethods(env), envelope = value(await api.prepareProjectFileAvailability(downloadRequest(env)));
            await env.client().run('UPDATE tasks SET title=? WHERE id=?', ['External task', 'task']);
            expect(await api.commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true });
            expect((await env.sql<{ title: string }>('SELECT title FROM tasks WHERE id=?', ['task']))[0].title).toBe('External task');
            await env.client().run('UPDATE projects SET supportNotes=? WHERE id=?', ['Later project', 'target']);
            await env.restart(); const before = await allRows(env);
            expect(await privateMethods(env).commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it('refuses pending persistence/readiness before selection and never drains that pending queue', async () => {
        const { env } = await open();
        try {
            const input = downloadRequest(env), api = privateMethods(env);
            await useTaskStore.getState().updateProject('other', { title: 'Queued' });
            const read = vi.spyOn(getStorageAdapter(), 'getData');
            expect(await api.prepareProjectFileAvailability(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(read).not.toHaveBeenCalled(); await flushPendingSave();
            const unavailable = preparedAvailability.createPreparedProjectAvailabilityMethods({ readiness: () => ({ ok: false,
                error: { code: 'NOT_READY', message: 'Held readiness' } }), revision: () => input.revision,
                save: async () => ({ ok: true, value: null }) });
            expect(await unavailable.prepareProjectFileAvailability(input)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            expect(read).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });
    it('allocates device initialization only in the frozen intent and applies it with the selected write', async () => {
        const { env } = await open();
        try {
            const { deviceId: _id, ...settings } = useTaskStore.getState().settings;
            await env.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            useTaskStore.setState({ settings });
            const before = await allRows(env), state = useTaskStore.getState(), api = privateMethods(env);
            const envelope = value(await api.prepareProjectFileAvailability(downloadRequest(env)));
            expect(envelope.prepared.effect.deviceIdBefore).toBeNull();
            expect(envelope.prepared.effect.deviceIdToInitialize).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
            expect(useTaskStore.getState().settings).toBe(state.settings); expect(await allRows(env)).toEqual(before);
            expect(await api.commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(envelope.prepared.effect.deviceIdToInitialize);
        } finally { await env.close(); }
    });

    it.each(['raw-row', 'readiness'] as const)('refuses %s changing during the final durable selection read', async (mode) => {
        const { env } = await open();
        try {
            const input = downloadRequest(env), adapter = getStorageAdapter(), actualRead = adapter.getData.bind(adapter);
            let release!: () => void, entered = false, ready = true;
            const gate = new Promise<void>(resolve => { release = resolve; });
            vi.spyOn(adapter, 'getData').mockImplementationOnce(async (...args) => { entered = true; await gate; return actualRead(...args); });
            const api = preparedAvailability.createPreparedProjectAvailabilityMethods({
                readiness: () => ready ? { ok: true, value: null } : { ok: false, error: { code: 'NOT_READY', message: 'Held readiness' } },
                revision: () => input.revision, save: async () => ({ ok: true, value: null }) });
            const pending = api.prepareProjectFileAvailability(input);
            await vi.waitFor(() => expect(entered).toBe(true));
            if (mode === 'raw-row') await env.client().run('UPDATE projects SET title=? WHERE id=?', ['Intervening raw row', 'target']);
            else ready = false;
            const before = await allRows(env); release();
            expect(await pending).toMatchObject({ ok: false, error: { code: mode === 'raw-row' ? 'STALE_REVISION' : 'NOT_READY' } });
            expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it('does not confirm a failed save acknowledgment and cold replay proves the exact committed effect', async () => {
        const { env } = await open();
        try {
            const api = preparedAvailability.createPreparedProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
                revision: () => request(env).revision, save: async () => {
                    await flushPendingSave(); return { ok: false, error: { code: 'SAVE_FAILED', message: 'Synthetic lost acknowledgment' } };
                } });
            const envelope = value(await api.prepareProjectFileAvailability(downloadRequest(env)));
            expect(await api.commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const committed = await allRows(env); await env.restart();
            const save = vi.fn(async () => ({ ok: true as const, value: null }));
            expect(await privateMethods(env, save).commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true });
            expect(save).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(committed);
        } finally { await env.close(); }
    });

});

const cachedMethods = (env: Awaited<ReturnType<typeof openSqliteHost>>, attachments: NativeAttachmentsHost,
    save = vi.fn(async () => { await flushPendingSave(); return { ok: true as const, value: null }; })) => ({ save,
    api: createProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
        revision: () => {
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            return options.ok ? options.value.revision : 'unavailable-selection';
        },
        save, host: () => attachments }, 'cached') });

describe('private cached Project availability durable authority', () => {
    it.each([
        ['active', ''], ['active', target], ['archived', ''], ['archived', target],
    ] as const)('repairs verified %s metadata from URI %j exactly once and survives SQLite recreation', async (status, uri) => {
        const selected = { ...file, uri };
        const { env, ensure, attachments } = await open(undefined, project('target', { status, attachments: [sibling, selected] }));
        try {
            const before = await allRows(env), input = request(env), { api, save } = cachedMethods(env, attachments);
            expect(value(await api.getProjectAttachmentAvailabilityPreflight(input))).toMatchObject({ revision: input.revision,
                targetURI: target, project: { attachments: [sibling, selected] } });
            expect(await allRows(env)).toEqual(before); expect(ensure).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
            expect(await api.downloadRelocatedProjectAttachment(input, target)).toEqual({ ok: true,
                value: { status: 'available', message: null, update: null } });
            expect(ensure).toHaveBeenCalledExactlyOnceWith({ ...selected, uri: target });
            expect(save).toHaveBeenCalledOnce(); expect(attachments.deleteManagedAttachmentFile).not.toHaveBeenCalled();
            const after = await allRows(env);
            expect(after.projects).toEqual((before.projects as Record<string, unknown>[]).map(row => row.id === 'target'
                ? { ...row, attachments: JSON.stringify([sibling, { ...selected, uri: target, localStatus: 'available' }]),
                    rev: 4, revBy: 'device', updatedAt: expect.any(String) } : row));
            expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
            expect(await api.downloadRelocatedProjectAttachment(request(env), target)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            await flushPendingSave(); expect(await allRows(env)).toEqual(after); expect(save).toHaveBeenCalledOnce();
            expect(ensure).toHaveBeenCalledOnce();
            await env.restart(); expect(await allRows(env)).toEqual(after);
            expect(await cachedMethods(env, attachments).api.getProjectAttachmentAvailabilityPreflight(request(env)))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await allRows(env)).toEqual(after);
        } finally { await env.close(); }
    });

    it.each(['', target])('does not broaden the default relocated factory for URI %j', async (uri) => {
        const { env, ensure } = await open(undefined, project('target', { attachments: [{ ...file, uri }, sibling] }));
        try {
            const before = await allRows(env), input = request(env);
            expect(await env.host.getProjectAttachmentAvailabilityPreflight(input)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.downloadRelocatedProjectAttachment(input, target)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(ensure).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    const selected = { ...file, uri: '' };
    // Each independent real SQLite boot keeps the default timeout and all no-effect checks.
    it.each([
        ['foreign URI', project('target', { attachments: [file, sibling] })],
        ['foreign target URI', project('target', { attachments: [{ ...selected, uri: target + '-foreign' }, sibling] })],
        ['already available selection', project('target', { attachments: [{ ...selected, uri: target, localStatus: 'available' }, sibling] })],
        ['missing hash', project('target', { attachments: [{ ...selected, fileHash: undefined }, sibling] })],
        ['invalid hash', project('target', { attachments: [{ ...selected, fileHash: 'invalid' }, sibling] })],
        ['deleted attachment', project('target', { attachments: [{ ...selected, deletedAt: at }, sibling] })],
        ['duplicate attachment ID', project('target', { attachments: [selected, { ...selected }, sibling] })],
        ['deleted project', project('target', { attachments: [selected, sibling], deletedAt: at })],
    ] as const)('refuses %s without proof or queued writes', async (_variant, fixture) => {
        const { env, ensure, attachments } = await open(undefined, fixture);
        try {
            const before = await allRows(env), state = useTaskStore.getState(), { api, save } = cachedMethods(env, attachments);
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            const input = { projectId: 'target', attachmentId: id, managedDirectoryURI: directory,
                revision: options.ok ? options.value.revision : 'unavailable-selection' };
            expect(await api.getProjectAttachmentAvailabilityPreflight(input)).toMatchObject({ ok: false });
            expect(await api.downloadRelocatedProjectAttachment(input, target)).toMatchObject({ ok: false });
            expect(ensure).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
            expect(useTaskStore.getState().lastDataChangeAt).toBe(state.lastDataChangeAt);
            await flushPendingSave(); expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it('refuses a different canonical target before the verified-local callback', async () => {
        const { env, ensure, attachments } = await open(undefined, project('target', { attachments: [{ ...file, uri: '' }, sibling] }));
        try {
            const before = await allRows(env), { api, save } = cachedMethods(env, attachments);
            expect(await api.downloadRelocatedProjectAttachment(request(env), directory + 'different.txt')).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(ensure).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it.each(['attachment-drift', 'generation-conflict'] as const)('preserves exact raw rows after local %s', async (refusal) => {
        const ensure = vi.fn(async (item: Attachment) => refusal === 'generation-conflict'
            ? { status: 'generation-conflict' as const }
            : { status: 'available' as const, attachment: { ...item, localStatus: 'available' as const, title: 'Changed proof' } });
        const { env, attachments } = await open(ensure, project('target', { attachments: [{ ...file, uri: '' }, sibling] }));
        try {
            const before = await allRows(env), state = useTaskStore.getState(), { api, save } = cachedMethods(env, attachments);
            expect(await api.downloadRelocatedProjectAttachment(request(env), target)).not.toMatchObject({ ok: true,
                value: { status: 'available' } });
            expect(ensure).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
            expect(useTaskStore.getState().lastDataChangeAt).toBe(state.lastDataChangeAt);
            await flushPendingSave(); expect(await allRows(env)).toEqual(before);
        } finally { await env.close(); }
    });

    it.each(['attachmentString', 'device'] as const)('preserves intervening durable %s while local proof is held', async (change) => {
        let release!: () => void;
        const selected = { ...file, uri: '' };
        const ensure = vi.fn((item: Attachment) => new Promise<{ status: 'available'; attachment: Attachment }>((resolve) => {
            release = () => resolve({ status: 'available', attachment: { ...item, localStatus: 'available' } });
        }));
        const { env, attachments } = await open(ensure, project('target', { attachments: [selected, sibling] }));
        try {
            const before = await allRows(env), state = useTaskStore.getState(), { api, save } = cachedMethods(env, attachments);
            const pending = api.downloadRelocatedProjectAttachment(request(env), target);
            await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
            expect(await allRows(env)).toEqual(before);
            if (change === 'attachmentString') await env.client().run('UPDATE projects SET attachments=? WHERE id=?',
                [' ' + JSON.stringify([selected, sibling]), 'target']);
            else await env.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'different' })]);
            const intervening = await allRows(env); release();
            expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(save).not.toHaveBeenCalled(); expect(useTaskStore.getState().lastDataChangeAt).toBe(state.lastDataChangeAt);
            await flushPendingSave(); expect(await allRows(env)).toEqual(intervening);
        } finally { await env.close(); }
    });

    it.each(['queued', 'failed'] as const)('refuses %s persistence without draining or adding an effect', async (failure) => {
        const { env, ensure, attachments } = await open(undefined, project('target', { attachments: [{ ...file, uri: '' }, sibling] }));
        try {
            const input = request(env), { api, save } = cachedMethods(env, attachments);
            if (failure === 'queued') await useTaskStore.getState().updateProject('other', { title: 'Intentionally queued' });
            else useTaskStore.setState({ persistenceFailure: { message: 'Synthetic disk failure', failedAt: at, retrying: false } });
            const before = await allRows(env), state = useTaskStore.getState(), read = vi.spyOn(getStorageAdapter(), 'getData');
            expect(await api.downloadRelocatedProjectAttachment(input, target)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            expect(read).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
            expect(useTaskStore.getState().lastDataChangeAt).toBe(state.lastDataChangeAt);
            expect(await allRows(env)).toEqual(before);
        } finally { useTaskStore.setState({ persistenceFailure: null }); await env.close(); }
    });

    it('does not confirm a failed acknowledgment or allocate another revision on retry', async () => {
        const { env, ensure, attachments } = await open(undefined, project('target', { attachments: [{ ...file, uri: '' }, sibling] }));
        try {
            const api = createProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
                revision: () => request(env).revision, host: () => attachments,
                save: async () => { await flushPendingSave(); return { ok: false,
                    error: { code: 'SAVE_FAILED', message: 'Synthetic lost acknowledgment' } }; } }, 'cached');
            expect(await api.downloadRelocatedProjectAttachment(request(env), target)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
            const committed = await allRows(env);
            expect((committed.projects as Record<string, unknown>[]).find(row => row.id === 'target')!.rev).toBe(4);
            expect(await api.downloadRelocatedProjectAttachment(request(env), target)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            await flushPendingSave(); expect(await allRows(env)).toEqual(committed); expect(ensure).toHaveBeenCalledOnce();
        } finally { await env.close(); }
    });
});


describe('native journal key ordering during prepared availability commit', () => {
    it.each(['compact', 'reversed', 'whitespace'] as const)(
    'commits and cold-replays the exact %s raw effect while retaining untouched nested Unicode settings', async (encoding) => {
        const selected = { ...file, uri: '', title: 'Original 文 🌿.txt' };
        const rawAttachments = encoding === 'reversed'
            ? JSON.stringify([selected, sibling].map(item => Object.fromEntries(Object.entries(item).reverse())))
            : encoding === 'whitespace' ? '\n ' + JSON.stringify([selected, sibling], null, 2) + ' '
                : JSON.stringify([selected, sibling]);
        const ordered = JSON.parse(rawAttachments) as Attachment[];
        const { env, ensure } = await open(undefined, project('target', { attachments: [selected, sibling] }));
        try {
            const rawSettings = JSON.stringify({ ...useTaskStore.getState().settings, futureUnknown: { zeta: '保留 / 🌿',
                alpha: { 'Ω': '終', 'é': false }, sequence: [{ z: 2, a: null }, '文'] } }, null, 2);
            await env.client().run('UPDATE settings SET data=? WHERE id=1', [rawSettings]);
            await env.restart(undefined, { recoveryLoad: true });
            await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [rawAttachments, 'target']);
            const envelope = value(await privateMethods(env).prepareProjectFileAvailability(downloadRequest(env)));
            const sortedObjects = (input: unknown): unknown => Array.isArray(input) ? input.map(sortedObjects)
                : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort()
                    .map(key => [key, sortedObjects((input as Record<string, unknown>)[key])])) : input;
            // NativeJSON sorts structured object keys but leaves every opaque SQL STRING intact.
            const wire = sortedObjects(JSON.parse(JSON.stringify(envelope))) as typeof envelope;
            expect(Object.keys(wire.prepared.effect.before.attachments![0]))
                .not.toEqual(Object.keys(ordered[0]));
            expect(wire.prepared.effect.rawBefore).toEqual(envelope.prepared.effect.rawBefore);
            expect(wire.prepared.effect.rawAfter).toEqual(envelope.prepared.effect.rawAfter);
            const before = await allRows(env), savedBefore = (before.projects as Record<string, unknown>[]).find(row => row.id === 'target')!;
            expect(savedBefore.attachments).toBe(rawAttachments);
            expect(privateMethods(env).validatePreparedProjectFileAvailability(wire)).toMatchObject({ ok: true });
            await env.restart(undefined, { recoveryLoad: true });
            expect(await allRows(env)).toEqual(before);
            expect(await privateMethods(env).commitPreparedProjectFileAvailability(wire)).toEqual({ ok: true,
                value: { status: 'available', message: null, update: null } });
            const after = await allRows(env);
            const rawAfter = JSON.stringify(ordered.map(item => item.id === selected.id
                ? { ...item, uri: target, localStatus: 'available' } : item));
            expect(after.projects).toEqual((before.projects as Record<string, unknown>[]).map(row => row.id === 'target'
                ? { ...row, attachments: rawAfter, rev: 4, revBy: 'device', updatedAt: envelope.prepared.effect.updateAt } : row));
            expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
            expect((after.settings as Record<string, unknown>[])[0].data).toBe(rawSettings);
            expect(ensure).not.toHaveBeenCalled();
            await env.restart(undefined, { recoveryLoad: true });
            const save = vi.fn(async () => ({ ok: true as const, value: null })), replay = privateMethods(env, save);
            expect(await replay.commitPreparedProjectFileAvailability(wire)).toMatchObject({ ok: true, value: { status: 'available' } });
            expect(save).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(after);
            // Sorting never permits a changed value, either forged in the effect or saved later.
            const forged = JSON.parse(JSON.stringify(wire));
            forged.prepared.effect.after.attachments[0].title = 'Changed real value';
            expect(replay.validatePreparedProjectFileAvailability(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            await env.client().run('UPDATE projects SET supportNotes=? WHERE id=?', ['Later durable value', 'target']);
            const intervening = await allRows(env);
            expect(await replay.commitPreparedProjectFileAvailability(wire)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(save).not.toHaveBeenCalled(); expect(await allRows(env)).toEqual(intervening);
        } finally { await env.close(); }
    });
});


describe('private owned WebDAV Project availability compatibility', () => {
    const api = (env: Awaited<ReturnType<typeof openSqliteHost>>, save = vi.fn(async () => {
        await flushPendingSave(); return { ok: true as const, value: null };
    })) => preparedAvailability.createPreparedProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
        revision: () => value(env.host.getProjectAttachmentEditOptions({ projectId: 'target' })).revision,
        save, translate: key => key }, 'webdav');

    it.each([true, false])('retains original hash/size presence after measured download (%s)', async (known) => {
        const selected = { ...file, uri: '' };
        if (!known) { delete selected.fileHash; delete selected.size; }
        const { env, ensure } = await open(undefined, project('target', { status: 'archived', attachments: [selected, sibling] }));
        try {
            const before = await allRows(env), envelope = value(await api(env).prepareProjectFileAvailability(downloadRequest(env)));
            expect(envelope.prepared.attachmentJSON).toBe(JSON.stringify(selected));
            expect(envelope.prepared.effect.after.attachments).toEqual([{ ...selected, uri: target, localStatus: 'available' }, sibling]);
            expect(await api(env).commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true, value: { status: 'available' } });
            const after = await allRows(env);
            expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
            expect(ensure).not.toHaveBeenCalled();
            await env.restart(undefined, { recoveryLoad: true });
            expect(await api(env).commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true });
            expect(await allRows(env)).toEqual(after);
            const forged = JSON.parse(JSON.stringify(envelope)); forged.request.sha256 = 'b'.repeat(64);
            if (known) expect(api(env).validatePreparedProjectFileAvailability(forged)).toMatchObject({ ok: false });
        } finally { await env.close(); }
    });

    it('restores absent bytes without metadata work when selected canonical metadata is already available', async () => {
        const selected = { ...file, uri: target, localStatus: 'available' as const }; delete selected.fileHash; delete selected.size;
        const { env, ensure } = await open(undefined, project('target', { attachments: [selected, sibling] }));
        try {
            const settingsRows = await env.sql('SELECT data FROM settings WHERE id=1') as { data: string }[];
            const settings = JSON.parse(settingsRows[0].data); delete settings.deviceId;
            await env.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            await env.restart(undefined, { recoveryLoad: true });
            await env.client().run('UPDATE projects SET attachments=? WHERE id=?', [JSON.stringify([selected, sibling]), 'target']);
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            const save = vi.fn(async () => ({ ok: true as const, value: null })), methods = api(env, save);
            const before = await allRows(env), state = useTaskStore.getState(), persistence = getPersistenceStatus();
            const envelope = value(await methods.prepareProjectFileAvailability(downloadRequest(env)));
            expect(envelope.prepared.effect).toMatchObject({ outcome: 'noop', deviceIdToInitialize: null });
            expect(envelope.prepared.effect.rawAfter).toEqual(envelope.prepared.effect.rawBefore);
            expect(await methods.commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true, value: { status: 'available' } });
            expect(await allRows(env)).toEqual(before); expect(save).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled();
            expect(useTaskStore.getState()._allProjects).toBe(state._allProjects); expect(getPersistenceStatus()).toEqual(persistence);
            expect(privateMethods(env).validatePreparedProjectFileAvailability(envelope)).toMatchObject({ ok: false });
            await env.restart(undefined, { recoveryLoad: true });
            expect(await api(env, save).commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true });
            expect(await allRows(env)).toEqual(before); expect(save).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it('freezes only the shared 404 lifecycle patch and cold-replays exact after without another save', async () => {
        const selected = { ...file, uri: '' };
        const { env, ensure } = await open(undefined, project('target', { attachments: [selected, sibling] }));
        try {
            const { sha256: _hash, size: _size, ...selection } = downloadRequest(env), before = await allRows(env);
            const envelope = value(await api(env).prepareProjectFileUnrecoverable({ ...selection, unrecoverableAt: at }));
            expect(envelope.prepared).toMatchObject({ version: 2, kind: 'project-file-unrecoverable', expectation: { kind: 'metadata-only' },
                result: { status: 'unrecoverable', message: 'attachments.unrecoverable', update: null } });
            const expected = { ...selected, localStatus: 'missing', deletedAt: at, updatedAt: at };
            delete expected.cloudKey; delete expected.fileHash;
            expect(envelope.prepared.effect.after.attachments).toEqual([expected, sibling]);
            expect(await allRows(env)).toEqual(before); expect(ensure).not.toHaveBeenCalled();
            expect(privateMethods(env).validatePreparedProjectFileAvailability(envelope)).toMatchObject({ ok: false });
            await env.restart(undefined, { recoveryLoad: true });
            const differentLocale = preparedAvailability.createPreparedProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
                revision: () => request(env).revision, save: async () => { await flushPendingSave(); return { ok: true, value: null }; },
                translate: () => '已改变的语言' }, 'webdav');
            expect(differentLocale.validatePreparedProjectFileAvailability(envelope)).toEqual({ ok: true, value: envelope.prepared.result });
            expect(await differentLocale.commitPreparedProjectFileAvailability(envelope)).toEqual({ ok: true, value: envelope.prepared.result });
            const after = await allRows(env); expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
            await env.restart(undefined, { recoveryLoad: true });
            const save = vi.fn(async () => ({ ok: true as const, value: null }));
            expect(await api(env, save).commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: true });
            expect(await allRows(env)).toEqual(after); expect(save).not.toHaveBeenCalled();
            for (const mutate of [(x: typeof envelope) => { x.request.unrecoverableAt = '2026-10-08T12:00:00.000Z'; },
                (x: typeof envelope) => { x.prepared.effect.rawAfter[0] = 'foreign'; },
                (x: typeof envelope) => { (x.prepared as unknown as Record<string, unknown>).source = {}; }]) {
                const forged = structuredClone(envelope); mutate(forged);
                expect(api(env).validatePreparedProjectFileAvailability(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            await env.client().run('UPDATE projects SET supportNotes=? WHERE id=?', ['Later real value', 'target']);
            const edited = await allRows(env);
            expect(await api(env).commitPreparedProjectFileAvailability(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await allRows(env)).toEqual(edited);
        } finally { await env.close(); }
    });

    it.each(['missing', 'available'] as const)('cached hashless current URI is an exact %s metadata effect', async (localStatus) => {
        const selected = { ...file, uri: target, localStatus }; delete selected.fileHash; delete selected.size;
        const { env, ensure, attachments } = await open(undefined, project('target', { attachments: [selected, sibling] }));
        try {
            const save = vi.fn(async () => { await flushPendingSave(); return { ok: true as const, value: null }; });
            const methods = createProjectAvailabilityMethods({ readiness: () => ({ ok: true, value: null }),
                revision: () => value(env.host.getProjectAttachmentEditOptions({ projectId: 'target' })).revision,
                save, host: () => attachments }, 'cached-webdav');
            const before = await allRows(env);
            expect(await methods.downloadRelocatedProjectAttachment(request(env), target)).toMatchObject({ ok: true, value: { status: 'available' } });
            expect(ensure).toHaveBeenCalledExactlyOnceWith(selected);
            const after = await allRows(env); expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
            if (localStatus === 'available') { expect(after).toEqual(before); expect(save).not.toHaveBeenCalled(); }
            else expect((after.projects as Record<string, unknown>[]).find(row => row.id === 'target')?.attachments)
                .toBe(JSON.stringify([{ ...selected, localStatus: 'available' }, sibling]));
        } finally { await env.close(); }
    });
});
