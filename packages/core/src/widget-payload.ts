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
import { resolveAreaFilterSelection, isTaskVisibleInArea } from './area-filter';
import { TASK_PRIORITY_COLORS } from './color-constants';
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
    type WidgetTaskList,
    WIDGET_SAVED_FILTER_LIST_PREFIX,
    widgetListTitles,
} from './widget-lists';

// Read-only substrate for the "Get Mindwtr Tasks" Shortcuts action and
// Spotlight indexing (#980), published next to the widget payloads.
export const SHORTCUTS_SNAPSHOT_VERSION = 2;
export const SHORTCUTS_SNAPSHOT_ITEM_CAP = 50;
// Global ceiling on project groups (not just items per group) -- otherwise a
// library with hundreds of active projects has no bound on snapshot size or
// how many entities get handed to Spotlight indexing per launch.
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
    /** Upcoming preview marker: calendar date, floating local datetime or canonical UTC instant. */
    upcomingDate?: string;
    /** Localized Starts/Returns prefix, so native can reformat after a timezone change. */
    upcomingLabel?: string;
    title: string;
    statusLabel: string;
    showStatus?: boolean;
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
    // Existing task contexts, also shown in iOS widget rows. Omitted when empty.
    contexts?: string[];
    // The rest is only read by the Android task sheet (#1173), so every field
    // is left out when it is empty: they ride every row of every list.
    description?: string;
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

// Hex only: the Android provider (apps/mobile/modules/android-widget
// WidgetPayload.kt) and the iOS widget parse these themselves.
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
    // Eligible rows before the bounded publication slice. Android uses this to
    // distinguish a complete list from one that needs an in-widget overflow row.
    totalCount: number;
    // Backward-compatible list-level destination. Next and saved filters use
    // the host-owned widget-list route; existing list screens stay direct.
    openUri?: string;
}

export interface WidgetSavedFilterOption {
    id: string;
    name: string;
}

export interface TasksWidgetPayload {
    prioritiesEnabled?: boolean;
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
    // Cached list snapshots (always `focus`), keyed by list id.
    lists: Record<string, WidgetListPayload>;
    // Titles of the fixed lists for the configuration screen.
    listTitles: Record<string, string>;
    // Saved filters the configuration screen offers.
    savedFilters: WidgetSavedFilterOption[];
    /** Android chooser only: IDs already include context:/tag: and canonical tokens. */
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
}

// Labels for the native Android quick-capture dialog (#1169). Localized here
// so the Kotlin side (modules/android-widget) carries no string tables.
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
    // Localized template formatted natively after parcel-budget truncation.
    viewAllLabel: string;
}

// Core's translator owns the locale-then-English chain; a second raw dictionary
// read in this module would be the hand-rolled fallback the i18n ratchet forbids.
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
    /** Stable-id deep link; titles are display data and never identity. */
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

// The widget renderer runs in a headless JS context where Intl may be missing,
// so every Intl call falls back to plain strings.
const formatShortWeekday = (date: Date, language: string): string => {
    try {
        return new Intl.DateTimeFormat(language, { weekday: 'short' }).format(date);
    } catch {
        return FALLBACK_SHORT_WEEKDAYS[date.getDay()];
    }
};

// A headless background sync rewrites the widget payload without ever mounting
// the app, so core's date formatting is unconfigured there: the widget has to
// name the device locale itself instead of reading core's ambient state.
const getDeviceLocaleTag = (): string => {
    try {
        return String(Intl.DateTimeFormat().resolvedOptions().locale || '');
    } catch {
        return '';
    }
};

// The compact date follows the app's date-format setting, not the UI language:
// "en" alone always produced US month/day order for a dd/MM/yyyy user (#1242).
// An explicit setting decides the order; System asks core about the device
// locale, so the widget and the app can never disagree about a region (core's
// table calls en-ZA day-first where CLDR does not).
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

// Today / Tomorrow / weekday inside the week / a short date, shared by the row
// due label and the task sheet's start line.
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

// A time reads exactly as the app's own times do: core's 'p' under the date
// settings the app configures (its language input, date format, calendar,
// time format and the device locale), so an en-GB phone shows 21:30 on both.
// It needs no Intl, so an engine without it formats the same. The row inside a
// dated section shows only this time (Todoist shows "17:00", not the date,
// under a "Today" header).
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

