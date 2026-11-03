import { buildBulkTaskTokenUpdates, collectBulkTaskTokens, type BulkTaskTokenField, type BulkTaskTokenMode } from './bulk-task-tokens';
import { taskMatchesContextOrTagSelection, type ContextOrTagMatchMode } from './hierarchy-utils';
import { tFallback } from './i18n';
import type { StoreActionResult, TaskStore } from './store-types';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { isTaskFinished } from './task-status';
import { getFrequentTaskTokens, getUsedTaskTokens } from './task-token-usage';
import { getSavedTaxonomyTokens } from './taxonomy-catalog';
import { baseTextCollator, sortTasksBy } from './task-utils';
import type { AppSettings, Task, TaskSortBy, TaskStatus } from './types';


export const CONTEXTS_NO_CONTEXT_TOKEN = '__no_context__';


export const CONTEXTS_BULK_STATUSES = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'] as const satisfies readonly TaskStatus[];

export type ContextsViewFilterSection = {
    kind: 'contexts' | 'tags';
    tokens: string[];
};

const matchesSearch = (token: string, query: string): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery.length === 0 || token.toLowerCase().includes(normalizedQuery);
};


export const buildContextsViewFilterSections = ({
    contextTokens,
    searchQuery,
    selectedTokens = [],
    tagTokens,
}: {
    contextTokens: string[];
    searchQuery: string;
    selectedTokens?: string[];
    tagTokens: string[];
}): ContextsViewFilterSection[] => {
    const choices = (tokens: string[], selected: string[]) => Array.from(new Set([
        ...tokens.filter((token) => matchesSearch(token, searchQuery)),
        ...selected,
    ])).sort((a, b) => baseTextCollator.compare(a, b));
    const selectedLabels = selectedTokens.filter((token) => token !== CONTEXTS_NO_CONTEXT_TOKEN);
    const contexts = choices(contextTokens, selectedLabels.filter((token) =>
        token.startsWith('@') || (!token.startsWith('#') && !tagTokens.includes(token))));
    const tags = choices(tagTokens, selectedLabels.filter((token) =>
        token.startsWith('#') || (!token.startsWith('@') && tagTokens.includes(token))));
    return [
        ...(contexts.length > 0 ? [{ kind: 'contexts' as const, tokens: contexts }] : []),
        ...(tags.length > 0 ? [{ kind: 'tags' as const, tokens: tags }] : []),
    ];
};

export type ContextsChipLabel = {

    label: string;

    depth: number;
};


export function getContextsChipLabels(tokens: readonly string[]): ContextsChipLabel[] {

    const path: string[] = [];
    return tokens.map((token) => {
        while (path.length > 0 && !token.startsWith(`${path[path.length - 1]}/`)) path.pop();
        const slash = token.lastIndexOf('/');
        const leaf = token.slice(slash + 1);
        if (path.length === 0 || slash !== path[path.length - 1].length || !leaf) {
            path.length = 0;
            path.push(token);
            return { label: token, depth: 0 };
        }
        path.push(token);
        return { label: `/${leaf}`, depth: path.length - 1 };
    });
}

export const taskHasContextOrTag = (task: Task): boolean => (
    (task.contexts?.length ?? 0) > 0 || (task.tags?.length ?? 0) > 0
);


export function getContextsRouteTokens(token: string | string[] | undefined): string[] {
    if (Array.isArray(token)) return token.filter(Boolean);
    if (typeof token === 'string' && token.trim()) return [token];
    return [];
}


export function selectContextsRouteTokens(requested: string[]): string[] {
    return requested.includes(CONTEXTS_NO_CONTEXT_TOKEN)
        ? [CONTEXTS_NO_CONTEXT_TOKEN]
        : Array.from(new Set(requested));
}


export function selectContextsToken(selected: string[], token: string): string[] {
    return selected.length === 1 && selected[0] === token ? [] : [token];
}


