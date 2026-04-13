import {
    type AppData,
    type Language,
    type TaskSortBy,
    safeParseDate,
    safeParseDueDate,
    SUPPORTED_LANGUAGES,
    getTranslationsSync,
    loadTranslations,
    sortTasksBy,
} from '@mindwtr/core';
import type { ColorProp } from 'react-native-android-widget';

export const WIDGET_DATA_KEY = 'mindwtr-data';
export const WIDGET_LANGUAGE_KEY = 'mindwtr-language';
export const IOS_WIDGET_APP_GROUP = 'group.tech.dongdongbh.mindwtr';
export const IOS_WIDGET_PAYLOAD_KEY = 'mindwtr-ios-widget-payload';
export const IOS_WIDGET_PAYLOAD_KEY_SMALL = 'mindwtr-ios-widget-payload-small';
export const IOS_WIDGET_PAYLOAD_KEY_MEDIUM = 'mindwtr-ios-widget-payload-medium';
export const IOS_WIDGET_PAYLOAD_KEY_LARGE = 'mindwtr-ios-widget-payload-large';
export const IOS_WIDGET_KIND = 'MindwtrTasksWidget';
export const WIDGET_FOCUS_URI = 'mindwtr:///focus';
export const WIDGET_QUICK_CAPTURE_URI = 'mindwtr:///capture-quick?mode=text';
const DARK_THEME_MODES = new Set(['dark', 'material3-dark', 'nord', 'oled']);
const LIGHT_THEME_MODES = new Set(['light', 'material3-light', 'eink', 'sepia']);

export type WidgetSystemColorScheme = 'light' | 'dark' | null | undefined;

export interface WidgetTaskItem {
    id: string;
    title: string;
    statusLabel: string;
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
    items: WidgetTaskItem[];
    emptyMessage: string;
    captureLabel: string;
    focusUri: string;
    quickCaptureUri: string;
    themeMode?: string;
    palette: WidgetPalette;
}

const TASK_SORT_OPTIONS: TaskSortBy[] = ['default', 'due', 'start', 'review', 'title', 'created', 'created-desc'];

const resolveWidgetTaskSort = (data: AppData): TaskSortBy => {
    const sortBy = data.settings?.taskSortBy;
    return TASK_SORT_OPTIONS.includes(sortBy as TaskSortBy) ? (sortBy as TaskSortBy) : 'default';
};

const buildSequentialFirstTaskIds = (
    tasks: AppData['tasks'],
    sequentialProjectIds: Set<string>
): Set<string> => {
    if (sequentialProjectIds.size === 0) return new Set<string>();

    const tasksByProject = new Map<string, AppData['tasks']>();
    tasks.forEach((task) => {
        if (!task.projectId) return;
        if (!sequentialProjectIds.has(task.projectId)) return;
        const list = tasksByProject.get(task.projectId) ?? [];
        list.push(task);
        tasksByProject.set(task.projectId, list);
    });

    const firstIds = new Set<string>();
    tasksByProject.forEach((projectTasks) => {
        const hasOrder = projectTasks.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
        let firstId: string | null = null;
        let bestKey = Number.POSITIVE_INFINITY;

        projectTasks.forEach((task) => {
            const orderKey = Number.isFinite(task.order)
                ? (task.order as number)
                : Number.isFinite(task.orderNum)
                    ? (task.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            const createdKey = safeParseDate(task.createdAt)?.getTime() ?? Number.POSITIVE_INFINITY;
            const key = hasOrder ? orderKey : createdKey;
            if (!firstId || key < bestKey) {
                firstId = task.id;
                bestKey = key;
            }
        });

        if (firstId) firstIds.add(firstId);
    });

    return firstIds;
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
    const isDark = DARK_THEME_MODES.has(normalizedMode)
        ? true
        : LIGHT_THEME_MODES.has(normalizedMode)
            ? false
            : systemColorScheme === 'dark';

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

export function buildWidgetPayload(
    data: AppData,
    language: Language,
    options?: { systemColorScheme?: WidgetSystemColorScheme; maxItems?: number }
): TasksWidgetPayload {
    void loadTranslations(language);
    const tr = getTranslationsSync(language);
    const tasks = data.tasks || [];
    const projects = data.projects || [];
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const palette = resolveWidgetPalette(
        typeof data.settings?.theme === 'string' ? data.settings.theme : undefined,
        options?.systemColorScheme,
    );

    const sequentialProjectIds = new Set(
        projects.filter((project) => project.isSequential && !project.deletedAt).map((project) => project.id)
    );

    const activeTasks = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (task.status === 'archived' || task.status === 'done' || task.status === 'reference') return false;
        return true;
    });

    const sequentialFirstTaskIds = buildSequentialFirstTaskIds(activeTasks, sequentialProjectIds);
    const isSequentialBlocked = (task: AppData['tasks'][number]) => {
        if (!task.projectId) return false;
        if (!sequentialProjectIds.has(task.projectId)) return false;
        return !sequentialFirstTaskIds.has(task.id);
    };
    const isPlannedForFuture = (task: AppData['tasks'][number]) => {
        const start = safeParseDate(task.startTime);
        return Boolean(start && start > endOfToday);
    };

    const scheduleTasks = activeTasks.filter((task) => {
        if (task.status !== 'next') return false;
        if (isSequentialBlocked(task)) return false;
        const due = safeParseDueDate(task.dueDate);
        const start = safeParseDate(task.startTime);
        const startsToday = Boolean(
            start
            && start >= startOfToday
            && start <= endOfToday
        );
        return Boolean(due && due <= endOfToday) || startsToday;
    });

    const scheduleTaskIds = new Set(scheduleTasks.map((task) => task.id));
    const nextTasks = activeTasks.filter((task) => {
        if (task.status !== 'next') return false;
        if (isPlannedForFuture(task)) return false;
        if (isSequentialBlocked(task)) return false;
        return !scheduleTaskIds.has(task.id);
    });

    const focusTasks = [...scheduleTasks, ...nextTasks];
    const listSource = sortTasksBy(focusTasks, resolveWidgetTaskSort(data));

    const maxItems = Number.isFinite(options?.maxItems)
        ? Math.max(1, Math.floor(options?.maxItems as number))
        : 3;

    const items = listSource.slice(0, maxItems).map((task) => ({
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
        inboxLabel: tr['nav.inbox'] ?? 'Inbox',
        inboxCount,
        items,
        emptyMessage: tr['agenda.noTasks'] ?? 'No tasks',
        captureLabel: tr['widget.capture'] ?? 'Quick capture',
        focusUri: WIDGET_FOCUS_URI,
        quickCaptureUri: WIDGET_QUICK_CAPTURE_URI,
        themeMode: typeof data.settings?.theme === 'string' ? data.settings.theme : 'system',
        palette,
    };
}
