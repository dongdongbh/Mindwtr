import {
    type AppData,
    type AppTheme,
    type Language,
    type TaskSortBy,
    resolveThemeColorScheme,
    safeParseDate,
    safeParseDueDate,
    SUPPORTED_LANGUAGES,
    getTranslationsSync,
    getSequentialFirstTaskIds,
    isTaskActionable,
    isTaskInActiveProject,
    loadTranslations,
    sortTasksBy,
} from '@mindwtr/core';
import type { ColorProp } from 'react-native-android-widget';
import { THEME_PRESETS, type ThemePresetName } from '../constants/theme-presets';

export const WIDGET_DATA_KEY = 'mindwtr-data';
export const WIDGET_LANGUAGE_KEY = 'mindwtr-language';
export const IOS_WIDGET_APP_GROUP = 'group.tech.dongdongbh.mindwtr';
export const IOS_WIDGET_PAYLOAD_KEY = 'mindwtr-ios-widget-payload';
export const IOS_WIDGET_PAYLOAD_KEY_SMALL = 'mindwtr-ios-widget-payload-small';
export const IOS_WIDGET_PAYLOAD_KEY_MEDIUM = 'mindwtr-ios-widget-payload-medium';
export const IOS_WIDGET_PAYLOAD_KEY_LARGE = 'mindwtr-ios-widget-payload-large';
export const IOS_WIDGET_PAYLOAD_KEY_EXTRA_LARGE = 'mindwtr-ios-widget-payload-extra-large';
// Read-only substrate for the "Get Mindwtr Tasks" Shortcuts action and
// Spotlight indexing (#980). Written alongside the widget payloads into the
// same App Group UserDefaults the widget already uses, so the App Intents
// running in the main app process can read it with the same access pattern
// -- no second storage mechanism, no live database read from an intent.
export const IOS_SHORTCUTS_SNAPSHOT_KEY = 'mindwtr-ios-shortcuts-snapshot';
export const SHORTCUTS_SNAPSHOT_ITEM_CAP = 50;
// Global ceiling on project groups (not just items per group) -- otherwise a
// library with hundreds of active projects has no bound on snapshot size or
// how many entities get handed to Spotlight indexing per launch.
export const SHORTCUTS_SNAPSHOT_PROJECT_CAP = 50;
export const IOS_WIDGET_KIND = 'MindwtrTasksWidget';
export const IOS_WIDGET_LOCK_KIND = 'MindwtrFocusLockWidget';
export const WIDGET_FOCUS_URI = 'mindwtr:///focus';
export const WIDGET_QUICK_CAPTURE_URI = 'mindwtr:///capture-quick?mode=text';
type ConcreteThemePresetName = Exclude<ThemePresetName, 'default'>;

export type WidgetSystemColorScheme = 'light' | 'dark' | null | undefined;

export interface WidgetTaskItem {
    id: string;
    title: string;
    statusLabel: string;
    dueLabel: string | null;
    dueEmphasis: boolean;
}

export interface WidgetPalette {
    background: ColorProp;
    card: ColorProp;
    border: ColorProp;
    text: ColorProp;
    mutedText: ColorProp;
    accent: ColorProp;
    onAccent: ColorProp;
}

export interface TasksWidgetPayload {
    headerTitle: string;
    subtitle: string;
    inboxLabel: string;
    inboxCount: number;
    focusedCount: number;
    items: WidgetTaskItem[];
    emptyMessage: string;
    captureLabel: string;
    focusUri: string;
    quickCaptureUri: string;
    themeMode?: string;
    palette: WidgetPalette;
}

export type ShortcutsSnapshotListKey = 'inbox' | 'focus' | 'next' | 'waiting' | 'someday';

export interface ShortcutsSnapshotTaskItem {
    id: string;
    title: string;
    list: ShortcutsSnapshotListKey;
    dueDate?: string;
    startDate?: string;
    projectId?: string;
    projectName?: string;
}

export interface ShortcutsSnapshotProjectGroup {
    id: string;
    name: string;
    items: ShortcutsSnapshotTaskItem[];
}

export interface ShortcutsSnapshot {
    generatedAt: string;
    lists: Record<ShortcutsSnapshotListKey, ShortcutsSnapshotTaskItem[]>;
    projects: ShortcutsSnapshotProjectGroup[];
}

