import {
    applyFilter,
    computeTodayFocusTasks,
    getAccentTint,
    getTaskAccentColor,
    getUpcomingDeferredTasks,
    hasTimeComponent,
    resolveFeatureFlags,
    shouldShowTaskForStart,
    getTranslationsSync,
    getTranslator,
    isTaskActionable,
    isTaskInActiveProject,
    isTaskVisibleInArea,
    loadTranslations,
    resolveAreaFilterSelection,
    resolveI18nText,
    resolveTaskSortByForFeatures,
    resolveThemeColorScheme,
    safeParseDate,
    safeParseDueDate,
    sortTasksBy,
    sortTasksBySavedPreference,
    stripMarkdown,
    SUPPORTED_LANGUAGES,
    type AppData,
    type AppTheme,
    type Language,
    type Task,
    type TaskSortBy,
    TASK_PRIORITY_COLORS,
} from '@mindwtr/core';
import { THEME_PRESETS, type ThemePresetName } from '../constants/theme-presets';
import { buildFocusTaskSections, deriveFocusTaskLists } from './focus-sections';
import { NO_FOCUS_WIDGET_FILTER, type FocusWidgetFilter } from './focus-widget-filter';
import { buildWidgetCompletionToken } from './widget-completion-token';
import {
    buildWidgetSavedFilterOptions,
    buildWidgetTaskList,
    WIDGET_SAVED_FILTER_LIST_PREFIX,
    widgetListTitles,
} from './widget-lists';

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
export const IOS_WIDGET_COMPACT_KIND = 'MindwtrCompactWidget';
export const IOS_WIDGET_LOCK_KIND = 'MindwtrFocusLockWidget';
export const WIDGET_FOCUS_URI = 'mindwtr:///focus';
export const WIDGET_QUICK_CAPTURE_URI = 'mindwtr:///capture-quick?mode=text';
type ConcreteThemePresetName = Exclude<ThemePresetName, 'default'>;

export type WidgetSystemColorScheme = 'light' | 'dark' | null | undefined;

export interface WidgetTaskItem {
    id: string;
    completionToken?: string;
    title: string;
    statusLabel: string;
    dueLabel: string | null;
    dueEmphasis: boolean;
    // Deep link that opens this task (the app routes mindwtr://open?task=<id>);
    // shared by Android and iOS widget rows.
    openUri: string;
    // Priority heat-ramp hex (core TASK_PRIORITY_COLORS); null when the task has
    // none or the Priorities feature is off.
    priorityColor: string | null;
    // Project title, else area name, else null.
    contextLabel: string | null;
    // The task's identity colour (core getTaskAccentColor: chosen project
    // colour, else area colour); null when neither is set.
    identityColor: string | null;
    // How the due label should read: overdue (warning), today (accent), normal.
    dueTone: WidgetDueTone;
    // The rest is only read by the Android task sheet (#1173), so every field
    // is left out when it is empty: they ride every row of every list.
    description?: string;
    contexts?: string[];
    tags?: string[];
    startLabel?: string;
    priorityLabel?: string;
}

// The sheet shows an excerpt, not the note: a description is per-row payload
// weight, and the app is one tap away for the whole thing.
export const WIDGET_PEEK_DESCRIPTION_MAX = 600;
export const WIDGET_PEEK_TOKEN_MAX = 8;

export type WidgetDueTone = 'overdue' | 'today' | 'normal';

export interface WidgetTaskSection {
    key: string;
    title: string;
    // Secondary part next to the title (the short date for Today); null otherwise.
    detail: string | null;
    items: WidgetTaskItem[];
}

// Hex only: the Android provider (modules/android-widget WidgetPayload.kt) and
// the iOS widget parse these themselves.
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
    // Accent wash for the widget header band over the card (core getAccentTint).
    headerWash: WidgetColor;
}

// One list a placed Tasks widget can show (#1173); `focus` mirrors the
// payload's curated Today's Focus + Today sections/items.
export interface WidgetListPayload {
    title: string;
    dateLabel?: string;
    sections?: WidgetTaskSection[];
    items: WidgetTaskItem[];
}

export interface WidgetSavedFilterOption {
    id: string;
    name: string;
}

