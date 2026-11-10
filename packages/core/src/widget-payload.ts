import { taskMatchesAreaFilterSelection } from './area-filter';
import { format } from 'date-fns';
import {
    createDateFormatter,
    hasTimeComponent,
    isLocaleDateDayFirst,
    normalizeDateFormatSetting,
    safeParseDate,
    safeParseDueDate,
} from './date';
import { resolveAreaFilterSelection, isTaskVisibleInArea, isTaskVisibleInInbox } from './area-filter';
import { getTaskPriorityColors } from './color-constants';
import { buildFocusTaskGroups } from './focus-grouping';
import { buildFocusPools, buildFocusTaskSections, deriveFocusTaskLists } from './focus-sections';
import { NO_FOCUS_WIDGET_FILTER, type FocusWidgetFilter } from './focus-widget-filter';
import { computeTodayFocusTasks, resolveWidgetTaskSort } from './focus-widget-selection';
import { getTranslator, resolveI18nText } from './i18n';
import { SUPPORTED_LANGUAGES } from './i18n/i18n-constants';
import { getTranslationsSync, loadTranslations } from './i18n/i18n-loader';
import type { Language } from './i18n/i18n-types';
import { stripMarkdown } from './markdown';
import { isTaskInActiveProject } from './project-utils';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getAccentTint, getTaskAccentColor } from './task-accent-color';
import { isTaskActionable } from './task-status';
import { getTaskDeferUntilSource, resolveTaskSortByForFeatures, sortTasksBy } from './task-utils';
import { THEME_PRESETS } from './theme-presets';
import { resolveThemeColorScheme, resolveThemeStatusPreset } from './theme-scheme';
import type { AppData, AppTheme, Task, TaskSortBy } from './types';
import { buildWidgetCompletionToken } from './widget-completion-token';
import {
    buildWidgetSavedFilterOptions,
    buildWidgetTokenOptions,
    buildWidgetTokenTaskIndex,
    buildWidgetTaskList,
    parseWidgetListSelection,
    WIDGET_FIXED_LIST_IDS,
    WIDGET_FOCUS_AVAILABLE_LIST_ID,
    type WidgetTaskList,
    WIDGET_SAVED_FILTER_LIST_PREFIX,
    widgetListTitles,
} from './widget-lists';


export const SHORTCUTS_SNAPSHOT_VERSION = 2;
export const SHORTCUTS_SNAPSHOT_ITEM_CAP = 50;


export const SHORTCUTS_SNAPSHOT_PROJECT_CAP = 50;
export const WIDGET_FOCUS_URI = 'mindwtr:///focus';
export const WIDGET_QUICK_CAPTURE_URI = 'mindwtr:///capture-quick?mode=text';
const WIDGET_LIST_DIRECT_URIS = {
    focus: WIDGET_FOCUS_URI,
    inbox: 'mindwtr:///inbox',
    waiting: 'mindwtr:///waiting',
    someday: 'mindwtr:///someday',
} as const;
const WIDGET_PROJECT_LIST_PREFIX = 'project:';

export type WidgetSystemColorScheme = 'light' | 'dark' | null | undefined;

export interface WidgetTaskItem {
    id: string;
    completionToken?: string;

    upcomingDate?: string;

    upcomingLabel?: string;
    title: string;
    statusLabel: string;
    showStatus?: boolean;
    dueLabel: string | null;
    dueEmphasis: boolean;


    openUri: string;


    priorityColor: string | null;

    contextLabel: string | null;


    identityColor: string | null;

    dueTone: WidgetDueTone;

    contexts?: string[];


    description?: string;
    tags?: string[];
    startLabel?: string;
    priorityLabel?: string;
}


export const WIDGET_PEEK_DESCRIPTION_MAX = 600;
export const WIDGET_PEEK_TOKEN_MAX = 8;

export type WidgetDueTone = 'overdue' | 'today' | 'normal';

export interface WidgetTaskSection {
    key: string;
    title: string;

    detail: string | null;
    items: WidgetTaskItem[];
}


export type WidgetColor = `#${string}`;

export interface WidgetPalette {
    background: WidgetColor;
    card: WidgetColor;
    border: WidgetColor;
    text: WidgetColor;
    mutedText: WidgetColor;
    accent: WidgetColor;
    onAccent: WidgetColor;
    warning: WidgetColor;

    headerWash: WidgetColor;
}


export interface WidgetListPayload {
    title: string;
    dateLabel?: string;
    sections?: WidgetTaskSection[];
    items: WidgetTaskItem[];


    totalCount: number;


    openUri?: string;
}

export interface WidgetSavedFilterOption {
    id: string;
    name: string;
}

export interface TasksWidgetPayload {
    prioritiesEnabled?: boolean;
    headerTitle: string;

    dateLabel: string;
    subtitle: string;
    inboxLabel: string;
    inboxCount: number;
    focusedCount: number;
    items: WidgetTaskItem[];


