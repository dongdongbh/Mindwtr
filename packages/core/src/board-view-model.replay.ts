


import { readFileSync } from 'node:fs';
import { BOARD_FILTER_VISIBILITY, EMPTY_BOARD_FILTER_STATE, type BoardFilterEdit, type BoardFilterState } from './board-view-model';
import type { createNativeHostContract, NativeHostResult } from './native-host-contract';
import type { NativeBoardAction, NativeBoardCard, NativeBoardView } from './native-host-contract-board';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Area, Project, Task } from './types';

type Contract = ReturnType<typeof createNativeHostContract>;
type Observation = Record<string, unknown>;
export type BoardScenario = { name: string; settings: string; taskIds?: string[]; actions: [string, ...unknown[]][] };
export type BoardFixturePart = {
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: BoardScenario[];
    observations: Record<string, Observation[]>;
};
export type BoardViewsFixture = { provenance: Record<string, unknown>; board: BoardFixturePart };

export const loadBoardViewsFixture = (): BoardViewsFixture => JSON.parse(
    readFileSync(new URL('./board-views-parity.fixtures.json', import.meta.url), 'utf8'),
);


const THEME = {
    bg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1', text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6',
    success: '#10b981', warning: '#f59e0b',
};

const REFUSED_COPY = 'n-locked';


export function createBoardRecorder() {
    const log: unknown[][] = [];
    const createdIds = new Map<string, string>();
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
        entry === undefined ? '<undefined>' : entry
    )).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => createdIds.get(match) ?? match));
    return { log, createdIds, normalize };
}
export type BoardRecorder = ReturnType<typeof createBoardRecorder>;

type Recorded = 'updateTask' | 'deleteTask' | 'duplicateTask' | 'reorderBoardTasks';
let realActions: Pick<ReturnType<typeof useTaskStore.getState>, Recorded> | null = null;


