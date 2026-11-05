


import { compareAreasByOrder } from './task-utils';
import { getDefaultTaskAreaMode, resolveDefaultNewTaskAreaId } from './area-utils';
import { normalizeClockTimeInput } from './date';
import { FOCUS_TASK_LIMIT_OPTIONS, normalizeFocusTaskLimit } from './focus-utils';
import { resolveI18nText, tFallback } from './i18n';
import { formatListItemCount } from './list-count';
import { sanitizePomodoroDurations, type PomodoroDurations } from './pomodoro';
import { resolveFeatureFlags } from './resolve-feature-flags';
import {
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_SECTION_BY_FIELD,
    DEFAULT_TASK_EDITOR_SECTION_OPEN,
    DEFAULT_TASK_EDITOR_VISIBLE,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isTaskEditorSectionableField,
    TASK_EDITOR_FIXED_FIELDS,
    TASK_EDITOR_SECTION_ORDER,
} from './task-editor-layout';
import type { AppSettings, Area, DefaultProjectFlowMode, FeatureSettings, TaskEditorFieldId, TaskEditorSectionId } from './types';

type Translate = (key: string) => string;

export type GtdSettingsScreenId = 'gtd' | 'gtd-archive' | 'gtd-capture' | 'gtd-inbox' | 'gtd-pomodoro' | 'gtd-review' | 'gtd-task-editor';


export type TaskEditorPresetId = 'simple' | 'standard' | 'full' | 'custom';

export type TaskEditorPresetConfig = {
    order: TaskEditorFieldId[];
    hidden: TaskEditorFieldId[];
    sections: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
    sectionOpen: Partial<Record<TaskEditorSectionId, boolean>>;
};

const isTaskEditorSectionId = (value: unknown): value is TaskEditorSectionId =>
    value === 'basic' || value === 'scheduling' || value === 'organization' || value === 'details';

const TASK_EDITOR_PRESET_VISIBLE_FIELDS: Record<Exclude<TaskEditorPresetId, 'custom'>, TaskEditorFieldId[]> = {
    simple: ['status', 'project', 'area', 'contexts', 'dueDate'],
    standard: [...DEFAULT_TASK_EDITOR_VISIBLE],
    full: [...DEFAULT_TASK_EDITOR_ORDER],
};

const normalizeTaskEditorHidden = (hidden: Iterable<TaskEditorFieldId>, featureHiddenFields: Set<TaskEditorFieldId>): TaskEditorFieldId[] => {
    const next = new Set<TaskEditorFieldId>();
    for (const fieldId of hidden) {
        if (DEFAULT_TASK_EDITOR_ORDER.includes(fieldId)) next.add(fieldId);
    }
    featureHiddenFields.forEach((fieldId) => next.add(fieldId));
    return DEFAULT_TASK_EDITOR_ORDER.filter((fieldId) => next.has(fieldId));
};

const normalizeTaskEditorSectionOverrides = (
    sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>
): Partial<Record<TaskEditorFieldId, TaskEditorSectionId>> => {
    const next: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>> = {};
    (Object.entries(sections ?? {}) as Array<[TaskEditorFieldId, TaskEditorSectionId | undefined]>).forEach(([fieldId, sectionId]) => {
        if (!isTaskEditorSectionableField(fieldId) || !isTaskEditorSectionId(sectionId)) return;
        if (sectionId === DEFAULT_TASK_EDITOR_SECTION_BY_FIELD[fieldId]) return;
        next[fieldId] = sectionId;
    });
    return next;
};

const normalizeTaskEditorSectionOpenOverrides = (
    sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>
): Partial<Record<TaskEditorSectionId, boolean>> => {
    const next: Partial<Record<TaskEditorSectionId, boolean>> = {};
    (['scheduling', 'organization', 'details'] as const).forEach((sectionId) => {
        const value = sectionOpen?.[sectionId];
        if (typeof value !== 'boolean') return;
        if (value === DEFAULT_TASK_EDITOR_SECTION_OPEN[sectionId]) return;
        next[sectionId] = value;
    });
    return next;
};

