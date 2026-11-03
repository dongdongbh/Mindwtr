


import {
    type AppData,
    type AppTheme,
    type Language,
    computeTodayFocusTasks,
    resolveWidgetTaskSort,
    getTranslationsSync,
    isTaskActionable,
    isTaskVisibleInArea,
    getFocusSelection,
    resolveAreaFilterSelection,
    taskMatchesAreaFilterSelection,
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

const resolveTaskSort = (data: AppData): TaskSortBy => (

    resolveTaskSortByForFeatures(resolveWidgetTaskSort(data.settings?.taskSortBy), data.settings)
);

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
    const areas = (data.areas ?? []).filter((area) => !area.deletedAt);
    const areaById = new Map(areas.map((area) => [area.id, area]));
    const resolvedAreaFilter = resolveAreaFilterSelection(data.settings?.filters, areas);
    const now = new Date();
    const themeMode = typeof data.settings?.theme === 'string' ? data.settings.theme : 'system';
    const palette = resolveMacWidgetPalette(themeMode, systemIsDark);

    const activeTasks = tasks.filter((task) => {
        if (!isTaskActionable(task)) return false;
        return isTaskVisibleInArea(task, { projectById, areaById, resolvedAreaFilter });
    });
    const selection = getFocusSelection(tasks, activeTasks, now,
        (task) => taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectById, areaById));

    const widgetSort = resolveTaskSort(data);
    const { starredTasks, focusTasks } = computeTodayFocusTasks({
        activeTasks,
        projects,
        sections: data.sections || [],
        sortBy: widgetSort,
        now,
        focusIncludeStartDates: data.settings?.gtd?.focusIncludeStartDates,
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
        focusedCount: selection.globalCount,
        items,
        emptyMessage: tr['agenda.allClear'] ?? 'All clear',
        captureLabel: tr['widget.capture'] ?? 'Quick capture',
        themeMode,
        palette,
    };
}
