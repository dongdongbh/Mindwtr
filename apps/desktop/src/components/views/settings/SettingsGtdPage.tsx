import type { AppSettings, Area, DefaultProjectFlowMode, FeatureSettings, GtdSettings, TaskEditorFieldId, TaskEditorPresentation, TaskEditorSectionId, TimeEstimate } from '@mindwtr/core';
import {
    FOCUS_TASK_LIMIT_OPTIONS,
    formatTimeEstimateLabel,
    normalizeClockTimeInput,
    normalizeFocusTaskLimit,
    getDefaultTaskAreaMode,
    resolveDefaultNewTaskAreaId,
    resolveFeatureFlags,
    sanitizePomodoroDurations,
} from '@mindwtr/core';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { reportSettingsFailure } from './settings-feedback';
import { dispatchDesktopOnboardingEvent } from '../../../lib/desktop-onboarding-events';
import { useUiStore } from '../../../store/ui-store';
import type { Language } from '../../../contexts/language-context';
import {
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_VISIBLE,
    DEFAULT_TASK_EDITOR_SECTION_BY_FIELD,
    DEFAULT_TASK_EDITOR_SECTION_OPEN,
    TASK_EDITOR_FIXED_FIELDS,
    TASK_EDITOR_SECTION_ORDER,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    isTaskEditorSectionableField,
} from '../../Task/task-item-helpers';
import { Switch } from '../../ui/Switch';
import { SettingField, SettingRow, SettingsDisclosureCard } from './SettingRow';

type Labels = {
    gtdDesc: string;
    settingsSaveFailed: string;
    pomodoroAutoStartNotice: string;
    features: string;
    featuresDesc: string;
    autoArchive: string;
    autoArchiveDesc: string;
    autoArchiveNever: string;
    autoArchiveDayUnit: string;
    defaultScheduleTime: string;
    defaultScheduleTimeDesc: string;
    defaultArea: string;
    defaultAreaDesc: string;
    defaultAreaNone: string;
    defaultAreaActive: string;
    focusTaskLimit: string;
    focusTaskLimitDesc: string;
    defaultProjectFlowMode: string;
    defaultProjectFlowModeDesc: string;
    projectFlowParallel: string;
    projectFlowSequential: string;
    timeEstimatePresets: string;
    timeEstimatePresetsDesc: string;
    timeEstimatePresetsDisabled: string;
    enableTimeEstimates: string;
    inboxProcessing: string;
    inboxProcessingDesc: string;
    inboxDefaultMode: string;
    inboxModeGuided: string;
    inboxModeQuick: string;
    inboxTwoMinuteEnabled: string;
    inboxTwoMinuteFirst: string;
    inboxProjectFirst: string;
    inboxContextStepEnabled: string;
    inboxScheduleEnabled: string;
    inboxReferenceEnabled: string;
    on: string;
    off: string;
    captureDefault: string;
    captureDefaultDesc: string;
    captureDefaultText: string;
    captureDefaultAudio: string;
    captureSaveAudio: string;
    captureSaveAudioDesc: string;
    quickAddAutoClean: string;
    quickAddAutoCleanDesc: string;
    naturalLanguageDates: string;
    naturalLanguageDatesDesc: string;
    markdownEditorAssist: string;
    markdownEditorAssistDesc: string;
    taskEditorLayout: string;
    taskEditorLayoutDesc: string;
    taskEditorLayoutHint: string;
    taskEditorPresentation: string;
    taskEditorPresentationDesc: string;
    taskEditorPresentationInline: string;
    taskEditorPresentationInlineDesc: string;
    taskEditorPresentationModal: string;
    taskEditorPresentationModalDesc: string;
    taskEditorLayoutReset: string;
    taskEditorSection: string;
    taskEditorDefaultOpen: string;
    taskEditorOpenByDefault: string;
    taskEditorDefaultOpenDesc: string;
    taskEditorFieldStatus: string;
    taskEditorFieldProject: string;
    taskEditorFieldSection: string;
    taskEditorFieldArea: string;
    taskEditorFieldPriority: string;
    taskEditorFieldEnergyLevel: string;
    taskEditorFieldAssignedTo: string;
    taskEditorFieldContexts: string;
    taskEditorFieldDescription: string;
    taskEditorFieldLocation: string;
    taskEditorFieldTags: string;
    taskEditorFieldTimeEstimate: string;
    taskEditorFieldRecurrence: string;
    taskEditorFieldStartTime: string;
    taskEditorFieldDueDate: string;
    taskEditorFieldReviewAt: string;
    taskEditorFieldAttachments: string;
    taskEditorFieldChecklist: string;
    taskEditorSectionBasic: string;
    taskEditorSectionScheduling: string;
    taskEditorSectionOrganization: string;
    taskEditorSectionDetails: string;
    featurePriorities: string;
    featurePrioritiesDesc: string;
    featureTimeEstimates: string;
    featureTimeEstimatesDesc: string;
    featurePomodoro: string;
    featurePomodoroDesc: string;
    featureTimeline: string;
    featureTimelineDesc: string;
    pomodoroCustomPreset: string;
    pomodoroCustomPresetDesc: string;
    pomodoroFocusMinutes: string;
    pomodoroBreakMinutes: string;
    pomodoroLinkTask: string;
    pomodoroLinkTaskDesc: string;
    pomodoroAutoStartBreaks: string;
    pomodoroAutoStartBreaksDesc: string;
    pomodoroAutoStartFocus: string;
    pomodoroAutoStartFocusDesc: string;
    pomodoroCompletionAlert: string;
    pomodoroCompletionAlertDesc: string;
    weeklyReviewConfig: string;
    weeklyReviewConfigDesc: string;
    weeklyReviewIncludeContextsStep: string;
    weeklyReviewIncludeContextsStepDesc: string;
    visible: string;
    hidden: string;
};

const DEFAULT_AREA_ACTIVE_SELECT_VALUE = '__active-area__';