    sections: WidgetTaskSection[];

    lists: Record<string, WidgetListPayload>;

    listTitles: Record<string, string>;

    savedFilters: WidgetSavedFilterOption[];

    contexts?: WidgetSavedFilterOption[];
    tags?: WidgetSavedFilterOption[];
    emptyMessage: string;
    captureLabel: string;
    completeLabel: string;
    undoLabel: string;
    chooseListLabel?: string;
    focusUri: string;
    quickCaptureUri: string;
    themeMode?: string;
    palette: WidgetPalette;

    upcomingDays?: WidgetUpcomingDays;
}


export interface WidgetUpcomingDays {
    today: string;
    tomorrow: string;
    weekdays: string[];
    dayFirst: boolean;
}


export interface AndroidQuickCaptureLabels {
    descriptionPlaceholder: string;
    title: string;
    placeholder: string;
    save: string;
    cancel: string;
    added: string;
    statusLabel: string;
    statusLabels: Record<'inbox' | 'next' | 'waiting' | 'someday', string>;
    queued: string;
    audioEnabled: boolean;
    audioRecord: string;
    audioStop: string;
    audioRecording: string;
    audioReady: string;
    audioSaved: string;
    audioError: string;
    audioPermissionDenied: string;
}


export interface AndroidTaskPeekLabels {
    complete: string;
    open: string;
    start: string;
    due: string;
    priority: string;
}

export interface AndroidTasksWidgetPayload extends TasksWidgetPayload {
    quickCapture: AndroidQuickCaptureLabels;
    taskPeek: AndroidTaskPeekLabels;

    viewAllLabel: string;
}


export function buildAndroidQuickCaptureLabels(language: Language, audioEnabled = false): AndroidQuickCaptureLabels {
    void loadTranslations(language);
    const t = getTranslator(language);
    return {
        descriptionPlaceholder: t('taskEdit.descriptionPlaceholder'),
        title: resolveI18nText(t, 'widget.capture', { fallback: 'Quick capture' }),
        placeholder: t('quickAdd.placeholder'),
        statusLabel: t('taskEdit.statusLabel'),
        statusLabels: { inbox: t('nav.inbox'), next: t('nav.next'), waiting: t('nav.waiting'), someday: t('nav.someday') },
        queued: t('quickAdd.textQueued'),
        save: resolveI18nText(t, 'common.save', { fallback: 'Save' }),
        cancel: resolveI18nText(t, 'common.cancel', { fallback: 'Cancel' }),
        added: resolveI18nText(t, 'obsidian.bringIntoMindwtrSuccess', { fallback: 'Task added to Mindwtr.' }),
        audioEnabled,
        audioRecord: t('quickAdd.audioRecord'),
        audioStop: t('quickAdd.audioStop'),
        audioRecording: t('quickAdd.audioRecording'),
        audioReady: t('quickAdd.audioReady'),
        audioSaved: t('quickAdd.audioQueued'),
        audioError: t('quickAdd.audioErrorBody'),
        audioPermissionDenied: t('quickAdd.audioPermissionBody'),
    };
}

export function buildAndroidTaskPeekLabels(language: Language): AndroidTaskPeekLabels {
    void loadTranslations(language);
    const t = getTranslator(language);
    return {
        complete: resolveI18nText(t, 'projects.complete', { fallback: 'Complete' }),
        open: resolveI18nText(t, 'common.open', { fallback: 'Open' }),
        start: resolveI18nText(t, 'taskEdit.start', { fallback: 'Start' }),
        due: resolveI18nText(t, 'task.aria.dueDate', { fallback: 'Due date' }),
        priority: resolveI18nText(t, 'taskEdit.priorityLabel', { fallback: 'Priority' }),
    };
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

    deepLink: string;
}

export interface ShortcutsSnapshotProjectGroup {
    id: string;
    name: string;
    items: ShortcutsSnapshotTaskItem[];
    coverage: { eligible: number; published: number; omitted: number };
}

