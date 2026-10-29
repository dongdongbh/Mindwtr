import { afterEach, describe, expect, it } from 'vitest';
import { getTranslator } from './i18n';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';
import { generateUUID } from './uuid';

/**
 * Native Android's project next-action prompt (RN's project-next-action-prompt.tsx and ProjectNextActionPromptModal.tsx), one
 * test per RN fix it ports: b98ced27a (the prompt), 8fedf16e2 (#874 Complete project), 321443606 (#859 quick-add text),
 * 16ebbfe79 (#911 a sequential section's prompt), 9dea771b5 (Save & edit), e7735a51e (titles inserted literally), f34284f8c
 * (the shared quick-add options), d25316cf9 (#1429 a Per section project's sequential section).
 */
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const NOW = new Date().toISOString();
const task = (id: string, status: Task['status'], fields: Partial<Task> = {}): Task => ({
    id, title: `Title ${id}`, status, tags: [], contexts: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a',
    projectId: 'project', ...fields,
} as Task);
const project = (fields: Partial<Project> = {}): Project => ({
    id: 'project', title: 'Launch', status: 'active', order: 0, color: '#94a3b8', tagIds: [], createdAt: NOW, updatedAt: NOW,
    rev: 1, revBy: 'device-a', ...fields,
} as Project);
const section = (id: string, fields: Partial<Section> = {}): Section => ({
    id, projectId: 'project', title: `Section ${id}`, order: 0, createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a', ...fields,
} as Section);

async function openHost(data: Partial<AppData>) {
    await flushPendingSave();
    resetForTests();
    let saved = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-a' }, ...data };
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(saved)),
        saveData: async (next) => { saved = JSON.parse(JSON.stringify(next)); },
    });
    // Each test loads its own library: the previous one's rows must not count as rows a save would drop.
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
        tasks: [], _allTasks: [], projects: [], _allProjects: [], sections: [], _allSections: [] } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
}
type Host = Awaited<ReturnType<typeof openHost>>;
const complete = async (host: Host, id: string) => {
    value(await host.completeTask({ id, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!) }));
    return value(host.getProjectNextActionPrompt({ taskId: id })).prompt;
};
const stored = (id: string) => useTaskStore.getState()._tasksById.get(id);
const t = getTranslator('en');
const lines: LogPayload[] = [];