const areTaskEditorArraysEqual = (left: TaskEditorFieldId[], right: TaskEditorFieldId[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

const areTaskEditorSectionMapsEqual = (
    left: Partial<Record<TaskEditorFieldId | TaskEditorSectionId, TaskEditorSectionId | boolean>>,
    right: Partial<Record<TaskEditorFieldId | TaskEditorSectionId, TaskEditorSectionId | boolean>>
): boolean => {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && left[key as keyof typeof left] === right[key as keyof typeof right]);
};

export const buildTaskEditorPresetConfig = (
    presetId: Exclude<TaskEditorPresetId, 'custom'>,
    featureHiddenFields: Iterable<TaskEditorFieldId> = []
): TaskEditorPresetConfig => {
    const featureHiddenSet = new Set(featureHiddenFields);
    const visibleSet = new Set(TASK_EDITOR_PRESET_VISIBLE_FIELDS[presetId]);
    const hidden = DEFAULT_TASK_EDITOR_ORDER.filter((fieldId) => !visibleSet.has(fieldId));
    const simpleOrder: TaskEditorFieldId[] = ['status', 'project', 'area', 'contexts', 'dueDate'];
    const base: TaskEditorPresetConfig = {
        order: presetId === 'simple'
            ? [...simpleOrder, ...DEFAULT_TASK_EDITOR_ORDER.filter((fieldId) => !simpleOrder.includes(fieldId))]
            : [...DEFAULT_TASK_EDITOR_ORDER],
        hidden: normalizeTaskEditorHidden(hidden, featureHiddenSet),
        sections: {},
        sectionOpen: {},
    };
    if (presetId === 'full') {
        base.hidden = normalizeTaskEditorHidden([], featureHiddenSet);
        base.sectionOpen = { scheduling: true, organization: true };
    }
    return base;
};

export const resolveTaskEditorPresetId = ({
    order,
    hidden,
    sections,
    sectionOpen,
    featureHiddenFields = [],
}: {
    order: TaskEditorFieldId[];
    hidden: Iterable<TaskEditorFieldId>;
    sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
    sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>;
    featureHiddenFields?: Iterable<TaskEditorFieldId>;
}): TaskEditorPresetId => {
    const featureHiddenSet = new Set(featureHiddenFields);
    const normalizedHidden = normalizeTaskEditorHidden(hidden, featureHiddenSet);
    const normalizedSections = normalizeTaskEditorSectionOverrides(sections);
    const normalizedSectionOpen = normalizeTaskEditorSectionOpenOverrides(sectionOpen);
    for (const presetId of ['simple', 'standard', 'full'] as const) {
        const preset = buildTaskEditorPresetConfig(presetId, featureHiddenSet);
        if (!areTaskEditorArraysEqual(order, preset.order)) continue;
        if (!areTaskEditorArraysEqual(normalizedHidden, preset.hidden)) continue;
        if (!areTaskEditorSectionMapsEqual(normalizedSections, preset.sections)) continue;
        if (!areTaskEditorSectionMapsEqual(normalizedSectionOpen, preset.sectionOpen)) continue;
        return presetId;
    }
    return 'custom';
};


export type GtdTaskOpenMode = 'automatic' | 'preview' | 'edit';
export const GTD_TASK_OPEN_MODES: readonly GtdTaskOpenMode[] = ['automatic', 'preview', 'edit'];

export const MOBILE_TASK_OPEN_MODE_STORAGE_KEY = 'mindwtr:view:taskOpenMode:v1';

export const readGtdTaskOpenMode = (raw: unknown): GtdTaskOpenMode => (
    GTD_TASK_OPEN_MODES.includes(raw as GtdTaskOpenMode) ? raw as GtdTaskOpenMode : 'automatic'
);

export type TaskOpenTab = 'task' | 'view';


export function resolveTaskOpenTab({
    mode,
    automaticTab,
    explicitEdit = false,
    readOnly = false,
}: {
    mode: GtdTaskOpenMode;
    automaticTab: TaskOpenTab;
    explicitEdit?: boolean;
    readOnly?: boolean;
}): TaskOpenTab {
    if (readOnly) return 'view';
    if (explicitEdit) return 'task';
    if (mode === 'preview') return 'view';
    if (mode === 'edit') return 'task';
    return automaticTab;
}

export const GTD_AUTO_ARCHIVE_DAY_OPTIONS: readonly number[] = [0, 1, 3, 7, 14, 30, 60];

export const GTD_DEFAULT_AREA_ACTIVE_OPTION = '__active-area__';


type GtdTaskEditorPreset = Exclude<TaskEditorPresetId, 'custom'>;
export type GtdOpenableSection = Exclude<TaskEditorSectionId, 'basic'>;

export type GtdSettingsEdit =
    | {
        type:
            | 'pomodoro' | 'pomodoroLinkTask' | 'pomodoroAutoStartBreaks' | 'pomodoroAutoStartFocus' | 'pomodoroCompletionAlert'
            | 'saveAudioAttachments' | 'quickAddAutoClean' | 'naturalLanguageDates' | 'markdownEditorAssist'
            | 'dailyReviewFocusStep' | 'weeklyReviewContextStep'
            | 'inboxTwoMinute' | 'inboxProjectFirst' | 'inboxContextStep' | 'inboxSchedule'
            | 'focusIncludeStartDates';
        value: boolean;
    }

    | { type: 'defaultScheduleTime'; value: string }
    | { type: 'focusTaskLimit'; value: number }
    | { type: 'defaultProjectFlowMode'; value: DefaultProjectFlowMode }
    | { type: 'autoArchiveDays'; value: number }

    | { type: 'pomodoroDurations'; focusMinutes: string; breakMinutes: string }
    | { type: 'captureMethod'; value: 'text' | 'audio' }

    | { type: 'defaultArea'; value: string }

    | { type: 'taskOpenMode'; value: GtdTaskOpenMode }
    | { type: 'taskEditorPreset'; value: GtdTaskEditorPreset }
    | { type: 'taskEditorFieldVisible'; field: TaskEditorFieldId; value: boolean }

    | { type: 'taskEditorOrder'; value: TaskEditorFieldId[] }
    | { type: 'taskEditorFieldSection'; field: TaskEditorFieldId; value: TaskEditorSectionId }
    | { type: 'taskEditorSectionOpen'; section: GtdOpenableSection; value: boolean }
    | { type: 'taskEditorReset' };

const POMODORO_KEYS = {
    pomodoroLinkTask: 'linkTask',
    pomodoroAutoStartBreaks: 'autoStartBreaks',
    pomodoroAutoStartFocus: 'autoStartFocus',
    pomodoroCompletionAlert: 'completionAlert',
} as const;
const INBOX_KEYS = {
    inboxTwoMinute: 'twoMinuteEnabled',
    inboxProjectFirst: 'projectFirst',
    inboxContextStep: 'contextStepEnabled',
    inboxSchedule: 'scheduleEnabled',
} as const;


function resolveTaskEditorLayout(settings: AppSettings) {
    const { priorities, timeEstimates } = resolveFeatureFlags(settings);
    const featureHiddenFields = new Set<TaskEditorFieldId>();
    if (!priorities) featureHiddenFields.add('priority');
    if (!timeEstimates) featureHiddenFields.add('timeEstimate');
    const defaultHidden = DEFAULT_TASK_EDITOR_ORDER.filter(
        (id) => !DEFAULT_TASK_EDITOR_VISIBLE.includes(id) || featureHiddenFields.has(id)
    );
    const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
    const savedOrder = (settings.gtd?.taskEditor?.order ?? []).filter((id) => known.has(id));
    const order = [...savedOrder, ...DEFAULT_TASK_EDITOR_ORDER.filter((id) => !savedOrder.includes(id))];
    const savedHidden = settings.gtd?.taskEditor?.hidden ?? defaultHidden;
    const hidden = new Set(savedHidden.filter((id) => known.has(id)));
    return { featureHiddenFields, defaultHidden, order, hidden };
}


export function resolveGtdPomodoroDurations(settings: AppSettings, focusText: string, breakText: string): PomodoroDurations {
    const current = sanitizePomodoroDurations(settings.gtd?.pomodoro?.customDurations);
    const focusValue = Number.parseInt(focusText, 10);
    const breakValue = Number.parseInt(breakText, 10);
    return sanitizePomodoroDurations({
        focusMinutes: Number.isFinite(focusValue) ? focusValue : current.focusMinutes,
        breakMinutes: Number.isFinite(breakValue) ? breakValue : current.breakMinutes,
    });
}


export function buildGtdSettingsUpdate(settings: AppSettings, edit: GtdSettingsEdit): Partial<AppSettings> | null {
    const gtd = settings.gtd ?? {};
    const withGtd = (partial: NonNullable<AppSettings['gtd']>): Partial<AppSettings> => ({ gtd: { ...gtd, ...partial } });
    const withTaskEditor = (next: Partial<TaskEditorPresetConfig>, features?: FeatureSettings): Partial<AppSettings> => ({
        ...(features ? { features } : null),
        gtd: { ...gtd, taskEditor: { ...(gtd.taskEditor ?? {}), ...next } },
    });
    switch (edit.type) {
        case 'pomodoro':
            return { features: { ...(settings.features ?? {}), pomodoro: edit.value } };
        case 'quickAddAutoClean':
            return { quickAddAutoClean: edit.value };
        case 'markdownEditorAssist':
            return { markdownEditorAssist: edit.value };
        case 'saveAudioAttachments':
            return withGtd({ saveAudioAttachments: edit.value });
        case 'naturalLanguageDates':
            return withGtd({ naturalLanguageDates: edit.value });
        case 'focusIncludeStartDates':
            return withGtd({ focusIncludeStartDates: edit.value });
        case 'pomodoroLinkTask':
        case 'pomodoroAutoStartBreaks':
        case 'pomodoroAutoStartFocus':
        case 'pomodoroCompletionAlert':
            return withGtd({ pomodoro: { ...(gtd.pomodoro ?? {}), [POMODORO_KEYS[edit.type]]: edit.value } });
        case 'pomodoroDurations':
            return withGtd({
                pomodoro: { ...(gtd.pomodoro ?? {}), customDurations: resolveGtdPomodoroDurations(settings, edit.focusMinutes, edit.breakMinutes) },
            });
        case 'inboxTwoMinute':
        case 'inboxProjectFirst':
        case 'inboxContextStep':
        case 'inboxSchedule':
            return withGtd({ inboxProcessing: { ...(gtd.inboxProcessing ?? {}), [INBOX_KEYS[edit.type]]: edit.value } });
        case 'dailyReviewFocusStep':
            return withGtd({ dailyReview: { ...(gtd.dailyReview ?? {}), includeFocusStep: edit.value } });
        case 'weeklyReviewContextStep':
            return withGtd({ weeklyReview: { ...(gtd.weeklyReview ?? {}), includeContextStep: edit.value } });
        case 'defaultScheduleTime':
            return withGtd({ defaultScheduleTime: edit.value });
        case 'focusTaskLimit':
            return withGtd({ focusTaskLimit: edit.value });
        case 'defaultProjectFlowMode':
            return withGtd({ defaultProjectFlowMode: edit.value });
        case 'autoArchiveDays':
            return withGtd({ autoArchiveDays: edit.value });
        case 'captureMethod':
            return withGtd({ defaultCaptureMethod: edit.value });
        case 'defaultArea':
            if (edit.value === GTD_DEFAULT_AREA_ACTIVE_OPTION) return withGtd({ defaultAreaMode: 'active', defaultAreaId: null });
            if (edit.value) return withGtd({ defaultAreaMode: 'fixed', defaultAreaId: edit.value });
            return withGtd({ defaultAreaMode: 'none', defaultAreaId: null });
        case 'taskOpenMode':
            return null;
        case 'taskEditorPreset':
            return withTaskEditor(buildTaskEditorPresetConfig(edit.value, resolveTaskEditorLayout(settings).featureHiddenFields));
        case 'taskEditorFieldVisible': {
            const { order, hidden } = resolveTaskEditorLayout(settings);
            const nextHidden = new Set(hidden);
            if (edit.value) nextHidden.delete(edit.field);
            else nextHidden.add(edit.field);

            const features = { ...(settings.features ?? {}) };
            if (edit.field === 'priority') features.priorities = !nextHidden.has('priority');
            if (edit.field === 'timeEstimate') features.timeEstimates = !nextHidden.has('timeEstimate');
            return withTaskEditor({ order, hidden: Array.from(nextHidden) }, features);
        }
        case 'taskEditorOrder':
            return withTaskEditor({ order: edit.value, hidden: Array.from(resolveTaskEditorLayout(settings).hidden) });
        case 'taskEditorFieldSection': {
            const { order, hidden } = resolveTaskEditorLayout(settings);
            const sections = { ...(gtd.taskEditor?.sections ?? {}) };
            if (edit.value === DEFAULT_TASK_EDITOR_SECTION_BY_FIELD[edit.field]) delete sections[edit.field];
            else sections[edit.field] = edit.value;
            return withTaskEditor({ order, hidden: Array.from(hidden), sections });
        }
        case 'taskEditorSectionOpen': {
            const sectionOpen = { ...(gtd.taskEditor?.sectionOpen ?? {}) };
            if (edit.value === DEFAULT_TASK_EDITOR_SECTION_OPEN[edit.section]) delete sectionOpen[edit.section];
            else sectionOpen[edit.section] = edit.value;
            return withTaskEditor({ sectionOpen });
        }
        case 'taskEditorReset': {
            const { defaultHidden } = resolveTaskEditorLayout(settings);
            return withTaskEditor(
                { order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...defaultHidden], sections: {}, sectionOpen: {} },
                { ...(settings.features ?? {}), priorities: !defaultHidden.includes('priority'), timeEstimates: !defaultHidden.includes('timeEstimate') },
            );
        }
    }
}


