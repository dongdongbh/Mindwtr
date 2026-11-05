import { afterEach, describe, expect, it } from 'vitest';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { canMoveTaskToChecklist, checklistItemIdForMovedTask, getChecklistMoveTargets } from './task-checklist-move';
import type { AppData, Task } from './types';

const at = '2026-10-01T12:00:00.000Z';
const task = (id: string, patch: Partial<Task> = {}): Task => ({
    id, title: id, status: 'inbox', tags: [], contexts: [], createdAt: at, updatedAt: at, ...patch,
});

let saves: AppData[] = [];
async function open(tasks: Task[]) {
    await flushPendingSave();
    resetForTests();
    saves = [];
    const data: AppData = { tasks, projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-a' } };
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async (saved) => { saves.push(structuredClone(saved)); } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    saves = [];
}
const row = (id: string) => useTaskStore.getState()._tasksById.get(id)!;

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
});

describe('canMoveTaskToChecklist', () => {
    it('accepts only a live, title-only Inbox task', () => {
        expect(canMoveTaskToChecklist(task('a', { title: 'Buy milk', reminderPolicy: 'inherit', pushCount: 0, dueReminderLeadMinutes: 0 }))).toBe(true);
        const blocked: Partial<Task>[] = [
            { status: 'next' }, { deletedAt: at }, { title: '  ' }, { description: 'note' }, { checklist: [{ id: 'c', title: 'x', isCompleted: false }] },
            { attachments: [{ id: 'f', kind: 'link', title: 'f', uri: 'https://example.com', createdAt: at, updatedAt: at }] },
            { startTime: at }, { dueDate: at }, { reviewAt: at }, { recurrence: { rule: 'daily' } }, { contexts: ['@home'] }, { tags: ['#x'] },
            { projectId: 'p' }, { areaId: 'a' }, { sectionId: 's' }, { priority: 'high' }, { energyLevel: 'low' }, { timeEstimate: '15min' },
            { assignedTo: 'Sam' }, { location: 'Home' }, { timeSpentMinutes: 5 }, { repeatReminderMinutes: 10 }, { dueReminderLeadMinutes: 30 },
            { reminderPolicy: 'send' },
        ];
        for (const patch of blocked) expect(canMoveTaskToChecklist(task('a', { title: 'Buy milk', ...patch })), JSON.stringify(patch)).toBe(false);

        expect(canMoveTaskToChecklist(task('a', { description: '  ' }))).toBe(true);
    });

    it('lets the default capture area through, but not a chosen one', () => {
        expect(canMoveTaskToChecklist(task('a', { areaId: 'home' }), 'home')).toBe(true);
        expect(canMoveTaskToChecklist(task('a', { areaId: 'work' }), 'home')).toBe(false);
        expect(canMoveTaskToChecklist(task('a', { areaId: 'home' }))).toBe(false);
    });
});

describe('getChecklistMoveTargets', () => {
    it('lists open tasks other than the source, ones with a checklist first, filtered by title', () => {
        const tasks = [
            task('src'), task('plain', { status: 'next', title: 'Groceries run' }),
            task('list', { status: 'someday', title: 'Groceries', checklist: [{ id: 'c', title: 'eggs', isCompleted: false }] }),
            task('done', { status: 'done' }), task('archived', { status: 'archived' }), task('trashed', { deletedAt: at }),
            task('ref', { status: 'reference', title: 'Packing' }),
        ];
        expect(getChecklistMoveTargets(tasks, 'src').map((t) => t.id)).toEqual(['list', 'plain', 'ref']);
        expect(getChecklistMoveTargets(tasks, 'src', ' groc ').map((t) => t.id)).toEqual(['list', 'plain']);
    });
});