export interface ShortcutsSnapshot {
    version: typeof SHORTCUTS_SNAPSHOT_VERSION;
    generatedAt: string;
    lists: Record<ShortcutsSnapshotListKey, ShortcutsSnapshotTaskItem[]>;
    projects: ShortcutsSnapshotProjectGroup[];
    coverage: {
        lists: Record<ShortcutsSnapshotListKey, { eligible: number; published: number; omitted: number }>;
        projects: { eligible: number; published: number; omitted: number };
        tasks: { eligible: number; published: number; omitted: number };
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];


const formatShortWeekday = (date: Date, language: string): string => {
    try {
        return new Intl.DateTimeFormat(language, { weekday: 'short' }).format(date);
    } catch {
        return FALLBACK_SHORT_WEEKDAYS[date.getDay()];
    }
};


const getDeviceLocaleTag = (): string => {
    try {
        return String(Intl.DateTimeFormat().resolvedOptions().locale || '');
    } catch {
        return '';
    }
};


export const resolveWidgetDayFirst = (
    dateFormat: string | null | undefined,
    systemLocale?: string,
): boolean => {
    const setting = normalizeDateFormatSetting(dateFormat);
    if (setting === 'dmy') return true;
    if (setting === 'mdy' || setting === 'ymd') return false;
    return isLocaleDateDayFirst(systemLocale || getDeviceLocaleTag());
};

const formatNumericDate = (date: Date, dayFirst: boolean): string => {
    const day = date.getDate();
    const month = date.getMonth() + 1;
    return dayFirst ? `${day}/${month}` : `${month}/${day}`;
};


const formatRelativeDayLabel = (
    date: Date,
    tr: Record<string, string>,
    language: string,
    dayFirst: boolean,
    startOfToday: Date,
    endOfToday: Date,
): string => {
    if (date < startOfToday) return formatNumericDate(date, dayFirst);
    if (date <= endOfToday) return tr['quickDate.today'] ?? 'Today';
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysAhead = Math.round((dayStart.getTime() - startOfToday.getTime()) / DAY_MS);
    if (daysAhead === 1) return tr['quickDate.tomorrow'] ?? 'Tomorrow';
    if (daysAhead <= 6) return formatShortWeekday(date, language);
    return formatNumericDate(date, dayFirst);
};

const computeDueLabel = (
    dueDate: string | undefined | null,
    tr: Record<string, string>,
    language: string,
    dayFirst: boolean,
    startOfToday: Date,
    endOfToday: Date,
): Pick<WidgetTaskItem, 'dueLabel' | 'dueEmphasis' | 'dueTone'> => {
    const due = safeParseDueDate(dueDate);
    if (!due) return { dueLabel: null, dueEmphasis: false, dueTone: 'normal' };
    const dueLabel = formatRelativeDayLabel(due, tr, language, dayFirst, startOfToday, endOfToday);
    if (due < startOfToday) return { dueLabel, dueEmphasis: true, dueTone: 'overdue' };
    if (due <= endOfToday) return { dueLabel, dueEmphasis: true, dueTone: 'today' };
    return { dueLabel, dueEmphasis: false, dueTone: 'normal' };
};


const createWidgetDateFormatter = (
    settings: AppData['settings'] | undefined,
    language: Language,
    systemLocale?: string,
): ReturnType<typeof createDateFormatter> => {
    return createDateFormatter({
        language: settings?.language || language,
        dateFormat: settings?.dateFormat,
        calendarSystem: settings?.calendarSystem,
        timeFormat: settings?.timeFormat,
        systemLocale: systemLocale || getDeviceLocaleTag(),
    });
};

const FALLBACK_LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FALLBACK_SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];


const formatDateLabel = (date: Date, language: string, weekday: 'long' | 'short'): string => {
    try {
        return new Intl.DateTimeFormat(language, { weekday, month: 'short', day: 'numeric' }).format(date);
    } catch {
        const day = weekday === 'long' ? FALLBACK_LONG_WEEKDAYS[date.getDay()] : FALLBACK_SHORT_WEEKDAYS[date.getDay()];
        return `${day}, ${FALLBACK_SHORT_MONTHS[date.getMonth()]} ${date.getDate()}`;
    }
};


const resolveWidgetSort = (data: AppData): TaskSortBy => (
    resolveTaskSortByForFeatures(resolveWidgetTaskSort(data.settings?.taskSortBy), data.settings)
);


export function resolveWidgetLanguage(saved: string | null, setting?: string, systemLanguage: Language = 'en'): Language {
    const candidate = setting && setting !== 'system' ? setting : saved;
    if (candidate && SUPPORTED_LANGUAGES.includes(candidate as Language)) return candidate as Language;
    return systemLanguage;
}

const resolveWidgetStatusPreset = (
    themeMode: string | undefined,
    systemColorScheme: WidgetSystemColorScheme,
) => resolveThemeStatusPreset(
    (themeMode || '').toLowerCase() as AppTheme,
    systemColorScheme === 'dark' ? 'dark' : 'light',
);