export async function seedBoardStore(
    part: BoardFixturePart,
    scenario: BoardScenario,
    recorder: BoardRecorder,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= {
        updateTask: initial.updateTask, deleteTask: initial.deleteTask, duplicateTask: initial.duplicateTask, reorderBoardTasks: initial.reorderBoardTasks,
    };
    const real = realActions;
    const tasks = scenario.taskIds ? part.tasks.filter((task) => scenario.taskIds!.includes(task.id)) : part.tasks;
    let data = JSON.parse(JSON.stringify({ tasks, projects: part.projects, sections: [], areas: part.areas, people: [], settings: part.settings[scenario.settings] }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await adapter.saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const record = (name: string, args: unknown[]) => { recorder.log.push([name, ...(recorder.normalize(args) as unknown[])]); };
    useTaskStore.setState({
        updateTask: async (id, updates) => { record('updateTask', [id, updates]); return real.updateTask(id, updates); },
        deleteTask: async (id) => { record('deleteTask', [id]); return real.deleteTask(id); },
        reorderBoardTasks: async (status, ids, movedTaskId) => { record('reorderBoardTasks', [status, ids, movedTaskId]); return real.reorderBoardTasks(status, ids, movedTaskId); },
        duplicateTask: async (id, asNextAction, copyId) => {
            record('duplicateTask', [id, asNextAction]);
            if (id === REFUSED_COPY) return { success: false, error: 'Copy refused' };
            const result = await real.duplicateTask(id, asNextAction, copyId);
            if (result.id) recorder.createdIds.set(result.id, `<copy:${id}>`);
            return result;
        },
    });
}

const ok = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

let requestCount = 0;
const requestId = () => {
    requestCount += 1;
    return `00000000-0000-4000-9000-${requestCount.toString(16).padStart(12, '0')}`;
};


function readBoard(contract: Contract, filters: BoardFilterState, filterEdit?: BoardFilterEdit) {
    const view = ok(contract.getBoardView({ filters, filterEdit, limit: 3 }));
    const page = (list: 'cards' | 'tokens' | 'projects' | 'chips', total: number, first: unknown[], status?: string) => {
        const all = [...first];
        while (all.length < total) {
            all.push(...ok(contract.getBoardList({
                filters: view.filters, list, status: status as never, offset: all.length, limit: 2, revision: view.revision,
            })).items);
        }
        return all;
    };
    return {
        view,
        cards: view.columns.map((column) => page('cards', column.count, column.cards, column.status) as NativeBoardCard[]),
        tokens: page('tokens', view.sheet.tokens.total, view.sheet.tokens.items) as NativeBoardView['sheet']['tokens']['items'],
        projects: page('projects', view.sheet.projects.total, view.sheet.projects.items) as NativeBoardView['sheet']['projects']['items'],
        chips: page('chips', view.sheet.chips.total, view.sheet.chips.items) as NativeBoardView['sheet']['chips']['items'],
    };
}

export async function replayBoardScenario(input: {
    scenario: BoardScenario;
    recorder: BoardRecorder;
    contract: Contract;
}): Promise<Observation[]> {
    const { scenario, recorder, contract } = input;
    let filters = EMPTY_BOARD_FILTER_STATE;
    let sheetOpen = false;
    let dueExpanded = false;
    let editor: string | null = null;
    const toasts: unknown[][] = [];
    const navigations: unknown[][] = [];
    const seen = { writes: 0, toasts: 0, navigations: 0 };

    const edit = (filterEdit: BoardFilterEdit) => {
        filters = ok(contract.getBoardView({ filters, filterEdit, limit: 1 })).filters;
    };
    const run = (action: NativeBoardAction) => contract.runBoardAction({ requestId: requestId(), action });

    const observe = (): Observation => {
        const { view, cards, tokens, projects, chips } = readBoard(contract, filters);
        const texts: string[] = [];
        if (view.bar.active) texts.push(view.bar.clearLabel);
        texts.push(view.bar.filterLabel);
        view.columns.forEach((column, index) => {
            texts.push(column.label, String(column.count));
            for (const { row, card } of cards[index]) {
                texts.push(view.cardActions.swipes.left.label, row.title);
                if (card.showMetaRow) {
                    if (card.projectTitle) texts.push(card.projectTitle);
                    texts.push(...card.tags, ...card.contexts);
                    if (card.timeEstimateLabel) texts.push(card.timeEstimateLabel);
                }
                texts.push(view.cardActions.swipes.right.label);
            }
            if (column.empty !== null) texts.push(column.empty);
        });
        if (sheetOpen) {
            texts.push(view.sheet.due.label, view.sheet.due.summary, dueExpanded ? '−' : '+');
            if (dueExpanded) texts.push(...view.sheet.due.presets.map((preset) => preset.label));
        }
        const observation = {
            texts,
            bar: {
                search: view.bar.searchQuery,
                searchBorder: view.bar.searchActive ? THEME.tint : THEME.border,
                clearSearch: view.bar.searchActive,
                toggle: [view.bar.active ? THEME.tint : THEME.filterBg, view.bar.active ? THEME.tint : THEME.border, sheetOpen],
            },
            columns: view.columns.map((column, index) => ({
                color: THEME[column.tone],
                badge: THEME[column.tone],
                cards: cards[index].map(({ row, card, boardOrder }) => [
                    row.id, row.status, boardOrder, card.projectTitle ? card.projectColor ?? THEME.secondaryText : null,
                ]),
            })),
            sheet: sheetOpen ? {
                tokens: tokens.map((token) => token.value),
                projects: projects.map((project) => ({ id: project.id, title: project.title })),
                visibility: BOARD_FILTER_VISIBILITY,
                chips: chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                contextMatchMode: view.filters.contextMatchMode,
                tagMatchMode: view.filters.tagMatchMode,
                additional: view.sheet.additionalChips.map((chip) => [chip.id, chip.label]),
                due: [[view.sheet.due.accessibilityLabel, dueExpanded]],
                presets: dueExpanded ? view.sheet.due.presets.map((preset) => [preset.label, preset.selected]) : [],
            } : null,
            editor: editor ? [editor, view.cardActions.editorTab] : null,
            writes: recorder.log.slice(seen.writes),
            toasts: toasts.slice(seen.toasts),
            navigations: navigations.slice(seen.navigations),
        };
        seen.writes = recorder.log.length;
        seen.toasts = toasts.length;
        seen.navigations = navigations.length;
        return recorder.normalize(observation) as Observation;
    };

    const perform = async ([kind, target, ...rest]: [string, ...unknown[]]) => {
        const view = () => ok(contract.getBoardView({ filters, limit: 1 }));

        const shown = (taskId: string) => readBoard(contract, filters).cards.flat().find((card) => card.row.id === taskId)!.row.taskRevision;
        switch (kind) {
            case 'search': return edit({ type: 'setSearch', value: target as string });
            case 'clearSearch': return edit({ type: 'setSearch', value: '' });
            case 'clearAll':
                dueExpanded = false;
                return edit({ type: 'clear' });
            case 'openFilters':
                sheetOpen = true;
                return undefined;
            case 'closeFilters':
                sheetOpen = false;
                dueExpanded = false;
                return undefined;
            case 'toggleToken': return edit({ type: 'toggleToken', value: target as string });
            case 'toggleProject': return edit({ type: 'toggleProject', value: target as string });
            case 'matchMode': return edit({ type: 'setMatchMode', kind: target as 'context' | 'tag', value: rest[0] as 'all' | 'any' });
            case 'chip': return edit(readBoard(contract, filters).chips.find((chip) => chip.id === target)!.edit);
            case 'additionalChip': {
                const chip = view().sheet.additionalChips.find((entry) => entry.id === target)!;
                if (chip.edit.type === 'clearDuePreset') dueExpanded = false;
                return edit(chip.edit);
            }
            case 'dueToggle':
                dueExpanded = !dueExpanded;
                return undefined;
            case 'duePreset':
                dueExpanded = false;
                return edit({ type: 'toggleDuePreset', preset: target as never });
            case 'drag':
                ok(await run({
                    type: 'moveCard', taskId: target as string, status: rest[0] as never, afterId: rest[1] as string | null | undefined, filters,
                    taskRevision: shown(target as string),
                }));
                return undefined;
            case 'tap':
                editor = target as string;
                return undefined;
            case 'closeEditor':
                editor = null;
                return undefined;
            case 'swipe': {
                for (const action of view().cardActions.swipes[rest[0] as 'left' | 'right'].actions) {
                    if (action === 'trash') {
                        ok(await run({ type: 'trashTask', taskId: target as string, taskRevision: shown(target as string) }));
                        continue;
                    }
                    const copied = await run({ type: 'duplicateTask', taskId: target as string });
                    if (copied.ok && copied.value.open) navigations.push([copied.value.open.taskId, copied.value.open.projectId ?? undefined, copied.value.open.tab]);
                    else if (!copied.ok) toasts.push(['error', view().cardActions.errorTitle, copied.error.message]);
                }
                return undefined;
            }
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };

    const observations = [observe()];
    for (const action of scenario.actions) {
        await perform(action);
        await flushPendingSave();
        observations.push(observe());
    }
    return observations;
}