describe('native host contract: project next-action prompt', () => {
    afterEach(() => {
        setLogger(consoleLogger);
        lines.length = 0;
    });

    it('asks after a project\'s last next action is done, with RN\'s words and candidates (b98ced27a)', async () => {
        const host = await openHost({ tasks: [task('last', 'next'), task('waits', 'waiting'), task('later', 'someday')], projects: [project()] });
        const prompt = await complete(host, 'last');
        expect(prompt).toEqual({
            taskId: 'last', projectId: 'project', projectRevision: expect.any(String), scope: 'project',
            title: t('projects.nextActionPromptTitle'),
            description: 'Choose or add the next action for Launch.',
            choose: { label: t('projects.nextActionPromptChooseExisting'), items: expect.arrayContaining([
                { id: 'waits', title: 'Title waits', status: 'waiting', statusLabel: t('status.waiting'), taskRevision: taskRevisionOf(stored('waits')!) },
            ]) },
            add: { label: t('projects.nextActionPromptAddNew'), placeholder: t('projects.nextActionPromptPlaceholder'),
                saveAndEdit: t('quickAdd.saveAndEdit'), button: t('projects.nextActionPromptAddButton') },
            completeProject: { label: t('projects.nextActionPromptComplete') },
            skip: t('common.skip'),
            failure: { title: t('common.error'), message: t('projects.nextActionPromptFailed') },
        });
    });

    it('stays quiet while the project still has a next action, for a task outside a project, and in an archived project', async () => {
        const host = await openHost({ tasks: [task('a', 'next'), task('b', 'next'), task('loose', 'next', { projectId: undefined })], projects: [project()] });
        expect(await complete(host, 'a')).toBeNull();
        expect(await complete(host, 'loose')).toBeNull();
        const archived = await openHost({ tasks: [task('a', 'next')], projects: [project({ status: 'archived' })] });
        expect(value(archived.getProjectNextActionPrompt({ taskId: 'a' })).prompt).toBeNull();
    });

    it('Choose makes the candidate Next, refuses a candidate changed since, and a replay writes nothing twice', async () => {
        const host = await openHost({ tasks: [task('last', 'next'), task('waits', 'waiting')], projects: [project()] });
        const prompt = (await complete(host, 'last'))!;
        const item = prompt.choose.items[0];
        const requestId = generateUUID();
        const request = { requestId, taskId: 'last', action: 'choose' as const, candidateId: item.id, candidateRevision: item.taskRevision };
        expect(value(await host.runProjectNextAction(request))).toEqual({ action: 'choose', id: 'waits' });
        expect(stored('waits')?.status).toBe('next');
        const revision = taskRevisionOf(stored('waits')!);
        expect(value(await host.runProjectNextAction(request))).toEqual({ action: 'choose', id: 'waits' });
        expect(taskRevisionOf(stored('waits')!)).toBe(revision);
        expect(await host.runProjectNextAction({ ...request, requestId: generateUUID() })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('Complete project archives it and completes its remaining tasks, as RN\'s Archive (8fedf16e2, #874)', async () => {
        const host = await openHost({ tasks: [task('last', 'next'), task('waits', 'waiting')], projects: [project()] });
        const prompt = (await complete(host, 'last'))!;
        expect(value(await host.runProjectNextAction({ requestId: generateUUID(), taskId: 'last', action: 'completeProject',
            projectId: prompt.projectId, projectRevision: prompt.projectRevision }))).toEqual({ action: 'completeProject', id: 'project' });
        expect(useTaskStore.getState()._projectsById.get('project')?.status).toBe('archived');
        expect(stored('waits')?.status).not.toBe('waiting');
    });

    it('Add parses the capture sheet\'s quick-add grammar into the project as Next unless a status is typed (321443606, #859)', async () => {
        const host = await openHost({ tasks: [task('last', 'next')], projects: [project()] });
        await complete(host, 'last');
        const plain = value(await host.runProjectNextAction({ requestId: generateUUID(), taskId: 'last', action: 'add', text: ' Draft brief @phone ', openAfterSave: false }));
        expect(stored(plain.id)).toMatchObject({ status: 'next', projectId: 'project', contexts: ['@phone'] });
        const waiting = value(await host.runProjectNextAction({ requestId: generateUUID(), taskId: 'last', action: 'add', text: 'Hear back /waiting', openAfterSave: false }));
        expect(stored(waiting.id)).toMatchObject({ status: 'waiting', projectId: 'project' });
    });

    it('Add uses the shared quick-add options: priorities and estimates off parse neither (f34284f8c)', async () => {
        const host = await openHost({ tasks: [task('last', 'next')], projects: [project()],
            settings: { deviceId: 'device-a', gtd: {}, features: { priorities: false, timeEstimates: false } } });
        await complete(host, 'last');
        const added = value(await host.runProjectNextAction({ requestId: generateUUID(), taskId: 'last', action: 'add',
            text: 'Call vendor /priority:high /estimate:45m', openAfterSave: false }));
        expect(stored(added.id)).not.toHaveProperty('priority');
        expect(stored(added.id)).not.toHaveProperty('timeEstimate');
    });

    it('Save & edit answers openAfterSave with the new task, and its replay finds the same task (9dea771b5)', async () => {
        const host = await openHost({ tasks: [task('last', 'next')], projects: [project()] });
        await complete(host, 'last');
        const request = { requestId: generateUUID(), taskId: 'last', action: 'add' as const, text: 'Write plan', openAfterSave: true };
        const added = value(await host.runProjectNextAction(request));
        expect(added).toEqual({ action: 'add', id: expect.any(String), openAfterSave: true });
        expect(value(await host.runProjectNextAction(request))).toEqual(added);
        expect(useTaskStore.getState()._allTasks.filter((row) => row.title === 'Write plan')).toHaveLength(1);
    });

    it('a sequential section left without a next action asks for that section, without Complete project (16ebbfe79, #911)', async () => {
        const host = await openHost({
            tasks: [task('s1', 'next', { sectionId: 'one' }), task('s1b', 'waiting', { sectionId: 'one' }), task('s2', 'next', { sectionId: 'two' })],
            projects: [project({ isSequential: true, sequentialScope: 'section' } as Partial<Project>)],
            sections: [section('one'), section('two')],
        });
        const prompt = (await complete(host, 's1'))!;
        expect(prompt.scope).toBe('section');
        expect(prompt.description).toBe('Choose or add the next action for Section one in Launch.');
        expect(prompt.completeProject).toBeNull();
        expect(prompt.choose.items.map((item) => item.id)).toEqual(['s1b']);
        const added = value(await host.runProjectNextAction({ requestId: generateUUID(), taskId: 's1', action: 'add', text: 'Next in one', openAfterSave: false }));
        expect(stored(added.id)?.sectionId).toBe('one');
    });

    it('a Per section project\'s sequential section prompts for itself (d25316cf9, #1429)', async () => {
        const host = await openHost({
            tasks: [task('s1', 'next', { sectionId: 'one' }), task('s2', 'next', { sectionId: 'two' })],
            projects: [project({ perSectionFlow: true } as Partial<Project>)],
            sections: [section('one', { isSequential: true } as Partial<Section>), section('two')],
        });
        expect((await complete(host, 's1'))?.scope).toBe('section');
    });

    it('inserts titles literally into RN\'s template (e7735a51e)', async () => {
        const host = await openHost({ tasks: [task('last', 'next')], projects: [project({ title: 'Cost $& {{section}}' })] });
        expect((await complete(host, 'last'))?.description).toBe('Choose or add the next action for Cost $& {{section}}.');
    });

    it('refuses a malformed action, and logs each saved action with no title', async () => {
        const host = await openHost({ tasks: [task('last', 'next')], projects: [project()] });
        await complete(host, 'last');
        expect(await host.runProjectNextAction({ requestId: 'nope', taskId: 'last', action: 'add', text: 'x', openAfterSave: false })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.runProjectNextAction({ requestId: generateUUID(), taskId: 'last', action: 'add', text: '   ', openAfterSave: false } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        setLogger((payload) => lines.push(payload));
        value(await host.runProjectNextAction({ requestId: generateUUID(), taskId: 'last', action: 'add', text: 'Secret words', openAfterSave: false }));
        const line = lines.find((entry) => entry.context?.releaseCheck === 'v1.3.8/native-project-next-action');
        expect(line?.context).toMatchObject({ outcome: 'add' });
        expect(JSON.stringify(lines)).not.toContain('Secret words');
    });
});