const TASK_SORT_OPTIONS: TaskSortBy[] = ['default', 'due', 'start', 'review', 'timeEstimate', 'title', 'created', 'created-desc'];

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The widget renderer runs in a headless JS context where Intl may be missing,
// so every Intl call falls back to plain strings.
const formatShortWeekday = (date: Date, language: string): string => {
    try {
        return new Intl.DateTimeFormat(language, { weekday: 'short' }).format(date);
    } catch {
        return FALLBACK_SHORT_WEEKDAYS[date.getDay()];
    }
};

const formatNumericDate = (date: Date, language: string): string => {
    try {
        return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric' }).format(date);
    } catch {
        return `${date.getMonth() + 1}/${date.getDate()}`;
    }
};

const computeDueLabel = (
    dueDate: string | undefined | null,
    tr: Record<string, string>,
    language: string,
    startOfToday: Date,
    endOfToday: Date,
): Pick<WidgetTaskItem, 'dueLabel' | 'dueEmphasis'> => {
    const due = safeParseDueDate(dueDate);
    if (!due) return { dueLabel: null, dueEmphasis: false };
    if (due < startOfToday) {
        return { dueLabel: formatNumericDate(due, language), dueEmphasis: true };
    }
    if (due <= endOfToday) {
        return { dueLabel: tr['quickDate.today'] ?? 'Today', dueEmphasis: true };
    }
    const dueDayStart = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const daysAhead = Math.round((dueDayStart.getTime() - startOfToday.getTime()) / DAY_MS);
    if (daysAhead === 1) {
        return { dueLabel: tr['quickDate.tomorrow'] ?? 'Tomorrow', dueEmphasis: false };
    }
    if (daysAhead <= 6) {
        return { dueLabel: formatShortWeekday(due, language), dueEmphasis: false };
    }
    return { dueLabel: formatNumericDate(due, language), dueEmphasis: false };
};

const resolveWidgetTaskSort = (data: AppData): TaskSortBy => {
    const sortBy = data.settings?.taskSortBy;
    return TASK_SORT_OPTIONS.includes(sortBy as TaskSortBy) ? (sortBy as TaskSortBy) : 'default';
};

export function resolveWidgetLanguage(saved: string | null, setting?: string): Language {
    const candidate = setting && setting !== 'system' ? setting : saved;
    if (candidate && SUPPORTED_LANGUAGES.includes(candidate as Language)) return candidate as Language;
    return 'en';
}

const resolveWidgetPalette = (
    themeMode: string | undefined,
    systemColorScheme: WidgetSystemColorScheme,
): WidgetPalette => {
    const normalizedMode = (themeMode || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(THEME_PRESETS, normalizedMode)) {
        const preset = THEME_PRESETS[normalizedMode as ConcreteThemePresetName];
        return {
            background: preset.cardBg,
            card: preset.taskItemBg,
            border: preset.border,
            text: preset.text,
            mutedText: preset.secondaryText,
            accent: preset.tint,
            onAccent: preset.onTint,
        };
    }

    const isDark = resolveThemeColorScheme(
        normalizedMode as AppTheme,
        systemColorScheme === 'dark' ? 'dark' : 'light',
    ) === 'dark';

    if (isDark) {
        return {
            background: '#111827',
            card: '#1F2937',
            border: '#374151',
            text: '#F9FAFB',
            mutedText: '#CBD5E1',
            accent: '#2563EB',
            onAccent: '#FFFFFF',
        };
    }

    return {
        background: '#F8FAFC',
        card: '#FFFFFF',
        border: '#CBD5E1',
        text: '#0F172A',
        mutedText: '#475569',
        accent: '#2563EB',
        onAccent: '#FFFFFF',
    };
};