const sameStored = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);


export function isGtdSettingStored(settings: AppSettings, edit: GtdSettingsEdit): boolean {
    if (edit.type === 'defaultScheduleTime') return edit.value === (normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || '');
    if (edit.type === 'pomodoroDurations') {
        const next = resolveGtdPomodoroDurations(settings, edit.focusMinutes, edit.breakMinutes);
        const shown = sanitizePomodoroDurations(settings.gtd?.pomodoro?.customDurations);
        return next.focusMinutes === shown.focusMinutes && next.breakMinutes === shown.breakMinutes;
    }
    const update = buildGtdSettingsUpdate(settings, edit);
    return !update || Object.entries(update).every(([key, value]) => sameStored(settings[key as keyof AppSettings], value));
}


export function getGtdSettingsDeviceWrites(edit: GtdSettingsEdit): { key: string; value: string | null }[] {
    return edit.type === 'taskOpenMode' ? [{ key: MOBILE_TASK_OPEN_MODE_STORAGE_KEY, value: edit.value }] : [];
}


export type GtdSettingsToggle = { label: string; description: string | null; value: boolean; edit: GtdSettingsEdit };
export type GtdSettingsOption<T> = { value: T; label: string; selected: boolean; edit: GtdSettingsEdit };

export type GtdSettingsLink = { title: string; description: string | null; screen: GtdSettingsScreenId };
type Labelled = { label: string; description: string };