const resolveWidgetPalette = (
    themeMode: string | undefined,
    systemColorScheme: WidgetSystemColorScheme,
): WidgetPalette => {
    const systemScheme = systemColorScheme === 'dark' ? 'dark' : 'light';
    const presetName = resolveWidgetStatusPreset(themeMode, systemColorScheme);
    if (presetName) {
        const preset = THEME_PRESETS[presetName];
        const presetIsDark = resolveThemeColorScheme(presetName, systemScheme) === 'dark';
        return {
            background: preset.cardBg,
            card: preset.taskItemBg,
            border: preset.border,
            text: preset.text,
            mutedText: preset.secondaryText,
            accent: preset.tint,
            onAccent: preset.onTint,
            warning: preset.warning,
            headerWash: (getAccentTint(preset.tint, presetIsDark ? 0.18 : 0.12) ?? preset.tint) as WidgetColor,
        };
    }

    const isDark = resolveThemeColorScheme((themeMode || '').toLowerCase() as AppTheme, systemScheme) === 'dark';

    if (isDark) {
        return {
            background: '#111827',
            card: '#1F2937',
            border: '#374151',
            text: '#F9FAFB',
            mutedText: '#CBD5E1',
            accent: '#2563EB',
            onAccent: '#FFFFFF',
            warning: '#F59E0B',
            headerWash: getAccentTint('#2563EB', 0.18) as WidgetColor,
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
        warning: '#D97706',
        headerWash: getAccentTint('#2563EB', 0.12) as WidgetColor,
    };
};

export interface WidgetPayloadBuildOptions {
    systemColorScheme?: WidgetSystemColorScheme;
    maxItems?: number;
    listIds?: readonly string[];

    includeSavedFilterLists?: boolean;

    includeTokenLists?: boolean;

    focusFilter?: FocusWidgetFilter;

    systemLocale?: string;
}

export interface WidgetPayloadProjection {
    build: (maxItems?: number) => TasksWidgetPayload;

    getTaskList: (listId: string) => WidgetTaskList | null;
}

export type WidgetPayloadProjectionOptions = Omit<WidgetPayloadBuildOptions, 'maxItems'>;

export function createWidgetPayloadProjection(
    data: AppData,
    language: Language,
    options?: WidgetPayloadProjectionOptions,
): WidgetPayloadProjection {
    void loadTranslations(language);
    const tr = getTranslationsSync(language);
    const tasks = data.tasks || [];
    const projects = data.projects || [];
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const dayFirst = resolveWidgetDayFirst(data.settings?.dateFormat, options?.systemLocale);
    const formatAbsoluteDate = createWidgetDateFormatter(data.settings, language, options?.systemLocale);
    const formatTime = (date: Date) => formatAbsoluteDate(date, 'p');
    const palette = resolveWidgetPalette(
        typeof data.settings?.theme === 'string' ? data.settings.theme : undefined,
        options?.systemColorScheme,
    );
    const statusPreset = resolveWidgetStatusPreset(
        typeof data.settings?.theme === 'string' ? data.settings.theme : undefined,
        options?.systemColorScheme,
    );


    const sortedAreas = (data.areas || [])
        .filter((area) => !area.deletedAt)
        .sort((left, right) => (left.order !== right.order ? left.order - right.order : left.name.localeCompare(right.name)));
    const areaById = new Map(sortedAreas.map((area) => [area.id, area]));
    const areaVisibility = {
        areaById,
        projectById,
        resolvedAreaFilter: resolveAreaFilterSelection(data.settings?.filters, sortedAreas),
    };

    const undeletedActionableTasks = tasks.filter((task) => !task.deletedAt && isTaskActionable(task));
    const activeTasks = undeletedActionableTasks.filter((task) => {
        if (!isTaskInActiveProject(task, projectById)) return false;
        return isTaskVisibleInArea(task, areaVisibility);
    });


    const inboxTasks = undeletedActionableTasks.filter((task) => (
        task.status === 'inbox' && isTaskVisibleInInbox(task, areaVisibility)
    ));

    const widgetSort = resolveWidgetSort(data);

    const prioritiesEnabled = resolveFeatureFlags(data.settings).priorities;
    const peekDescription = (task: Task): string | undefined => {
        const text = stripMarkdown(task.description ?? '').trim();
        if (!text) return undefined;
        return text.length > WIDGET_PEEK_DESCRIPTION_MAX
            ? `${text.slice(0, WIDGET_PEEK_DESCRIPTION_MAX).trimEnd()}…`
            : text;
    };
    const peekStartLabel = (task: Task): string | undefined => {
        const start = safeParseDate(task.startTime);
        if (!start) return undefined;
        const day = formatRelativeDayLabel(start, tr, language, dayFirst, startOfToday, endOfToday);
        return hasTimeComponent(task.startTime) ? `${day} ${formatTime(start)}` : day;
    };
    const itemById = new Map<string, WidgetTaskItem>();
    const toItem = (task: Task): WidgetTaskItem => {
        const cached = itemById.get(task.id);
        if (cached) return cached;
        const project = task.projectId ? projectById.get(task.projectId) : undefined;
        const area = task.areaId ? areaById.get(task.areaId) : undefined;
        const description = peekDescription(task);
        const contexts = (task.contexts ?? []).slice(0, WIDGET_PEEK_TOKEN_MAX);
        const tags = (task.tags ?? []).slice(0, WIDGET_PEEK_TOKEN_MAX);
        const startLabel = peekStartLabel(task);
        const priorityLabel = prioritiesEnabled && task.priority
            ? tr[`priority.${task.priority}`] ?? task.priority
            : undefined;
        const item: WidgetTaskItem = {
            id: task.id,
            completionToken: buildWidgetCompletionToken(task),
            title: task.title,
            statusLabel: tr[`status.${task.status}`] || task.status,
            ...computeDueLabel(task.dueDate, tr, language, dayFirst, startOfToday, endOfToday),
            openUri: `mindwtr://open?task=${encodeURIComponent(task.id)}`,
            priorityColor: prioritiesEnabled && task.priority ? getTaskPriorityColors(statusPreset)[task.priority] ?? null : null,
            contextLabel: project?.title ?? area?.name ?? null,
            identityColor: getTaskAccentColor(task, projectById, areaById, statusPreset) ?? null,
            ...(description ? { description } : {}),
            ...(contexts.length ? { contexts } : {}),
            ...(tags.length ? { tags } : {}),
            ...(startLabel ? { startLabel } : {}),
            ...(priorityLabel ? { priorityLabel } : {}),
        };
        itemById.set(task.id, item);
        return item;
    };
    const toUpcomingItem = (task: Task): WidgetTaskItem => {
        const item = { ...toItem(task) };
        delete item.completionToken;
        const source = getTaskDeferUntilSource(task);
        const parsed = safeParseDate(source);
        if (!source || !parsed) return item;

        const upcomingDate = !hasTimeComponent(source) ? format(parsed, 'yyyy-MM-dd')
            : /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(source) ? parsed.toISOString()
                : format(parsed, "yyyy-MM-dd'T'HH:mm:ss.SSS");
        const upcomingLabel = safeParseDate(task.startTime)
            ? tr['widget.upcomingStarts'] ?? 'Starts'
            : tr['widget.upcomingReturns'] ?? 'Returns';
        const day = formatRelativeDayLabel(parsed, tr, language, dayFirst, startOfToday, endOfToday);
        const label = hasTimeComponent(source) ? `${day} ${formatTime(parsed)}` : day;
        return { ...item, upcomingDate, upcomingLabel, dueLabel: `${upcomingLabel} ${label}`, dueTone: 'normal', dueEmphasis: false };
    };


    const focusFilter = options?.focusFilter ?? NO_FOCUS_WIDGET_FILTER;
    const pools = buildFocusPools({
        tasks: undeletedActionableTasks,
        visibleTasks: activeTasks,
        isAreaVisible: (task) => taskMatchesAreaFilterSelection(task, areaVisibility.resolvedAreaFilter, projectById, areaVisibility.areaById),
        projects,
        criteria: focusFilter.criteria,
        now,
    });
    const lists = deriveFocusTaskLists(pools, {
        now,
        projects,
        sections: data.sections || [],
        sortBy: focusFilter.sortBy,
        prioritiesEnabled,
        sortOrder: focusFilter.sortOrder,
        focusIncludeStartDates: data.settings?.gtd?.focusIncludeStartDates,
    });


    const curatedTasks = [...lists.focusedTasks, ...lists.schedule];
    const curatedSections: { key: string; title: string; items: Task[] }[] = buildFocusTaskSections(lists, (key) => tr[key])
        .filter((section) => section.key === 'focus' || section.key === 'schedule');


    const curatedIds = new Set(curatedTasks.map((task) => task.id));
    const availableTasks = lists.nextActions.filter((task) => {
        const start = safeParseDate(task.startTime);
        return start !== null && start.getTime() <= now.getTime() && !curatedIds.has(task.id);
    });
    const inboxCount = inboxTasks.length;
    const dateLabel = formatDateLabel(now, language, 'long');
    const listContext = { data, activeTasks, inboxTasks, now, focusLists: lists, sortBy: widgetSort, prioritiesEnabled, tr,
        tokenTaskIndex: options?.listIds?.some((id) => {
            const base = parseWidgetListSelection(id)?.listId ?? '';
            return base.startsWith('context:') || base.startsWith('tag:');
        })
            ? buildWidgetTokenTaskIndex(activeTasks) : undefined };
    const listTitles = widgetListTitles(tr);
    const savedFilters = buildWidgetSavedFilterOptions(data);
    const tokenSources = options?.includeTokenLists ? { ...data, tasks: tasks.filter((task) => !task.deletedAt
        && isTaskInActiveProject(task, projectById) && isTaskVisibleInArea(task, areaVisibility)) } : data;
    const contexts = options?.includeTokenLists ? buildWidgetTokenOptions(tokenSources, 'contexts') : undefined;
    const tags = options?.includeTokenLists ? buildWidgetTokenOptions(tokenSources, 'tags') : undefined;
    const taskLists = new Map<string, NonNullable<ReturnType<typeof buildWidgetTaskList>>>();
    const requestedListIds = new Set(options?.listIds ?? []);
    const includeFocusAvailable = requestedListIds.has(WIDGET_FOCUS_AVAILABLE_LIST_ID);
    if (options?.includeSavedFilterLists) {
        for (const { id } of savedFilters) requestedListIds.add(`${WIDGET_SAVED_FILTER_LIST_PREFIX}${id}`);
    }
    for (const selection of requestedListIds) {
        const parsed = parseWidgetListSelection(selection);
        if (!parsed) continue;
        const { listId, groupBy } = parsed;
        if (listId === 'focus') continue;
        const projectId = listId.startsWith(WIDGET_PROJECT_LIST_PREFIX)
            ? listId.slice(WIDGET_PROJECT_LIST_PREFIX.length)
            : null;
        const project = projectId ? projectById.get(projectId) : undefined;
        const projectList = projectId && project && !project.deletedAt
            && (project.status === 'active' || project.isFocused === true)
            ? {
                title: project.title,
                tasks: sortTasksBy(activeTasks.filter((task) => task.projectId === projectId), project.taskSortBy ?? widgetSort),
            }
            : null;
        const list = projectId ? projectList : buildWidgetTaskList(listId, listContext);
        if (list) taskLists.set(selection, { ...list, ...(groupBy ? { groupBy } : {}) });
    }
    const scheduleById = new Map(lists.schedule.map((task) => [task.id, task]));


    const dropSameDayDue = (item: WidgetTaskItem, task: Task): WidgetTaskItem => {
        if (item.dueTone === 'overdue' || !item.dueLabel) return item;
        const due = safeParseDueDate(task.dueDate);
        if (!due || due < startOfToday || due > endOfToday) return item;
        return { ...item, dueLabel: hasTimeComponent(task.dueDate) ? formatTime(due) : null };
    };

    return {
        getTaskList: (listId: string): WidgetTaskList | null => {
            if (listId === 'focus') {
                return { title: listTitles.focus, tasks: curatedTasks };
            }
            return taskLists.get(listId) ?? null;
        },
        build: (requestedMaxItems?: number): TasksWidgetPayload => {
            const maxItems = Number.isFinite(requestedMaxItems)
                ? Math.max(1, Math.floor(requestedMaxItems as number))
                : 3;
            const items = curatedTasks.slice(0, maxItems).map(toItem);
            const hiddenTaskCount = Math.max(curatedTasks.length - items.length, 0);


            const buildSections = (source: typeof curatedSections): WidgetTaskSection[] => {
                let remaining = maxItems;
                const built: WidgetTaskSection[] = [];
                for (const section of source) {
                    if (remaining <= 0) break;
                    if (section.items.length === 0) continue;
                    const sectionItems = section.items.slice(0, remaining).map(toItem);
                    remaining -= sectionItems.length;
                    built.push({
                        key: section.key,
                        title: section.title,
                        detail: section.key === 'schedule' ? formatDateLabel(now, language, 'short') : null,
                        items: section.key === 'schedule'
                            ? sectionItems.map((item) => {
                                const task = scheduleById.get(item.id);
                                return task ? dropSameDayDue(item, task) : item;
                            })
                            : sectionItems,
                    });
                }
                return built;
            };
            const sections = buildSections(curatedSections);

            const subtitleParts = [`${tr['nav.inbox'] ?? 'Inbox'}: ${inboxCount}`];
            if (hiddenTaskCount > 0) {
                subtitleParts.push(`+${hiddenTaskCount} ${tr['common.more'] ?? 'More'}`);
            }

            const listPayloads: Record<string, WidgetListPayload> = {
                focus: {
                    title: listTitles.focus,
                    dateLabel,
                    sections,
                    items,
                    totalCount: curatedTasks.length,
                    openUri: WIDGET_LIST_DIRECT_URIS.focus,
                },
            };
            if (includeFocusAvailable) {
                const focusAvailableTasks = [...curatedTasks, ...availableTasks];
                listPayloads[WIDGET_FOCUS_AVAILABLE_LIST_ID] = {
                    title: listTitles.focus,
                    dateLabel,
                    sections: buildSections([...curatedSections, {
                        key: 'available',
                        title: tr['widget.availableActions'] ?? 'Available actions',
                        items: availableTasks,
                    }]),
                    items: focusAvailableTasks.slice(0, maxItems).map(toItem),
                    totalCount: focusAvailableTasks.length,
                    openUri: WIDGET_LIST_DIRECT_URIS.focus,
                };
            }
            let hasUpcoming = false;
            for (const [selection, list] of taskLists) {
                const listId = parseWidgetListSelection(selection)!.listId;
                if (listId === 'upcoming') hasUpcoming = true;
                const directUri = WIDGET_LIST_DIRECT_URIS[listId as keyof typeof WIDGET_LIST_DIRECT_URIS];
                const openUri = directUri
                    ?? `mindwtr:///widget-list/${encodeURIComponent(listId)}`;
                const toListItem = (task: Task): WidgetTaskItem => ({
                    ...(listId === 'upcoming' ? toUpcomingItem(task) : toItem(task)),
                    ...(list.showStatus ? { showStatus: true } : {}),
                });
                const groupBy = list.groupBy === 'priority' && !prioritiesEnabled ? 'none' : list.groupBy;
                const groups = groupBy && groupBy !== 'none' ? buildFocusTaskGroups({
                    groupBy, tasks: list.tasks, projects, areas: data.areas || [],
                    resolveText: (key, fallback) => tr[key] || fallback,
                    theme: statusPreset ?? undefined,
                }) : [];
                let budget = maxItems;
                const groupedSections: WidgetTaskSection[] = [];
                for (const group of groups) {
                    if (budget <= 0) break;
                    const visible = group.tasks.slice(0, budget);
                    budget -= visible.length;
                    groupedSections.push({ key: group.key, title: group.label,
                        detail: String(group.tasks.length), items: visible.map(toListItem) });
                }
                listPayloads[selection] = {
                    title: list.title,
                    items: groups.length ? groupedSections.flatMap((section) => section.items)
                        : list.tasks.slice(0, maxItems).map(toListItem),
                    ...(groups.length ? { sections: groupedSections } : {}),
                    totalCount: list.tasks.length,
                    openUri,
                };
            }

            return {
                prioritiesEnabled,
                headerTitle: tr['agenda.todaysFocus'] ?? 'Today',
                dateLabel,
                subtitle: subtitleParts.join(' · '),
                inboxLabel: tr['nav.inbox'] ?? 'Inbox',
                inboxCount,
                focusedCount: pools.selection.globalCount,
                items,
                sections,
                lists: listPayloads,
                listTitles: options?.includeTokenLists ? { ...listTitles,
                    contexts: tr['contexts.title'] ?? 'Contexts', tags: tr['tags.title'] ?? 'Tags',
                    search: tr['common.search'] ?? 'Search',
                    focusAvailable: tr['widget.includeAvailableActions'] ?? 'Add Next Actions whose start date has arrived',
                } : listTitles,
                savedFilters,
                ...(contexts ? { contexts } : {}),
                ...(tags ? { tags } : {}),
                emptyMessage: tr['list.noTasks'] ?? 'No tasks found',
                captureLabel: tr['widget.capture'] ?? 'Quick capture',
                completeLabel: tr['review.markDone'] ?? 'Mark Done',
                undoLabel: tr['common.undo'] ?? 'Undo',
                chooseListLabel: tr['common.change'] ?? 'Change',
                focusUri: WIDGET_FOCUS_URI,
                quickCaptureUri: WIDGET_QUICK_CAPTURE_URI,
                themeMode: typeof data.settings?.theme === 'string' ? data.settings.theme : 'system',
                ...(hasUpcoming ? { upcomingDays: {
                    today: tr['quickDate.today'] ?? 'Today',
                    tomorrow: tr['quickDate.tomorrow'] ?? 'Tomorrow',

                    weekdays: Array.from({ length: 7 }, (_, day) => formatShortWeekday(new Date(2026, 0, 4 + day), language)),
                    dayFirst,
                } } : {}),
                palette,
            };
        },
    };
}

export function buildWidgetPayload(
    data: AppData,
    language: Language,
    options?: WidgetPayloadBuildOptions,
): TasksWidgetPayload {
    const { maxItems, ...projectionOptions } = options ?? {};
    return createWidgetPayloadProjection(data, language, projectionOptions).build(maxItems);
}


export const ANDROID_WIDGET_MAX_ITEMS = 200;


export const IOS_WIDGET_FAMILY_CACHE_ITEMS = {
    default: 20,
    small: 11,
    medium: 13,
    large: 20,
    extraLarge: 32,
} as const;

export interface WidgetPublicationInput {
    systemColorScheme?: WidgetSystemColorScheme;

    focusFilter?: FocusWidgetFilter;


    systemLocale?: string;
}


export function androidWidgetProjectionOptions(
    input: WidgetPublicationInput & { listSelections: readonly string[] },
): WidgetPayloadProjectionOptions {
    return {
        systemColorScheme: input.systemColorScheme,
        focusFilter: input.focusFilter,
        systemLocale: input.systemLocale,
        listIds: [...WIDGET_FIXED_LIST_IDS, ...input.listSelections],
        includeTokenLists: true,
    };
}


export function iosWidgetProjectionOptions(input: WidgetPublicationInput): WidgetPayloadProjectionOptions {
    return {
        systemColorScheme: input.systemColorScheme,
        focusFilter: input.focusFilter,
        systemLocale: input.systemLocale,

        listIds: [...WIDGET_FIXED_LIST_IDS, WIDGET_FOCUS_AVAILABLE_LIST_ID],
        includeSavedFilterLists: true,
    };
}


export function createPublishedWidgetProjection(
    projection: WidgetPayloadProjection,
    language: Language,
): WidgetPayloadProjection {
    return {
        getTaskList: projection.getTaskList,
        build: (maxItems) => {
            const payload = projection.build(maxItems);
            return {
                ...payload,
                headerTitle: getTranslator(language)('focus.schedule'),
            };
        },
    };
}


export function isWidgetAudioCaptureEnabled(settings: AppData['settings']): boolean {
    return settings.ai?.speechToText?.enabled === true;
}


export function buildAndroidTasksWidgetPayload(
    rendered: TasksWidgetPayload,
    language: Language,
    audioEnabled: boolean,
): AndroidTasksWidgetPayload {
    return {
        ...rendered,
        quickCapture: buildAndroidQuickCaptureLabels(language, audioEnabled),
        taskPeek: buildAndroidTaskPeekLabels(language),
        viewAllLabel: getTranslator(language)('widget.viewAllTasks'),
    };
}


export function buildAndroidWidgetPublication(
    data: AppData,
    language: Language,
    input: WidgetPublicationInput & { listSelections: readonly string[] },
): AndroidTasksWidgetPayload {
    const projection = createPublishedWidgetProjection(
        createWidgetPayloadProjection(data, language, androidWidgetProjectionOptions(input)),
        language,
    );
    return buildAndroidTasksWidgetPayload(
        projection.build(ANDROID_WIDGET_MAX_ITEMS),
        language,
        isWidgetAudioCaptureEnabled(data.settings),
    );
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
        deepLink: `mindwtr://open?task=${encodeURIComponent(task.id)}`,
    };
};