// "Saturday, Sep 6" for the header band; "Sat Sep 6" for a section detail.
const formatDateLabel = (date: Date, language: string, weekday: 'long' | 'short'): string => {
    try {
        return new Intl.DateTimeFormat(language, { weekday, month: 'short', day: 'numeric' }).format(date);
    } catch {
        const day = weekday === 'long' ? FALLBACK_LONG_WEEKDAYS[date.getDay()] : FALLBACK_SHORT_WEEKDAYS[date.getDay()];
        return `${day}, ${FALLBACK_SHORT_MONTHS[date.getMonth()]} ${date.getDate()}`;
    }
};

// Widgets follow the feature toggles too (#1107).
const resolveWidgetSort = (data: AppData): TaskSortBy => (
    resolveTaskSortByForFeatures(resolveWidgetTaskSort(data.settings?.taskSortBy), data.settings)
);

// The app shows the chosen language, else the device's (its language context
// falls back to getSystemDefaultLanguage), so the widget falls back the same way.
export function resolveWidgetLanguage(saved: string | null, setting?: string, systemLanguage: Language = 'en'): Language {
    const candidate = setting && setting !== 'system' ? setting : saved;
    if (candidate && SUPPORTED_LANGUAGES.includes(candidate as Language)) return candidate as Language;
    return systemLanguage;
}

const resolveWidgetPalette = (
    themeMode: string | undefined,
    systemColorScheme: WidgetSystemColorScheme,
): WidgetPalette => {
    const normalizedMode = (themeMode || '').toLowerCase();
    const systemScheme = systemColorScheme === 'dark' ? 'dark' : 'light';
    const presetName = resolveThemeStatusPreset(normalizedMode as AppTheme, systemScheme);
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

    const isDark = resolveThemeColorScheme(normalizedMode as AppTheme, systemScheme) === 'dark';

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
    /** Include every bounded saved-filter list offered by the platform chooser. */
    includeSavedFilterLists?: boolean;
    /** Android's chooser offers every known context and tag (names only: their lists come with `listIds`). */
    includeTokenLists?: boolean;
    /** What the Focus screen is filtering and sorting by right now (#1173). */
    focusFilter?: FocusWidgetFilter;
    /** Device locale for the "System" date format; defaults to the runtime's. */
    systemLocale?: string;
}

export interface WidgetPayloadProjection {
    build: (maxItems?: number) => TasksWidgetPayload;
    /** Fresh uncapped task list for the host-owned widget-list route. */
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