export type GtdTaskEditorMove = { label: string; disabled: boolean; edit: GtdSettingsEdit | null };

export type GtdTaskEditorField = {
    id: TaskEditorFieldId;
    label: string;
    visible: boolean;

    status: string;

    visibility: { accessibilityLabel: string; edit: GtdSettingsEdit };

    sheet: {
        title: string;

        section: string | null;
        visible: GtdSettingsToggle;

        sections: { label: string; options: GtdSettingsOption<TaskEditorSectionId>[] } | null;
        order: { label: string; moveUp: GtdTaskEditorMove; moveDown: GtdTaskEditorMove };
        doneLabel: string;
    };
};

export type GtdTaskEditorGroup = {
    id: TaskEditorSectionId;
    title: string;
    count: number;

    defaultOpen: GtdSettingsToggle | null;
    fields: GtdTaskEditorField[];
};

export type GtdSettingsModel = {
    hub: {
        title: string;
        description: string;

        features: Labelled;
        pomodoro: GtdSettingsToggle;
        pomodoroSettings: GtdSettingsLink | null;

        defaultScheduleTime: Labelled & { value: string; placeholder: string; invalidMessage: string };
        focusTaskLimit: Labelled & { options: GtdSettingsOption<number>[] };
        focusIncludeStartDates: GtdSettingsToggle;
        defaultProjectFlowMode: Labelled & { options: GtdSettingsOption<DefaultProjectFlowMode>[] };
        autoArchive: GtdSettingsLink;

        taskEditor: GtdSettingsLink;
        capture: GtdSettingsLink;
        review: GtdSettingsLink;
        inbox: GtdSettingsLink;
    };
    pomodoro: {
        title: string;
        description: string;

        enable: { label: string; edit: GtdSettingsEdit } | null;

        minutes: { focus: string; break: string };

        controls: {
            customPreset: Labelled & { focusLabel: string; breakLabel: string };
            linkTask: GtdSettingsToggle;

            autoStartBreaks: GtdSettingsToggle;
            autoStartFocus: GtdSettingsToggle;
            completionAlert: GtdSettingsToggle;

            alarmNotice: { label: string; description: string; actionLabel: string } | null;
        } | null;
        autoStartNotice: string;
    };
    capture: {
        title: string;
        description: string;
        method: Labelled & { options: (GtdSettingsOption<'text' | 'audio'> & { icon: 'text-outline' | 'mic-outline' })[] };
        defaultArea: Labelled & { value: string; accessibilityLabel: string; pickerTitle: string; options: GtdSettingsOption<string>[] };

        saveAudio: GtdSettingsToggle | null;
        quickAddAutoClean: GtdSettingsToggle;
        naturalLanguageDates: GtdSettingsToggle;
        markdownEditorAssist: GtdSettingsToggle;


        captureIntent: {
            label: string;
            description: string;

            value: boolean;

            disabled: boolean;
            token: { label: string; copyLabel: string } | null;

            messages: { copied: string; copyFailed: string; loadFailed: string; updateFailed: string };
        } | null;
    };
    review: {
        title: string;
        description: string;
        daily: Labelled;
        dailyFocusStep: GtdSettingsToggle;
        weekly: Labelled;
        weeklyContextStep: GtdSettingsToggle;
    };
    inbox: {
        title: string;
        description: string;
        twoMinute: GtdSettingsToggle;
        projectFirst: GtdSettingsToggle;
        contextStep: GtdSettingsToggle;
        schedule: GtdSettingsToggle;
    };
    archive: { title: string; description: string; options: GtdSettingsOption<number>[] };
    taskEditor: {
        title: string;
        description: string;
        helper: string;

        openMode: Labelled & { options: GtdSettingsOption<GtdTaskOpenMode>[] };
        presets: { label: string; options: GtdSettingsOption<GtdTaskEditorPreset>[]; custom: string | null };

        groups: GtdTaskEditorGroup[];

        initiallyExpanded: Record<TaskEditorSectionId, boolean>;


        expandedResetKey: string;
        reset: { label: string; edit: GtdSettingsEdit };
    };
};

