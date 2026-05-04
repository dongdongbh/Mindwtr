import type { AppData, TaskEditorFieldId, TaskEditorSectionId } from '@mindwtr/core';
import { normalizeClockTimeInput, sanitizePomodoroDurations, translateText } from '@mindwtr/core';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { reportError } from '../../../lib/report-error';
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

type Labels = {
    features: string;
    featuresDesc: string;
    autoArchive: string;
    autoArchiveDesc: string;
    autoArchiveNever: string;
    defaultScheduleTime: string;
    defaultScheduleTimeDesc: string;
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
    taskEditorLayout: string;
    taskEditorLayoutDesc: string;
    taskEditorLayoutHint: string;
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
    taskEditorFieldTags: string;
    taskEditorFieldTimeEstimate: string;
    taskEditorFieldRecurrence: string;
    taskEditorFieldStartTime: string;
    taskEditorFieldDueDate: string;
    taskEditorFieldReviewAt: string;
    taskEditorFieldAttachments: string;
    taskEditorFieldChecklist: string;
    featurePriorities: string;
    featurePrioritiesDesc: string;
    featureTimeEstimates: string;
    featureTimeEstimatesDesc: string;
    featurePomodoro: string;
    featurePomodoroDesc: string;
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
    weeklyReviewConfig: string;
    weeklyReviewConfigDesc: string;
    weeklyReviewIncludeContextsStep: string;
    weeklyReviewIncludeContextsStepDesc: string;
    visible: string;
    hidden: string;
};

type SettingsGtdPageProps = {
    t: Labels;
    language: Language;
    settings?: AppData['settings'];
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    showSaved: () => void;
    autoArchiveDays: number;
};

type SettingsDisclosureCardProps = {
    title: string;
    description?: string;
    hint?: string;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
};