describe('moveTaskToChecklist store action', () => {
    const itemId = checklistItemIdForMovedTask('src');

    it('appends one unchecked item and trashes the source in one save; a retry changes nothing', async () => {
        await open([task('src', { title: ' Eggs ' }), task('target', { status: 'next', checklist: [{ id: 'c1', title: 'Milk', isCompleted: true }] })]);
        expect(await useTaskStore.getState().moveTaskToChecklist('src', 'target')).toEqual({ success: true, id: 'target' });
        await flushPendingSave();
        expect(saves).toHaveLength(1);
        const saved = new Map(saves[0].tasks.map((t) => [t.id, t]));
        expect(saved.get('target')!.checklist).toEqual([{ id: 'c1', title: 'Milk', isCompleted: true }, { id: itemId, title: 'Eggs', isCompleted: false }]);
        expect(saved.get('src')!.deletedAt).toBeTruthy();
        expect(saved.get('target')!.status).toBe('next');

        const targetRev = row('target').rev;
        expect(await useTaskStore.getState().moveTaskToChecklist('src', 'target')).toEqual({ success: true, id: 'target' });
        await flushPendingSave();
        expect(saves).toHaveLength(1);
        expect(row('target').checklist).toHaveLength(2);
        expect(row('target').rev).toBe(targetRev);
    });

    it('refuses a source that is not simple or a target that is closed, writing nothing', async () => {
        await open([task('src', { tags: ['#x'] }), task('simple'), task('target', { status: 'next' }), task('closed', { status: 'done' })]);
        expect((await useTaskStore.getState().moveTaskToChecklist('src', 'target')).success).toBe(false);
        expect((await useTaskStore.getState().moveTaskToChecklist('simple', 'closed')).success).toBe(false);
        expect((await useTaskStore.getState().moveTaskToChecklist('simple', 'simple')).success).toBe(false);
        await flushPendingSave();
        expect(saves).toHaveLength(0);
        expect(row('target').checklist).toBeUndefined();
    });

    it('Undo restores the source and removes only its item, in one save', async () => {
        await open([task('src', { title: 'Eggs' }), task('target', { status: 'next' })]);
        await useTaskStore.getState().moveTaskToChecklist('src', 'target');
        await flushPendingSave();
        saves = [];
        expect((await useTaskStore.getState().undoMoveTaskToChecklist('src', 'target')).success).toBe(true);
        await flushPendingSave();
        expect(saves).toHaveLength(1);
        expect(row('src').deletedAt).toBeUndefined();
        expect(row('src').status).toBe('inbox');
        expect(row('target').checklist).toBeUndefined();

        expect((await useTaskStore.getState().undoMoveTaskToChecklist('src', 'target')).success).toBe(false);
    });
});

describe('canonical title-only eligibility and deterministic identity',()=>{
    it('retains every donor detail guard and the explicit newer-field compatibility guard',()=>{
        const patches:Partial<Task>[]=[{status:'next'},{deletedAt:at},{purgedAt:at},{title:' '},{description:'note'},{attachments:[{id:'a',kind:'link',title:'a',uri:'https://example.com',createdAt:at}]},{checklist:[{id:'x',title:'x',isCompleted:false}]},
            {startTime:at},{dueDate:at},{reviewAt:at},{recurrence:{rule:'daily'}},{relativeStartOffset:{amount:1,unit:'days'}},{contexts:['@a']},{tags:['#a']},{projectId:'p'},{sectionId:'s'},
            {priority:'high'},{energyLevel:'low'},{timeEstimate:'15min'},{assignedTo:'Sam'},{location:'Home'},{timeSpentMinutes:5},{repeatReminderMinutes:10},{reminderPolicy:'send'}];
        expect(canMoveTaskToChecklist(task('source'))).toBe(true);for(const patch of patches)expect(canMoveTaskToChecklist(task('source',patch)),JSON.stringify(patch)).toBe(false);
        expect(canMoveTaskToChecklist(task('source'),null,{dueReminderLeadMinutes:30})).toBe(false);expect(canMoveTaskToChecklist(task('source'),null,{dueReminderLeadMinutes:0})).toBe(true);expect(canMoveTaskToChecklist(task('source'),null,{dueReminderLeadMinutes:null})).toBe(true);
        expect(canMoveTaskToChecklist(task('source',{areaId:'default'}),'default')).toBe(true);expect(canMoveTaskToChecklist(task('source',{areaId:'other'}),'default')).toBe(false);
    });
    it('prefers existing checklists and keeps Unicode identities literal',()=>{const rows=[task('source'),task('plain',{title:'Packing'}),task('list',{title:'Packing list',checklist:[{id:'x',title:'x',isCompleted:false}]}),task('closed',{status:'done'})];
        expect(getChecklistMoveTargets(rows,'source',' PACK ').map(row=>row.id)).toEqual(['list','plain']);expect(checklistItemIdForMovedTask('e\u0301')).not.toBe(checklistItemIdForMovedTask('é'));expect(checklistItemIdForMovedTask('源')).toMatch(/^[0-9a-f-]{36}$/);
    });
});