// Shared by the widget's "Today" list and the Shortcuts snapshot's "focus"
// list (#980) so both surfaces agree on what "today's focus" means: starred
// tasks first, then next actions due/starting today or otherwise actionable,
// respecting sequential-project gating. A single source of truth here avoids
// the two surfaces silently drifting apart.
function computeTodayFocusTasks(
    activeTasks: AppData['tasks'],
    projects: AppData['projects'],
    widgetSort: TaskSortBy,
    startOfToday: Date,
    endOfToday: Date,
): { starredTasks: AppData['tasks']; listSource: AppData['tasks'] } {
    const sequentialProjectIds = new Set(
        projects.filter((project) => project.isSequential && !project.deletedAt).map((project) => project.id)
    );
    const sequentialWithinSectionProjectIds = new Set(
        projects
            .filter((project) => project.isSequential && project.sequentialScope === 'section' && !project.deletedAt)
            .map((project) => project.id)
    );

    const isPlannedForFuture = (task: AppData['tasks'][number]) => {
        const start = safeParseDate(task.startTime);
        return Boolean(start && start > endOfToday);
    };
    const isScheduleCandidate = (task: AppData['tasks'][number]) => {
        const due = safeParseDueDate(task.dueDate);
        const start = safeParseDate(task.startTime);
        const startsToday = Boolean(
            start
            && start >= startOfToday
            && start <= endOfToday
        );
        return Boolean(due && due <= endOfToday) || startsToday;
    };

    // Waiting tasks hold their chain slot (a waiting first step blocks the
    // later ones); the future-start deferral below only applies to next
    // tasks — a waiting step blocks by existing, whenever it starts.
    const sequentialFirstTaskIds = getSequentialFirstTaskIds(
        activeTasks.filter((task) => (
            task.status === 'waiting'
            || (task.status === 'next'
                && (!isPlannedForFuture(task) || isScheduleCandidate(task)))
        )),
        sequentialProjectIds,
        { sectionScopedProjectIds: sequentialWithinSectionProjectIds },
    );
    const isSequentialBlocked = (task: AppData['tasks'][number]) => {
        if (!task.projectId) return false;
        if (!sequentialProjectIds.has(task.projectId)) return false;
        return !sequentialFirstTaskIds.has(task.id);
    };

    const scheduleTasks = activeTasks.filter((task) => {
        if (task.status !== 'next') return false;
        if (isSequentialBlocked(task)) return false;
        return isScheduleCandidate(task);
    });

    const scheduleTaskIds = new Set(scheduleTasks.map((task) => task.id));
    const nextTasks = activeTasks.filter((task) => {
        if (task.status !== 'next') return false;
        if (isPlannedForFuture(task)) return false;
        if (isSequentialBlocked(task)) return false;
        return !scheduleTaskIds.has(task.id);
    });

    // Starred tasks mirror core's focusedTasks (activeTasks already excludes
    // done/reference/archived/deleted and inactive projects) and lead the list,
    // so "current focused task" surfaces (lock widget, list head) show the task
    // the user actually starred — including starred waiting/someday tasks,
    // which keep their status by design.
    const starredTasks = activeTasks.filter((task) => (
        task.isFocusedToday === true
        && (!isPlannedForFuture(task) || isScheduleCandidate(task))
    ));
    const starredTaskIds = new Set(starredTasks.map((task) => task.id));
    const focusTasks = [...scheduleTasks, ...nextTasks].filter((task) => !starredTaskIds.has(task.id));
    const listSource = [
        ...sortTasksBy(starredTasks, widgetSort),
        ...sortTasksBy(focusTasks, widgetSort),
    ];

    return { starredTasks, listSource };
}

export function buildWidgetPayload(
    data: AppData,
    language: Language,
    options?: { systemColorScheme?: WidgetSystemColorScheme; maxItems?: number }
): TasksWidgetPayload {
    void loadTranslations(language);
    const tr = getTranslationsSync(language);
    const tasks = data.tasks || [];
    const projects = data.projects || [];
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const palette = resolveWidgetPalette(
        typeof data.settings?.theme === 'string' ? data.settings.theme : undefined,
        options?.systemColorScheme,
    );

    const activeTasks = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (!isTaskActionable(task)) return false;
        if (!isTaskInActiveProject(task, projectById)) return false;
        return true;
    });

    const widgetSort = resolveWidgetTaskSort(data);
    const { starredTasks, listSource } = computeTodayFocusTasks(
        activeTasks,
        projects,
        widgetSort,
        startOfToday,
        endOfToday,
    );

    const maxItems = Number.isFinite(options?.maxItems)
        ? Math.max(1, Math.floor(options?.maxItems as number))
        : 3;

    const items = listSource.slice(0, maxItems).map((task) => ({
        id: task.id,
        title: task.title,
        statusLabel: tr[`status.${task.status}`] || task.status,
        ...computeDueLabel(task.dueDate, tr, language, startOfToday, endOfToday),
    }));
    const hiddenTaskCount = Math.max(listSource.length - items.length, 0);

    const inboxCount = activeTasks.filter((task) => task.status === 'inbox').length;
    const subtitleParts = [`${tr['nav.inbox'] ?? 'Inbox'}: ${inboxCount}`];
    if (hiddenTaskCount > 0) {
        subtitleParts.push(`+${hiddenTaskCount} ${tr['common.more'] ?? 'More'}`);
    }

    return {
        headerTitle: tr['agenda.todaysFocus'] ?? 'Today',
        subtitle: subtitleParts.join(' · '),
        inboxLabel: tr['nav.inbox'] ?? 'Inbox',
        inboxCount,
        focusedCount: starredTasks.length,
        items,
        emptyMessage: tr['agenda.allClear'] ?? 'All clear',
        captureLabel: tr['widget.capture'] ?? 'Quick capture',
        focusUri: WIDGET_FOCUS_URI,
        quickCaptureUri: WIDGET_QUICK_CAPTURE_URI,
        themeMode: typeof data.settings?.theme === 'string' ? data.settings.theme : 'system',
        palette,
    };
}

