import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNativeHostContract } from '../../../packages/core/src/native-host-contract';
import { taskRevisionOf } from '../../../packages/core/src/native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import { createTaskDraft } from '../../../packages/core/src/task-draft';
import type { AppData } from '../../../packages/core/src/types';

// The task editor's "..." menu on Android: Share is a Menu read (taskShare) and every write one journaled Menu command
// (taskEditorAction). This runs host-entry's own MENU_READS and MENU_COMMANDS source with core's real contract.
const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const table = (name: string) => {
    const start = entry.indexOf(`const ${name}: `);
    const end = entry.indexOf('\n};', start);
    if (start < 0 || end < 0) throw new Error(`${name} unavailable`);
    return entry.slice(start, end + 3);
};
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `${table('MENU_READS')}\n${table('MENU_COMMANDS')}\nglobalThis.tables = { MENU_READS, MENU_COMMANDS };`);

const at = '2026-10-01T12:00:00.000Z';
async function open() {
    await flushPendingSave();
    resetForTests();
    const data: AppData = { tasks: [{ id: 'task', title: 'Pack the kitchen', status: 'next', tags: [], contexts: [], projectId: 'p',
        checklist: [{ id: 'c1', title: 'Wrap the glasses', isCompleted: false }], createdAt: at, updatedAt: at }],
    projects: [{ id: 'p', title: 'Move house', status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at }],
    sections: [], areas: [], people: [], settings: { deviceId: 'device' } };
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async () => undefined });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const contract = createNativeHostContract();
    expect(await contract.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await contract.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    const context: { contract: typeof contract; withCalendar: (input: unknown) => unknown; tables?: Record<string, Record<string, (input: unknown) => unknown>> } =
        { contract, withCalendar: (input) => input };
    vm.runInNewContext(source, context);
    return { contract, ...context.tables! };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('the task editor menu through host-entry', () => {
    it('the expanded editor\'s Markdown toolbar reads core\'s actions and applies one to the text', async () => {
        const { contract, MENU_READS } = await open();
        expect(MENU_READS.markdownToolbarActions({})).toEqual(contract.getMarkdownToolbarActions());
        expect(MENU_READS.markdownToolbarApply({ value: 'pack the boxes', start: 5, end: 8, action: 'bold' }))
            .toEqual({ ok: true, value: { value: 'pack **the** boxes', start: 7, end: 10 } });
    });

    it('Share reads core\'s getTaskShare for the editor draft', async () => {
        const { contract, MENU_READS } = await open();
        const task = useTaskStore.getState()._tasksById.get('task')!;
        const input = { id: 'task', taskRevision: taskRevisionOf(task), draft: { ...createTaskDraft(task), title: 'Unsaved title' },
            checklist: [{ id: 'c1', title: 'Wrap the glasses', isCompleted: true }] };
        const shared = MENU_READS.taskShare(input) as { ok: boolean; value: { title: string | null; message: string } };
        expect(shared).toEqual(contract.getTaskShare(input as never));
        expect(shared.ok).toBe(true);
        expect(shared.value.message).toContain('Unsaved title');
    });

    it('Create project\'s Expand checklist block reads core\'s getTaskChecklistProjectBlock for the editor draft', async () => {
        const { contract, MENU_READS } = await open();
        const task = useTaskStore.getState()._tasksById.get('task')!;
        const input = { id: 'task', taskRevision: taskRevisionOf(task), draft: { ...createTaskDraft(task), timeEstimate: '30min' },
            checklist: [{ id: 'c1', title: 'Wrap the glasses', isCompleted: false }] };
        const read = MENU_READS.taskChecklistProjectBlock(input) as { ok: boolean; value: { blocked: string | null } };
        expect(read).toEqual(contract.getTaskChecklistProjectBlock(input as never));
        expect(read.value.blocked).toContain('time estimate');
        expect(MENU_READS.taskChecklistProjectBlock({ ...input, draft: createTaskDraft(task) })).toEqual({ ok: true, value: { blocked: null } });
    });

    it('a menu write is core\'s runTaskEditorAction', async () => {
        const { MENU_COMMANDS } = await open();
        const requestId = '00000000-0000-4000-8000-000000000401';
        const task = useTaskStore.getState()._tasksById.get('task')!;
        expect(await MENU_COMMANDS.taskEditorAction({ requestId, taskId: 'task', taskRevision: taskRevisionOf(task), kind: 'convertToSection' }))
            .toEqual({ ok: true, value: { kind: 'convertToSection', outcome: 'saved', projectId: 'p', sectionId: requestId } });
    });
});
