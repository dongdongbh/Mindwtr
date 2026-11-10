import React from 'react';
import renderer from 'react-test-renderer';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore, type AppData, type Attachment, type Task } from '@mindwtr/core';
import { SqliteAdapter, type SqliteClient } from '../../../../packages/core/src/sqlite-adapter';
import { useTaskEditState } from './use-task-edit-state';

const logInfo = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../lib/app-log', () => ({ logInfo }));

const sqlValue = (value: unknown): SQLInputValue => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
    throw new Error('Invalid SQLite parameter');
};
const sqliteClient = (db: DatabaseSync): SqliteClient => ({
    exec: async (sql) => { db.exec(sql); },
    run: async (sql, parameters = []) => { db.prepare(sql).run(...parameters.map(sqlValue)); },
    all: async <T,>(sql: string, parameters: unknown[] = []) => db.prepare(sql).all(...parameters.map(sqlValue)) as T[],
    get: async <T,>(sql: string, parameters: unknown[] = []) => db.prepare(sql).get(...parameters.map(sqlValue)) as T | undefined,
});
const at = new Date().toISOString();
const original: Task = { id: 'source', title: 'Original', status: 'next', contexts: [], tags: [], rev: 1, revBy: 'device', createdAt: at, updatedAt: at };
const files: string[] = [];
const databases: DatabaseSync[] = [];
const trees: renderer.ReactTestRenderer[] = [];

afterEach(async () => {
    for (const tree of trees.splice(0)) renderer.act(() => tree.unmount());
    setStorageAdapter({ getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData: async () => undefined });
    await flushPendingSave().catch(() => undefined);
    resetForTests();
    for (const db of databases.splice(0)) db.close();
    for (const file of files.splice(0)) rmSync(file, { recursive: true, force: true });
    logInfo.mockClear();
});

async function open(task: Task = original) {
    await flushPendingSave().catch(() => undefined);
    resetForTests();
    const directory = mkdtempSync(join(tmpdir(), 'mindwtr-preview-completion-'));
    files.push(directory);
    const file = join(directory, 'data.sqlite');
    const db = new DatabaseSync(file); databases.push(db);
    const adapter = new SqliteAdapter(sqliteClient(db));
    const data: AppData = { tasks: [task], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device', gtd: { autoArchiveDays: 0 } } };
    await adapter.saveData(data);
    let fail = false;
    let barrier: (() => Promise<void>) | null = null;
    const saves = vi.fn(async (next: AppData) => {
        if (barrier) await barrier();
        if (fail) throw new Error('SQLite unavailable');
        await adapter.saveData(next);
    });
    setStorageAdapter({ getData: () => adapter.getData(), saveData: saves });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {}, error: null, persistenceFailure: null, isLoading: false });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const onSave = vi.fn((id: string, updates: Partial<Task>) => useTaskStore.getState().updateTask(id, updates));
    const onClose = vi.fn(); const onSaveError = vi.fn(); const settleAttachmentDraft = vi.fn();
    let state: ReturnType<typeof useTaskEditState>;
    function Probe() {
        const tasks = useTaskStore((store) => store.tasks);
        state = useTaskEditState({ task: tasks.find((row) => row.id === task.id) ?? task, tasks, sections: [], visible: true,
            resetCopilotStateRef: { current: () => undefined }, onSave, onClose, onSaveError, settleAttachmentDraft });
        return null;
    }
    renderer.act(() => { trees.push(renderer.create(<Probe />)); });
    return { state: () => state!, onSave, onClose, onSaveError, settleAttachmentDraft, fail: (value: boolean) => { fail = value; },
        barrier: (value: (() => Promise<void>) | null) => { barrier = value; },
        read: async () => {
            const reopened = new DatabaseSync(file);
            try { return await new SqliteAdapter(sqliteClient(reopened)).getData({ rawTasks: true }); }
            finally { reopened.close(); }
        } };
}

