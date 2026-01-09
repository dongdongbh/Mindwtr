import { useState } from 'react';
import type { AppData, TaskEditorFieldId } from '@mindwtr/core';
import { translateText } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import type { Language } from '../../../contexts/language-context';

type Labels = {
    autoArchive: string;
    autoArchiveDesc: string;
    autoArchiveNever: string;
    features: string;
    featuresDesc: string;
    featurePriorities: string;
    featurePrioritiesDesc: string;
    featureTimeEstimates: string;
    featureTimeEstimatesDesc: string;
    on: string;
    off: string;
    taskEditorLayout: string;
    taskEditorLayoutDesc: string;
    taskEditorLayoutHint: string;
    taskEditorLayoutReset: string;
    taskEditorFieldStatus: string;
    taskEditorFieldProject: string;
    taskEditorFieldPriority: string;
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
    visible: string;
    hidden: string;
};

type SettingsGtdPageProps = {
    t: Labels;
    language: Language;
    settings: AppData['settings'];
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    showSaved: () => void;
    autoArchiveDays: number;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    updateFeatureFlags: (next: Partial<NonNullable<AppData['settings']['features']>>) => void;
};

export function SettingsGtdPage({
    t,
    language,
    settings,
    updateSettings,
    showSaved,
    autoArchiveDays,
    prioritiesEnabled,
    timeEstimatesEnabled,
    updateFeatureFlags,
}: SettingsGtdPageProps) {
    const [showAdvanced, setShowAdvanced] = useState(false);
    const autoArchiveOptions = [0, 1, 3, 7, 14, 30, 60];
    const formatArchiveLabel = (days: number) => {
        if (days <= 0) return t.autoArchiveNever;
        const dayLabelMap: Record<Language, string> = {
            en: 'days',
            zh: '天',
            es: 'días',
            hi: 'दिन',
            ar: 'أيام',
            de: translateText('days', 'de'),
            ru: translateText('days', 'ru'),
            ja: translateText('days', 'ja'),
            fr: translateText('days', 'fr'),
            pt: translateText('days', 'pt'),
            ko: translateText('days', 'ko'),
            it: translateText('days', 'it'),
            tr: translateText('days', 'tr'),
        };
        const label = dayLabelMap[language] ?? 'days';
        return `${days} ${label}`;
    };
    const advancedLabel = translateText('Advanced', language);
    const featureHiddenFields = new Set<TaskEditorFieldId>();
    if (!prioritiesEnabled) {
        featureHiddenFields.add('priority');
    }
    if (!timeEstimatesEnabled) {
        featureHiddenFields.add('timeEstimate');
    }

    const baseTaskEditorOrder: TaskEditorFieldId[] = [
        'status',
        'project',
        'priority',
        'contexts',
        'description',
        'tags',
        'timeEstimate',
        'recurrence',
        'startTime',
        'dueDate',
        'reviewAt',
        'attachments',
        'checklist',
    ];
    const defaultTaskEditorOrder = baseTaskEditorOrder.filter((fieldId) => !featureHiddenFields.has(fieldId));
    const defaultTaskEditorHidden = [...defaultTaskEditorOrder];
    const savedOrder = settings.gtd?.taskEditor?.order ?? [];
    const savedHidden = settings.gtd?.taskEditor?.hidden ?? defaultTaskEditorHidden;
    const taskEditorOrder: TaskEditorFieldId[] = [
        ...savedOrder.filter((id) => defaultTaskEditorOrder.includes(id)),
        ...defaultTaskEditorOrder.filter((id) => !savedOrder.includes(id)),
    ];
    const taskEditorDisplayOrder = taskEditorOrder.filter((id) => id !== 'dueDate');
    const hiddenSet = new Set(savedHidden);
    const fieldLabel = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return t.taskEditorFieldStatus;
            case 'project':
                return t.taskEditorFieldProject;
            case 'priority':
                return t.taskEditorFieldPriority;
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
    const saveTaskEditor = (next: { order?: TaskEditorFieldId[]; hidden?: TaskEditorFieldId[] }) => {
        updateSettings({
            gtd: {
                ...(settings.gtd ?? {}),
                taskEditor: {
                    ...(settings.gtd?.taskEditor ?? {}),
                    ...next,
                },
            },
        }).then(showSaved).catch(console.error);
    };
    const toggleFieldVisibility = (fieldId: TaskEditorFieldId) => {
        const nextHidden = new Set(hiddenSet);
        if (nextHidden.has(fieldId)) {
            nextHidden.delete(fieldId);
        } else {
            nextHidden.add(fieldId);
        }
        saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(nextHidden) });
    };
    const moveField = (fieldId: TaskEditorFieldId, delta: number) => {
        const fromIndex = taskEditorOrder.indexOf(fieldId);
        if (fromIndex === -1) return;
        const toIndex = Math.max(0, Math.min(taskEditorOrder.length - 1, fromIndex + delta));
        if (fromIndex === toIndex) return;
        const nextOrder = [...taskEditorOrder];
        const [moved] = nextOrder.splice(fromIndex, 1);
        nextOrder.splice(toIndex, 0, moved);
        saveTaskEditor({ order: nextOrder, hidden: Array.from(hiddenSet) });
    };

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
                                        ...(settings.gtd ?? {}),
                                        autoArchiveDays: Number.isFinite(value) ? value : 7,
                                    },
                                }).then(showSaved).catch(console.error);
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
            </div>
            <div className="bg-card border border-border rounded-lg divide-y divide-border">
                <div className="p-4">
                    <div className="text-sm font-medium">{t.features}</div>
                    <div className="text-xs text-muted-foreground mt-1">{t.featuresDesc}</div>
                </div>
                <div className="p-4 flex items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.featurePriorities}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.featurePrioritiesDesc}</div>
                    </div>
                    <button
                        type="button"
                        onClick={() => updateFeatureFlags({ priorities: !prioritiesEnabled })}
                        className={cn(
                            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors border",
                            prioritiesEnabled
                                ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                        )}
                    >
                        {prioritiesEnabled ? t.on : t.off}
                    </button>
                </div>

                <div className="p-4 flex items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.featureTimeEstimates}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.featureTimeEstimatesDesc}</div>
                    </div>
                    <button
                        type="button"
                        onClick={() => updateFeatureFlags({ timeEstimates: !timeEstimatesEnabled })}
                        className={cn(
                            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors border",
                            timeEstimatesEnabled
                                ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                        )}
                    >
                        {timeEstimatesEnabled ? t.on : t.off}
                    </button>
                </div>
            </div>
            <div className="bg-card border border-border rounded-lg p-4 flex items-center justify-between">
                <div className="text-sm font-medium">{advancedLabel}</div>
                <button
                    type="button"
                    onClick={() => setShowAdvanced((prev) => !prev)}
                    className={cn(
                        "px-3 py-1.5 rounded-md text-xs font-medium transition-colors border",
                        showAdvanced
                            ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                            : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                    )}
                >
                    {showAdvanced ? t.on : t.off}
                </button>
            </div>
            {showAdvanced && (
            <div className="bg-card border border-border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="text-sm font-medium">{t.taskEditorLayout}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t.taskEditorLayoutDesc}</div>
                        <div className="text-xs text-muted-foreground">{t.taskEditorLayoutHint}</div>
                    </div>
                    <button
                        type="button"
                        onClick={() => saveTaskEditor({ order: [...defaultTaskEditorOrder], hidden: [...defaultTaskEditorHidden] })}
                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                    >
                        {t.taskEditorLayoutReset}
                    </button>
                </div>
                <div className="space-y-2">
                    {taskEditorDisplayOrder.map((fieldId, index) => {
                        const isVisible = !hiddenSet.has(fieldId);
                        return (
                            <div
                                key={fieldId}
                                className={cn(
                                    "flex items-center justify-between rounded-md px-3 py-2 border transition-colors cursor-pointer",
                                    isVisible ? "bg-primary/10 border-primary/40" : "bg-muted/30 border-transparent hover:border-border"
                                )}
                                onClick={() => toggleFieldVisibility(fieldId)}
                            >
                                <div className="flex items-center gap-2 text-sm">
                                    <span className={cn("text-xs uppercase tracking-wide", isVisible ? "text-primary" : "text-muted-foreground")}>
                                        {isVisible ? t.visible : t.hidden}
                                    </span>
                                    <span className={cn(isVisible ? "text-foreground" : "text-muted-foreground")}>
                                        {fieldLabel(fieldId)}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            moveField(fieldId, -1);
                                        }}
                                        disabled={index === 0}
                                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors disabled:opacity-40"
                                    >
                                        ↑
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            moveField(fieldId, 1);
                                        }}
                                        disabled={index === taskEditorDisplayOrder.length - 1}
                                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors disabled:opacity-40"
                                    >
                                        ↓
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            )}
        </div>
    );
}