export function buildShortcutsSnapshot(data: AppData): ShortcutsSnapshot {
    const tasks = data.tasks || [];
    const projects = data.projects || [];
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const now = new Date();
    const widgetSort = resolveWidgetSort(data);

    const activeTasks = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (!isTaskActionable(task)) return false;
        if (!isTaskInActiveProject(task, projectById)) return false;
        return true;
    });

    const { starredTasks, focusTasks } = computeTodayFocusTasks({
        activeTasks,
        projects,
        sections: data.sections || [],
        sortBy: widgetSort,
        now,
        focusIncludeStartDates: data.settings?.gtd?.focusIncludeStartDates,
    });
    const focusListSource = [...starredTasks, ...focusTasks];

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


    const tasksByProjectId = new Map<string, AppData['tasks']>();
    for (const task of activeTasks) {
        if (!task.projectId) continue;
        const bucket = tasksByProjectId.get(task.projectId);
        if (bucket) bucket.push(task);
        else tasksByProjectId.set(task.projectId, [task]);
    }

    const eligibleProjects = projects
        .filter((project) => project.status === 'active' && !project.deletedAt)
        .filter((project) => (tasksByProjectId.get(project.id)?.length ?? 0) > 0)


        .sort((a, b) => a.order - b.order);

    const projectGroups: ShortcutsSnapshotProjectGroup[] = eligibleProjects
        .slice(0, SHORTCUTS_SNAPSHOT_PROJECT_CAP)
        .map((project) => {
            const eligibleProjectTasks = sortTasksBy(
                tasksByProjectId.get(project.id) ?? [],
                widgetSort,
            );
            const projectTasks = eligibleProjectTasks.slice(0, SHORTCUTS_SNAPSHOT_ITEM_CAP);
            return {
                id: project.id,
                name: project.title,


                items: projectTasks.map((task) => buildSnapshotItem(task, task.status as ShortcutsSnapshotListKey, projectById)),
                coverage: {
                    eligible: eligibleProjectTasks.length,
                    published: projectTasks.length,
                    omitted: Math.max(0, eligibleProjectTasks.length - projectTasks.length),
                },
            };
        });

    const listCoverage = SHORTCUTS_SNAPSHOT_LISTS.reduce((acc, key) => {
        const eligible = listTasksByKey[key].length;
        const published = lists[key].length;
        acc[key] = { eligible, published, omitted: Math.max(0, eligible - published) };
        return acc;
    }, {} as ShortcutsSnapshot['coverage']['lists']);
    const publishedTaskIds = new Set<string>();
    for (const items of Object.values(lists)) {
        for (const item of items) publishedTaskIds.add(item.id);
    }
    for (const group of projectGroups) {
        for (const item of group.items) publishedTaskIds.add(item.id);
    }

    return {
        version: SHORTCUTS_SNAPSHOT_VERSION,
        generatedAt: now.toISOString(),
        lists,
        projects: projectGroups,
        coverage: {
            lists: listCoverage,
            projects: {
                eligible: eligibleProjects.length,
                published: projectGroups.length,
                omitted: Math.max(0, eligibleProjects.length - projectGroups.length),
            },
            tasks: {
                eligible: activeTasks.length,
                published: publishedTaskIds.size,
                omitted: Math.max(0, activeTasks.length - publishedTaskIds.size),
            },
        },
    };
}
