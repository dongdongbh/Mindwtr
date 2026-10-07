import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createProjectAvailabilityMethods } from './native-host-contract-project-availability';
import { openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
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