function SettingsDisclosureCard({
    title,
    description,
    hint,
    open,
    onToggle,
    children,
}: SettingsDisclosureCardProps) {
    return (
        <div className="bg-card border border-border rounded-lg">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="w-full p-4 flex items-center justify-between gap-4 text-left"
            >
                <div className="min-w-0">
                    <div className="text-sm font-medium">{title}</div>
                    {description ? <div className="text-xs text-muted-foreground mt-1">{description}</div> : null}
                    {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
                </div>
                {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
            </button>
            {open ? (
                <div className="border-t border-border divide-y divide-border">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

export function SettingsGtdPage({
    t,
    language,
    settings,
    updateSettings,
    showSaved,
    autoArchiveDays,
}: SettingsGtdPageProps) {
    const safeSettings = settings ?? ({} as AppData['settings']);
    const [featuresOpen, setFeaturesOpen] = useState(false);
    const [captureOpen, setCaptureOpen] = useState(false);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [inboxOpen, setInboxOpen] = useState(false);
    const [taskEditorOpen, setTaskEditorOpen] = useState(false);
    const showToast = useUiStore((state) => state.showToast);
    const pomodoroAutoStartNoticeShownRef = useRef(false);
    const autoArchiveOptions = [0, 1, 3, 7, 14, 30, 60];
    const formatArchiveLabel = (days: number) => {
        if (days <= 0) return t.autoArchiveNever;
        const dayLabelMap: Record<Language, string> = {
            en: 'days',
            zh: '天',
            'zh-Hant': '天',
            es: 'días',
            hi: 'दिन',
            ar: 'أيام',
            de: translateText('days', 'de'),
            ru: translateText('days', 'ru'),
            ja: translateText('days', 'ja'),
            fr: translateText('days', 'fr'),
            pt: translateText('days', 'pt'),
            pl: translateText('days', 'pl'),
            nl: translateText('days', 'nl'),
            ko: translateText('days', 'ko'),
            it: translateText('days', 'it'),
            tr: translateText('days', 'tr'),
        };
        const label = dayLabelMap[language] ?? 'days';
        return `${days} ${label}`;
    };
    const featureHiddenFields = new Set<TaskEditorFieldId>();
    if (safeSettings.features?.priorities === false) {
        featureHiddenFields.add('priority');
    }
    if (safeSettings.features?.timeEstimates === false) {
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
    const defaultCaptureMethod = safeSettings.gtd?.defaultCaptureMethod ?? 'text';
    const saveAudioAttachments = safeSettings.gtd?.saveAudioAttachments !== false;
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
    const pomodoroEnabled = safeSettings.features?.pomodoro === true;
    const pomodoroCustomDurations = sanitizePomodoroDurations(safeSettings.gtd?.pomodoro?.customDurations);
    const pomodoroLinkTask = safeSettings.gtd?.pomodoro?.linkTask === true;
    const pomodoroAutoStartBreaks = safeSettings.gtd?.pomodoro?.autoStartBreaks === true;
    const pomodoroAutoStartFocus = safeSettings.gtd?.pomodoro?.autoStartFocus === true;
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
        showToast('Pomodoro will now advance phases automatically.', 'info', 5000);
    };

    const updatePomodoroSettings = (
        partial: Partial<NonNullable<NonNullable<AppData['settings']['gtd']>['pomodoro']>>,
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
        }).catch((error) => reportError('Failed to update Pomodoro settings', error));
    };

    const savePomodoroCustomDurations = (nextDurations: { focusMinutes: number; breakMinutes: number }) => {
        updatePomodoroSettings({ customDurations: nextDurations });
        return nextDurations;
    };

    const updateGtdSettings = (partial: Partial<NonNullable<AppData['settings']['gtd']>>) => {
        updateSettings({
            gtd: {
                ...(safeSettings.gtd ?? {}),
                ...partial,
            },
        }).then(showSaved).catch((error) => reportError('Failed to update GTD settings', error));
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
        },
        nextFeatures?: AppData['settings']['features']
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
        }).then(showSaved).catch((error) => reportError('Failed to update task editor layout', error));
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
    const updateInboxProcessing = (partial: Partial<NonNullable<AppData['settings']['gtd']>['inboxProcessing']>) => {
        updateSettings({
            gtd: {
                ...(safeSettings.gtd ?? {}),
                inboxProcessing: {
                    ...(safeSettings.gtd?.inboxProcessing ?? {}),
                    ...partial,
                },
            },
        }).then(showSaved).catch((error) => reportError('Failed to update inbox processing settings', error));
    };
    const updateWeeklyReviewConfig = (partial: NonNullable<AppData['settings']['gtd']>['weeklyReview']) => {
        updateSettings({
            gtd: {
                ...(safeSettings.gtd ?? {}),
                weeklyReview: {
                    ...(safeSettings.gtd?.weeklyReview ?? {}),
                    ...partial,
                },
            },
        }).then(showSaved).catch((error) => reportError('Failed to update weekly review settings', error));
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

    const taskEditorSectionLabel = (sectionId: TaskEditorSectionId) => {
        switch (sectionId) {
            case 'basic':
                return translateText('Basic', language);
            case 'scheduling':
                return translateText('Scheduling', language);
            case 'organization':
                return translateText('Organization', language);
            case 'details':
                return translateText('Details', language);
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
            <div className="bg-card border border-border rounded-lg divide-y divide-border">
                <div className="p-4 flex items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.autoArchive}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.autoArchiveDesc}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <select
                            value={autoArchiveDays}
                            onChange={(e) => {
                                const value = Number.parseInt(e.target.value, 10);
                                updateSettings({
                                    gtd: {
                                        ...(safeSettings.gtd ?? {}),
                                        autoArchiveDays: Number.isFinite(value) ? value : 7,
                                    },
                                }).then(showSaved).catch((error) => reportError('Failed to update auto-archive settings', error));
                            }}
                            className="text-sm bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            {autoArchiveOptions.map((days) => (
                                <option key={days} value={days}>
                                    {formatArchiveLabel(days)}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
                <div className="p-4 flex items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.defaultScheduleTime}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.defaultScheduleTimeDesc}</div>
                    </div>
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
                </div>
            </div>
            <SettingsDisclosureCard
                title={t.features}
                description={t.featuresDesc}
                open={featuresOpen}
                onToggle={() => setFeaturesOpen((prev) => !prev)}
            >
                <div className="p-4 flex items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.featurePomodoro}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.featurePomodoroDesc}</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={pomodoroEnabled}
                        onClick={() => {
                            updateSettings({
                                features: {
                                    ...(safeSettings.features ?? {}),
                                    pomodoro: !pomodoroEnabled,
                                },
                            }).then(showSaved).catch((error) => reportError('Failed to update feature flags', error));
                        }}
                        className={cn(
                            'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                            pomodoroEnabled ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                        )}
                    >
                        <span
                            className={cn(
                                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                pomodoroEnabled ? 'translate-x-4' : 'translate-x-1'
                            )}
                        />
                    </button>
                </div>
                {pomodoroEnabled && (
                    <div className="p-4 space-y-3">
                        <div>
                            <div className="text-sm font-medium">{t.pomodoroCustomPreset}</div>
                            <div className="text-xs text-muted-foreground mt-1">{t.pomodoroCustomPresetDesc}</div>
                        </div>
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
                            <div className="p-3 flex items-center justify-between gap-6">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{t.pomodoroLinkTask}</div>
                                    <div className="text-xs text-muted-foreground mt-1">{t.pomodoroLinkTaskDesc}</div>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={pomodoroLinkTask}
                                    onClick={() => updatePomodoroSettings({ linkTask: !pomodoroLinkTask })}
                                    className={cn(
                                        'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                        pomodoroLinkTask ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                            pomodoroLinkTask ? 'translate-x-4' : 'translate-x-1'
                                        )}
                                    />
                                </button>
                            </div>
                            <div className="p-3 flex items-center justify-between gap-6">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{t.pomodoroAutoStartBreaks}</div>
                                    <div className="text-xs text-muted-foreground mt-1">{t.pomodoroAutoStartBreaksDesc}</div>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={pomodoroAutoStartBreaks}
                                    onClick={() => updatePomodoroSettings(
                                        { autoStartBreaks: !pomodoroAutoStartBreaks },
                                        { showAutoStartNotice: !pomodoroAutoStartBreaks }
                                    )}
                                    className={cn(
                                        'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                        pomodoroAutoStartBreaks ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                            pomodoroAutoStartBreaks ? 'translate-x-4' : 'translate-x-1'
                                        )}
                                    />
                                </button>
                            </div>
                            <div className="p-3 flex items-center justify-between gap-6">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{t.pomodoroAutoStartFocus}</div>
                                    <div className="text-xs text-muted-foreground mt-1">{t.pomodoroAutoStartFocusDesc}</div>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={pomodoroAutoStartFocus}
                                    onClick={() => updatePomodoroSettings(
                                        { autoStartFocus: !pomodoroAutoStartFocus },
                                        { showAutoStartNotice: !pomodoroAutoStartFocus }
                                    )}
                                    className={cn(
                                        'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                        pomodoroAutoStartFocus ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                            pomodoroAutoStartFocus ? 'translate-x-4' : 'translate-x-1'
                                        )}
                                    />
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </SettingsDisclosureCard>
            <SettingsDisclosureCard
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
                                }).then(showSaved).catch((error) => reportError('Failed to update capture defaults', error));
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
                                }).then(showSaved).catch((error) => reportError('Failed to update capture defaults', error));
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
                {defaultCaptureMethod === 'audio' && speechEnabled ? (
                    <div className="p-4 flex items-center justify-between gap-6">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.captureSaveAudio}</div>
                            <div className="text-xs text-muted-foreground mt-1">{t.captureSaveAudioDesc}</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={saveAudioAttachments}
                            onClick={() => {
                                updateSettings({
                                    gtd: {
                                        ...(safeSettings.gtd ?? {}),
                                        saveAudioAttachments: !saveAudioAttachments,
                                    },
                                }).then(showSaved).catch((error) => reportError('Failed to update audio capture settings', error));
                            }}
                            className={cn(
                                'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                saveAudioAttachments ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                    saveAudioAttachments ? 'translate-x-4' : 'translate-x-1'
                                )}
                            />
                        </button>
                    </div>
                ) : null}
            </SettingsDisclosureCard>
            <SettingsDisclosureCard
                title={t.weeklyReviewConfig}
                description={t.weeklyReviewConfigDesc}
                open={reviewOpen}
                onToggle={() => setReviewOpen((prev) => !prev)}
            >
                <div className="p-4 flex items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.weeklyReviewIncludeContextsStep}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.weeklyReviewIncludeContextsStepDesc}</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={includeContextStep}
                        onClick={() => updateWeeklyReviewConfig({ includeContextStep: !includeContextStep })}
                        className={cn(
                            'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                            includeContextStep ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                        )}
                    >
                        <span
                            className={cn(
                                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                includeContextStep ? 'translate-x-4' : 'translate-x-1'
                            )}
                        />
                    </button>
                </div>
            </SettingsDisclosureCard>
            <div className="bg-card border border-border rounded-lg">
                <button
                    type="button"
                    onClick={() => setInboxOpen((prev) => !prev)}
                    aria-expanded={inboxOpen}
                    className="w-full p-4 flex items-center justify-between gap-4 text-left"
                >
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.inboxProcessing}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.inboxProcessingDesc}</div>
                    </div>
                    {inboxOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>
                {inboxOpen && <div className="divide-y divide-border border-t border-border">
                    <div className="p-4 space-y-3">
                        <div className="text-sm font-medium">{t.inboxDefaultMode}</div>
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
                    </div>
                    <div className="p-4 flex items-center justify-between gap-6">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.inboxTwoMinuteEnabled}</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={inboxTwoMinuteEnabled}
                            onClick={() => updateInboxProcessing({ twoMinuteEnabled: !inboxTwoMinuteEnabled })}
                            className={cn(
                                'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                inboxTwoMinuteEnabled ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                    inboxTwoMinuteEnabled ? 'translate-x-4' : 'translate-x-1'
                                )}
                            />
                        </button>
                    </div>
                    <div className="p-4 flex items-center justify-between gap-6">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.inboxTwoMinuteFirst}</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={inboxTwoMinuteFirst}
                            disabled={!inboxTwoMinuteEnabled}
                            onClick={() => updateInboxProcessing({ twoMinuteFirst: !inboxTwoMinuteFirst })}
                            className={cn(
                                'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                inboxTwoMinuteFirst ? 'bg-primary border-primary' : 'bg-muted/50 border-border',
                                !inboxTwoMinuteEnabled && 'opacity-50 cursor-not-allowed'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                    inboxTwoMinuteFirst ? 'translate-x-4' : 'translate-x-1'
                                )}
                            />
                        </button>
                    </div>
                    <div className="p-4 flex items-center justify-between gap-6">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.inboxProjectFirst}</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={inboxProjectFirst}
                            onClick={() => updateInboxProcessing({ projectFirst: !inboxProjectFirst })}
                            className={cn(
                                'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                inboxProjectFirst ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                    inboxProjectFirst ? 'translate-x-4' : 'translate-x-1'
                                )}
                            />
                        </button>
                    </div>
                    <div className="p-4 flex items-center justify-between gap-6">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.inboxContextStepEnabled}</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={inboxContextStepEnabled}
                            onClick={() => updateInboxProcessing({ contextStepEnabled: !inboxContextStepEnabled })}
                            className={cn(
                                'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                inboxContextStepEnabled ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                    inboxContextStepEnabled ? 'translate-x-4' : 'translate-x-1'
                                )}
                            />
                        </button>
                    </div>
                    <div className="p-4 flex items-center justify-between gap-6">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.inboxScheduleEnabled}</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={inboxScheduleEnabled}
                            onClick={() => updateInboxProcessing({ scheduleEnabled: !inboxScheduleEnabled })}
                            className={cn(
                                'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                inboxScheduleEnabled ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                    inboxScheduleEnabled ? 'translate-x-4' : 'translate-x-1'
                                )}
                            />
                        </button>
                    </div>
                </div>}
            </div>
            <div className="bg-card border border-border rounded-lg">
                <button
                    type="button"
                    onClick={() => setTaskEditorOpen((prev) => !prev)}
                    aria-expanded={taskEditorOpen}
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
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={isOpenByDefault}
                                                aria-label={`${group.title}: ${t.taskEditorOpenByDefault}`}
                                                onClick={() => updateSectionOpenDefault(sectionOpenSectionId, !isOpenByDefault)}
                                                className={cn(
                                                    'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                                    isOpenByDefault ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                                        isOpenByDefault ? 'translate-x-4' : 'translate-x-1'
                                                    )}
                                                />
                                            </button>
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
