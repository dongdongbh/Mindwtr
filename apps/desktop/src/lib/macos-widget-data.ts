/**
 * Builds the JSON payload the macOS WidgetKit "Tasks" widget reads (#1054).
 *
 * The "today focus" selection itself lives in core
 * (`computeTodayFocusTasks`), shared with the iOS/Android builder so both
 * widgets and the Focus screens name the same next action. Only the payload
 * shaping stays here: the mobile builder depends on
 * `react-native-android-widget` (for `ColorProp`) and AsyncStorage, neither of
 * which exists in the desktop runtime.
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
    computeTodayFocusTasks,
    getTranslationsSync,
    isTaskActionable,
    isTaskInActiveProject,
    loadTranslations,
    resolveTaskSortByForFeatures,
    resolveThemeColorScheme,
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
    const allowed = TASK_SORT_OPTIONS.includes(sortBy as TaskSortBy) ? (sortBy as TaskSortBy) : 'default';
    // Widgets follow the feature toggles too (#1107).
    return resolveTaskSortByForFeatures(allowed, data.settings);
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

export function buildMacWidgetPayload(data: AppData, language: Language, systemIsDark: boolean): MacWidgetPayload {
    void loadTranslations(language);
    const tr = getTranslationsSync(language);
    const tasks = data.tasks || [];
    const projects = data.projects || [];
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const now = new Date();
    const themeMode = typeof data.settings?.theme === 'string' ? data.settings.theme : 'system';
    const palette = resolveMacWidgetPalette(themeMode, systemIsDark);

    const activeTasks = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (!isTaskActionable(task)) return false;
        if (!isTaskInActiveProject(task, projectById)) return false;
        return true;
    });

    const widgetSort = resolveTaskSort(data);
    const { starredTasks, focusTasks } = computeTodayFocusTasks({
        activeTasks,
        projects,
        sortBy: widgetSort,
        now,
    });
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