export function buildGtdSettingsModel(input: {
    settings: AppSettings;

    areas: readonly Area[];
    taskOpenMode: GtdTaskOpenMode;

    captureIntent?: { enabled: boolean | null };
    t: Translate;
}): GtdSettingsModel {
    const { settings, t } = input;
    const gtd = settings.gtd;
    const tr = (key: string) => resolveI18nText(t, key);

    const keyOr = (key: string, other: string) => {
        const raw = t(key);
        return raw === key ? tr(other) : raw;
    };
    const toggle = (label: string, description: string | null, value: boolean, edit: GtdSettingsEdit): GtdSettingsToggle => ({ label, description, value, edit });
    const option = <T,>(value: T, label: string, selected: boolean, edit: GtdSettingsEdit): GtdSettingsOption<T> => ({ value, label, selected, edit });
    const flip = (type: Extract<GtdSettingsEdit, { value: boolean }>['type'], value: boolean) => ({ type, value: !value }) as GtdSettingsEdit;

    const { pomodoro: pomodoroEnabled } = resolveFeatureFlags(settings);
    const featurePomodoroLabel = keyOr('settings.featurePomodoro', 'settings.featurePomodoro');
    const featurePomodoroDesc = keyOr('settings.featurePomodoroDesc', 'settings.featurePomodoroDesc');
    const pomodoroSettingsLabel = tFallback(t, 'settings.pomodoroSettings', tr('settings.gtdMobile.pomodoroSettings'));
    const captureTitle = tFallback(t, 'settings.captureSettings', tr('settings.gtdMobile.captureDefaults'));
    const reviewTitle = tFallback(t, 'settings.reviewSettings', tr('settings.gtdMobile.reviewSteps'));
    const reviewDescription = tr('settings.gtdMobile.chooseWhichOptionalStepsAppearInDailyAndWeeklyReview');
    const inboxTitle = tFallback(t, 'settings.inboxProcessing', tr('settings.inboxProcessing'));


    const focusTaskLimit = normalizeFocusTaskLimit(gtd?.focusTaskLimit);
    const flowMode: DefaultProjectFlowMode = gtd?.defaultProjectFlowMode === 'sequential' ? 'sequential' : 'parallel';
    const hub: GtdSettingsModel['hub'] = {
        title: t('settings.gtd'),
        description: t('settings.gtdDesc'),
        features: { label: t('settings.features'), description: t('settings.featuresDesc') },
        pomodoro: toggle(featurePomodoroLabel, featurePomodoroDesc, pomodoroEnabled, flip('pomodoro', pomodoroEnabled)),
        pomodoroSettings: pomodoroEnabled
            ? { title: pomodoroSettingsLabel, description: tr('settings.gtdMobile.customPresetTaskLinkingAndAutoStartBehavior'), screen: 'gtd-pomodoro' }
            : null,
        defaultScheduleTime: {
            label: tFallback(t, 'settings.defaultScheduleTime', tr('settings.gtdMobile.defaultScheduleTime')),
            description: tFallback(t, 'settings.defaultScheduleTimeDesc', tr('settings.gtdMobile.optionalPreFillsManualStartDueAndReviewTimeFields')),
            value: normalizeClockTimeInput(gtd?.defaultScheduleTime) || '',
            placeholder: tr('settings.gtdMobile.hhMm'),
            invalidMessage: tr('settings.gtdMobile.useHhMmForTheDefaultScheduleTime'),
        },
        focusTaskLimit: {
            label: tFallback(t, 'settings.focusTaskLimit', tr('settings.focusTaskLimit')),
            description: tFallback(t, 'settings.focusTaskLimitDesc', tr('settings.focusTaskLimitDesc')),
            options: FOCUS_TASK_LIMIT_OPTIONS.map((value) => option<number>(value, String(value), focusTaskLimit === value, { type: 'focusTaskLimit', value })),
        },
        focusIncludeStartDates: toggle(
            t('settings.focusIncludeStartDates'),
            t('settings.focusIncludeStartDatesDesc'),
            gtd?.focusIncludeStartDates !== false,
            flip('focusIncludeStartDates', gtd?.focusIncludeStartDates !== false),
        ),
        defaultProjectFlowMode: {
            label: tFallback(t, 'settings.defaultProjectFlowMode', 'Default project flow'),
            description: tFallback(t, 'settings.defaultProjectFlowModeDesc', 'Applies only when creating new projects.'),
            options: ([
                ['parallel', tFallback(t, 'settings.projectFlowParallel', 'Parallel')],
                ['sequential', tFallback(t, 'settings.projectFlowSequential', 'Sequential')],
            ] as const).map(([value, label]) => option<DefaultProjectFlowMode>(value, label, flowMode === value, { type: 'defaultProjectFlowMode', value })),
        },
        autoArchive: { title: t('settings.autoArchive'), description: t('settings.autoArchiveDesc'), screen: 'gtd-archive' },
        taskEditor: { title: t('settings.taskEditorLayout'), description: t('settings.taskEditorLayoutDesc'), screen: 'gtd-task-editor' },
        capture: { title: captureTitle, description: t('settings.captureDefaultDesc'), screen: 'gtd-capture' },
        review: { title: reviewTitle, description: reviewDescription, screen: 'gtd-review' },
        inbox: { title: inboxTitle, description: t('settings.inboxProcessingDesc'), screen: 'gtd-inbox' },
    };


    const durations = sanitizePomodoroDurations(gtd?.pomodoro?.customDurations);
    const linkTask = gtd?.pomodoro?.linkTask === true;
    const autoStartBreaks = gtd?.pomodoro?.autoStartBreaks === true;
    const autoStartFocus = gtd?.pomodoro?.autoStartFocus === true;

    const completionAlert = gtd?.pomodoro?.completionAlert !== false;
    const pomodoro: GtdSettingsModel['pomodoro'] = {
        title: pomodoroSettingsLabel,
        description: featurePomodoroDesc,
        enable: pomodoroEnabled ? null : { label: featurePomodoroLabel, edit: { type: 'pomodoro', value: true } },
        minutes: { focus: String(durations.focusMinutes), break: String(durations.breakMinutes) },
        controls: pomodoroEnabled ? {
            customPreset: {
                label: keyOr('settings.pomodoroCustomPreset', 'settings.pomodoroCustomPreset'),
                description: keyOr('settings.pomodoroCustomPresetDesc', 'settings.pomodoroCustomPresetDesc'),
                focusLabel: keyOr('settings.pomodoroFocusMinutes', 'settings.pomodoroFocusMinutes'),
                breakLabel: keyOr('settings.pomodoroBreakMinutes', 'settings.pomodoroBreakMinutes'),
            },
            linkTask: toggle(
                tFallback(t, 'settings.pomodoroLinkTask', tr('settings.pomodoroLinkTask')),
                tFallback(t, 'settings.pomodoroLinkTaskDesc', tr('settings.pomodoroLinkTaskDesc')),
                linkTask,
                flip('pomodoroLinkTask', linkTask),
            ),
            autoStartBreaks: toggle(
                keyOr('settings.pomodoroAutoStartBreaks', 'settings.gtdMobile.autoStartBreaks'),
                keyOr('settings.pomodoroAutoStartBreaksDesc', 'settings.gtdMobile.startTheBreakTimerAutomaticallyWhenAFocusSessionEnds'),
                autoStartBreaks,
                flip('pomodoroAutoStartBreaks', autoStartBreaks),
            ),
            autoStartFocus: toggle(
                keyOr('settings.pomodoroAutoStartFocus', 'settings.gtdMobile.autoStartFocus'),
                keyOr('settings.pomodoroAutoStartFocusDesc', 'settings.gtdMobile.startTheNextFocusSessionAutomaticallyWhenABreakEnds'),
                autoStartFocus,
                flip('pomodoroAutoStartFocus', autoStartFocus),
            ),
            completionAlert: toggle(
                tFallback(t, 'settings.pomodoroCompletionAlert', 'Alert when timer ends'),
                tFallback(t, 'settings.pomodoroCompletionAlertDesc', 'Notify me when a focus session or break ends.'),
                completionAlert,
                flip('pomodoroCompletionAlert', completionAlert),
            ),
            alarmNotice: completionAlert ? {
                label: t('settings.pomodoroAlertPermissionTitle'),
                description: t('settings.pomodoroAlertPermissionDesc'),
                actionLabel: t('settings.pomodoroAlertPermissionAction'),
            } : null,
        } : null,
        autoStartNotice: tr('settings.gtdMobile.pomodoroWillNowAdvancePhasesAutomatically'),
    };


    const captureMethod = gtd?.defaultCaptureMethod ?? 'text';
    const sortedAreas = [...input.areas].filter((area) => !area.deletedAt).sort(compareAreasByOrder);
    const areaPickerValue = getDefaultTaskAreaMode(settings) === 'active'
        ? GTD_DEFAULT_AREA_ACTIVE_OPTION
        : resolveDefaultNewTaskAreaId(settings, sortedAreas) ?? '';
    const areaNone = t('settings.defaultAreaNone');
    const areaOptions = [
        { id: '', label: areaNone },
        { id: GTD_DEFAULT_AREA_ACTIVE_OPTION, label: t('settings.defaultAreaActive') },
        ...sortedAreas.map((area) => ({ id: area.id, label: area.name })),
    ].map(({ id, label }) => option(id, label, areaPickerValue === id, { type: 'defaultArea', value: id }));
    const areaLabel = t('settings.defaultArea');
    const areaValue = areaOptions.find((entry) => entry.selected)?.label ?? areaNone;
    const saveAudio = gtd?.saveAudioAttachments !== false;
    const quickAddAutoClean = settings.quickAddAutoClean === true;
    const naturalLanguageDates = gtd?.naturalLanguageDates !== false;
    const markdownEditorAssist = settings.markdownEditorAssist !== false;
    const capture: GtdSettingsModel['capture'] = {
        title: captureTitle,
        description: t('settings.captureDefaultDesc'),
        method: {
            label: t('settings.captureDefault'),
            description: t('settings.captureDefaultDesc'),
            options: ([
                ['text', t('settings.captureDefaultText'), 'text-outline'],
                ['audio', t('settings.captureDefaultAudio'), 'mic-outline'],
            ] as const).map(([value, label, icon]) => ({ ...option<'text' | 'audio'>(value, label, captureMethod === value, { type: 'captureMethod', value }), icon })),
        },
        defaultArea: {
            label: areaLabel,
            description: t('settings.defaultAreaDesc'),
            value: areaValue,
            accessibilityLabel: `${areaLabel}: ${areaValue}`,
            pickerTitle: areaLabel,
            options: areaOptions,
        },
        saveAudio: captureMethod === 'audio'
            ? toggle(t('settings.captureSaveAudio'), t('settings.captureSaveAudioDesc'), saveAudio, flip('saveAudioAttachments', saveAudio))
            : null,
        quickAddAutoClean: toggle(t('settings.quickAddAutoClean'), t('settings.quickAddAutoCleanDesc'), quickAddAutoClean, flip('quickAddAutoClean', quickAddAutoClean)),
        naturalLanguageDates: toggle(t('settings.naturalLanguageDates'), t('settings.naturalLanguageDatesDesc'), naturalLanguageDates, flip('naturalLanguageDates', naturalLanguageDates)),
        markdownEditorAssist: toggle(t('settings.markdownEditorAssist'), t('settings.markdownEditorAssistDesc'), markdownEditorAssist, flip('markdownEditorAssist', markdownEditorAssist)),
        captureIntent: input.captureIntent ? {
            label: tr('settings.automationCapture'),
            description: tr('settings.automationCaptureDesc'),
            value: input.captureIntent.enabled === true,
            disabled: input.captureIntent.enabled === null,
            token: input.captureIntent.enabled === true
                ? { label: tr('settings.automationCaptureToken'), copyLabel: tr('settings.automationCaptureCopyToken') }
                : null,
            messages: {
                copied: tr('settings.automationCaptureCopied'),
                copyFailed: tr('settings.automationCaptureCopyFailed'),
                loadFailed: tr('settings.automationCaptureLoadFailed'),
                updateFailed: tr('settings.automationCaptureUpdateFailed'),
            },
        } : null,
    };


    const dailyFocusStep = gtd?.dailyReview?.includeFocusStep !== false;
    const weeklyContextStep = gtd?.weeklyReview?.includeContextStep !== false;
    const review: GtdSettingsModel['review'] = {
        title: reviewTitle,
        description: reviewDescription,
        daily: { label: t('settings.dailyReviewConfig'), description: t('settings.dailyReviewConfigDesc') },
        dailyFocusStep: toggle(t('settings.dailyReviewIncludeFocusStep'), t('settings.dailyReviewIncludeFocusStepDesc'), dailyFocusStep, flip('dailyReviewFocusStep', dailyFocusStep)),
        weekly: { label: t('settings.weeklyReviewConfig'), description: t('settings.weeklyReviewConfigDesc') },
        weeklyContextStep: toggle(t('settings.weeklyReviewIncludeContextsStep'), t('settings.weeklyReviewIncludeContextsStepDesc'), weeklyContextStep, flip('weeklyReviewContextStep', weeklyContextStep)),
    };
    const inboxProcessing = gtd?.inboxProcessing ?? {};
    const inboxToggle = (type: keyof typeof INBOX_KEYS, key: string, value: boolean) => toggle(t(key), null, value, flip(type, value));
    const inbox: GtdSettingsModel['inbox'] = {
        title: inboxTitle,
        description: t('settings.inboxProcessingDesc'),
        twoMinute: inboxToggle('inboxTwoMinute', 'settings.inboxTwoMinuteEnabled', inboxProcessing.twoMinuteEnabled !== false),
        projectFirst: inboxToggle('inboxProjectFirst', 'settings.inboxProjectFirst', inboxProcessing.projectFirst === true),
        contextStep: inboxToggle('inboxContextStep', 'settings.inboxContextStepEnabled', inboxProcessing.contextStepEnabled !== false),
        schedule: inboxToggle('inboxSchedule', 'settings.inboxScheduleEnabled', inboxProcessing.scheduleEnabled === true),
    };


    const archiveDays = Number.isFinite(gtd?.autoArchiveDays) ? Math.max(0, Math.floor(gtd?.autoArchiveDays as number)) : 7;
    const archive: GtdSettingsModel['archive'] = {
        title: t('settings.autoArchive'),
        description: t('settings.autoArchiveDesc'),
        options: GTD_AUTO_ARCHIVE_DAY_OPTIONS.map((days) => option(
            days,
            days <= 0 ? t('settings.autoArchiveNever') : formatListItemCount(days, 'day', t),
            archiveDays === days,
            { type: 'autoArchiveDays', value: days },
        )),
    };

    return { hub, pomodoro, capture, review, inbox, archive, taskEditor: buildTaskEditor(settings, input.taskOpenMode, t, tr, toggle, option) };
}