export function toggleContextsToken(selected: string[], token: string): string[] {
    if (selected.includes(CONTEXTS_NO_CONTEXT_TOKEN)) return [token];
    return selected.includes(token) ? selected.filter((item) => item !== token) : [...selected, token];
}


export function toggleContextsNoContext(selected: string[]): string[] {
    return selected.includes(CONTEXTS_NO_CONTEXT_TOKEN) ? [] : [CONTEXTS_NO_CONTEXT_TOKEN];
}


export function resolveContextsMatchMode(selected: string[], matchMode: ContextOrTagMatchMode): ContextOrTagMatchMode {
    return selected.length === 0 ? 'all' : matchMode;
}


export type ContextsTokenIndex = {

    activeTasks: Task[];
    contextTokens: string[];
    tagTokens: string[];

    untokenedTasks: Task[];
    tokenCounts: Map<string, number>;
};

export function buildContextsTokenIndex(visibleTasks: Task[], { includeFinished = false }: { includeFinished?: boolean } = {}): ContextsTokenIndex {
    const activeTasks = includeFinished ? visibleTasks : visibleTasks.filter((task) => !isTaskFinished(task));
    const tokenCounts = new Map<string, number>();
    const matched = new Set<string>();
    for (const task of activeTasks) {
        matched.clear();
        for (const token of [...(task.contexts ?? []), ...(task.tags ?? [])]) {

            for (let index = token.indexOf('/'); index !== -1; index = token.indexOf('/', index + 1)) {
                matched.add(token.slice(0, index));
            }
            matched.add(token);
        }
        matched.forEach((token) => tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1));
    }
    return {
        activeTasks,
        contextTokens: getUsedTaskTokens(activeTasks, (task) => task.contexts, { includeAncestors: true }),
        tagTokens: getUsedTaskTokens(activeTasks, (task) => task.tags, { includeAncestors: true }),
        untokenedTasks: activeTasks.filter((task) => !taskHasContextOrTag(task)),
        tokenCounts,
    };
}


export const getContextsTokenCount = (index: ContextsTokenIndex, token: string): number => (
    index.tokenCounts.get(token.replace(/\/+$/, '')) ?? 0
);

export type ContextsViewModel = {
    activeTasks: Task[];

    hasTokens: boolean;
    filterSections: ContextsViewFilterSection[];
    noContextSelected: boolean;

    allCount: number;

    noContextCount: number;

    tokenChips: { token: string; kind: ContextsViewFilterSection['kind']; count: number; selected: boolean }[];

    showMatchMode: boolean;
    sortBy: TaskSortBy;

    tasks: Task[];
};

export function buildContextsViewModel({
    index,
    settings,
    selectedTokens,
    matchMode,
    searchQuery,
}: {
    index: ContextsTokenIndex;
    settings: AppSettings | undefined;
    selectedTokens: string[];
    matchMode: ContextOrTagMatchMode;
    searchQuery: string;
}): ContextsViewModel {
    const { activeTasks, contextTokens, tagTokens } = index;
    const filterSections = buildContextsViewFilterSections({ contextTokens, searchQuery, selectedTokens, tagTokens });
    const noContextSelected = selectedTokens.includes(CONTEXTS_NO_CONTEXT_TOKEN);
    const filtered = noContextSelected
        ? index.untokenedTasks
        : selectedTokens.length > 0
            ? activeTasks.filter((task) => taskMatchesContextOrTagSelection(task, selectedTokens, matchMode))
            : activeTasks;
    const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
    return {
        activeTasks,
        hasTokens: filterSections.length > 0 || contextTokens.length + tagTokens.length > 0,
        filterSections,
        noContextSelected,
        allCount: activeTasks.length,
        noContextCount: index.untokenedTasks.length,
        tokenChips: filterSections.flatMap((section) => section.tokens.map((token) => ({
            token,
            kind: section.kind,
            count: getContextsTokenCount(index, token),
            selected: selectedTokens.includes(token),
        }))),
        showMatchMode: selectedTokens.length > 1 && !noContextSelected,
        sortBy,
        tasks: sortTasksBy(filtered, sortBy),
    };
}


