/**
 * Builds the JSON payload the macOS WidgetKit "Tasks" widget reads (#1054).
 *
 * This mirrors the shape and "today focus" selection logic of
 * `apps/mobile/lib/widget-data.ts` (`buildWidgetPayload`) so the Mac widget
 * looks and behaves like the iOS one, but is its own small module rather than
 * a shared import: the mobile module depends on `react-native-android-widget`
 * (for `ColorProp`) and AsyncStorage, neither of which exist in the desktop
 * runtime, and moving it into `@mindwtr/core` was explicitly out of scope.
 *
 * Two deliberate shape differences from the iOS payload:
 *  - No `focusUri` / `quickCaptureUri`. The desktop app registers no
 *    `mindwtr://` URL scheme, so the Mac widget uses WidgetKit's default
 *    "tap opens the containing app" behavior instead of `Link(destination:)`
 *    (decision #1054/7) -- there is nothing for those URIs to resolve to.
 *  - One item list capped generously (`MAC_WIDGET_MAX_ITEMS`) rather than
 *    five per-size payloads. The Swift view itself caps further per family
 *    (systemSmall/systemMedium/systemLarge -- macOS has no systemExtraLarge).
 */
import {
    type AppData,
    type AppTheme,
    type Language,
    getSequentialFirstTaskIds,
    getTranslationsSync,
    isTaskActionable,
    isTaskInActiveProject,
    loadTranslations,
    resolveThemeColorScheme,
    safeParseDate,
    safeParseDueDate,
    sortTasksBy,
    type TaskSortBy,
} from '@mindwtr/core';

export const MAC_WIDGET_MAX_ITEMS = 12;

export interface MacWidgetTaskItem {
    id: string;
    title: string;
    statusLabel: string;
}

export interface MacWidgetPalette {
    background: string;
    card: string;
    border: string;
    text: string;
    mutedText: string;
    accent: string;
    onAccent: string;
}

export interface MacWidgetPayload {
    headerTitle: string;
    subtitle: string;
    focusedCount: number;
    items: MacWidgetTaskItem[];
    emptyMessage: string;
    captureLabel: string;
    themeMode: string;
    palette: MacWidgetPalette;
}

const TASK_SORT_OPTIONS: TaskSortBy[] = ['default', 'due', 'start', 'review', 'timeEstimate', 'title', 'created', 'created-desc'];

const resolveTaskSort = (data: AppData): TaskSortBy => {
    const sortBy = data.settings?.taskSortBy;
    return TASK_SORT_OPTIONS.includes(sortBy as TaskSortBy) ? (sortBy as TaskSortBy) : 'default';
};

const LIGHT_PALETTE: MacWidgetPalette = {
    background: '#F8FAFC',
    card: '#FFFFFF',
    border: '#CBD5E1',
    text: '#0F172A',
    mutedText: '#475569',
    accent: '#2563EB',
    onAccent: '#FFFFFF',
};

const DARK_PALETTE: MacWidgetPalette = {
    background: '#111827',
    card: '#1F2937',
    border: '#374151',
    text: '#F9FAFB',
    mutedText: '#CBD5E1',
    accent: '#2563EB',
    onAccent: '#FFFFFF',
};

// Only light/dark are resolved here -- unlike mobile's widget-data.ts, named
// theme presets (Dracula, Nord, ...) are not ported to hex palettes for the
// Mac widget in v1. The widget still falls back correctly (via `themeMode`
// and `resolveThemeColorScheme`) to plain light/dark for any preset theme,
// it just won't carry that preset's exact accent colors into the widget.
const resolveMacWidgetPalette = (themeMode: string | undefined, systemIsDark: boolean): MacWidgetPalette => {
    const isDark = resolveThemeColorScheme(
        (themeMode || 'system') as AppTheme,
        systemIsDark ? 'dark' : 'light',
    ) === 'dark';
    return isDark ? DARK_PALETTE : LIGHT_PALETTE;
};

// Ported from apps/mobile/lib/widget-data.ts's computeTodayFocusTasks so the
// Mac widget shows the same "Today" selection: starred tasks first, then
// next actions due/starting today or otherwise actionable, respecting
// sequential-project gating. Kept in sync manually -- there is no shared
// home for this without moving it into core, which is out of scope for #1054.
function computeTodayFocusTasks(
    activeTasks: AppData['tasks'],
    projects: AppData['projects'],
    widgetSort: TaskSortBy,
    startOfToday: Date,
    endOfToday: Date,
): { starredTasks: AppData['tasks']; focusTasks: AppData['tasks'] } {
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
        const startsToday = Boolean(start && start >= startOfToday && start <= endOfToday);
        return Boolean(due && due <= endOfToday) || startsToday;
    };

    const sequentialFirstTaskIds = getSequentialFirstTaskIds(
        activeTasks.filter((task) => (
            task.status === 'waiting'
            || (task.status === 'next' && (!isPlannedForFuture(task) || isScheduleCandidate(task)))
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

    const starredTasks = activeTasks.filter((task) => (
        task.isFocusedToday === true
        && (!isPlannedForFuture(task) || isScheduleCandidate(task))
    ));
    const starredTaskIds = new Set(starredTasks.map((task) => task.id));
    const focusTasks = [...scheduleTasks, ...nextTasks].filter((task) => !starredTaskIds.has(task.id));

    return {
        starredTasks: sortTasksBy(starredTasks, widgetSort),
        focusTasks: sortTasksBy(focusTasks, widgetSort),
    };
}

export function buildMacWidgetPayload(data: AppData, language: Language, systemIsDark: boolean): MacWidgetPayload {
    void loadTranslations(language);
    const tr = getTranslationsSync(language);
    const tasks = data.tasks || [];
    const projects = data.projects || [];
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const themeMode = typeof data.settings?.theme === 'string' ? data.settings.theme : 'system';
    const palette = resolveMacWidgetPalette(themeMode, systemIsDark);

    const activeTasks = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (!isTaskActionable(task)) return false;
        if (!isTaskInActiveProject(task, projectById)) return false;
        return true;
    });

    const widgetSort = resolveTaskSort(data);
    const { starredTasks, focusTasks } = computeTodayFocusTasks(
        activeTasks,
        projects,
        widgetSort,
        startOfToday,
        endOfToday,
    );
    const listSource = [...starredTasks, ...focusTasks];

    const items = listSource.slice(0, MAC_WIDGET_MAX_ITEMS).map((task) => ({
        id: task.id,
        title: task.title,
        statusLabel: tr[`status.${task.status}`] || task.status,
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
        focusedCount: starredTasks.length,
        items,
        emptyMessage: tr['agenda.allClear'] ?? 'All clear',
        captureLabel: tr['widget.capture'] ?? 'Quick capture',
        themeMode,
        palette,
    };
}
