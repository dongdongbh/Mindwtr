import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { Project, Task } from './types';

const at = '2026-10-01T12:00:00.000Z';
const task = (id: string): Task => ({ id, title: id, status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at });
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...extra,
});
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
};


describe('Project Notes draft preview', () => {
    let host: ReturnType<typeof createNativeHostContract>;
    let writes: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        resetForTests();
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
        writes = vi.fn().mockResolvedValue(undefined);
        setStorageAdapter({ getData: async () => ({ tasks: [task('live')], projects: [project('source', { supportNotes: 'Stored notes' }),
            project('archived', { status: 'archived', supportNotes: 'Old' })], sections: [], areas: [], people: [], settings: {} }), saveData: writes });
        host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        writes.mockClear();
    });

    afterEach(async () => { await flushPendingSave(); resetForTests(); });

    it('resolves the unsaved draft, links included, exactly as the stored notes would be, and writes nothing', async () => {
        const draft = '# Plan\n\nSee [[task:live|Live task]] and [[project:source|Self]].';
        const preview = value(host.getProjectNotesPreview({ projectId: 'source', text: draft }));
        expect(preview.blocks.map((block) => block.type)).toEqual(['heading', 'blank', 'paragraph']);
        expect(JSON.stringify(preview.blocks)).toContain('"id":"live"');
        expect(preview).toMatchObject({ projectId: 'source', direction: 'ltr',
            markdownLabels: { deletedTask: 'deleted task', deletedProject: 'deleted project', copyCode: 'Copy code' } });
        expect(useTaskStore.getState()._allProjects.find((item) => item.id === 'source')?.supportNotes).toBe('Stored notes');
        await flushPendingSave();
        expect(writes).not.toHaveBeenCalled();
    });

    it('answers no blocks for a blank draft and refuses a missing project or a bad draft', () => {
        expect(value(host.getProjectNotesPreview({ projectId: 'source', text: '   ' })).blocks).toEqual([]);
        expect(host.getProjectNotesPreview({ projectId: 'missing', text: 'x' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(host.getProjectNotesPreview({ projectId: 'source', text: 7 } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getProjectNotesPreview({ projectId: 'source', text: 'x', extra: 1 } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});
