import { normalizeBulkTaskTokenInput, type BulkTaskTokenField } from './bulk-task-tokens';
import { getUsedTaskTokens } from './task-token-usage';
import type { FocusTaskLists } from './focus-sections';
import { compareSomedayTasks, compareWaitingTasks } from './menu-views-model';
import { applyFilter, normalizeSavedFilters } from './saved-filters';
import { logInfo } from './logger';
import { sortTasksBy, sortTasksBySavedPreference } from './task-utils';
import type { AppData, FocusGroupBy, SavedFilter, Task, TaskSortBy } from './types';

// The lists a placed Tasks widget can show (#1173): Mindwtr's own GTD lists,
// each in the order its screen uses, plus saved filters and context/tag lists. `focus` is the
// sectioned Focus layout widget-payload.ts already builds; the others are defined
// here, once. A single project is covered by a saved filter scoped to it.
export const WIDGET_FIXED_LIST_IDS = ['focus', 'inbox', 'next', 'waiting', 'someday', 'upcoming'] as const;
export type WidgetFixedListId = (typeof WIDGET_FIXED_LIST_IDS)[number];
export const WIDGET_SAVED_FILTER_LIST_PREFIX = 'filter:';
export const WIDGET_SAVED_FILTER_OPTION_CAP = 50;
export const WIDGET_CONTEXT_LIST_PREFIX = 'context:';
export const WIDGET_TAG_LIST_PREFIX = 'tag:';

export type WidgetGroupBy = 'none' | 'context' | 'project' | 'priority';

/** A presentation variant stays local to its widget; navigation uses the base list. */
export function parseWidgetListSelection(selection: string): { listId: string; groupBy?: WidgetGroupBy } | null {
    if (!selection.startsWith('group:')) return { listId: selection };
    const match = /^group:(none|context|project|priority):(.+)$/.exec(selection);
    if (!match || selection.length > 12 * 1024 + 32) return null;
    try {
        const listId = decodeURIComponent(match[2]);
        if (!listId || listId.length > 1024 || listId === 'focus' || listId.startsWith('group:')) return null;
        return { listId, groupBy: match[1] as WidgetGroupBy };
    } catch {
        return null;
    }
}

