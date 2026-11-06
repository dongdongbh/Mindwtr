import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTranslator } from './i18n';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { Area, Project, Section, Task } from './types';

const T0 = '2026-09-01T00:00:00.000Z';
const DELETED = '2036-09-01T00:00:00.000Z';
const project = (id: string, title: string, order: number, areaId: string, extra: Partial<Project> = {}): Project => ({
    id, title, order, areaId, status: 'active', color: '#123456', tagIds: [], createdAt: T0, updatedAt: T0, ...extra,
});
const area = (id: string, name: string, order: number, extra: Partial<Area> = {}): Area => ({
    id, name, order, createdAt: T0, updatedAt: T0, ...extra,
});
const section = (id: string, title: string, order: number, projectId = 'p-z', extra: Partial<Section> = {}): Section => ({
    id, title, order, projectId, createdAt: T0, updatedAt: T0, ...extra,
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', contexts: [], tags: [], createdAt: T0, updatedAt: T0, ...extra,
});
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

describe('native task draft destination picker', () => {
    let host: ReturnType<typeof createNativeHostContract>;
    let saveData: ReturnType<typeof vi.fn>;
    const draftOf = (id = 'edit') => value(host.getTaskEditorModel({ id })).draft;
    const read = (draft = draftOf(), query = '', id = 'edit') => value(host.getTaskDraftDestinationPicker({ id, draft, query }));
    const groupIds = (draft = draftOf(), query = '') => Object.fromEntries(read(draft, query).destination.groups.map(
        (group) => [group.kind, group.choices.map((choice) => choice.id)],
    ));

    beforeEach(async () => {
        resetForTests();
        saveData = vi.fn().mockResolvedValue(undefined);
        setStorageAdapter({
            getData: async () => ({
                tasks: [task('edit', { projectId: 'p-z', sectionId: 's-z', rev: 7 }),
                    task('readonly', { status: 'reference', projectId: 'p-old' }), task('deleted', { deletedAt: DELETED })],
                projects: [project('p-z', ' Zeta ', 9, 'a-work'), project('p-a', 'Alpha', 1, 'a-work'),
                    project('p-b', 'Beta', 0, 'a-home'), project('p-later', 'Later', 2, 'a-home', { status: 'someday' }),
                    project('p-old', 'Old', 3, 'a-work', { status: 'archived' }),
                    project('p-gone', 'Gone', 4, 'a-work', { deletedAt: DELETED })],
                areas: [area('a-work', 'Work', 2), area('a-home', 'Home', 0), area('a-10', 'Area 10', 1),
                    area('a-2', 'Area 2', 1), area('a-gone', 'Gone', -1, { deletedAt: DELETED })],
                sections: [section('s-z', 'Zulu', 1), section('s-b', 'Beta', 0), section('s-a', 'Alpha', 0),
                    section('s-other', 'Other', 0, 'p-a'), section('s-gone', 'Gone', -1, 'p-z', { deletedAt: DELETED })],
                people: [], settings: {},
            }),
            saveData,
        });
        useTaskStore.setState({
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        });
        host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        await flushPendingSave();
        saveData.mockClear();
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    it('returns one combined row, existing ordered choices and exact draft-only move patches', () => {
        const draft = draftOf();
        const before = useTaskStore.getState();
        const picker = read(draft);
        expect(picker).toMatchObject({ version: 1, id: 'edit', readOnly: false, query: '', destination: {
            fieldId: 'project', label: 'Destination', value: ' Zeta ',
        }, section: { visible: true, label: 'Project section', value: 'Zulu' } });
        expect(picker.destination.groups.map(({ kind, label }) => [kind, label])).toEqual([
            ['none', null], ['project', 'Projects'], ['area', 'Area'],
        ]);
        expect(groupIds()).toEqual({ none: [''], project: ['p-z', 'p-a', 'p-b', 'p-later'], area: ['a-home', 'a-2', 'a-10', 'a-work'] });
        const choices = picker.destination.groups.flatMap((group) => group.choices);
        for (const [id, patch] of [
            ['p-z', { projectId: 'p-z', areaId: '', sectionId: 's-z' }],
            ['p-a', { projectId: 'p-a', areaId: '', sectionId: '' }],
            ['a-home', { projectId: '', areaId: 'a-home', sectionId: '' }],
            ['', { projectId: '', areaId: '', sectionId: '' }],
        ] as const) {
            const choice = choices.find((item) => item.id === id)!;
            expect(choice.patch).toEqual(patch);
            expect(value(host.editTaskDraft({ id: 'edit', draft, edit: { type: 'fields', patch: choice.patch } })).draft).toMatchObject(patch);
        }
        expect(choices.filter((choice) => choice.selected).map((choice) => choice.id)).toEqual(['p-z']);
        expect(JSON.parse(JSON.stringify(picker))).toEqual(picker);
        expect(useTaskStore.getState()).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('on Android, lists projects in the Projects view order with Someday / Waiting after them, as RN (78dafc4a2, ebdfa59ed, #1467)', async () => {
        const grouped = createNativeHostContract({ projectPickerGroups: true });
        expect(await grouped.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const draft = value(grouped.getTaskEditorModel({ id: 'edit' })).draft;
        const picker = value(grouped.getTaskDraftDestinationPicker({ id: 'edit', draft, query: '' }));
        expect(picker.destination.groups.map((group) => [group.kind, group.label, group.choices.map((choice) => choice.id)])).toEqual([
            ['none', null, ['']], ['project', 'Projects', ['p-b', 'p-a', 'p-z']], ['project', 'Someday / Waiting', ['p-later']],
            ['area', 'Area', ['a-home', 'a-2', 'a-10', 'a-work']],
        ]);
        const searched = value(grouped.getTaskDraftDestinationPicker({ id: 'edit', draft, query: 'a' }));
        expect(searched.destination.groups.filter((group) => group.kind === 'project').map((group) => group.choices.map((choice) => choice.id)))
            .toEqual([['p-b', 'p-a', 'p-z'], ['p-later']]);
        expect(groupIds()).toEqual({ none: [''], project: ['p-z', 'p-a', 'p-b', 'p-later'], area: ['a-home', 'a-2', 'a-10', 'a-work'] });
    });

    it('filters browsing by the direct area, searches across areas, and never infers an area from a project', () => {
        const direct = { ...draftOf(), projectId: '', sectionId: '', areaId: 'a-work' };
        expect(groupIds(direct).project).toEqual(['p-z', 'p-a']);
        expect(read(direct).destination.value).toBe('Work');
        expect(read(direct).destination.groups.find((group) => group.kind === 'area')?.choices.find((choice) => choice.id === 'a-work')?.selected).toBe(true);
        expect(groupIds(direct, '  bEtA  ').project).toEqual(['p-b']);
        expect(read(direct, '  bEtA  ').query).toBe('  bEtA  ');
        expect(groupIds({ ...direct, areaId: '' }).project).toEqual(['p-z', 'p-a', 'p-b', 'p-later']);
        expect(groupIds(draftOf()).project).toEqual(['p-z', 'p-a', 'p-b', 'p-later']);
        expect(groupIds(direct, '  aReA  ').area).toEqual(['a-2', 'a-10']);
        expect(groupIds(direct, 'nothing')).toEqual({ none: [''], project: [], area: [] });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('uses actual layout order and visibility, including populated hidden fields', () => {
        const draft = { ...draftOf(), projectId: '', areaId: '', sectionId: '' };
        useTaskStore.setState({ settings: { gtd: { taskEditor: { order: ['area', 'project'], hidden: [] } } } });
        expect(read(draft).destination.fieldId).toBe('area');
        useTaskStore.setState({ settings: { gtd: { taskEditor: { hidden: ['project', 'section'] } } } });
        expect(read(draft).destination.fieldId).toBe('area');
        expect(groupIds(draft)).not.toHaveProperty('project');
        expect(read(draft).section).toMatchObject({ visible: false, choices: [] });
        useTaskStore.setState({ settings: { gtd: { taskEditor: { hidden: ['project', 'area', 'section'] } } } });
        expect(read(draft).destination.fieldId).toBeNull();
        expect(groupIds(draft)).toEqual({ none: [''] });
        expect(read(draft).destination.groups[0].choices[0]).toMatchObject({ selected: true, label: 'None' });

        expect(read(draftOf()).destination.fieldId).toBe('project');
        expect(read(draftOf()).section.visible).toBe(true);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('returns None then live sections by order/title and changes only sectionId', () => {
        const draft = draftOf();
        const picker = read(draft);
        expect(picker.section.choices.map(({ id, label, selected }) => [id, label, selected])).toEqual([
            ['', 'No Section', false], ['s-a', 'Alpha', false], ['s-b', 'Beta', false], ['s-z', 'Zulu', true],
        ]);
        for (const choice of picker.section.choices) {
            expect(choice.patch).toEqual({ sectionId: choice.id });
            expect(value(host.editTaskDraft({ id: 'edit', draft, edit: { type: 'fields', patch: choice.patch } })).draft)
                .toEqual({ ...draft, sectionId: choice.id });
        }
        expect(read(draft, '  bET  ').section.choices.map(({ id }) => id)).toEqual(['', 's-b']);
        expect(read(draft, 'nothing').section.choices.map(({ id }) => id)).toEqual(['']);
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each(['missing', 's-gone', 's-other'])('shows RN fallback for stale section %s without normalizing the draft', (sectionId) => {
        const draft = { ...draftOf(), sectionId };
        const before = structuredClone(draft);
        const picker = read(draft);
        expect(picker.section.value).toBe('No Section');
        expect(picker.section.choices.some((choice) => choice.id === sectionId)).toBe(false);
        expect(picker.destination.groups.find((group) => group.kind === 'project')?.choices.find((choice) => choice.id === 'p-z')?.patch.sectionId).toBe(sectionId);
        expect(draft).toEqual(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('keeps archived-parent readOnly and resolves unavailable destination labels like RN', () => {
        const before = useTaskStore.getState();
        expect(read(draftOf('readonly'), '', 'readonly')).toMatchObject({ readOnly: true, destination: { value: 'Old' } });
        expect(read({ ...draftOf(), projectId: 'p-gone' }).destination.value).toBe('No Project');
        expect(read({ ...draftOf(), projectId: '', areaId: 'a-gone' }).destination.value).toBe('No Area');
        expect(useTaskStore.getState()).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('returns every matching existing choice beyond the usual native window size', () => {
        useTaskStore.setState({ _allProjects: Array.from({ length: 151 }, (_, index) => project(`p-${index}`, `Project ${index}`, index, 'a-work')) });
        expect(read().destination.groups.find((group) => group.kind === 'project')?.choices).toHaveLength(151);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('uses the host language for destination, groups, None and section labels', async () => {
        expect(await host.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' })).toMatchObject({ ok: true });
        const t = getTranslator('zh');
        const picker = read();
        expect(picker.destination.label).toBe(t('task.destination'));
        expect(picker.destination.groups.map((group) => group.label)).toEqual([null, t('nav.projects'), t('taskEdit.areaLabel')]);
        expect(picker.destination.groups[0].choices[0].label).toBe(t('common.none'));
        expect(picker.section.label).toBe(t('taskEdit.sectionLabel'));
        expect(picker.section.choices[0].label).toBe(t('taskEdit.noSectionOption'));
        expect(saveData).not.toHaveBeenCalled();
    });

    it('returns RN empty labels for empty, whitespace and nonmatching queries without counting None', () => {
        const noMatches = getTranslator('en')('common.noMatches');
        for (const query of ['', '   ', 'does not match']) {
            const picker = read(draftOf(), query);
            expect(picker.destination.emptyLabel).toBe(query === 'does not match' ? noMatches : null);
            expect(picker.section.emptyLabel).toBe(query === 'does not match' ? noMatches : null);
        }
        useTaskStore.setState({ settings: { gtd: { taskEditor: { hidden: ['project', 'area'] } } } });
        const emptyDraft = { ...draftOf(), projectId: '', sectionId: '', areaId: '' };
        for (const query of ['', '   ', 'does not match']) {
            const picker = read(emptyDraft, query);
            expect(picker.destination.groups).toHaveLength(1);
            expect(picker.destination.groups[0].kind).toBe('none');
            expect(picker.destination.emptyLabel).toBe(noMatches);
            expect(picker.section.emptyLabel).toBe(query === 'does not match' ? noMatches : null);
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it('validates readiness, full drafts, query and unknown fields without writing', () => {
        const draft = draftOf();
        const before = useTaskStore.getState();
        const input = { id: 'edit', draft, query: '' };
        expect(createNativeHostContract().getTaskDraftDestinationPicker(input)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        for (const invalid of [null, {}, { ...input, id: '' }, { ...input, query: undefined }, { ...input, query: 3 },
            { ...input, draft: {} }, { ...input, draft: { ...draft, extra: 'unknown' } },
            { ...input, draft: { ...draft, status: 'cancelled' } }, { ...input, extra: 'unknown' }]) {
            expect(host.getTaskDraftDestinationPicker(invalid as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const id of ['missing', 'deleted']) {
            expect(host.getTaskDraftDestinationPicker({ ...input, id })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        }
        expect(useTaskStore.getState()).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });
});