// Mirrors the mobile GTD time-estimate editor (gtd-settings-screen.tsx) so the
// two platforms round-trip each other's gtd.timeEstimatePresets values.
const DEFAULT_TIME_ESTIMATE_PRESETS: TimeEstimate[] = ['5min', '10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const TIME_ESTIMATE_OPTIONS: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];

type PomodoroSettings = NonNullable<GtdSettings['pomodoro']>;
type InboxProcessingSettings = NonNullable<GtdSettings['inboxProcessing']>;

type SettingsGtdPageProps = {
    t: Labels;
    language: Language;
    settings?: AppSettings;
    updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
    showSaved: () => void;
    autoArchiveDays: number;
    areas: Area[];
};

const SHOW_TEMP_ONBOARDING_TRIGGER = false;

export function SettingsGtdPage({
    t,
    settings,
    updateSettings,
    showSaved,
    autoArchiveDays,
    areas,
}: SettingsGtdPageProps) {
    const safeSettings = settings ?? ({} as AppSettings);
    const [featuresOpen, setFeaturesOpen] = useState(false);
    const [timeEstimatesOpen, setTimeEstimatesOpen] = useState(false);
    const [captureOpen, setCaptureOpen] = useState(false);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [inboxOpen, setInboxOpen] = useState(false);
    const [taskEditorOpen, setTaskEditorOpen] = useState(false);
    const showToast = useUiStore((state) => state.showToast);
    const pomodoroAutoStartNoticeShownRef = useRef(false);
    const autoArchiveOptions = [0, 1, 3, 7, 14, 30, 60];
    const formatArchiveLabel = (days: number) => {
        if (days <= 0) return t.autoArchiveNever;
        return `${days} ${t.autoArchiveDayUnit}`;
    };
    const resolvedFeatureFlags = resolveFeatureFlags(safeSettings);
    const featureHiddenFields = new Set<TaskEditorFieldId>();
    if (!resolvedFeatureFlags.priorities) {
        featureHiddenFields.add('priority');
    }
    if (!resolvedFeatureFlags.timeEstimates) {
        featureHiddenFields.add('timeEstimate');
    }

    const defaultTaskEditorOrder = DEFAULT_TASK_EDITOR_ORDER;
    const defaultVisibleFields = new Set<TaskEditorFieldId>(DEFAULT_TASK_EDITOR_VISIBLE);
    const defaultTaskEditorHidden = defaultTaskEditorOrder.filter(
        (fieldId) => !defaultVisibleFields.has(fieldId) || featureHiddenFields.has(fieldId)
    );
    const savedOrder = safeSettings.gtd?.taskEditor?.order ?? [];
    const savedHidden = safeSettings.gtd?.taskEditor?.hidden ?? defaultTaskEditorHidden;
    const taskEditorOrder: TaskEditorFieldId[] = [
        ...savedOrder.filter((id) => defaultTaskEditorOrder.includes(id)),
        ...defaultTaskEditorOrder.filter((id) => !savedOrder.includes(id)),
    ];
    const hiddenSet = new Set(savedHidden);
    const taskEditorSections = getTaskEditorSectionAssignments(safeSettings.gtd?.taskEditor);
    const taskEditorSectionOpen = getTaskEditorSectionOpenDefaults(safeSettings.gtd?.taskEditor);
    const taskEditorPresentation: TaskEditorPresentation = safeSettings.gtd?.taskEditor?.presentation === 'modal'
        ? 'modal'
        : 'inline';
    const defaultCaptureMethod = safeSettings.gtd?.defaultCaptureMethod ?? 'text';
    const defaultAreaMode = getDefaultTaskAreaMode(safeSettings);
    const sortedAreas = [...areas]
        .filter((area) => !area.deletedAt)
        .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
    const defaultAreaId = resolveDefaultNewTaskAreaId(safeSettings, sortedAreas) ?? '';
    const defaultAreaSelectValue = defaultAreaMode === 'active'
        ? DEFAULT_AREA_ACTIVE_SELECT_VALUE
        : defaultAreaId;
    const saveAudioAttachments = safeSettings.gtd?.saveAudioAttachments !== false;
    const quickAddAutoClean = safeSettings.quickAddAutoClean === true;
    const naturalLanguageDates = safeSettings.gtd?.naturalLanguageDates !== false;
    const markdownEditorAssist = safeSettings.markdownEditorAssist !== false;
    const speechEnabled = safeSettings.ai?.speechToText?.enabled === true;
    const inboxProcessing = safeSettings.gtd?.inboxProcessing ?? {};
    const inboxDefaultMode = inboxProcessing.defaultMode === 'quick' ? 'quick' : 'guided';
    const inboxTwoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
    const inboxTwoMinuteFirst = inboxProcessing.twoMinuteFirst === true;
    const inboxProjectFirst = inboxProcessing.projectFirst === true;
    const inboxContextStepEnabled = inboxProcessing.contextStepEnabled !== false;
    const inboxScheduleEnabled = inboxProcessing.scheduleEnabled === true;
    const includeContextStep = safeSettings.gtd?.weeklyReview?.includeContextStep !== false;
    const defaultScheduleTime = normalizeClockTimeInput(safeSettings.gtd?.defaultScheduleTime) || '';
    const focusTaskLimit = normalizeFocusTaskLimit(safeSettings.gtd?.focusTaskLimit);
    const defaultProjectFlowMode: DefaultProjectFlowMode = safeSettings.gtd?.defaultProjectFlowMode === 'sequential'
        ? 'sequential'
        : 'parallel';
    const timeEstimatesEnabled = resolvedFeatureFlags.timeEstimates;
    const timeEstimatePresets: TimeEstimate[] = (safeSettings.gtd?.timeEstimatePresets?.length
        ? safeSettings.gtd.timeEstimatePresets
        : DEFAULT_TIME_ESTIMATE_PRESETS) as TimeEstimate[];
    const pomodoroEnabled = resolvedFeatureFlags.pomodoro;
    const pomodoroCustomDurations = sanitizePomodoroDurations(safeSettings.gtd?.pomodoro?.customDurations);
    const pomodoroLinkTask = safeSettings.gtd?.pomodoro?.linkTask === true;
    const pomodoroAutoStartBreaks = safeSettings.gtd?.pomodoro?.autoStartBreaks === true;
    const pomodoroAutoStartFocus = safeSettings.gtd?.pomodoro?.autoStartFocus === true;
    // Defaults on: the alert is the point of the timer, and an off-by-default
    // switch is what made #528 read as broken.
    const pomodoroCompletionAlert = safeSettings.gtd?.pomodoro?.completionAlert !== false;
    const [pomodoroFocusDraft, setPomodoroFocusDraft] = useState(String(pomodoroCustomDurations.focusMinutes));
    const [pomodoroBreakDraft, setPomodoroBreakDraft] = useState(String(pomodoroCustomDurations.breakMinutes));
    const [defaultScheduleTimeDraft, setDefaultScheduleTimeDraft] = useState(defaultScheduleTime);

    useEffect(() => {
        setPomodoroFocusDraft(String(pomodoroCustomDurations.focusMinutes));
        setPomodoroBreakDraft(String(pomodoroCustomDurations.breakMinutes));
    }, [pomodoroCustomDurations.breakMinutes, pomodoroCustomDurations.focusMinutes]);

    useEffect(() => {
        setDefaultScheduleTimeDraft(defaultScheduleTime);
    }, [defaultScheduleTime]);

    const showPomodoroAutoStartNotice = () => {
        if (pomodoroAutoStartNoticeShownRef.current) return;
        pomodoroAutoStartNoticeShownRef.current = true;
        showToast(t.pomodoroAutoStartNotice, 'info', 5000);
    };

    const updatePomodoroSettings = (
        partial: Partial<PomodoroSettings>,
        options?: { showAutoStartNotice?: boolean }
    ) => {
        updateSettings({
            gtd: {
                ...(safeSettings.gtd ?? {}),
                pomodoro: {
                    ...(safeSettings.gtd?.pomodoro ?? {}),
                    ...partial,
                },
            },
        }).then(() => {
            showSaved();
            if (options?.showAutoStartNotice) {
                showPomodoroAutoStartNotice();
            }
        }).catch((error) => reportSettingsFailure('Failed to update Pomodoro settings', error, t.settingsSaveFailed));
    };

    const savePomodoroCustomDurations = (nextDurations: { focusMinutes: number; breakMinutes: number }) => {
        updatePomodoroSettings({ customDurations: nextDurations });
        return nextDurations;
    };

    const updateGtdSettings = (partial: Partial<GtdSettings>) => {
        updateSettings({
            gtd: {
                ...(safeSettings.gtd ?? {}),
                ...partial,
            },
        }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update GTD settings', error, t.settingsSaveFailed));
    };

    const toggleTimeEstimatePreset = (value: TimeEstimate) => {
        const isSelected = timeEstimatePresets.includes(value);
        // Keep at least one preset so the editor always offers a choice.
        if (isSelected && timeEstimatePresets.length <= 1) return;
        const next = isSelected
            ? timeEstimatePresets.filter((v) => v !== value)
            : [...timeEstimatePresets, value];
        const ordered = TIME_ESTIMATE_OPTIONS.filter((v) => next.includes(v));
        updateGtdSettings({ timeEstimatePresets: ordered });
    };

    const resetTimeEstimatePresets = () => {
        updateGtdSettings({ timeEstimatePresets: [...DEFAULT_TIME_ESTIMATE_PRESETS] });
    };

    const enableTimeEstimates = () => {
        updateSettings({
            features: {
                ...(safeSettings.features ?? {}),
                timeEstimates: true,
            },
        }).then(showSaved).catch((error) => reportSettingsFailure('Failed to enable time estimates', error, t.settingsSaveFailed));
    };

    const commitDefaultScheduleTime = () => {
        const normalized = normalizeClockTimeInput(defaultScheduleTimeDraft);
        if (normalized === null) {
            setDefaultScheduleTimeDraft(defaultScheduleTime);
            return;
        }
        setDefaultScheduleTimeDraft(normalized);
        if (normalized === defaultScheduleTime) return;
        updateGtdSettings({ defaultScheduleTime: normalized });
    };

    const commitPomodoroMinutes = () => {
        const focusValue = Number.parseInt(pomodoroFocusDraft, 10);
        const breakValue = Number.parseInt(pomodoroBreakDraft, 10);
        const nextDurations = savePomodoroCustomDurations(sanitizePomodoroDurations({
            focusMinutes: Number.isFinite(focusValue) ? focusValue : pomodoroCustomDurations.focusMinutes,
            breakMinutes: Number.isFinite(breakValue) ? breakValue : pomodoroCustomDurations.breakMinutes,
        }));
        setPomodoroFocusDraft(String(nextDurations.focusMinutes));
        setPomodoroBreakDraft(String(nextDurations.breakMinutes));
    };

    const fieldLabel = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return t.taskEditorFieldStatus;
            case 'project':
                return t.taskEditorFieldProject;
            case 'section':
                return t.taskEditorFieldSection;
            case 'area':
                return t.taskEditorFieldArea;
            case 'priority':
                return t.taskEditorFieldPriority;
            case 'energyLevel':
                return t.taskEditorFieldEnergyLevel;
            case 'assignedTo':
                return t.taskEditorFieldAssignedTo;
            case 'contexts':
                return t.taskEditorFieldContexts;
            case 'description':
                return t.taskEditorFieldDescription;
            case 'location':
                return t.taskEditorFieldLocation;
            case 'tags':
                return t.taskEditorFieldTags;
            case 'timeEstimate':
                return t.taskEditorFieldTimeEstimate;
            case 'recurrence':
                return t.taskEditorFieldRecurrence;
            case 'startTime':
                return t.taskEditorFieldStartTime;
            case 'dueDate':
                return t.taskEditorFieldDueDate;
            case 'reviewAt':
                return t.taskEditorFieldReviewAt;
            case 'attachments':
                return t.taskEditorFieldAttachments;
            case 'checklist':
                return t.taskEditorFieldChecklist;
            default:
                return fieldId;
        }
    };
    const saveTaskEditor = (
        next: {
            order?: TaskEditorFieldId[];
            hidden?: TaskEditorFieldId[];
            sections?: Partial<Record<TaskEditorFieldId, TaskEditorSectionId>>;
            sectionOpen?: Partial<Record<TaskEditorSectionId, boolean>>;
            presentation?: TaskEditorPresentation;
        },
        nextFeatures?: FeatureSettings
    ) => {
        updateSettings({
            ...(nextFeatures ? { features: nextFeatures } : null),
            gtd: {
                ...(safeSettings.gtd ?? {}),
                taskEditor: {
                    ...(safeSettings.gtd?.taskEditor ?? {}),
                    ...next,
                },
            },
        }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update task editor layout', error, t.settingsSaveFailed));
    };
    const toggleFieldVisibility = (fieldId: TaskEditorFieldId) => {
        const nextHidden = new Set(hiddenSet);
        if (nextHidden.has(fieldId)) {
            nextHidden.delete(fieldId);
        } else {
            nextHidden.add(fieldId);
        }
        const nextFeatures = { ...(safeSettings.features ?? {}) };
        if (fieldId === 'priority') {
            nextFeatures.priorities = !nextHidden.has('priority');
        }
        if (fieldId === 'timeEstimate') {
            nextFeatures.timeEstimates = !nextHidden.has('timeEstimate');
        }
        saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(nextHidden) }, nextFeatures);
    };
    const updateInboxProcessing = (partial: Partial<InboxProcessingSettings>) => {
        updateSettings({
            gtd: {
                ...(safeSettings.gtd ?? {}),
                inboxProcessing: {
                    ...(safeSettings.gtd?.inboxProcessing ?? {}),
                    ...partial,
                },
            },
        }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update inbox processing settings', error, t.settingsSaveFailed));
    };
    const updateWeeklyReviewConfig = (partial: GtdSettings['weeklyReview']) => {
        updateSettings({
            gtd: {
                ...(safeSettings.gtd ?? {}),
                weeklyReview: {
                    ...(safeSettings.gtd?.weeklyReview ?? {}),
                    ...partial,
                },
            },
        }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update weekly review settings', error, t.settingsSaveFailed));
    };
    const moveFieldInGroup = (fieldId: TaskEditorFieldId, delta: number, groupFields: TaskEditorFieldId[]) => {
        const groupOrder = taskEditorOrder.filter((id) => groupFields.includes(id));
        const fromIndex = groupOrder.indexOf(fieldId);
        if (fromIndex === -1) return;
        const toIndex = Math.max(0, Math.min(groupOrder.length - 1, fromIndex + delta));
        if (fromIndex === toIndex) return;
        const nextGroupOrder = [...groupOrder];
        const [moved] = nextGroupOrder.splice(fromIndex, 1);
        nextGroupOrder.splice(toIndex, 0, moved);
        let groupIndex = 0;
        const nextOrder = taskEditorOrder.map((id) =>
            groupFields.includes(id) ? nextGroupOrder[groupIndex++] : id
        );
        saveTaskEditor({ order: nextOrder, hidden: Array.from(hiddenSet) });
    };

    const updateFieldSection = (fieldId: TaskEditorFieldId, sectionId: TaskEditorSectionId) => {
        if (!isTaskEditorSectionableField(fieldId)) return;
        const nextSections = { ...(safeSettings.gtd?.taskEditor?.sections ?? {}) };
        if (sectionId === DEFAULT_TASK_EDITOR_SECTION_BY_FIELD[fieldId]) {
            delete nextSections[fieldId];
        } else {
            nextSections[fieldId] = sectionId;
        }
        saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(hiddenSet), sections: nextSections });
    };

    const updateSectionOpenDefault = (sectionId: Exclude<TaskEditorSectionId, 'basic'>, isOpen: boolean) => {
        const nextSectionOpen = { ...(safeSettings.gtd?.taskEditor?.sectionOpen ?? {}) };
        if (isOpen === DEFAULT_TASK_EDITOR_SECTION_OPEN[sectionId]) {
            delete nextSectionOpen[sectionId];
        } else {
            nextSectionOpen[sectionId] = isOpen;
        }
        saveTaskEditor({ sectionOpen: nextSectionOpen });
    };
    const updateTaskEditorPresentation = (presentation: TaskEditorPresentation) => {
        if (presentation === taskEditorPresentation) return;
        saveTaskEditor({ presentation });
    };
    const handleOpenOnboardingFlow = () => {
        dispatchDesktopOnboardingEvent();
    };

    const taskEditorSectionLabel = (sectionId: TaskEditorSectionId) => {
        switch (sectionId) {
            case 'basic':
                return t.taskEditorSectionBasic;
            case 'scheduling':
                return t.taskEditorSectionScheduling;
            case 'organization':
                return t.taskEditorSectionOrganization;
            case 'details':
                return t.taskEditorSectionDetails;
            default:
                return sectionId;
        }
    };

    const fieldGroups: { id: TaskEditorSectionId; title: string; fields: TaskEditorFieldId[] }[] = TASK_EDITOR_SECTION_ORDER.map((sectionId) => ({
        id: sectionId,
        title: taskEditorSectionLabel(sectionId),
        fields: taskEditorOrder.filter((fieldId) => {
            if (sectionId === 'basic' && TASK_EDITOR_FIXED_FIELDS.includes(fieldId)) return true;
            return isTaskEditorSectionableField(fieldId) && taskEditorSections[fieldId] === sectionId;
        }),
    }));

    return (
        <div className="space-y-6">
            <p className="max-w-2xl text-sm text-muted-foreground">
                {t.gtdDesc}
            </p>
            {SHOW_TEMP_ONBOARDING_TRIGGER ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">Temporary onboarding test</div>
                        <div className="text-xs text-muted-foreground mt-1">
                            Opens the desktop first-run onboarding flow so you can test Sync, Import, and Start fresh.
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleOpenOnboardingFlow}
                        className="shrink-0 rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-sm font-medium text-foreground hover:bg-warning/25 focus:outline-none focus:ring-2 focus:ring-warning/40"
                    >
                        Open onboarding flow
                    </button>
                </div>
            ) : null}
            <div className="bg-card border border-border rounded-lg divide-y divide-border">
                <SettingRow padded settingsKey="autoArchive" title={t.autoArchive} description={t.autoArchiveDesc}>
                    <select
                        aria-label={t.autoArchive}
                        value={autoArchiveDays}
                        onChange={(e) => {
                            const value = Number.parseInt(e.target.value, 10);
                            updateSettings({
                                gtd: {
                                    ...(safeSettings.gtd ?? {}),
                                    autoArchiveDays: Number.isFinite(value) ? value : 7,
                                },
                            }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update auto-archive settings', error, t.settingsSaveFailed));
                        }}
                        className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        {autoArchiveOptions.map((days) => (
                            <option key={days} value={days}>
                                {formatArchiveLabel(days)}
                            </option>
                        ))}
                    </select>
                </SettingRow>
                <SettingRow padded settingsKey="defaultScheduleTime" title={t.defaultScheduleTime} description={t.defaultScheduleTimeDesc}>
                    <input
                        type="text"
                        inputMode="numeric"
                        aria-label={t.defaultScheduleTime}
                        value={defaultScheduleTimeDraft}
                        placeholder="HH:MM"
                        onChange={(event) => setDefaultScheduleTimeDraft(event.target.value)}
                        onBlur={commitDefaultScheduleTime}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.currentTarget.blur();
                            }
                        }}
                        className="w-24 shrink-0 text-sm bg-muted/50 text-foreground border border-border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                </SettingRow>
                <SettingRow padded settingsKey="focusTaskLimit" title={t.focusTaskLimit} description={t.focusTaskLimitDesc}>
                    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 shrink-0">
                        {FOCUS_TASK_LIMIT_OPTIONS.map((option) => {
                            const selected = focusTaskLimit === option;
                            return (
                                <button
                                    key={option}
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => {
                                        updateGtdSettings({ focusTaskLimit: option });
                                    }}
                                    className={cn(
                                        'min-w-9 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                                        selected
                                            ? 'bg-background text-foreground shadow-sm'
                                            : 'text-muted-foreground hover:text-foreground hover:bg-background/60'
                                    )}
                                >
                                    {option}
                                </button>
                            );
                        })}
                    </div>
                </SettingRow>
                <SettingRow padded settingsKey="defaultProjectFlowMode" title={t.defaultProjectFlowMode} description={t.defaultProjectFlowModeDesc}>
                    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 shrink-0">
                        {([
                            { id: 'parallel', label: t.projectFlowParallel },
                            { id: 'sequential', label: t.projectFlowSequential },
                        ] satisfies Array<{ id: DefaultProjectFlowMode; label: string }>).map((option) => {
                            const selected = defaultProjectFlowMode === option.id;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => {
                                        updateGtdSettings({ defaultProjectFlowMode: option.id });
                                    }}
                                    className={cn(
                                        'rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                                        selected
                                            ? 'bg-background text-foreground shadow-sm'
                                            : 'text-muted-foreground hover:text-foreground hover:bg-background/60'
                                    )}
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                </SettingRow>
            </div>
            <SettingsDisclosureCard
                sectionKey="features"
                title={t.features}
                description={t.featuresDesc}
                open={featuresOpen}
                onToggle={() => setFeaturesOpen((prev) => !prev)}
            >
                <SettingRow padded settingsKey="featureTimeline" title={t.featureTimeline} description={t.featureTimelineDesc}>
                    <Switch
                        aria-label={t.featureTimeline}
                        checked={resolvedFeatureFlags.timeline}
                        onCheckedChange={() => {
                            updateSettings({
                                features: {
                                    ...(safeSettings.features ?? {}),
                                    timeline: !resolvedFeatureFlags.timeline,
                                },
                            }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update feature flags', error, t.settingsSaveFailed));
                        }}
                    />
                </SettingRow>
                <SettingRow padded settingsKey="featurePomodoro" title={t.featurePomodoro} description={t.featurePomodoroDesc}>
                    <Switch
                        aria-label={t.featurePomodoro}
                        checked={pomodoroEnabled}
                        onCheckedChange={() => {
                            updateSettings({
                                features: {
                                    ...(safeSettings.features ?? {}),
                                    pomodoro: !pomodoroEnabled,
                                },
                            }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update feature flags', error, t.settingsSaveFailed));
                        }}
                    />
                </SettingRow>
                {pomodoroEnabled && (
                    <SettingField
                        settingsKey="pomodoroCustomPreset"
                        title={t.pomodoroCustomPreset}
                        description={t.pomodoroCustomPresetDesc}
                        className="p-4 gap-3"
                    >
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <label className="space-y-1.5">
                                <span className="text-xs font-medium text-muted-foreground">{t.pomodoroFocusMinutes}</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={180}
                                    inputMode="numeric"
                                    value={pomodoroFocusDraft}
                                    onChange={(event) => setPomodoroFocusDraft(event.target.value)}
                                    onBlur={commitPomodoroMinutes}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.currentTarget.blur();
                                        }
                                    }}
                                    className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                />
                            </label>
                            <label className="space-y-1.5">
                                <span className="text-xs font-medium text-muted-foreground">{t.pomodoroBreakMinutes}</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={180}
                                    inputMode="numeric"
                                    value={pomodoroBreakDraft}
                                    onChange={(event) => setPomodoroBreakDraft(event.target.value)}
                                    onBlur={commitPomodoroMinutes}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.currentTarget.blur();
                                        }
                                    }}
                                    className="w-full text-sm bg-muted/50 text-foreground border border-border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                />
                            </label>
                        </div>
                        <div className="rounded-lg border border-border divide-y divide-border">
                            <SettingRow padded settingsKey="pomodoroLinkTask" title={t.pomodoroLinkTask} description={t.pomodoroLinkTaskDesc}>
                                <Switch
                                    aria-label={t.pomodoroLinkTask}
                                    checked={pomodoroLinkTask}
                                    onCheckedChange={() => updatePomodoroSettings({ linkTask: !pomodoroLinkTask })}
                                />
                            </SettingRow>
                            <SettingRow padded settingsKey="pomodoroAutoStartBreaks" title={t.pomodoroAutoStartBreaks} description={t.pomodoroAutoStartBreaksDesc}>
                                <Switch
                                    aria-label={t.pomodoroAutoStartBreaks}
                                    checked={pomodoroAutoStartBreaks}
                                    onCheckedChange={() => updatePomodoroSettings(
                                        { autoStartBreaks: !pomodoroAutoStartBreaks },
                                        { showAutoStartNotice: !pomodoroAutoStartBreaks }
                                    )}
                                />
                            </SettingRow>
                            <SettingRow padded settingsKey="pomodoroAutoStartFocus" title={t.pomodoroAutoStartFocus} description={t.pomodoroAutoStartFocusDesc}>
                                <Switch
                                    aria-label={t.pomodoroAutoStartFocus}
                                    checked={pomodoroAutoStartFocus}
                                    onCheckedChange={() => updatePomodoroSettings(
                                        { autoStartFocus: !pomodoroAutoStartFocus },
                                        { showAutoStartNotice: !pomodoroAutoStartFocus }
                                    )}
                                />
                            </SettingRow>
                            <SettingRow padded settingsKey="pomodoroCompletionAlert" title={t.pomodoroCompletionAlert} description={t.pomodoroCompletionAlertDesc}>
                                <Switch
                                    aria-label={t.pomodoroCompletionAlert}
                                    checked={pomodoroCompletionAlert}
                                    onCheckedChange={() => updatePomodoroSettings({ completionAlert: !pomodoroCompletionAlert })}
                                />
                            </SettingRow>
                        </div>
                    </SettingField>
                )}
            </SettingsDisclosureCard>
            <SettingsDisclosureCard
                sectionKey="timeEstimatePresets"
                title={t.timeEstimatePresets}
                description={t.timeEstimatePresetsDesc}
                open={timeEstimatesOpen}
                onToggle={() => setTimeEstimatesOpen((prev) => !prev)}
            >
                {timeEstimatesEnabled ? (
                    <div className="p-4 space-y-3">
                        <div className="flex flex-wrap gap-2">
                            {TIME_ESTIMATE_OPTIONS.map((value) => {
                                const selected = timeEstimatePresets.includes(value);
                                return (
                                    <button
                                        key={value}
                                        type="button"
                                        aria-pressed={selected}
                                        onClick={() => toggleTimeEstimatePreset(value)}
                                        className={cn(
                                            'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                                            selected
                                                ? 'border-primary bg-primary/10 text-primary'
                                                : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                                        )}
                                    >
                                        {/* This page's `t` prop is a pre-resolved Labels struct, not a
                                            (key: string) => string function (unlike InboxProcessingWizard/
                                            InboxProcessingQuickPanel's `t`), so there's no key-lookup function
                                            to pass here — the core default (English, matching this page's
                                            existing copy) is used instead. That still fixes the real bug: the
                                            deleted local copy of this function collapsed any custom estimate
                                            straight to '4h+', losing precision; the shared implementation keeps
                                            the exact hours/minutes split. */}
                                        {formatTimeEstimateLabel(value)}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={resetTimeEstimatePresets}
                                className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                            >
                                {t.taskEditorLayoutReset}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="p-4 flex items-center justify-between gap-6">
                        <div className="min-w-0 text-sm text-muted-foreground">{t.timeEstimatePresetsDisabled}</div>
                        <button
                            type="button"
                            onClick={enableTimeEstimates}
                            className="shrink-0 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            {t.enableTimeEstimates}
                        </button>
                    </div>
                )}
            </SettingsDisclosureCard>
            <SettingsDisclosureCard
                sectionKey="captureDefault"
                title={t.captureDefault}
                description={t.captureDefaultDesc}
                open={captureOpen}
                onToggle={() => setCaptureOpen((prev) => !prev)}
            >
                <div className="p-4 space-y-3">
                    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                        <button
                            type="button"
                            onClick={() => {
                                updateSettings({
                                    gtd: {
                                        ...(safeSettings.gtd ?? {}),
                                        defaultCaptureMethod: 'text',
                                    },
                                }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update capture defaults', error, t.settingsSaveFailed));
                            }}
                            className={cn(
                                'px-3 py-1 text-xs rounded-md transition-colors',
                                defaultCaptureMethod === 'text'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t.captureDefaultText}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                updateSettings({
                                    gtd: {
                                        ...(safeSettings.gtd ?? {}),
                                        defaultCaptureMethod: 'audio',
                                    },
                                }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update capture defaults', error, t.settingsSaveFailed));
                            }}
                            className={cn(
                                'px-3 py-1 text-xs rounded-md transition-colors',
                                defaultCaptureMethod === 'audio'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t.captureDefaultAudio}
                        </button>
                    </div>
                </div>
                <SettingRow padded settingsKey="defaultArea" title={t.defaultArea} description={t.defaultAreaDesc}>
                    <select
                        value={defaultAreaSelectValue}
                        aria-label={t.defaultArea}
                        onChange={(event) => {
                            const value = event.target.value;
                            if (value === DEFAULT_AREA_ACTIVE_SELECT_VALUE) {
                                updateGtdSettings({ defaultAreaMode: 'active', defaultAreaId: null });
                            } else if (value) {
                                updateGtdSettings({ defaultAreaMode: 'fixed', defaultAreaId: value });
                            } else {
                                updateGtdSettings({ defaultAreaMode: 'none', defaultAreaId: null });
                            }
                        }}
                        className="max-w-56 shrink-0 text-sm bg-muted/50 text-foreground border border-border rounded px-3 py-2 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        <option value="">{t.defaultAreaNone}</option>
                        <option value={DEFAULT_AREA_ACTIVE_SELECT_VALUE}>{t.defaultAreaActive}</option>
                        {sortedAreas.map((area) => (
                            <option key={area.id} value={area.id}>{area.name}</option>
                        ))}
                    </select>
                </SettingRow>
                {defaultCaptureMethod === 'audio' && speechEnabled ? (
                    <SettingRow padded settingsKey="captureSaveAudio" title={t.captureSaveAudio} description={t.captureSaveAudioDesc}>
                        <Switch
                            aria-label={t.captureSaveAudio}
                            checked={saveAudioAttachments}
                            onCheckedChange={() => {
                                updateSettings({
                                    gtd: {
                                        ...(safeSettings.gtd ?? {}),
                                        saveAudioAttachments: !saveAudioAttachments,
                                    },
                                }).then(showSaved).catch((error) => reportSettingsFailure('Failed to update audio capture settings', error, t.settingsSaveFailed));
                            }}
                        />
                    </SettingRow>
                ) : null}
                <SettingRow padded settingsKey="quickAddAutoClean" title={t.quickAddAutoClean} description={t.quickAddAutoCleanDesc}>
                    <Switch
                        aria-label={t.quickAddAutoClean}
                        checked={quickAddAutoClean}
                        onCheckedChange={() => {
                            updateSettings({ quickAddAutoClean: !quickAddAutoClean })
                                .then(showSaved)
                                .catch((error) => reportSettingsFailure('Failed to update quick add settings', error, t.settingsSaveFailed));
                        }}
                    />
                </SettingRow>
                <SettingRow padded settingsKey="naturalLanguageDates" title={t.naturalLanguageDates} description={t.naturalLanguageDatesDesc}>
                    <Switch
                        aria-label={t.naturalLanguageDates}
                        checked={naturalLanguageDates}
                        onCheckedChange={() => {
                            updateSettings({
                                gtd: {
                                    ...(safeSettings.gtd ?? {}),
                                    naturalLanguageDates: !naturalLanguageDates,
                                },
                            })
                                .then(showSaved)
                                .catch((error) => reportSettingsFailure('Failed to update quick add settings', error, t.settingsSaveFailed));
                        }}
                    />
                </SettingRow>
                <SettingRow padded settingsKey="markdownEditorAssist" title={t.markdownEditorAssist} description={t.markdownEditorAssistDesc}>
                    <Switch
                        aria-label={t.markdownEditorAssist}
                        checked={markdownEditorAssist}
                        onCheckedChange={() => {
                            updateSettings({ markdownEditorAssist: !markdownEditorAssist })
                                .then(showSaved)
                                .catch((error) => reportSettingsFailure('Failed to update editor settings', error, t.settingsSaveFailed));
                        }}
                    />
                </SettingRow>
            </SettingsDisclosureCard>
            <SettingsDisclosureCard
                sectionKey="weeklyReviewConfig"
                title={t.weeklyReviewConfig}
                description={t.weeklyReviewConfigDesc}
                open={reviewOpen}
                onToggle={() => setReviewOpen((prev) => !prev)}
            >
                <SettingRow padded settingsKey="weeklyReviewIncludeContextsStep" title={t.weeklyReviewIncludeContextsStep} description={t.weeklyReviewIncludeContextsStepDesc}>
                    <Switch
                        aria-label={t.weeklyReviewIncludeContextsStep}
                        checked={includeContextStep}
                        onCheckedChange={() => updateWeeklyReviewConfig({ includeContextStep: !includeContextStep })}
                    />
                </SettingRow>
            </SettingsDisclosureCard>
            <div className="bg-card border border-border rounded-lg">
                <button
                    type="button"
                    onClick={() => setInboxOpen((prev) => !prev)}
                    aria-expanded={inboxOpen}
                    data-settings-section="inboxProcessing"
                    data-settings-key="inboxProcessing"
                    className="w-full p-4 flex items-center justify-between gap-4 text-left"
                >
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.inboxProcessing}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.inboxProcessingDesc}</div>
                    </div>
                    {inboxOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>
                {inboxOpen && <div className="divide-y divide-border border-t border-border">
                    <SettingField settingsKey="inboxDefaultMode" title={t.inboxDefaultMode} className="p-4 gap-3">
                        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                            <button
                                type="button"
                                onClick={() => updateInboxProcessing({ defaultMode: 'guided' })}
                                className={cn(
                                    'px-3 py-1 text-xs rounded-md transition-colors',
                                    inboxDefaultMode === 'guided'
                                        ? 'bg-primary text-primary-foreground'
                                        : 'text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {t.inboxModeGuided}
                            </button>
                            <button
                                type="button"
                                onClick={() => updateInboxProcessing({ defaultMode: 'quick' })}
                                className={cn(
                                    'px-3 py-1 text-xs rounded-md transition-colors',
                                    inboxDefaultMode === 'quick'
                                        ? 'bg-primary text-primary-foreground'
                                        : 'text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {t.inboxModeQuick}
                            </button>
                        </div>
                    </SettingField>
                    <SettingRow padded settingsKey="inboxTwoMinuteEnabled" title={t.inboxTwoMinuteEnabled}>
                        <Switch
                            aria-label={t.inboxTwoMinuteEnabled}
                            checked={inboxTwoMinuteEnabled}
                            onCheckedChange={() => updateInboxProcessing({ twoMinuteEnabled: !inboxTwoMinuteEnabled })}
                        />
                    </SettingRow>
                    <SettingRow padded settingsKey="inboxTwoMinuteFirst" title={t.inboxTwoMinuteFirst}>
                        <Switch
                            aria-label={t.inboxTwoMinuteFirst}
                            checked={inboxTwoMinuteFirst}
                            disabled={!inboxTwoMinuteEnabled}
                            onCheckedChange={() => updateInboxProcessing({ twoMinuteFirst: !inboxTwoMinuteFirst })}
                        />
                    </SettingRow>
                    <SettingRow padded settingsKey="inboxProjectFirst" title={t.inboxProjectFirst}>
                        <Switch
                            aria-label={t.inboxProjectFirst}
                            checked={inboxProjectFirst}
                            onCheckedChange={() => updateInboxProcessing({ projectFirst: !inboxProjectFirst })}
                        />
                    </SettingRow>
                    <SettingRow padded settingsKey="inboxContextStepEnabled" title={t.inboxContextStepEnabled}>
                        <Switch
                            aria-label={t.inboxContextStepEnabled}
                            checked={inboxContextStepEnabled}
                            onCheckedChange={() => updateInboxProcessing({ contextStepEnabled: !inboxContextStepEnabled })}
                        />
                    </SettingRow>
                    <SettingRow padded settingsKey="inboxScheduleEnabled" title={t.inboxScheduleEnabled}>
                        <Switch
                            aria-label={t.inboxScheduleEnabled}
                            checked={inboxScheduleEnabled}
                            onCheckedChange={() => updateInboxProcessing({ scheduleEnabled: !inboxScheduleEnabled })}
                        />
                    </SettingRow>
                </div>}
            </div>
            <div className="bg-card border border-border rounded-lg">
                <button
                    type="button"
                    onClick={() => setTaskEditorOpen((prev) => !prev)}
                    aria-expanded={taskEditorOpen}
                    data-settings-section="taskEditorLayout"
                    data-settings-key="taskEditorLayout"
                    className="w-full p-4 flex items-center justify-between gap-4 text-left"
                >
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.taskEditorLayout}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.taskEditorLayoutDesc}</div>
                        <div className="text-xs text-muted-foreground">{t.taskEditorLayoutHint}</div>
                    </div>
                    {taskEditorOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>
                {taskEditorOpen && <div className="p-4 space-y-4">
                    <SettingField
                        settingsKey="taskEditorPresentation"
                        title={t.taskEditorPresentation}
                        description={t.taskEditorPresentationDesc}
                        className="rounded-md border border-border bg-muted/20 p-3 gap-3"
                    >
                        <div className="grid gap-2 sm:grid-cols-2">
                            {([
                                {
                                    value: 'inline',
                                    label: t.taskEditorPresentationInline,
                                    description: t.taskEditorPresentationInlineDesc,
                                },
                                {
                                    value: 'modal',
                                    label: t.taskEditorPresentationModal,
                                    description: t.taskEditorPresentationModalDesc,
                                },
                            ] as const).map((option) => {
                                const selected = taskEditorPresentation === option.value;
                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        aria-pressed={selected}
                                        onClick={() => updateTaskEditorPresentation(option.value)}
                                        className={cn(
                                            'rounded-md border px-3 py-2 text-left transition-colors',
                                            selected
                                                ? 'border-primary bg-primary/10 text-primary'
                                                : 'border-border bg-background text-foreground hover:bg-muted/50'
                                        )}
                                    >
                                        <div className="text-sm font-medium">{option.label}</div>
                                        <div className={cn(
                                            'mt-1 text-xs',
                                            selected ? 'text-primary/80' : 'text-muted-foreground'
                                        )}>
                                            {option.description}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </SettingField>
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={() => {
                                const nextFeatures = { ...(safeSettings.features ?? {}) };
                                nextFeatures.priorities = !defaultTaskEditorHidden.includes('priority');
                                nextFeatures.timeEstimates = !defaultTaskEditorHidden.includes('timeEstimate');
                                saveTaskEditor({
                                    order: [...defaultTaskEditorOrder],
                                    hidden: [...defaultTaskEditorHidden],
                                    sections: {},
                                    sectionOpen: {},
                                }, nextFeatures);
                            }}
                            className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                        >
                            {t.taskEditorLayoutReset}
                        </button>
                    </div>
                    {fieldGroups.map((group) => {
                        const groupOrder = taskEditorOrder.filter((id) => group.fields.includes(id));
                        const sectionOpenSectionId = group.id === 'basic' ? null : group.id;
                        const isOpenByDefault = sectionOpenSectionId ? taskEditorSectionOpen[sectionOpenSectionId] : false;
                        return (
                            <div key={group.id} className="space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                                        {group.title}
                                    </div>
                                    {sectionOpenSectionId && (
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] text-muted-foreground">
                                                {t.taskEditorOpenByDefault}
                                            </span>
                                            <Switch
                                                aria-label={`${group.title}: ${t.taskEditorOpenByDefault}`}
                                                checked={isOpenByDefault}
                                                onCheckedChange={() => updateSectionOpenDefault(sectionOpenSectionId, !isOpenByDefault)}
                                            />
                                        </div>
                                    )}
                                </div>
                                {groupOrder.map((fieldId, index) => {
                                    const isVisible = !hiddenSet.has(fieldId);
                                    const isSectionable = isTaskEditorSectionableField(fieldId);
                                    return (
                                        <div
                                            key={fieldId}
                                            className={cn(
                                                'flex flex-wrap items-center justify-between gap-3 rounded-md px-3 py-2 border transition-colors',
                                                isVisible ? 'bg-primary/10 border-primary/40' : 'bg-muted/30 border-transparent'
                                            )}
                                        >
                                            <div className="min-w-0 flex-1 text-sm">
                                                <span className={cn("text-xs uppercase tracking-wide", isVisible ? "text-primary" : "text-muted-foreground")}>
                                                    {isVisible ? t.visible : t.hidden}
                                                </span>
                                                <div className={cn('mt-1', isVisible ? 'text-foreground' : 'text-muted-foreground')}>
                                                    {fieldLabel(fieldId)}
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => toggleFieldVisibility(fieldId)}
                                                className={cn(
                                                    'text-xs px-2 py-1 rounded border transition-colors',
                                                    isVisible
                                                        ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                                                        : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted'
                                                )}
                                            >
                                                {isVisible ? t.visible : t.hidden}
                                            </button>
                                            {isSectionable && (
                                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                                    <span>{t.taskEditorSection}</span>
                                                    <select
                                                        value={taskEditorSections[fieldId]}
                                                        onChange={(event) => updateFieldSection(fieldId, event.target.value as TaskEditorSectionId)}
                                                        className="text-xs bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                                    >
                                                        {TASK_EDITOR_SECTION_ORDER.map((sectionId) => (
                                                            <option key={sectionId} value={sectionId}>
                                                                {taskEditorSectionLabel(sectionId)}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </label>
                                            )}
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() => moveFieldInGroup(fieldId, -1, group.fields)}
                                                    disabled={index === 0}
                                                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => moveFieldInGroup(fieldId, 1, group.fields)}
                                                    disabled={index === groupOrder.length - 1}
                                                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    ↓
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>}
            </div>
        </div>
    );
}
