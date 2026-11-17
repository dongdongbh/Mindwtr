import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNativeHostContract } from '../../../packages/core/src/native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import type { AppData } from '../../../packages/core/src/types';
import { readMarkdownReferences } from './host-markdown-references';


const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('const MENU_READS: ');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `${entry.slice(start, entry.indexOf('\n};', start) + 3)}\nglobalThis.MENU_READS = MENU_READS;`);

const at = '2026-10-01T12:00:00.000Z';
async function open(settings: AppData['settings'] = { deviceId: 'device' }) {
    await flushPendingSave();
    resetForTests();
    const data: AppData = { tasks: [
        { id: 'pack', title: 'Pack the kitchen', status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at },
        { id: 'paint', title: 'Paint the hall', status: 'waiting', tags: [], contexts: [], createdAt: at, updatedAt: at },
        { id: 'gone', title: 'Pack the shed', status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at, deletedAt: at },
    ], projects: [{ id: 'move', title: 'Pack and move', status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at }],
    sections: [], areas: [], people: [], settings };
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async () => undefined });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const contract = createNativeHostContract();
    expect(await contract.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    const context: { contract: typeof contract; readMarkdownReferences: typeof readMarkdownReferences; useTaskStore: typeof useTaskStore;
        MENU_READS?: Record<string, (input: unknown) => unknown> } = { contract, readMarkdownReferences, useTaskStore };
    vm.runInNewContext(source, context);
    return context.MENU_READS!;
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('Markdown typing help through host-entry', () => {
    it('rewrites one typed edit with core\'s markdownTextChange', async () => {
        const reads = await open();
        expect(reads.markdownTextChange({ previous: '- milk', next: '- milk\n', start: 6, end: 6, pairs: true }))
            .toEqual({ ok: true, value: { changed: true, value: '- milk\n- ', start: 9, end: 9 } });
        expect(reads.markdownTextChange({ previous: 'a', next: 'a(', start: 1, end: 1, pairs: true }))
            .toEqual({ ok: true, value: { changed: true, value: 'a()', start: 2, end: 2 } });
        expect(reads.markdownTextChange({ previous: 'a', next: 'a(', start: 1, end: 1, pairs: false }))
            .toEqual({ ok: true, value: { changed: false, value: 'a(', start: 1, end: 1 } });
    });

    it('lists up to six live tasks and projects for an open [[ with RN\'s labels, leaving out the edited task', async () => {
        const reads = await open();
        const reply = reads.markdownReferences({ value: 'see [[pa', start: 8, end: 8, taskId: 'paint' }) as {
            ok: true; value: { start: number; end: number; suggestions: Array<{ id: string; title: string; meta: string; token: string }> } };
        expect(reply.ok).toBe(true);
        expect(reply.value.start).toBe(4);
        expect(reply.value.end).toBe(8);
        expect(reply.value.suggestions).toEqual([
            { id: 'project:move', title: 'Pack and move', meta: 'Project • Active', token: '[[project:move|Pack and move]]' },
            { id: 'task:pack', title: 'Pack the kitchen', meta: 'Task • Next', token: '[[task:pack|Pack the kitchen]]' },
        ]);
        expect(reply.value.suggestions.map((s) => s.id)).not.toContain('task:paint');
        expect(reply.value.suggestions.map((s) => s.id)).not.toContain('task:gone');
    });

    it('lists nothing outside an open [[, for a range selection, or when Editor typing help is off', async () => {
        let reads = await open();
        for (const input of [{ value: 'plain text', start: 5, end: 5 }, { value: '[[pa]] done', start: 11, end: 11 }, { value: '[[pack', start: 2, end: 6 }]) {
            expect(reads.markdownReferences(input)).toMatchObject({ ok: true, value: { suggestions: [] } });
        }
        reads = await open({ deviceId: 'device', markdownEditorAssist: false });
        expect(reads.markdownReferences({ value: '[[pa', start: 4, end: 4 })).toMatchObject({ ok: true, value: { suggestions: [] } });
        expect(reads.markdownTextChange({ previous: '- milk', next: '- milk\n', start: 6, end: 6, pairs: true }))
            .toEqual({ ok: true, value: { changed: false, value: '- milk\n', start: 6, end: 6 } });
    });

    it('refuses text without a selection inside it', async () => {
        const reads = await open();
        for (const input of [null, {}, { value: 'a', start: 0, end: 2 }, { value: 'ab', start: 2, end: 1 }, { value: 'a', start: 0, end: 0, taskId: 3 }]) {
            expect(reads.markdownReferences(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });
});