describe('Preview completion through the real store and SQLite adapter', () => {
    it('saves raw fields, pending checklist input, attachments and edited recurrence in one durable completion', async () => {
        const env = await open({ ...original, recurrence: { rule: 'daily' }, checklist: [{ id: 'first', title: 'First', isCompleted: false }] });
        const attachment: Attachment = { id: 'link', kind: 'link', title: 'Reference', uri: 'https://example.com', createdAt: at, updatedAt: at };
        renderer.act(() => {
            env.state().titleDraftRef.current = 'Edited title';
            env.state().descriptionDraftRef.current = 'Edited description';
            env.state().setDraftField('contexts', '@home'); env.state().setDraftField('tags', '#edited');
            env.state().setDraftField('recurrence', 'weekly');
            env.state().setChecklist([{ id: 'first', title: 'First', isCompleted: true }]);
            env.state().checklistDraftRef.current = 'Pending item'; env.state().setAttachments([attachment]);
        });
        await renderer.act(async () => { expect(await env.state().draftLifecycle.complete()).toBe(true); });
        expect(env.onSave).toHaveBeenCalledOnce(); expect(env.onClose).toHaveBeenCalledOnce();
        const saved = await env.read();
        const source = saved?.tasks.find((task) => task.id === original.id);
        expect(source).toMatchObject({ title: 'Edited title', description: 'Edited description', status: 'done', contexts: ['@home'], tags: ['#edited'], attachments: [attachment], recurrence: { rule: 'weekly' } });
        expect(source?.checklist?.map((item) => [item.title, item.isCompleted])).toEqual([['First', true], ['Pending item', false]]);
        expect(saved?.tasks.filter((task) => task.id !== original.id)).toHaveLength(1);
        expect(saved?.tasks.find((task) => task.id !== original.id)).toMatchObject({ title: 'Edited title', recurrence: { rule: 'weekly' } });
        expect(logInfo).toHaveBeenCalledWith('Mobile Preview task completion saved', expect.objectContaining({ extra: { releaseCheck: 'v1.3.9/preview-mark-done', platform: 'rn', outcome: 'saved' } }));
    });

    it('blocks repeat taps, Save, Close and draft changes until the durable acknowledgement', async () => {
        const env = await open();
        let release: () => void = () => undefined;
        let reached: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => { reached = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        env.barrier(async () => { reached(); await held; });
        await renderer.act(async () => {
            const first = env.state().draftLifecycle.complete();
            await entered;
            expect(await env.state().draftLifecycle.complete()).toBe(false);
            expect(await env.state().draftLifecycle.save()).toBe(false);
            env.state().draftLifecycle.discard(); env.state().setDraftField('title', 'Must not replace');
            expect(env.onSave).toHaveBeenCalledOnce(); expect(env.onClose).not.toHaveBeenCalled();
            release(); expect(await first).toBe(true);
        });
        expect((await env.read())?.tasks[0]).toMatchObject({ title: 'Original', status: 'done' });
        expect(env.onClose).toHaveBeenCalledOnce();
    });

    it('retries persistence of the applied completion without another domain write or recurring successor', async () => {
        const env = await open({ ...original, recurrence: { rule: 'daily' } });
        renderer.act(() => { env.state().checklistDraftRef.current = 'Retained pending item'; });
        env.fail(true);
        await renderer.act(async () => { expect(await env.state().draftLifecycle.complete()).toBe(false); });
        expect(env.state().completionRetryPending).toBe(true); expect(env.state().taskEditDraft?.draft.status).toBe('done'); expect(env.state().completionError).toContain('SQLite unavailable');
        expect(env.onClose).not.toHaveBeenCalled(); expect(env.settleAttachmentDraft).not.toHaveBeenCalled();
        expect((await env.read())?.tasks).toHaveLength(1);
        expect(useTaskStore.getState().tasks.filter((task) => task.id !== original.id)).toHaveLength(1);
        expect(env.state().checklistDraftRef.current).toBe('Retained pending item');
        renderer.act(() => { env.state().draftLifecycle.discard(); env.state().setDraftField('title', 'Blocked'); });
        env.fail(false);
        await renderer.act(async () => { expect(await env.state().draftLifecycle.save()).toBe(true); });
        expect(env.onSave).toHaveBeenCalledOnce(); expect(env.onClose).toHaveBeenCalledOnce();
        const saved = await env.read();
        expect(saved?.tasks).toHaveLength(2); expect(saved?.tasks.find((task) => task.id === original.id)?.status).toBe('done');
        expect(env.state().completionRetryPending).toBe(false);
    });

    it('forces list completion after appending the pending composer item', async () => {
        const env = await open({ ...original, taskMode: 'list', checklist: [{ id: 'first', title: 'First', isCompleted: false }] });
        renderer.act(() => { env.state().checklistDraftRef.current = 'Pending item'; });
        await renderer.act(async () => { expect(await env.state().draftLifecycle.complete()).toBe(true); });
        const source = (await env.read())?.tasks[0];
        expect(source?.status).toBe('done'); expect(source?.checklist).toHaveLength(2);
        expect(source?.checklist?.map((item) => [item.title, item.isCompleted])).toEqual([['First', false], ['Pending item', false]]);
    });
});