/** Canonical IDs use the same legacy-token normalization as shared filtering. */
export function normalizeWidgetTokenListId(value: string): string | null {
    const prefix = value.startsWith(WIDGET_CONTEXT_LIST_PREFIX) ? WIDGET_CONTEXT_LIST_PREFIX
        : value.startsWith(WIDGET_TAG_LIST_PREFIX) ? WIDGET_TAG_LIST_PREFIX : null;
    // eslint-disable-next-line no-control-regex
    if (!prefix || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    const token = normalizeBulkTaskTokenInput(value.slice(prefix.length), prefix === WIDGET_CONTEXT_LIST_PREFIX ? 'contexts' : 'tags');
    return token && prefix.length + token.length <= 1024 ? `${prefix}${token}` : null;
}

export function buildWidgetTokenOptions(data: AppData, field: BulkTaskTokenField): { id: string; name: string }[] {
    const prefix = field === 'contexts' ? WIDGET_CONTEXT_LIST_PREFIX : WIDGET_TAG_LIST_PREFIX;
    // Retained records keep unused labels available; deleted records contribute nothing. Every Android widget refresh runs
    // this over the whole store, where a few labels repeat thousands of times: each is normalized once.
    const normalized = new Map<string, string>();
    const normalize = (token: string): string => {
        let value = normalized.get(token);
        if (value === undefined) normalized.set(token, value = normalizeBulkTaskTokenInput(token, field));
        return value;
    };
    const tokens = getUsedTaskTokens(data.tasks || [], (task) => (task[field] || []).map(normalize), { includeAncestors: true });
    return tokens.flatMap((name) => {
        const id = normalizeWidgetTokenListId(`${prefix}${name}`);
        return id ? [{ id, name }] : [];
    });
}

/** Candidate index avoids scanning the whole task store once for every chooser option. */
export function buildWidgetTokenTaskIndex(tasks: Task[]): Map<string, Task[]> {
    const index = new Map<string, Task[]>();
    for (const task of tasks) {
        for (const field of ['contexts', 'tags'] as const) {
            const prefix = field === 'contexts' ? WIDGET_CONTEXT_LIST_PREFIX : WIDGET_TAG_LIST_PREFIX;
            const ids = new Set<string>();
            for (const raw of task[field] || []) {
                const token = normalizeBulkTaskTokenInput(raw, field);
                if (!token) continue;
                ids.add(`${prefix}${token}`);
                for (let slash = token.indexOf('/'); slash !== -1; slash = token.indexOf('/', slash + 1)) {
                    ids.add(`${prefix}${token.slice(0, slash)}`);
                }
            }
            for (const id of ids) {
                const pool = index.get(id);
                if (pool) pool.push(task);
                else index.set(id, [task]);
            }
        }
    }
    return index;
}

const LIST_TITLE_KEYS: Record<WidgetFixedListId, [string, string]> = {
    focus: ['nav.agenda', 'Focus'],
    inbox: ['nav.inbox', 'Inbox'],
    next: ['nav.next', 'Next Actions'],
    waiting: ['nav.waiting', 'Waiting For'],
    someday: ['nav.someday', 'Someday/Maybe'],
    upcoming: ['agenda.upcoming', 'Upcoming'],
};

// The fixed list titles plus the picker's labels: the group above its
// saved-filter rows, the grouping row, and the background row.
export function widgetListTitles(tr: Record<string, string>): Record<WidgetFixedListId | 'savedFilters' | 'groupBy' | 'groupDefault' | 'groupNone' | 'groupContext' | 'groupProject' | 'groupPriority' | 'background' | 'backgroundLightText' | 'backgroundDarkText', string> {
    return {
        ...(Object.fromEntries(
            WIDGET_FIXED_LIST_IDS.map((id) => [id, tr[LIST_TITLE_KEYS[id][0]] ?? LIST_TITLE_KEYS[id][1]]),
        ) as Record<WidgetFixedListId, string>),
        savedFilters: tr['settings.syncPreferenceSavedFilters'] ?? 'Saved filters',
        groupBy: tr['list.groupBy'] ?? 'Group',
        groupDefault: tr['sort.default'] ?? 'Default',
        groupNone: tr['list.groupByNone'] ?? 'No grouping',
        groupContext: tr['list.groupByContext'] ?? 'Context',
        groupProject: tr['list.groupByProject'] ?? 'Project',
        groupPriority: tr['taskEdit.priorityLabel'] ?? 'Priority',
        background: tr['widget.background'] ?? 'Background',
        backgroundLightText: tr['widget.backgroundLightText'] ?? 'Transparent, light text',
        backgroundDarkText: tr['widget.backgroundDarkText'] ?? 'Transparent, dark text',
    };
}

export interface WidgetTaskList {
    title: string;
    tasks: Task[];
    groupBy?: FocusGroupBy;
    showStatus?: boolean;
}

export interface WidgetListContext {
    data: AppData;
    /** Undeleted, actionable, in an active project: the widget's base pool. */
    activeTasks: Task[];
    focusLists: FocusTaskLists;
    sortBy: TaskSortBy;
    prioritiesEnabled: boolean;
    now?: Date;
    tr: Record<string, string>;
    tokenTaskIndex?: Map<string, Task[]>;
}

// The saved filters this build can apply, not deleted: a newer app's view is left out.
const liveSavedFilters = (data: AppData): SavedFilter[] => (
    normalizeSavedFilters(data.settings?.savedFilters).filter((filter) => !filter.deletedAt)
);

/** Saved filters the configuration screen offers, in the order the app lists them. */
export function buildWidgetSavedFilterOptions(data: AppData): { id: string; name: string }[] {
    return liveSavedFilters(data)
        .slice(0, WIDGET_SAVED_FILTER_OPTION_CAP)
        .map((filter) => ({ id: filter.id, name: filter.name }));
}

// A saved filter is written against one view, and the app only ever applies it
// on that view's list, so the widget narrows the pool the same way before
// matching. Every other view filters the full actionable pool.
const savedFilterStatus: Partial<Record<SavedFilter['view'], Task['status']>> = {
    next: 'next',
    waiting: 'waiting',
    someday: 'someday',
};

function buildSavedFilterList(filter: SavedFilter, context: WidgetListContext): WidgetTaskList {
    const { data, activeTasks, sortBy, prioritiesEnabled } = context;
    const status = savedFilterStatus[filter.view];
    const pool = status ? activeTasks.filter((task) => task.status === status) : activeTasks;
    const projects = data.projects || [];
    const matched = applyFilter(pool, filter.criteria, { projects, tokenMatchMode: 'all', now: context.now });
    if (filter.criteria.anyDateRange) {
        logInfo('Task date filter projected for widget', {
            scope: 'widget-lists',
            category: 'unknown',
            context: { releaseCheck: 'v1.3.7/task-date-filter', count: matched.length, outcome: 'projected' },
        });
    }
    const tasks = filter.sortBy && filter.sortBy !== 'default'
        ? sortTasksBySavedPreference(matched, filter.sortBy, {
            projects,
            prioritizeByPriority: prioritiesEnabled,
            sortOrder: filter.sortOrder,
        })
        : sortTasksBy(matched, sortBy);
    return { title: filter.name, tasks, groupBy: filter.groupBy, showStatus: !status };
}

/** Null when the id names no list (an unknown or deleted saved filter). */
export function buildWidgetTaskList(listId: string, context: WidgetListContext): WidgetTaskList | null {
    const { data, activeTasks, focusLists, sortBy, tr } = context;
    const titles = widgetListTitles(tr);
    switch (listId) {
        case 'inbox':
            return { title: titles.inbox, tasks: sortTasksBy(activeTasks.filter((task) => task.status === 'inbox'), sortBy) };
        case 'next':
            // The app's Next Actions list is the Focus screen's Next section
            // (sequential-project rules included).
            return { title: titles.next, tasks: focusLists.nextActions };
        case 'upcoming':
            return { title: titles.upcoming, tasks: focusLists.upcoming };
        case 'waiting':
            return { title: titles.waiting, tasks: activeTasks.filter((task) => task.status === 'waiting').sort(compareWaitingTasks) };
        case 'someday':
            return { title: titles.someday, tasks: activeTasks.filter((task) => task.status === 'someday').sort(compareSomedayTasks) };
        default:
            break;
    }
    const tokenListId = normalizeWidgetTokenListId(listId);
    if (tokenListId) {
        const field = tokenListId.startsWith(WIDGET_CONTEXT_LIST_PREFIX) ? 'contexts' : 'tags';
        const prefix = field === 'contexts' ? WIDGET_CONTEXT_LIST_PREFIX : WIDGET_TAG_LIST_PREFIX;
        const token = tokenListId.slice(prefix.length);
        const candidates = context.tokenTaskIndex?.get(`${prefix}${token.replace(/\/+$/, '')}`)
            ?? (context.tokenTaskIndex ? [] : activeTasks);
        return { title: token, showStatus: true, tasks: sortTasksBy(applyFilter(candidates, { [field]: [token] }, {
            projects: data.projects || [], tokenMatchMode: 'all',
        }), sortBy) };
    }
    if (!listId.startsWith(WIDGET_SAVED_FILTER_LIST_PREFIX)) return null;
    const filterId = listId.slice(WIDGET_SAVED_FILTER_LIST_PREFIX.length);
    const filter = liveSavedFilters(data).find((candidate) => candidate.id === filterId);
    return filter ? buildSavedFilterList(filter, context) : null;
}