export interface TasksWidgetPayload {
    headerTitle: string;
    // Today's date for the widget header band, localized ("Saturday, Sep 6").
    dateLabel: string;
    subtitle: string;
    inboxLabel: string;
    inboxCount: number;
    focusedCount: number;
    items: WidgetTaskItem[];
    // The calm default from the Focus screen (#1173): Today's Focus + Today,
    // empty sections dropped, with `maxItems` shared across the two sections.
    // `items` stays for flat/legacy widget layouts and the QuickCapture kind.
    sections: WidgetTaskSection[];
    // The lists placed widgets asked for (always `focus`), keyed by list id.
    lists: Record<string, WidgetListPayload>;
    // Titles of the fixed lists for the configuration screen.
    listTitles: Record<string, string>;
    // Saved filters the configuration screen offers.
    savedFilters: WidgetSavedFilterOption[];
    emptyMessage: string;
    captureLabel: string;
    completeLabel: string;
    undoLabel: string;
    focusUri: string;
    quickCaptureUri: string;
    themeMode?: string;
    palette: WidgetPalette;
}

// Labels for the native Android quick-capture dialog (#1169). Localized here
// so the Kotlin side (modules/android-widget) carries no string tables.
export interface AndroidQuickCaptureLabels {
    title: string;
    placeholder: string;
    save: string;
    cancel: string;
    added: string;
    audioEnabled: boolean;
    audioRecord: string;
    audioStop: string;
    audioRecording: string;
    audioReady: string;
    audioSaved: string;
    audioError: string;
    audioPermissionDenied: string;
}

// Labels for the native Android task sheet a widget row opens (#1173).
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
}