    const undeletedActionableTasks = tasks.filter((task) => !task.deletedAt && isTaskActionable(task));
    const activeTasks = undeletedActionableTasks.filter((task) => {
        if (!isTaskInActiveProject(task, projectById)) return false;
        return isTaskVisibleInArea(task, areaVisibility);
    });

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
    const toUpcomingItem = (task: Task): WidgetTaskItem => {
        const item = { ...toItem(task) };
        delete item.completionToken;
        const source = getTaskDeferUntilSource(task);
        const parsed = safeParseDate(source);
        if (!source || !parsed) return item;
        // Native parsers accept one datetime spelling; retain floating local intent and date-only precision.
        const upcomingDate = !hasTimeComponent(source) ? format(parsed, 'yyyy-MM-dd')
            : /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(source) ? parsed.toISOString()
                : format(parsed, "yyyy-MM-dd'T'HH:mm:ss.SSS");
        const upcomingLabel = safeParseDate(task.startTime)
            ? tr['widget.upcomingStarts'] ?? 'Starts'
            : tr['widget.upcomingReturns'] ?? 'Returns';
        const label = formatAbsoluteDate(upcomingDate, hasTimeComponent(upcomingDate) ? 'P p' : 'P');
        return { ...item, upcomingDate, upcomingLabel, dueLabel: `${upcomingLabel} ${label}`, dueTone: 'normal', dueEmphasis: false };
    };
    // The Focus screen's own pools through the shared derivation (#1173),
    // narrowed by the screen's area selection, filters and sort.
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
    // A home-screen glance should stay calm: reuse the app's canonical Focus
    // derivation, but publish only Today's Focus followed by Today. The other
    // Focus-screen sections remain available through their explicit widget
    // lists and must never become an implicit fallback here.
    const curatedTasks = [...lists.focusedTasks, ...lists.schedule];
    const curatedSections = buildFocusTaskSections(lists, (key) => tr[key])
        .filter((section) => section.key === 'focus' || section.key === 'schedule');
    const inboxCount = activeTasks.filter((task) => task.status === 'inbox').length;
    const dateLabel = formatDateLabel(now, language, 'long');
    const listContext = { data, activeTasks, now, focusLists: lists, sortBy: widgetSort, prioritiesEnabled, tr,
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

    // In a dated section the row's date is the header's date: hide it, show the
    // due time when there is one, keep an overdue date (it says the task slipped).
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
                focus: {
                    title: listTitles.focus,
                    dateLabel,
                    sections,
                    items,
                    totalCount: curatedTasks.length,
                    openUri: WIDGET_LIST_DIRECT_URIS.focus,
                },
            };
            for (const [selection, list] of taskLists) {
                const listId = parseWidgetListSelection(selection)!.listId;
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

// ---------------------------------------------------------------------------
// What each platform publishes. The host keeps the IO (native module calls,
// storage, the render skip); these decide what the payload holds.

// The native Android widget's task list scrolls (RemoteViewsService), so the
// payload carries a fixed slice instead of a per-widget-height budget.
export const ANDROID_WIDGET_MAX_ITEMS = 200;

// The iOS widget decides what fits from its actual geometry and Dynamic Type.
// Each family snapshot carries eight bounded refill rows beyond the old family
// caps, so queued completions can disappear without waiting for the app to
// republish.
export const IOS_WIDGET_FAMILY_CACHE_ITEMS = {
    default: 20,
    small: 11,
    medium: 13,
    large: 20,
    extraLarge: 32,
} as const;

export interface WidgetPublicationInput {
    systemColorScheme?: WidgetSystemColorScheme;
    /** What the Focus screen is filtering and sorting by right now (#1173). */
    focusFilter?: FocusWidgetFilter;
    /**
     * The device locale for the "System" date and time formats. A host without
     * Intl (QuickJS) must pass it; React Native leaves it to the runtime's.
     */
    systemLocale?: string;
}

/**
 * Which lists the Android payload carries. The widget's own header chooser
 * switches lists with no app running, so it can only show a list the payload
 * already holds. Publish all bounded GTD lists even before placement:
 * Compact needs Next Actions as its empty-today fallback, and a new Tasks
 * widget can switch to Inbox without an extra app opening (#1211). The chooser
 * offers every saved filter, context and tag by name, but their lists (and
 * legacy project lists) are built only for what placed widgets chose
 * (`listSelections`): one list per label made every refresh grow with the
 * labels (#1399). The chooser requests a background publication when its
 * selected snapshot is not cached yet.
 */
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

/**
 * Edit Widget can switch lists while the app is not running, so every iOS
 * family snapshot carries the bounded chooser's lists, not just Focus.
 */
export function iosWidgetProjectionOptions(input: WidgetPublicationInput): WidgetPayloadProjectionOptions {
    return {
        systemColorScheme: input.systemColorScheme,
        focusFilter: input.focusFilter,
        systemLocale: input.systemLocale,
        listIds: WIDGET_FIXED_LIST_IDS,
        includeSavedFilterLists: true,
    };
}

/**
 * The projection a platform publishes: Android Compact and iOS Tasks both
 * combine starred and scheduled rows under one short localized Today header.
 */
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

/** Native capture reads only availability, never provider credentials or model paths. */
export function isWidgetAudioCaptureEnabled(settings: AppData['settings']): boolean {
    return settings.ai?.speechToText?.enabled === true;
}

/** The Android payload: the published rows plus the native dialog's and task sheet's words. */
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

/**
 * The whole Android publication in one call, for a host with no render skip
 * of its own: what React Native hands the widget module's setPayload.
 */
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

// Read-only substrate for the "Get Mindwtr Tasks" Shortcuts action and
// Spotlight indexing (#980): a capped, per-list + per-project snapshot of
// task metadata, refreshed on the same cadence as the widget payload. App
// Intents only ever read this; they never touch the live database.
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

    const eligibleProjects = projects
        .filter((project) => project.status === 'active' && !project.deletedAt)
        .filter((project) => (tasksByProjectId.get(project.id)?.length ?? 0) > 0)
        // Deterministic global cap on project groups (below): manual project
        // order, same ordering the Projects list itself shows, so which
        // projects survive the cap matches what the user already sees first.
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
                // Every remaining status on an active task is one of the four
                // list keys above (activeTasks already excludes done/archived/
                // reference), so the cast is safe.
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