export function getContextsEmptyState(
    { hasTokens, selectedTokens }: { hasTokens: boolean; selectedTokens: string[] },
    t: (key: string) => string,
): { icon: 'tag' | 'check'; title: string; message: string } {
    if (!hasTokens) {
        return { icon: 'tag', title: t('contexts.noContexts').split('.')[0], message: t('contexts.noContexts') };
    }
    return {
        icon: 'check',
        title: t('contexts.noTasks'),
        message: selectedTokens.length > 0
            ? `${t('contexts.noTasks')} ${selectedTokens.map((token) => token === CONTEXTS_NO_CONTEXT_TOKEN ? t('contexts.none') : token).join(', ')}`
            : t('contexts.noTasks'),
    };
}


export function getContextsMatchModeLabels(t: (key: string) => string): { label: string; all: string; any: string } {
    return {
        label: `${t('contexts.title')} & ${t('tags.title')}`,
        all: tFallback(t, 'common.all', 'All'),
        any: tFallback(t, 'filters.matchAny', 'Any'),
    };
}


export function getContextsAddTokenOptions(activeTasks: Task[], field: BulkTaskTokenField, settings: AppSettings = {}): string[] {
    const prefix = field === 'tags' ? '#' : '@';
    return Array.from(new Set([
        ...getFrequentTaskTokens(activeTasks, (task) => task[field], 12, { prefix }),
        ...getUsedTaskTokens(activeTasks, (task) => task[field], { prefix }),
        ...getSavedTaxonomyTokens(settings, field === 'tags' ? 'tag' : 'context'),
    ]));
}

export type ContextsTokenPicker = {
    title: string;
    placeholder: string;
    tokens: string[];
    allowCustomValue: boolean;
    multiSelect: boolean;
};


export function getContextsTokenPickerTitle(field: BulkTaskTokenField, action: BulkTaskTokenMode, t: (key: string) => string): string {
    if (field === 'contexts') return action === 'add' ? t('bulk.addContext') : t('bulk.removeContext');
    if (action === 'add') return t('bulk.addTag');
    const removeTag = t('bulk.removeTag');
    return removeTag === 'bulk.removeTag' ? 'Remove tag' : removeTag;
}


export function getContextsTokenPicker({
    field,
    action,
    activeTasks,
    settings,
    selectedIds,
    tasksById,
    t,
}: {
    field: BulkTaskTokenField;
    action: BulkTaskTokenMode;
    activeTasks: Task[];
    settings?: AppSettings;
    selectedIds: string[];
    tasksById: Record<string, Task>;
    t: (key: string) => string;
}): ContextsTokenPicker {
    return {
        title: getContextsTokenPickerTitle(field, action, t),
        placeholder: field === 'tags' ? t('taskEdit.tagsPlaceholder') : t('taskEdit.contextsPlaceholder'),
        tokens: action === 'add'
            ? getContextsAddTokenOptions(activeTasks, field, settings)
            : collectBulkTaskTokens(selectedIds, tasksById, field),
        allowCustomValue: action === 'add',
        multiSelect: action === 'remove',
    };
}


export async function editContextsTaskTokens(
    store: Pick<TaskStore, 'batchUpdateTasks'>,
    { taskIds, tasksById, field, mode, values }: {
        taskIds: string[];
        tasksById: Record<string, Task>;
        field: BulkTaskTokenField;
        mode: BulkTaskTokenMode;
        values: string[];
    },
): Promise<{ changed: false } | { changed: true; count: number; result: StoreActionResult }> {
    const updates = buildBulkTaskTokenUpdates(taskIds, tasksById, field, values, mode);
    if (updates.length === 0) return { changed: false };
    return { changed: true, count: updates.length, result: await store.batchUpdateTasks(updates) };
}