// Core's translator owns the locale-then-English chain; a second raw dictionary
// read in this module would be the hand-rolled fallback the i18n ratchet forbids.
export function buildAndroidQuickCaptureLabels(language: Language, audioEnabled = false): AndroidQuickCaptureLabels {
    void loadTranslations(language);
    const t = getTranslator(language);
    return {
        title: resolveI18nText(t, 'widget.capture', { fallback: 'Quick capture' }),
        placeholder: resolveI18nText(t, 'inbox.addPlaceholder', { fallback: 'Add task to inbox...' }),
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

// Today / Tomorrow / weekday inside the week / a short date, shared by the row
// due label and the task sheet's start line.
const formatRelativeDayLabel = (
    date: Date,
    tr: Record<string, string>,
    language: string,
    startOfToday: Date,
    endOfToday: Date,
): string => {
    if (date < startOfToday) return formatNumericDate(date, language);
    if (date <= endOfToday) return tr['quickDate.today'] ?? 'Today';
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysAhead = Math.round((dayStart.getTime() - startOfToday.getTime()) / DAY_MS);
    if (daysAhead === 1) return tr['quickDate.tomorrow'] ?? 'Tomorrow';
    if (daysAhead <= 6) return formatShortWeekday(date, language);
    return formatNumericDate(date, language);
};

const computeDueLabel = (
    dueDate: string | undefined | null,
    tr: Record<string, string>,
    language: string,
    startOfToday: Date,
    endOfToday: Date,
): Pick<WidgetTaskItem, 'dueLabel' | 'dueEmphasis' | 'dueTone'> => {
    const due = safeParseDueDate(dueDate);
    if (!due) return { dueLabel: null, dueEmphasis: false, dueTone: 'normal' };
    const dueLabel = formatRelativeDayLabel(due, tr, language, startOfToday, endOfToday);
    if (due < startOfToday) return { dueLabel, dueEmphasis: true, dueTone: 'overdue' };
    if (due <= endOfToday) return { dueLabel, dueEmphasis: true, dueTone: 'today' };
    return { dueLabel, dueEmphasis: false, dueTone: 'normal' };
};

// A due TIME for a row inside a dated section (Todoist shows "17:00", not the
// date, under a "Today" header); null when the due date carries no time.
const formatDueTime = (date: Date, language: string): string => {
    try {
        return new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' }).format(date);
    } catch {
        return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
};

const FALLBACK_LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FALLBACK_SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Saturday, Sep 6" for the header band; "Sat Sep 6" for a section detail.
const formatDateLabel = (date: Date, language: string, weekday: 'long' | 'short'): string => {
    try {
        return new Intl.DateTimeFormat(language, { weekday, month: 'short', day: 'numeric' }).format(date);
    } catch {
        const day = weekday === 'long' ? FALLBACK_LONG_WEEKDAYS[date.getDay()] : FALLBACK_SHORT_WEEKDAYS[date.getDay()];
        return `${day}, ${FALLBACK_SHORT_MONTHS[date.getMonth()]} ${date.getDate()}`;
    }
};

const resolveWidgetTaskSort = (data: AppData): TaskSortBy => {
    const sortBy = data.settings?.taskSortBy;
    const allowed = TASK_SORT_OPTIONS.includes(sortBy as TaskSortBy) ? (sortBy as TaskSortBy) : 'default';
    // Widgets follow the feature toggles too (#1107).
    return resolveTaskSortByForFeatures(allowed, data.settings);
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
            warning: preset.warning,
            headerWash: (getAccentTint(preset.tint, isDarkPreset(preset) ? 0.18 : 0.12) ?? preset.tint) as WidgetColor,
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

// A preset counts as dark when its background is darker than mid-grey.
const isDarkPreset = (preset: { bg: string }): boolean => {
    const hex = preset.bg.replace('#', '');
    if (hex.length !== 6) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
};

export interface WidgetPayloadBuildOptions {
    systemColorScheme?: WidgetSystemColorScheme;
    maxItems?: number;
    listIds?: readonly string[];
    /** Include every bounded saved-filter list offered by the iOS chooser. */
    includeSavedFilterLists?: boolean;
    /** What the Focus screen is filtering and sorting by right now (#1173). */
    focusFilter?: FocusWidgetFilter;
}

export interface WidgetPayloadProjection {
    build: (maxItems?: number) => TasksWidgetPayload;
}

type WidgetPayloadProjectionOptions = Omit<WidgetPayloadBuildOptions, 'maxItems'>;

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
    const palette = resolveWidgetPalette(
        typeof data.settings?.theme === 'string' ? data.settings.theme : undefined,
        options?.systemColorScheme,
    );

    // The device's area selection hides tasks on every screen of the app, so it
    // hides them in every widget list too (#1173) — it is a stored setting, not
    // transient screen state, so the widget can read it directly.
    const sortedAreas = (data.areas || [])
        .filter((area) => !area.deletedAt)
        .sort((left, right) => (left.order !== right.order ? left.order - right.order : left.name.localeCompare(right.name)));
    const areaById = new Map(sortedAreas.map((area) => [area.id, area]));
    const areaVisibility = {
        areaById,
        projectById,
        resolvedAreaFilter: resolveAreaFilterSelection(data.settings?.filters, sortedAreas),
    };

    const activeTasks = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (!isTaskActionable(task)) return false;
        if (!isTaskInActiveProject(task, projectById)) return false;
        return isTaskVisibleInArea(task, areaVisibility);
    });

    const widgetSort = resolveWidgetTaskSort(data);

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
        const day = formatRelativeDayLabel(start, tr, language, startOfToday, endOfToday);
        return hasTimeComponent(task.startTime) ? `${day} ${formatDueTime(start, language)}` : day;
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
            ...computeDueLabel(task.dueDate, tr, language, startOfToday, endOfToday),
            openUri: `mindwtr://open?task=${encodeURIComponent(task.id)}`,
            priorityColor: prioritiesEnabled && task.priority ? TASK_PRIORITY_COLORS[task.priority] ?? null : null,
            contextLabel: project?.title ?? area?.name ?? null,
            identityColor: getTaskAccentColor(task, projectById, areaById) ?? null,
            ...(description ? { description } : {}),
            ...(contexts.length ? { contexts } : {}),
            ...(tags.length ? { tags } : {}),
            ...(startLabel ? { startLabel } : {}),
            ...(priorityLabel ? { priorityLabel } : {}),
        };
        itemById.set(task.id, item);
        return item;
    };
    // The Focus screen's own pools through the shared derivation (#1173),
    // narrowed by exactly what the screen is filtering and sorting by. Today's
    // Focus keeps drawing from every starred task, as it does on the screen:
    // area visibility and start times must never eat one of its slots.
    const focusFilter = options?.focusFilter ?? NO_FOCUS_WIDGET_FILTER;
    const filterOptions = { projects, tokenMatchMode: 'all' } as const;
    const matchingFocusCriteria = <T extends Task>(pool: T[]): T[] => applyFilter(pool, focusFilter.criteria, filterOptions);
    const sequentialProjects = projects.filter((project) => project.isSequential && !project.deletedAt);
    const lists = deriveFocusTaskLists({
        now,
        focusedPool: matchingFocusCriteria(
            tasks.filter((task) => !task.deletedAt && isTaskActionable(task) && task.isFocusedToday === true),
        ),
        filteredActiveTasks: matchingFocusCriteria(
            activeTasks.filter((task) => shouldShowTaskForStart(task, { now, granularity: 'time' })),
        ),
        scheduleCandidates: matchingFocusCriteria(activeTasks.filter((task) => shouldShowTaskForStart(task, { now }))),
        upcomingCandidates: getUpcomingDeferredTasks(
            matchingFocusCriteria(activeTasks.filter((task) => !task.isFocusedToday)),
            { now },
        ).map((entry) => entry.task),
        baseActiveTasks: activeTasks,
        projects,
        sections: data.sections || [],
        sequentialProjectIds: new Set(sequentialProjects.map((project) => project.id)),
        sequentialWithinSectionProjectIds: new Set(
            sequentialProjects.filter((project) => project.sequentialScope === 'section').map((project) => project.id),
        ),
        sortBy: focusFilter.sortBy,
        prioritiesEnabled,
        sortBySavedPerspective: (list) => sortTasksBySavedPreference(list, focusFilter.sortBy, {
            projects,
            prioritizeByPriority: prioritiesEnabled,
            sortOrder: focusFilter.sortOrder,
        }),
    });
    // A home-screen glance should stay calm: reuse the app's canonical Focus
    // derivation, but publish only Today's Focus followed by Today. The other
    // Focus-screen sections remain available through their explicit widget
    // lists and must never become an implicit fallback here.
    const curatedTasks = [...lists.focusedTasks, ...lists.schedule];
    const curatedSections = buildFocusTaskSections(lists, (key) => tr[key])
        .filter((section) => section.key === 'focus' || section.key === 'schedule');
    const inboxCount = activeTasks.filter((task) => task.status === 'inbox').length;
    const dateLabel = formatDateLabel(now, language, 'long');
    const listContext = { data, activeTasks, focusLists: lists, sortBy: widgetSort, prioritiesEnabled, tr };
    const listTitles = widgetListTitles(tr);
    const savedFilters = buildWidgetSavedFilterOptions(data);
    const taskLists = new Map<string, NonNullable<ReturnType<typeof buildWidgetTaskList>>>();
    const requestedListIds = new Set(options?.listIds ?? []);
    if (options?.includeSavedFilterLists) {
        for (const { id } of savedFilters) requestedListIds.add(`${WIDGET_SAVED_FILTER_LIST_PREFIX}${id}`);
    }
    for (const listId of requestedListIds) {
        if (listId === 'focus') continue;
        const list = buildWidgetTaskList(listId, listContext);
        if (list) taskLists.set(listId, list);
    }
    const scheduleById = new Map(lists.schedule.map((task) => [task.id, task]));

    // In a dated section the row's date is the header's date: hide it, show the
    // due time when there is one, keep an overdue date (it says the task slipped).
    const dropSameDayDue = (item: WidgetTaskItem, task: Task): WidgetTaskItem => {
        if (item.dueTone === 'overdue' || !item.dueLabel) return item;
        const due = safeParseDueDate(task.dueDate);
        if (!due || due < startOfToday || due > endOfToday) return item;
        return { ...item, dueLabel: hasTimeComponent(task.dueDate) ? formatDueTime(due, language) : null };
    };

    return {
        build: (requestedMaxItems?: number): TasksWidgetPayload => {
            const maxItems = Number.isFinite(requestedMaxItems)
                ? Math.max(1, Math.floor(requestedMaxItems as number))
                : 3;
            const items = curatedTasks.slice(0, maxItems).map(toItem);
            const hiddenTaskCount = Math.max(curatedTasks.length - items.length, 0);

            let remaining = maxItems;
            const sections: WidgetTaskSection[] = [];
            for (const section of curatedSections) {
                if (remaining <= 0) break;
                if (section.items.length === 0) continue;
                const sectionItems = section.items.slice(0, remaining).map(toItem);
                remaining -= sectionItems.length;
                sections.push({
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

            const subtitleParts = [`${tr['nav.inbox'] ?? 'Inbox'}: ${inboxCount}`];
            if (hiddenTaskCount > 0) {
                subtitleParts.push(`+${hiddenTaskCount} ${tr['common.more'] ?? 'More'}`);
            }

            const listPayloads: Record<string, WidgetListPayload> = {
                focus: { title: listTitles.focus, dateLabel, sections, items },
            };
            for (const [listId, list] of taskLists) {
                listPayloads[listId] = { title: list.title, items: list.tasks.slice(0, maxItems).map(toItem) };
            }

            return {
                headerTitle: tr['agenda.todaysFocus'] ?? 'Today',
                dateLabel,
                subtitle: subtitleParts.join(' · '),
                inboxLabel: tr['nav.inbox'] ?? 'Inbox',
                inboxCount,
                focusedCount: lists.focusedTasks.length,
                items,
                sections,
                lists: listPayloads,
                listTitles,
                savedFilters,
                emptyMessage: tr['list.noTasks'] ?? 'No tasks found',
                captureLabel: tr['widget.capture'] ?? 'Quick capture',
                completeLabel: tr['review.markDone'] ?? 'Mark Done',
                undoLabel: tr['common.undo'] ?? 'Undo',
                focusUri: WIDGET_FOCUS_URI,
                quickCaptureUri: WIDGET_QUICK_CAPTURE_URI,
                themeMode: typeof data.settings?.theme === 'string' ? data.settings.theme : 'system',
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
    const widgetSort = resolveWidgetTaskSort(data);

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