function buildTaskEditor(
    settings: AppSettings,
    openMode: GtdTaskOpenMode,
    t: Translate,
    tr: Translate,
    toggle: (label: string, description: string | null, value: boolean, edit: GtdSettingsEdit) => GtdSettingsToggle,
    option: <T>(value: T, label: string, selected: boolean, edit: GtdSettingsEdit) => GtdSettingsOption<T>,
): GtdSettingsModel['taskEditor'] {
    const taskEditor = settings.gtd?.taskEditor;
    const { featureHiddenFields, order, hidden } = resolveTaskEditorLayout(settings);
    const assignments = getTaskEditorSectionAssignments(taskEditor);
    const sectionOpen = getTaskEditorSectionOpenDefaults(taskEditor);
    const defaultOpenRaw = t('settings.taskEditorDefaultOpen');
    const defaultOpenLabel = defaultOpenRaw === 'settings.taskEditorDefaultOpen' ? 'Open sections by default' : defaultOpenRaw;
    const showInEditor = tr('settings.gtdMobile.showInEditor');
    const hideInEditor = tr('settings.gtdMobile.hideFromEditor');
    const activePreset = resolveTaskEditorPresetId({
        order,
        hidden,
        sections: taskEditor?.sections,
        sectionOpen: taskEditor?.sectionOpen,
        featureHiddenFields,
    });
    const sectionLabel = (id: TaskEditorSectionId) => t(`taskEdit.${id}`);
    const groupFields = TASK_EDITOR_SECTION_ORDER.map((id) => ({
        id,
        fields: order.filter((fieldId) => (
            (id === 'basic' && TASK_EDITOR_FIXED_FIELDS.includes(fieldId))
            || (isTaskEditorSectionableField(fieldId) && assignments[fieldId] === id)
        )),
    }));
    const move = (fieldId: TaskEditorFieldId, delta: number, fields: TaskEditorFieldId[], label: string): GtdTaskEditorMove => {
        const groupOrder = order.filter((id) => fields.includes(id));
        const from = groupOrder.indexOf(fieldId);
        const disabled = delta < 0 ? from <= 0 : from >= groupOrder.length - 1;
        const to = Math.max(0, Math.min(groupOrder.length - 1, from + delta));
        if (disabled || from < 0 || from === to) return { label, disabled, edit: null };
        const next = [...groupOrder];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        let index = 0;
        return { label, disabled, edit: { type: 'taskEditorOrder', value: order.map((id) => (fields.includes(id) ? next[index++] : id)) } };
    };
    const field = (fieldId: TaskEditorFieldId): GtdTaskEditorField => {
        const label = fieldLabel(fieldId, t);
        const visible = !hidden.has(fieldId);
        const edit: GtdSettingsEdit = { type: 'taskEditorFieldVisible', field: fieldId, value: !visible };
        const group = groupFields.find((entry) => entry.fields.includes(fieldId)) ?? null;
        const fields = group?.fields ?? [];
        return {
            id: fieldId,
            label,
            visible,
            status: visible ? t('settings.visible') : t('settings.hidden'),
            visibility: { accessibilityLabel: `${visible ? hideInEditor : showInEditor}: ${label}`, edit },
            sheet: {
                title: label,
                section: group ? sectionLabel(group.id) : null,
                visible: toggle(showInEditor, null, visible, edit),
                sections: isTaskEditorSectionableField(fieldId) ? {
                    label: tr('settings.gtdMobile.moveToSection'),
                    options: TASK_EDITOR_SECTION_ORDER.map((id) => option(id, sectionLabel(id), assignments[fieldId] === id, { type: 'taskEditorFieldSection', field: fieldId, value: id })),
                } : null,
                order: {
                    label: tr('settings.gtdMobile.orderWithinSection'),
                    moveUp: move(fieldId, -1, fields, tr('projects.moveUp')),
                    moveDown: move(fieldId, 1, fields, tr('projects.moveDown')),
                },
                doneLabel: tFallback(t, 'common.done', tr('nav.done')),
            },
        };
    };
    const openModeLabels: Record<GtdTaskOpenMode, string> = {
        automatic: tr('settings.gtdMobile.taskOpenAutomatic'),
        preview: tr('settings.gtdMobile.taskOpenPreview'),
        edit: tr('settings.gtdMobile.taskOpenEdit'),
    };
    const rawSectionOpen = taskEditor?.sectionOpen;
    return {
        title: t('settings.taskEditorLayout'),
        description: t('settings.taskEditorLayoutDesc'),
        helper: tr('settings.gtdMobile.chooseAPresetThenOpenASectionToFineTune'),
        openMode: {
            label: tr('settings.gtdMobile.openTasksIn'),
            description: tr('settings.gtdMobile.openTasksInDesc'),
            options: GTD_TASK_OPEN_MODES.map((mode) => option(mode, openModeLabels[mode], openMode === mode, { type: 'taskOpenMode', value: mode })),
        },
        presets: {
            label: tr('settings.gtdMobile.presets'),
            options: (['simple', 'standard', 'full'] as const).map((id) => option(id, tr(`settings.gtdMobile.${id}`), activePreset === id, { type: 'taskEditorPreset', value: id })),
            custom: activePreset === 'custom' ? tr('settings.gtdMobile.currentLayoutCustom') : null,
        },
        groups: groupFields.filter((group) => group.fields.length > 0).map((group) => ({
            id: group.id,
            title: sectionLabel(group.id),
            count: group.fields.length,
            defaultOpen: group.id === 'basic' ? null : toggle(
                defaultOpenLabel,
                tr('settings.gtdMobile.startTaskEditingWithThisSectionExpanded'),
                sectionOpen[group.id],
                { type: 'taskEditorSectionOpen', section: group.id, value: !sectionOpen[group.id] },
            ),
            fields: group.fields.map(field),
        })),
        initiallyExpanded: sectionOpen,


        expandedResetKey: JSON.stringify([rawSectionOpen?.scheduling, rawSectionOpen?.organization, rawSectionOpen?.details]),
        reset: { label: t('settings.resetToDefault'), edit: { type: 'taskEditorReset' } },
    };
}

const FIELD_LABEL_KEYS: Partial<Record<TaskEditorFieldId, string>> = {
    status: 'taskEdit.statusLabel',
    project: 'taskEdit.projectLabel',
    section: 'taskEdit.sectionLabel',
    area: 'taskEdit.areaLabel',
    priority: 'taskEdit.priorityLabel',
    energyLevel: 'taskEdit.energyLevel',
    assignedTo: 'taskEdit.assignedTo',
    contexts: 'taskEdit.contextsLabel',
    description: 'taskEdit.descriptionLabel',
    location: 'taskEdit.locationLabel',
    tags: 'taskEdit.tagsLabel',
    timeEstimate: 'taskEdit.timeEstimateLabel',
    recurrence: 'taskEdit.recurrenceLabel',
    startTime: 'taskEdit.startDateLabel',
    dueDate: 'taskEdit.dueDateLabel',
    reviewAt: 'taskEdit.reviewDateLabel',
    attachments: 'attachments.title',
    checklist: 'taskEdit.checklist',
};

const fieldLabel = (fieldId: TaskEditorFieldId, t: Translate) => {
    const key = FIELD_LABEL_KEYS[fieldId];
    return key ? t(key) : fieldId;
};
