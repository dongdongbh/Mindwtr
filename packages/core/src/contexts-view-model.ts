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

/**
 * The React Native Contexts screen: which active tasks it lists for the chosen
 * contexts and tags, its chips and their counts, the All/Any switch, the empty
 * state, and the bulk token pickers. The screen keeps only React state.
 */

/** The No context chip's selection value. */
export const CONTEXTS_NO_CONTEXT_TOKEN = '__no_context__';

/** The statuses the bulk bar offers, in its order. */
export const CONTEXTS_BULK_STATUSES = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'] as const satisfies readonly TaskStatus[];

export type ContextsViewFilterSection = {
    kind: 'contexts' | 'tags';
    tokens: string[];
};

const matchesSearch = (token: string, query: string): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery.length === 0 || token.toLowerCase().includes(normalizedQuery);
};

/** The chip sections the search box leaves: contexts, then tags; an empty section is dropped. */
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
    /** The text the chip shows: the full token, or "/" and its last part. */
    label: string;
    /** How many shown ancestors sit above the chip; 0 for a full token. */
    depth: number;
};

/**
 * What each chip of one section shows, in order (#1428). A chip whose parent
 * token is the chip before it, or an earlier chip of the same family run,
 * shows only "/" and its last part: `@person`, `/emma`, `/todd`. Any other
 * chip, including one whose parent the search hid, shows its full token.
 * Display only: selection, counts and accessibility labels keep the full token.
 */
export function getContextsChipLabels(tokens: readonly string[]): ContextsChipLabel[] {
    // The chips from the family root down to the previous chip.
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

/** The tokens a Contexts route parameter asks for. */
export function getContextsRouteTokens(token: string | string[] | undefined): string[] {
    if (Array.isArray(token)) return token.filter(Boolean);
    if (typeof token === 'string' && token.trim()) return [token];
    return [];
}

/** The selection a route opens with: No context alone, or each token once. */
export function selectContextsRouteTokens(requested: string[]): string[] {
    return requested.includes(CONTEXTS_NO_CONTEXT_TOKEN)
        ? [CONTEXTS_NO_CONTEXT_TOKEN]
        : Array.from(new Set(requested));
}

/**
 * A plain chip press (token or No context): the chip alone, or nothing when it
 * already was alone. Adding to the selection is the additive gesture's
 * job (long-press on mobile, Ctrl/Cmd-click on desktop): toggleContextsToken.
 */
export function selectContextsToken(selected: string[], token: string): string[] {
    return selected.length === 1 && selected[0] === token ? [] : [token];
}

/** The additive token chip press: it replaces No context, otherwise toggles itself. */
export function toggleContextsToken(selected: string[], token: string): string[] {
    if (selected.includes(CONTEXTS_NO_CONTEXT_TOKEN)) return [token];
    return selected.includes(token) ? selected.filter((item) => item !== token) : [...selected, token];
}

/** The No context chip press: it turns itself on alone, or off. */
export function toggleContextsNoContext(selected: string[]): string[] {
    return selected.includes(CONTEXTS_NO_CONTEXT_TOKEN) ? [] : [CONTEXTS_NO_CONTEXT_TOKEN];
}

/** An empty selection matches with All. */
export function resolveContextsMatchMode(selected: string[], matchMode: ContextOrTagMatchMode): ContextOrTagMatchMode {
    return selected.length === 0 ? 'all' : matchMode;
}

/**
 * What Contexts derives from the tasks alone, independent of the selection: build it
 * once per store change. `tokenCounts` counts each task once under every token it
 * matches hierarchically (a task tagged `@work/deep` counts under `@work` too).
 */
export type ContextsTokenIndex = {
    /** The unfinished tasks the screen counts and lists from. */
    activeTasks: Task[];
    contextTokens: string[];
    tagTokens: string[];
    /** Active tasks with no context and no tag: the No context chip. */
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
            // Every chip that matches this token: the token, and each part before a "/".
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

/** How many active tasks a chip matches: taskMatchesContextOrTagSelection(task, [token]), counted once. */
export const getContextsTokenCount = (index: ContextsTokenIndex, token: string): number => (
    index.tokenCounts.get(token.replace(/\/+$/, '')) ?? 0
);

export type ContextsViewModel = {
    activeTasks: Task[];
    /** Every context and tag in use; none means the "No contexts found" empty state. */
    hasTokens: boolean;
    filterSections: ContextsViewFilterSection[];
    noContextSelected: boolean;
    /** The All chip's count. */
    allCount: number;
    /** The No context chip's count. */
    noContextCount: number;
    /** The token chips the search leaves, in order, with their counts. */
    tokenChips: { token: string; kind: ContextsViewFilterSection['kind']; count: number; selected: boolean }[];
    /** The All/Any switch shows for two or more tokens, never with No context. */
    showMatchMode: boolean;
    sortBy: TaskSortBy;
    /** The listed tasks, sorted. */
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

/** What the list shows when it has no rows. */
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

/** The All/Any switch: its label and option labels. */
export function getContextsMatchModeLabels(t: (key: string) => string): { label: string; all: string; any: string } {
    return {
        label: `${t('contexts.title')} & ${t('tags.title')}`,
        all: tFallback(t, 'common.all', 'All'),
        any: tFallback(t, 'filters.matchAny', 'Any'),
    };
}

/** Tokens the add pickers offer: the 12 most used, then every other used or saved token. */
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

/** The bulk bar button, and the picker title, for one token action. */
export function getContextsTokenPickerTitle(field: BulkTaskTokenField, action: BulkTaskTokenMode, t: (key: string) => string): string {
    if (field === 'contexts') return action === 'add' ? t('bulk.addContext') : t('bulk.removeContext');
    if (action === 'add') return t('bulk.addTag');
    const removeTag = t('bulk.removeTag');
    return removeTag === 'bulk.removeTag' ? 'Remove tag' : removeTag;
}

/** The bulk token picker for adding or removing tags or contexts on the selected tasks. */
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

/**
 * The bulk token edit: add or remove tags or contexts on the selected tasks. Tasks
 * that already read that way are skipped; when none change, nothing is written
 * (`changed` is false). Mobile's picker and the native host both write through here.
 */
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