const SHORTCUTS_SNAPSHOT_LISTS: readonly ShortcutsSnapshotListKey[] = ['inbox', 'focus', 'next', 'waiting', 'someday'];

const buildSnapshotItem = (
    task: AppData['tasks'][number],
    list: ShortcutsSnapshotListKey,
    projectById: Map<string, AppData['projects'][number]>,
): ShortcutsSnapshotTaskItem => {
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    return {
        id: task.id,
        title: task.title,
        list,
        ...(task.dueDate ? { dueDate: task.dueDate } : {}),
        ...(task.startTime ? { startDate: task.startTime } : {}),
        ...(task.projectId ? { projectId: task.projectId } : {}),
        ...(project?.title ? { projectName: project.title } : {}),
    };
};

// Read-only substrate for the "Get Mindwtr Tasks" Shortcuts action and
// Spotlight indexing (#980): a capped, per-list + per-project snapshot of
// task metadata, refreshed on the same cadence as the widget payload. App
// Intents only ever read this; they never touch the live database.
export function buildShortcutsSnapshot(data: AppData): ShortcutsSnapshot {
    const tasks = data.tasks || [];
    const projects = data.projects || [];
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const widgetSort = resolveWidgetTaskSort(data);

    const activeTasks = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (!isTaskActionable(task)) return false;
        if (!isTaskInActiveProject(task, projectById)) return false;
        return true;
    });

    const { listSource: focusListSource } = computeTodayFocusTasks(
        activeTasks,
        projects,
        widgetSort,
        startOfToday,
        endOfToday,
    );

    const tasksByStatus = (status: ShortcutsSnapshotListKey) => (
        sortTasksBy(activeTasks.filter((task) => task.status === status), widgetSort)
    );

    const listTasksByKey: Record<ShortcutsSnapshotListKey, AppData['tasks']> = {
        inbox: tasksByStatus('inbox'),
        focus: focusListSource,
        next: tasksByStatus('next'),
        waiting: tasksByStatus('waiting'),
        someday: tasksByStatus('someday'),
    };

    const lists = SHORTCUTS_SNAPSHOT_LISTS.reduce((acc, key) => {
        acc[key] = listTasksByKey[key]
            .slice(0, SHORTCUTS_SNAPSHOT_ITEM_CAP)
            .map((task) => buildSnapshotItem(task, key, projectById));
        return acc;
    }, {} as Record<ShortcutsSnapshotListKey, ShortcutsSnapshotTaskItem[]>);

    // One grouping pass over activeTasks (O(tasks)) instead of filtering the
    // full task list once per project (O(projects x tasks) -- measurably
    // slow at a few hundred projects).
    const tasksByProjectId = new Map<string, AppData['tasks']>();
    for (const task of activeTasks) {
        if (!task.projectId) continue;
        const bucket = tasksByProjectId.get(task.projectId);
        if (bucket) bucket.push(task);
        else tasksByProjectId.set(task.projectId, [task]);
    }

    const projectGroups: ShortcutsSnapshotProjectGroup[] = projects
        .filter((project) => project.status === 'active' && !project.deletedAt)
        // Deterministic global cap on project groups (below): manual project
        // order, same ordering the Projects list itself shows, so which
        // projects survive the cap matches what the user already sees first.
        .sort((a, b) => a.order - b.order)
        .slice(0, SHORTCUTS_SNAPSHOT_PROJECT_CAP)
        .map((project) => {
            const projectTasks = sortTasksBy(
                tasksByProjectId.get(project.id) ?? [],
                widgetSort,
            ).slice(0, SHORTCUTS_SNAPSHOT_ITEM_CAP);
            return {
                id: project.id,
                name: project.title,
                // Every remaining status on an active task is one of the four
                // list keys above (activeTasks already excludes done/archived/
                // reference), so the cast is safe.
                items: projectTasks.map((task) => buildSnapshotItem(task, task.status as ShortcutsSnapshotListKey, projectById)),
            };
        })
        .filter((group) => group.items.length > 0);

    return {
        generatedAt: new Date().toISOString(),
        lists,
        projects: projectGroups,
    };
}
