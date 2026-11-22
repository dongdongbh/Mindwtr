import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturedWebLinkAttachment } from './attachment-link-utils';
import { executeCaptureTransaction } from './capture';
import { enrichAttachmentLinkTitle, enrichCapturedTaskLinkTitle } from './link-title-enrichment';
import { parseQuickAdd } from './quick-add';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { runStoreCommand } from './store-write-gate';
import type { AppData, Task } from './types';

const uri = 'https://example.com/write-tomorrow/reading?query=a%2Fb#chapter';
const pageTitle = 'Read next /due:tomorrow #work';
const createdAt = '2026-01-01T00:00:00.000Z';
const task: Task = { id: 'capture', title: uri, status: 'inbox', contexts: [], tags: [], createdAt, updatedAt: createdAt, rev: 1 };
const initial = (): AppData => ({ tasks: [{ ...task, attachments: [createCapturedWebLinkAttachment(uri, new Date(createdAt))] }], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' } });

const clientOf = (database: DatabaseSync): SqliteClient => ({
    exec: async (sql) => { database.exec(sql); },
    run: async (sql, params = []) => { database.prepare(sql).run(...params as never[]); },
    all: async <T>(sql: string, params: unknown[] = []) => database.prepare(sql).all(...params as never[]) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => database.prepare(sql).get(...params as never[]) as T | undefined,
});

describe('captured link title writes', () => {
    let directory: string;
    let database: DatabaseSync;
    let external: DatabaseSync;
    let adapter: SqliteAdapter;

    const seed = async (data: AppData) => {
        await adapter.saveData(data);
        useTaskStore.setState({ _allTasks: data.tasks, _allProjects: data.projects, settings: data.settings });
    };

    beforeEach(async () => {
        resetForTests();
        directory = mkdtempSync(join(homedir(), 'mindwtr-link-title-test-'));
        const path = join(directory, 'data.sqlite');
        database = new DatabaseSync(path);
        external = new DatabaseSync(path);
        adapter = new SqliteAdapter(clientOf(database));
        setStorageAdapter(adapter);
        await seed(initial());
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetForTests();
        database.close();
        external.close();
        rmSync(directory, { recursive: true, force: true });
    });

    it('saves the URL and openable attachment before lookup, then enriches both without reparsing the title', async () => {
        const state = useTaskStore.getState();
        const first = await executeCaptureTransaction({ parsed: parseQuickAdd(uri), rawInput: uri, projects: [] }, state);
        expect(first.success).toBe(true);
        if (!first.success || !first.createdTaskId) throw new Error('Expected a captured link task');
        const id = first.createdTaskId;
        const offline = vi.fn(async () => null);
        await expect(enrichCapturedTaskLinkTitle(id, uri, offline)).resolves.toBe(false);
        expect(offline).toHaveBeenCalledOnce();
        const before = (await adapter.getData()).tasks.find((row) => row.id === id);
        expect(before).toMatchObject({ title: uri, attachments: [{ kind: 'link', uri }] });

        await expect(enrichCapturedTaskLinkTitle(id, uri, async () => pageTitle)).resolves.toBe(true);
        const after = (await adapter.getData()).tasks.find((row) => row.id === id);
        expect(after).toMatchObject({
            title: pageTitle, status: 'inbox', tags: [],
            attachments: [{ title: pageTitle, kind: 'link', uri, id: before?.attachments?.[0].id }],
        });
        expect(after?.dueDate).toBeUndefined();
        expect(useTaskStore.getState()._tasksById.get(id)?.title).toBe(pageTitle);
    });

    it('does no network work when the device preference is off', async () => {
        const before = initial();
        await seed({ ...before, settings: { ...before.settings, fetchLinkTitles: false } });
        const lookup = vi.fn(async () => pageTitle);
        await expect(enrichCapturedTaskLinkTitle(task.id, uri, lookup)).resolves.toBe(false);
        expect(lookup).not.toHaveBeenCalled();
        expect((await adapter.getData()).tasks[0].title).toBe(uri);
    });

    it('honors a durable opt-out even when this window has stale settings', async () => {
        const before = await adapter.getData();
        await adapter.saveData({ ...before, settings: { ...before.settings, fetchLinkTitles: false } });
        expect(useTaskStore.getState().settings.fetchLinkTitles).toBeUndefined();
        const lookup = vi.fn(async () => pageTitle);
        await expect(enrichCapturedTaskLinkTitle(task.id, uri, lookup)).resolves.toBe(false);
        expect(lookup).not.toHaveBeenCalled();
    });

    it('leaves a nested task write free to finish while a title response arrives', async () => {
        let finishLookup!: (title: string) => void;
        const lookup = vi.fn(() => new Promise<string>((resolve) => { finishLookup = resolve; }));
        const pending = enrichCapturedTaskLinkTitle(task.id, uri, lookup);
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const command = runStoreCommand(async () => {
            await held;
            await useTaskStore.getState().addTask('A concurrent capture');
        });
        finishLookup(pageTitle);
        try {
            await expect(pending).resolves.toBe(false);
        } finally {
            release();
        }
        await command;
        await flushPendingSave();
        expect((await adapter.getData()).tasks.map((row) => row.title)).toContain('A concurrent capture');
    });

    it('leaves a removed link alone when lookup starts after removal', async () => {
        await seed({ ...initial(), tasks: [{ ...task, attachments: [] }] });
        const lookup = vi.fn(async () => pageTitle);
        await expect(enrichCapturedTaskLinkTitle(task.id, uri, lookup)).resolves.toBe(false);
        expect(lookup).not.toHaveBeenCalled();
    });

    it('lets an in-app title edit win while the request is pending', async () => {
        let finish!: (title: string) => void;
        const response = new Promise<string>((resolve) => { finish = resolve; });
        const lookup = vi.fn(() => response);
        const pending = enrichCapturedTaskLinkTitle(task.id, uri, lookup);
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
        await useTaskStore.getState().updateTask(task.id, { title: 'My own reading title' });
        await flushPendingSave();
        finish(pageTitle);
        await expect(pending).resolves.toBe(false);
        expect((await adapter.getData()).tasks[0].title).toBe('My own reading title');
    });

    it('rejects a title replaced by another SQLite writer at compare-and-swap', async () => {
        const conditionalSave = adapter.saveDataIfUnchanged.bind(adapter);
        const save = vi.spyOn(adapter, 'saveDataIfUnchanged').mockImplementationOnce(async (next, expected) => {
            external.exec("UPDATE tasks SET title='Other window title', rev=rev+1 WHERE id='capture'");
            await conditionalSave(next, expected);
        });
        await expect(enrichCapturedTaskLinkTitle(task.id, uri, async () => pageTitle)).resolves.toBe(false);
        expect(save).toHaveBeenCalledOnce();
        expect((await adapter.getData()).tasks[0]).toMatchObject({ title: 'Other window title' });
    });

    it('preserves a concurrent change to another field on a captured task', async () => {
        const conditionalSave = adapter.saveDataIfUnchanged.bind(adapter);
        vi.spyOn(adapter, 'saveDataIfUnchanged').mockImplementationOnce(async (next, expected) => {
            external.exec("UPDATE tasks SET description='Other window note', rev=rev+1 WHERE id='capture'");
            await conditionalSave(next, expected);
        });
        await expect(enrichCapturedTaskLinkTitle(task.id, uri, async () => pageTitle)).resolves.toBe(true);
        expect((await adapter.getData()).tasks[0]).toMatchObject({
            title: pageTitle, description: 'Other window note', rev: 3, attachments: [{ kind: 'link', uri }],
        });
    });

    it('changes only the attachment label and preserves a label edited after lookup starts', async () => {
        const first = createCapturedWebLinkAttachment(uri, new Date(createdAt));
        const second = createCapturedWebLinkAttachment(uri, new Date(createdAt));
        const before = initial();
        await seed({ ...before, tasks: [{ ...task, title: 'My task', attachments: [first, second] }] });
        await expect(enrichAttachmentLinkTitle({ kind: 'task', id: task.id }, first, async () => pageTitle)).resolves.toBe(true);
        let finish!: (title: string) => void;
        const lookup = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
        const pending = enrichAttachmentLinkTitle({ kind: 'task', id: task.id }, second, lookup);
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
        const current = useTaskStore.getState()._tasksById.get(task.id);
        await useTaskStore.getState().updateTask(task.id, {
            attachments: current?.attachments?.map((attachment) => attachment.id === second.id
                ? { ...attachment, updatedAt: new Date().toISOString() } : attachment),
        });
        finish(pageTitle);
        await expect(pending).resolves.toBe(false);
        expect((await adapter.getData()).tasks[0]).toMatchObject({
            title: 'My task', attachments: [{ id: first.id, title: pageTitle, uri }, { id: second.id, title: second.title, uri }],
        });
    });
});
