import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import {
    addBreadcrumb,
    DEFAULT_PROJECT_COLOR,
    getFrequentTaskTokens,
    getRecentTaskTokens,
    parseQuickAddDateCommands,
    safeParseDate,
    safeFormatDate,
    hasTimeComponent,
    type AppData,
    type Area,
    type Project,
    type Task,
    type TaskEnergyLevel,
    type TaskPriority,
} from '@mindwtr/core';

import { InboxProcessingWizard, type ProcessingStep } from '../InboxProcessingWizard';
import { InboxProcessingQuickPanel, type QuickActionabilityChoice, type QuickExecutionChoice, type QuickTwoMinuteChoice } from '../InboxProcessingQuickPanel';
import type { InboxProcessingScheduleFieldsControls } from '../InboxProcessingScheduleFields';
import { DEFAULT_TASK_EDITOR_HIDDEN } from '../Task/task-item-helpers';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { reportError } from '../../lib/report-error';
import { useUiStore } from '../../store/ui-store';

type InboxProcessorProps = {
    t: (key: string) => string;
    isInbox: boolean;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings?: AppData['settings'];
    addProject: (title: string, color: string) => Promise<Project | null>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
    deleteTask: (id: string) => Promise<unknown>;
    allContexts: string[];
    isProcessing: boolean;
    setIsProcessing: (value: boolean) => void;
};

const parseTokenListInput = (value: string, prefix: '@' | '#'): string[] => Array.from(
    new Set(
        value
            .split(/[,\n]+/)
            .map((part) => part.trim())
            .map((part) => part.replace(/^[@#]+/, '').trim())
            .filter(Boolean)
            .map((part) => `${prefix}${part}`)
    )
);

const mergeSuggestedTokens = (...groups: string[][]): string[] =>
    Array.from(new Set(groups.flat()));

const normalizeTimeInput = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const compact = trimmed.replace(/\s+/g, '');
    let hours: number;
    let minutes: number;
    if (/^\d{1,2}:\d{2}$/.test(compact)) {
        const [h, m] = compact.split(':');
        hours = Number(h);
        minutes = Number(m);
    } else if (/^\d{3,4}$/.test(compact)) {
        if (compact.length === 3) {
            hours = Number(compact.slice(0, 1));
            minutes = Number(compact.slice(1));
        } else {
            hours = Number(compact.slice(0, 2));
            minutes = Number(compact.slice(2));
        }
    } else {
        return null;
    }
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const getDateFieldDraft = (value?: string): { date: string; time: string; timeDraft: string } => {
    const parsed = value ? safeParseDate(value) : null;
    const date = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
    const time = parsed && value && hasTimeComponent(value)
        ? safeFormatDate(parsed, 'HH:mm')
        : '';

    return {
        date,
        time,
        timeDraft: time,
    };
};

const resolveCommittedTime = (draft: string, committed: string): { time: string; timeDraft: string } => {
    const normalized = normalizeTimeInput(draft);
    if (normalized === null) {
        return {
            time: committed,
            timeDraft: committed,
        };
    }

    return {
        time: normalized,
        timeDraft: normalized,
    };
};

const buildDateTimeUpdate = (date: string, timeDraft: string, committedTime: string): string | undefined => {
    if (!date) return undefined;
    const normalized = normalizeTimeInput(timeDraft);
    const resolvedTime = normalized === null ? committedTime : normalized;
    return resolvedTime ? `${date}T${resolvedTime}` : date;
};

export function InboxProcessor({
    t,
    isInbox,
    tasks,
    projects,
    areas,
    settings,
    addProject,
    updateTask,
    deleteTask,
    allContexts,
    isProcessing,
    setIsProcessing,
}: InboxProcessorProps) {
    const showToast = useUiStore((state) => state.showToast);
    const [processingMode, setProcessingMode] = useState<'guided' | 'quick'>('guided');
    const [processingTask, setProcessingTask] = useState<Task | null>(null);
    const [processingStep, setProcessingStep] = useState<ProcessingStep>('actionable');
    const [stepHistory, setStepHistory] = useState<ProcessingStep[]>([]);
    const [quickActionability, setQuickActionability] = useState<QuickActionabilityChoice>('actionable');
    const [quickTwoMinuteChoice, setQuickTwoMinuteChoice] = useState<QuickTwoMinuteChoice>('no');
    const [quickExecutionChoice, setQuickExecutionChoice] = useState<QuickExecutionChoice>('defer');
    const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedEnergyLevel, setSelectedEnergyLevel] = useState<TaskEnergyLevel | undefined>(undefined);
    const [selectedAssignedTo, setSelectedAssignedTo] = useState('');
    const [selectedPriority, setSelectedPriority] = useState<TaskPriority | undefined>(undefined);
    const [delegateWho, setDelegateWho] = useState('');
    const [delegateFollowUp, setDelegateFollowUp] = useState('');
    const [projectSearch, setProjectSearch] = useState('');
    const [processingTitle, setProcessingTitle] = useState('');
    const [processingDescription, setProcessingDescription] = useState('');
    const [convertToProject, setConvertToProject] = useState(false);
    const [projectTitleDraft, setProjectTitleDraft] = useState('');
    const [nextActionDraft, setNextActionDraft] = useState('');
    const [customContext, setCustomContext] = useState('');
    const [customTag, setCustomTag] = useState('');
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
    const [scheduleDate, setScheduleDate] = useState('');
    const [scheduleTime, setScheduleTime] = useState('');
    const [scheduleTimeDraft, setScheduleTimeDraft] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [dueTime, setDueTime] = useState('');
    const [dueTimeDraft, setDueTimeDraft] = useState('');
    const [reviewDate, setReviewDate] = useState('');
    const [reviewTime, setReviewTime] = useState('');
    const [reviewTimeDraft, setReviewTimeDraft] = useState('');
    const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());

    const inboxProcessing = settings?.gtd?.inboxProcessing ?? {};
    const defaultProcessingMode = inboxProcessing.defaultMode === 'quick' ? 'quick' : 'guided';
    const twoMinuteEnabled = inboxProcessing.twoMinuteEnabled !== false;
    const twoMinuteFirst = inboxProcessing.twoMinuteFirst === true;
    const projectFirst = inboxProcessing.projectFirst === true;
    const contextStepEnabled = inboxProcessing.contextStepEnabled !== false;
    const scheduleEnabled = inboxProcessing.scheduleEnabled === true;
    const referenceEnabled = inboxProcessing.referenceEnabled === true;
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const hiddenTaskEditorFields = useMemo(
        () => new Set(settings?.gtd?.taskEditor?.hidden ?? DEFAULT_TASK_EDITOR_HIDDEN),
        [settings?.gtd?.taskEditor?.hidden],
    );
    const showEnergyLevelField = !hiddenTaskEditorFields.has('energyLevel');
    const showAssignedToField = !hiddenTaskEditorFields.has('assignedTo');

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const matchesAreaFilter = useCallback(
        (task: Task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById),
        [resolvedAreaFilter, projectMap, areaById],
    );

    const filteredProjects = useMemo(() => {
        if (!projectSearch.trim()) return projects;
        const query = projectSearch.trim().toLowerCase();
        return projects.filter((project) => project.title.toLowerCase().includes(query));
    }, [projects, projectSearch]);

    const hasExactProjectMatch = useMemo(() => {
        if (!projectSearch.trim()) return false;
        const query = projectSearch.trim().toLowerCase();
        return projects.some((project) => project.title.toLowerCase() === query);
    }, [projects, projectSearch]);
    const activeAreas = useMemo(
        () => areas.filter((area) => !area.deletedAt).sort((a, b) => a.order - b.order),
        [areas],
    );

    const inboxCount = useMemo(() => (
        tasks.filter((task) => {
            if (task.status !== 'inbox' || task.deletedAt) return false;
            const start = safeParseDate(task.startTime);
            if (start && start > new Date()) return false;
            if (!matchesAreaFilter(task)) return false;
            return true;
        }).length
    ), [tasks, matchesAreaFilter]);

    const remainingInboxCount = useMemo(
        () => tasks.filter((task) => task.status === 'inbox' && !skippedIds.has(task.id) && matchesAreaFilter(task)).length,
        [tasks, skippedIds, matchesAreaFilter]
    );

    useEffect(() => {
        if (isProcessing) return;
        setProcessingMode(defaultProcessingMode);
        setProcessingTask(null);
        setProcessingStep('actionable');
        setStepHistory([]);
        setQuickActionability('actionable');
        setQuickTwoMinuteChoice('no');
        setQuickExecutionChoice('defer');
        setSelectedContexts([]);
        setSelectedTags([]);
        setSelectedEnergyLevel(undefined);
        setSelectedAssignedTo('');
        setSelectedPriority(undefined);
        setDelegateWho('');
        setDelegateFollowUp('');
        setProjectSearch('');
        setProcessingTitle('');
        setProcessingDescription('');
        setConvertToProject(false);
        setProjectTitleDraft('');
        setNextActionDraft('');
        setCustomContext('');
        setCustomTag('');
        setSelectedProjectId(null);
        setSelectedAreaId(null);
        setScheduleDate('');
        setScheduleTime('');
        setScheduleTimeDraft('');
        setDueDate('');
        setDueTime('');
        setDueTimeDraft('');
        setReviewDate('');
        setReviewTime('');
        setReviewTimeDraft('');
        setSkippedIds(new Set());
    }, [
        contextStepEnabled,
        defaultProcessingMode,
        isProcessing,
        prioritiesEnabled,
        projectFirst,
        referenceEnabled,
        scheduleEnabled,
        twoMinuteEnabled,
        twoMinuteFirst,
    ]);

    const hydrateProcessingTask = useCallback((task: Task) => {
        setProcessingTask(task);
        setProcessingStep('refine');
        setStepHistory([]);
        setQuickActionability('actionable');
        setQuickTwoMinuteChoice('no');
        setQuickExecutionChoice('defer');
        setSelectedContexts(task.contexts ?? []);
        setSelectedTags(task.tags ?? []);
        setSelectedEnergyLevel(task.energyLevel);
        setSelectedAssignedTo(task.assignedTo ?? '');
        setSelectedPriority(task.priority);
        setCustomContext('');
        setCustomTag('');
        setProjectSearch('');
        setProcessingTitle(task.title);
        setProcessingDescription(task.description || '');
        setConvertToProject(false);
        setProjectTitleDraft(task.title);
        setNextActionDraft('');
        setSelectedProjectId(task.projectId ?? null);
        setSelectedAreaId(task.projectId ? null : (task.areaId ?? null));
        const startDraft = getDateFieldDraft(task.startTime);
        setScheduleDate(startDraft.date);
        setScheduleTime(startDraft.time);
        setScheduleTimeDraft(startDraft.timeDraft);
        const dueDraft = getDateFieldDraft(task.dueDate);
        setDueDate(dueDraft.date);
        setDueTime(dueDraft.time);
        setDueTimeDraft(dueDraft.timeDraft);
        const reviewDraft = getDateFieldDraft(task.reviewAt);
        setReviewDate(reviewDraft.date);
        setReviewTime(reviewDraft.time);
        setReviewTimeDraft(reviewDraft.timeDraft);
    }, []);

    const suggestedContexts = useMemo(
        () => mergeSuggestedTokens(
            getRecentTaskTokens(tasks, (task) => task.contexts, 6, { prefix: '@' }),
            getFrequentTaskTokens(tasks, (task) => task.contexts, 6, { prefix: '@' }),
        ).slice(0, 8),
        [tasks],
    );
    const suggestedTags = useMemo(
        () => mergeSuggestedTokens(
            getRecentTaskTokens(tasks, (task) => task.tags, 6, { prefix: '#' }),
            getFrequentTaskTokens(tasks, (task) => task.tags, 6, { prefix: '#' }),
        ).slice(0, 8),
        [tasks],
    );

    const startProcessing = useCallback(() => {
        const inboxTasks = tasks.filter((task) => task.status === 'inbox' && matchesAreaFilter(task));
        if (inboxTasks.length === 0) return;
        hydrateProcessingTask(inboxTasks[0]);
        addBreadcrumb('inbox:start');
        setIsProcessing(true);
    }, [tasks, hydrateProcessingTask, setIsProcessing, matchesAreaFilter]);
    const closeProcessing = useCallback(() => {
        setIsProcessing(false);
    }, [setIsProcessing]);

    const processNext = useCallback(() => {
        const currentTaskId = processingTask?.id;
        const inboxTasks = tasks.filter((task) =>
            task.status === 'inbox'
            && task.id !== currentTaskId
            && !skippedIds.has(task.id)
            && matchesAreaFilter(task)
        );
        if (inboxTasks.length > 0) {
            hydrateProcessingTask(inboxTasks[0]);
            return;
        }
        addBreadcrumb('inbox:done');
        setIsProcessing(false);
        setProcessingTask(null);
        setSelectedContexts([]);
        setSelectedTags([]);
        setSelectedEnergyLevel(undefined);
        setSelectedAssignedTo('');
        setSelectedPriority(undefined);
    }, [hydrateProcessingTask, processingTask?.id, tasks, setIsProcessing, skippedIds, matchesAreaFilter]);

    const handleSkip = useCallback(() => {
        if (processingTask) {
            setSkippedIds((prev) => {
                const next = new Set(prev);
                next.add(processingTask.id);
                return next;
            });
        }
        processNext();
    }, [processNext, processingTask]);

    const buildScheduleUpdates = useCallback(
        () => (scheduleEnabled
            ? {
                startTime: buildDateTimeUpdate(scheduleDate, scheduleTimeDraft, scheduleTime),
                dueDate: buildDateTimeUpdate(dueDate, dueTimeDraft, dueTime),
                reviewAt: buildDateTimeUpdate(reviewDate, reviewTimeDraft, reviewTime),
            }
            : {}),
        [
            dueDate,
            dueTime,
            dueTimeDraft,
            reviewDate,
            reviewTime,
            reviewTimeDraft,
            scheduleDate,
            scheduleEnabled,
            scheduleTime,
            scheduleTimeDraft,
        ]
    );

    const applyProcessingEdits = useCallback((
        updates: Partial<Task>,
        titleInput: string = processingTitle,
        fallbackTitle?: string,
    ) => {
        if (!processingTask) return false;
        const { title: parsedTitle, props: parsedDateProps, invalidDateCommands } = parseQuickAddDateCommands(titleInput, new Date());
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return false;
        }
        const trimmedTitle = parsedTitle.trim();
        const title = trimmedTitle.length > 0 ? trimmedTitle : (fallbackTitle ?? processingTask.title);
        const description = processingDescription.trim();
        void updateTask(processingTask.id, {
            title,
            description: description.length > 0 ? description : undefined,
            ...updates,
            ...parsedDateProps,
        });
        return true;
    }, [processingDescription, processingTask, processingTitle, showToast, t, updateTask]);

    const handleNotActionable = useCallback((action: 'trash' | 'someday' | 'reference') => {
        if (!processingTask) return;
        if (action === 'trash') {
            void deleteTask(processingTask.id);
            processNext();
            return;
        }
        const applied = action === 'someday'
            ? applyProcessingEdits({ status: 'someday' })
            : applyProcessingEdits({ status: 'reference' });
        if (applied) {
            processNext();
        }
    }, [applyProcessingEdits, deleteTask, processNext, processingTask]);

    const goToStep = useCallback((nextStep: ProcessingStep) => {
        setStepHistory((prev) => [...prev, processingStep]);
        setProcessingStep(nextStep);
    }, [processingStep]);

    const goBack = useCallback(() => {
        setStepHistory((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            const last = next.pop();
            if (last) setProcessingStep(last);
            return next;
        });
    }, []);

    const getInitialGuidedStep = useCallback<() => ProcessingStep>(() => (
        twoMinuteEnabled && twoMinuteFirst ? 'twomin' : 'actionable'
    ), [twoMinuteEnabled, twoMinuteFirst]);

    const continueFromProjectCheck = useCallback(() => {
        if (!twoMinuteEnabled) {
            goToStep('decide');
            return;
        }
        goToStep(twoMinuteFirst ? 'decide' : 'twomin');
    }, [goToStep, twoMinuteEnabled, twoMinuteFirst]);

    const handleActionable = useCallback(() => {
        goToStep('projectcheck');
    }, [goToStep]);

    const handleProjectCheckNo = useCallback(() => {
        continueFromProjectCheck();
    }, [continueFromProjectCheck]);

    const handleProjectCheckYes = useCallback(() => {
        const { title: parsedTitle } = parseQuickAddDateCommands(processingTitle, new Date());
        const baseTitle = parsedTitle.trim() || processingTitle.trim() || processingTask?.title || '';
        setConvertToProject(true);
        setProjectTitleDraft(baseTitle);
        setNextActionDraft(baseTitle);
        goToStep('project');
    }, [goToStep, processingTask?.title, processingTitle]);

    const handleTwoMinDone = useCallback(() => {
        if (!processingTask) return;
        if (applyProcessingEdits({ status: 'done' })) {
            processNext();
        }
    }, [applyProcessingEdits, processNext, processingTask]);

    const handleTwoMinNo = useCallback(() => {
        goToStep(twoMinuteFirst ? 'actionable' : 'decide');
    }, [goToStep, twoMinuteFirst]);

    const handleDelegate = useCallback(() => {
        setDelegateWho('');
        setDelegateFollowUp('');
        goToStep('delegate');
    }, [goToStep]);

    const handleConfirmWaiting = useCallback(() => {
        if (!processingTask) return;
        const who = delegateWho.trim();
        const scheduleUpdates = buildScheduleUpdates();
        const followUpIso = delegateFollowUp
            ? new Date(`${delegateFollowUp}T09:00:00`).toISOString()
            : scheduleUpdates.reviewAt;
        const applied = applyProcessingEdits({
            status: 'waiting',
            energyLevel: selectedEnergyLevel ?? undefined,
            assignedTo: who || undefined,
            ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
            ...scheduleUpdates,
            reviewAt: followUpIso,
        });
        if (applied) {
            setDelegateWho('');
            setDelegateFollowUp('');
            processNext();
        }
    }, [
        applyProcessingEdits,
        buildScheduleUpdates,
        delegateFollowUp,
        delegateWho,
        prioritiesEnabled,
        processNext,
        processingTask,
        selectedEnergyLevel,
        selectedPriority,
    ]);

    const handleDelegateBack = useCallback(() => {
        goBack();
    }, [goBack]);

    const handleSendDelegateRequest = useCallback(() => {
        if (!processingTask) return;
        const title = processingTitle.trim() || processingTask.title;
        const baseDescription = processingDescription.trim() || processingTask.description || '';
        const who = delegateWho.trim();
        const greeting = who ? `Hi ${who},` : 'Hi,';
        const bodyParts = [
            greeting,
            '',
            `Could you please handle: ${title}`,
            baseDescription ? `\nDetails:\n${baseDescription}` : '',
            '',
            'Thanks!',
        ];
        const body = bodyParts.join('\n');
        const subject = `Delegation: ${title}`;
        const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(mailto);
    }, [delegateWho, processingDescription, processingTask, processingTitle]);

    const toggleTag = useCallback((tag: string) => {
        setSelectedTags((prev) =>
            prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]
        );
    }, []);

    const toggleContext = useCallback((ctx: string) => {
        if (ctx.startsWith('#')) {
            toggleTag(ctx);
            return;
        }
        setSelectedContexts((prev) =>
            prev.includes(ctx) ? prev.filter((item) => item !== ctx) : [...prev, ctx]
        );
    }, [toggleTag]);

    const addCustomContext = useCallback(() => {
        const trimmed = customContext.trim();
        if (!trimmed) return;
        const raw = trimmed.replace(/^@/, '');
        const ctx = `@${raw.replace(/^@/, '').trim()}`;
        if (ctx.length > 1 && !selectedContexts.includes(ctx)) {
            setSelectedContexts((prev) => [...prev, ctx]);
        }
        setCustomContext('');
    }, [customContext, selectedContexts]);

    const addCustomTag = useCallback(() => {
        const trimmed = customTag.trim();
        if (!trimmed) return;
        const tag = `#${trimmed.replace(/^#+/, '').trim()}`;
        if (tag.length > 1 && !selectedTags.includes(tag)) {
            setSelectedTags((prev) => [...prev, tag]);
        }
        setCustomTag('');
    }, [customTag, selectedTags]);

    const handleProcessingTimeCommit = useCallback((
        draft: string,
        committed: string,
        setDraft: (value: string) => void,
        setTime: (value: string) => void,
    ) => {
        const resolved = resolveCommittedTime(draft, committed);
        setDraft(resolved.timeDraft);
        setTime(resolved.time);
    }, []);

    const handleDateFieldChange = useCallback((
        value: string,
        setDateValue: (value: string) => void,
        setTimeValue: (value: string) => void,
        setTimeDraftValue: (value: string) => void,
    ) => {
        setDateValue(value);
        if (!value) {
            setTimeValue('');
            setTimeDraftValue('');
        }
    }, []);

    const handleScheduleTimeCommit = useCallback(() => {
        handleProcessingTimeCommit(scheduleTimeDraft, scheduleTime, setScheduleTimeDraft, setScheduleTime);
    }, [handleProcessingTimeCommit, scheduleTime, scheduleTimeDraft]);

    const handleDueTimeCommit = useCallback(() => {
        handleProcessingTimeCommit(dueTimeDraft, dueTime, setDueTimeDraft, setDueTime);
    }, [dueTime, dueTimeDraft, handleProcessingTimeCommit]);

    const handleReviewTimeCommit = useCallback(() => {
        handleProcessingTimeCommit(reviewTimeDraft, reviewTime, setReviewTimeDraft, setReviewTime);
    }, [handleProcessingTimeCommit, reviewTime, reviewTimeDraft]);

    const handleScheduleDateChange = useCallback((value: string) => {
        handleDateFieldChange(value, setScheduleDate, setScheduleTime, setScheduleTimeDraft);
    }, [handleDateFieldChange]);

    const handleDueDateChange = useCallback((value: string) => {
        handleDateFieldChange(value, setDueDate, setDueTime, setDueTimeDraft);
    }, [handleDateFieldChange]);

    const handleReviewDateChange = useCallback((value: string) => {
        handleDateFieldChange(value, setReviewDate, setReviewTime, setReviewTimeDraft);
    }, [handleDateFieldChange]);

    const clearScheduleDate = useCallback(() => {
        setScheduleDate('');
        setScheduleTime('');
        setScheduleTimeDraft('');
    }, []);

    const clearDueDate = useCallback(() => {
        setDueDate('');
        setDueTime('');
        setDueTimeDraft('');
    }, []);

    const clearReviewDate = useCallback(() => {
        setReviewDate('');
        setReviewTime('');
        setReviewTimeDraft('');
    }, []);

    const scheduleFields = useMemo<InboxProcessingScheduleFieldsControls>(() => ({
        start: {
            date: scheduleDate,
            timeDraft: scheduleTimeDraft,
            onDateChange: handleScheduleDateChange,
            onTimeDraftChange: setScheduleTimeDraft,
            onTimeCommit: handleScheduleTimeCommit,
            onClear: clearScheduleDate,
        },
        due: {
            date: dueDate,
            timeDraft: dueTimeDraft,
            onDateChange: handleDueDateChange,
            onTimeDraftChange: setDueTimeDraft,
            onTimeCommit: handleDueTimeCommit,
            onClear: clearDueDate,
        },
        review: {
            date: reviewDate,
            timeDraft: reviewTimeDraft,
            onDateChange: handleReviewDateChange,
            onTimeDraftChange: setReviewTimeDraft,
            onTimeCommit: handleReviewTimeCommit,
            onClear: clearReviewDate,
        },
    }), [
        clearDueDate,
        clearReviewDate,
        clearScheduleDate,
        dueDate,
        dueTimeDraft,
        handleDueDateChange,
        handleDueTimeCommit,
        handleReviewDateChange,
        handleReviewTimeCommit,
        handleScheduleDateChange,
        handleScheduleTimeCommit,
        reviewDate,
        reviewTimeDraft,
        scheduleDate,
        scheduleTimeDraft,
    ]);

    const handleSetProject = useCallback((projectId: string | null) => {
        if (!processingTask) return;
        const applied = applyProcessingEdits({
            status: 'next',
            contexts: selectedContexts,
            tags: selectedTags,
            energyLevel: selectedEnergyLevel ?? undefined,
            assignedTo: selectedAssignedTo.trim() || undefined,
            ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
            projectId: projectId || undefined,
            areaId: projectId ? undefined : (selectedAreaId || undefined),
            ...buildScheduleUpdates(),
        });
        if (applied) {
            processNext();
        }
    }, [
        applyProcessingEdits,
        buildScheduleUpdates,
        prioritiesEnabled,
        processNext,
        processingTask,
        selectedAreaId,
        selectedAssignedTo,
        selectedContexts,
        selectedEnergyLevel,
        selectedPriority,
        selectedTags,
    ]);

    const handleConfirmContexts = useCallback(() => {
        if (projectFirst) {
            handleSetProject(selectedProjectId);
            return;
        }
        goToStep('project');
    }, [goToStep, handleSetProject, projectFirst, selectedProjectId]);

    const handleDefer = useCallback(() => {
        if (contextStepEnabled) {
            setSelectedContexts(processingTask?.contexts ?? []);
            setSelectedTags(processingTask?.tags ?? []);
            goToStep('context');
            return;
        }
        if (projectFirst) {
            handleSetProject(selectedProjectId);
            return;
        }
        goToStep('project');
    }, [
        contextStepEnabled,
        goToStep,
        handleSetProject,
        processingTask?.contexts,
        processingTask?.tags,
        projectFirst,
        selectedProjectId,
    ]);

    const handleConvertToProject = useCallback(async () => {
        if (!processingTask) return;
        const projectTitle = projectTitleDraft.trim() || processingTitle.trim();
        const nextAction = nextActionDraft.trim();
        if (!projectTitle) return;
        if (!nextAction) {
            alert(t('process.nextActionRequired'));
            return;
        }
        try {
            const existing = projects.find((project) => project.title.toLowerCase() === projectTitle.toLowerCase());
            const project = existing ?? await addProject(projectTitle, DEFAULT_PROJECT_COLOR);
            if (!project) return;
            const applied = applyProcessingEdits({
                status: 'next',
                contexts: selectedContexts,
                tags: selectedTags,
                energyLevel: selectedEnergyLevel ?? undefined,
                assignedTo: selectedAssignedTo.trim() || undefined,
                ...(prioritiesEnabled ? { priority: selectedPriority ?? undefined } : {}),
                projectId: project.id,
                ...buildScheduleUpdates(),
            }, nextAction, processingTask.title);
            if (applied) {
                processNext();
            }
        } catch (error) {
            reportError('Failed to create project from inbox processing', error);
            showToast(t('projects.createFailed') || 'Failed to create project', 'error');
        }
    }, [
        addProject,
        applyProcessingEdits,
        buildScheduleUpdates,
        nextActionDraft,
        prioritiesEnabled,
        processingTask,
        processingTitle,
        processNext,
        projectTitleDraft,
        projects,
        selectedAssignedTo,
        selectedContexts,
        selectedEnergyLevel,
        selectedPriority,
        selectedTags,
        showToast,
        t,
    ]);

    const handleRefineNext = useCallback(() => {
        goToStep(getInitialGuidedStep());
    }, [getInitialGuidedStep, goToStep]);
    const handleContextsInputChange = useCallback((value: string) => {
        setSelectedContexts(parseTokenListInput(value, '@'));
    }, []);
    const handleTagsInputChange = useCallback((value: string) => {
        setSelectedTags(parseTokenListInput(value, '#'));
    }, []);

    const handleQuickSubmit = useCallback(async () => {
        handleScheduleTimeCommit();
        handleDueTimeCommit();
        handleReviewTimeCommit();
        if (quickActionability !== 'actionable') {
            handleNotActionable(quickActionability);
            return;
        }
        if (quickTwoMinuteChoice === 'yes') {
            handleTwoMinDone();
            return;
        }
        if (quickExecutionChoice === 'delegate') {
            handleConfirmWaiting();
            return;
        }
        if (convertToProject) {
            await handleConvertToProject();
            return;
        }
        handleSetProject(selectedProjectId);
    }, [
        handleConfirmWaiting,
        handleConvertToProject,
        handleDueTimeCommit,
        handleNotActionable,
        handleReviewTimeCommit,
        handleScheduleTimeCommit,
        handleSetProject,
        handleTwoMinDone,
        quickActionability,
        quickExecutionChoice,
        quickTwoMinuteChoice,
        convertToProject,
        prioritiesEnabled,
        selectedPriority,
        selectedProjectId,
    ]);

    if (!isInbox) return null;

    return (
        <>
            {inboxCount > 0 && !isProcessing && (
                <button
                    onClick={startProcessing}
                    className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors"
                >
                    <Play className="w-4 h-4" />
                    {t('process.btn')} ({inboxCount})
                </button>
            )}

            {isProcessing && processingTask && processingMode === 'quick' ? (
                <InboxProcessingQuickPanel
                    t={t}
                    processingTask={processingTask}
                    remainingCount={remainingInboxCount}
                    processingTitle={processingTitle}
                    processingDescription={processingDescription}
                    setProcessingTitle={setProcessingTitle}
                    setProcessingDescription={setProcessingDescription}
                    processingMode={processingMode}
                    onModeChange={setProcessingMode}
                    onSkip={handleSkip}
                    onClose={closeProcessing}
                    showReferenceOption={referenceEnabled}
                    actionabilityChoice={quickActionability}
                    setActionabilityChoice={setQuickActionability}
                    twoMinuteChoice={quickTwoMinuteChoice}
                    setTwoMinuteChoice={setQuickTwoMinuteChoice}
                    executionChoice={quickExecutionChoice}
                    setExecutionChoice={setQuickExecutionChoice}
                    showScheduleFields={scheduleEnabled}
                    scheduleFields={scheduleFields}
                    delegateWho={delegateWho}
                    setDelegateWho={setDelegateWho}
                    delegateFollowUp={delegateFollowUp}
                    setDelegateFollowUp={setDelegateFollowUp}
                    onSendDelegateRequest={handleSendDelegateRequest}
                    selectedContexts={selectedContexts}
                    selectedTags={selectedTags}
                    selectedEnergyLevel={selectedEnergyLevel}
                    setSelectedEnergyLevel={setSelectedEnergyLevel}
                    selectedAssignedTo={selectedAssignedTo}
                    setSelectedAssignedTo={setSelectedAssignedTo}
                    showEnergyLevelField={showEnergyLevelField}
                    showAssignedToField={showAssignedToField}
                    prioritiesEnabled={prioritiesEnabled}
                    selectedPriority={selectedPriority}
                    setSelectedPriority={setSelectedPriority}
                    onContextsInputChange={handleContextsInputChange}
                    onTagsInputChange={handleTagsInputChange}
                    toggleContext={toggleContext}
                    toggleTag={toggleTag}
                    suggestedContexts={suggestedContexts}
                    suggestedTags={suggestedTags}
                    projects={projects}
                    areas={activeAreas}
                    selectedProjectId={selectedProjectId}
                    setSelectedProjectId={setSelectedProjectId}
                    selectedAreaId={selectedAreaId}
                    setSelectedAreaId={setSelectedAreaId}
                    convertToProject={convertToProject}
                    setConvertToProject={setConvertToProject}
                    projectTitleDraft={projectTitleDraft}
                    setProjectTitleDraft={setProjectTitleDraft}
                    nextActionDraft={nextActionDraft}
                    setNextActionDraft={setNextActionDraft}
                    addProject={addProject}
                    onSubmit={handleQuickSubmit}
                />
            ) : (
                <InboxProcessingWizard
                    t={t}
                    isProcessing={isProcessing}
                    processingTask={processingTask}
                    processingMode={processingMode}
                    onModeChange={setProcessingMode}
                    processingStep={processingStep}
                    processingTitle={processingTitle}
                    processingDescription={processingDescription}
                    setProcessingTitle={setProcessingTitle}
                    setProcessingDescription={setProcessingDescription}
                    setIsProcessing={setIsProcessing}
                    canGoBack={stepHistory.length > 0}
                    onBack={goBack}
                    handleRefineNext={handleRefineNext}
                    handleSkip={handleSkip}
                    handleNotActionable={handleNotActionable}
                    handleActionable={handleActionable}
                    showDoneNowShortcut={twoMinuteEnabled && !twoMinuteFirst}
                    showReferenceOption={referenceEnabled}
                    handleProjectCheckNo={handleProjectCheckNo}
                    handleProjectCheckYes={handleProjectCheckYes}
                    handleTwoMinDone={handleTwoMinDone}
                    handleTwoMinNo={handleTwoMinNo}
                    handleDefer={handleDefer}
                    handleDelegate={handleDelegate}
                    delegateWho={delegateWho}
                    setDelegateWho={setDelegateWho}
                    delegateFollowUp={delegateFollowUp}
                    setDelegateFollowUp={setDelegateFollowUp}
                    handleDelegateBack={handleDelegateBack}
                    handleSendDelegateRequest={handleSendDelegateRequest}
                    handleConfirmWaiting={handleConfirmWaiting}
                    selectedContexts={selectedContexts}
                    selectedTags={selectedTags}
                    selectedEnergyLevel={selectedEnergyLevel}
                    setSelectedEnergyLevel={setSelectedEnergyLevel}
                    selectedAssignedTo={selectedAssignedTo}
                    setSelectedAssignedTo={setSelectedAssignedTo}
                    showEnergyLevelField={showEnergyLevelField}
                    showAssignedToField={showAssignedToField}
                    prioritiesEnabled={prioritiesEnabled}
                    selectedPriority={selectedPriority}
                    setSelectedPriority={setSelectedPriority}
                    allContexts={allContexts}
                    customContext={customContext}
                    setCustomContext={setCustomContext}
                    addCustomContext={addCustomContext}
                    customTag={customTag}
                    setCustomTag={setCustomTag}
                    addCustomTag={addCustomTag}
                    toggleContext={toggleContext}
                    toggleTag={toggleTag}
                    suggestedContexts={suggestedContexts}
                    suggestedTags={suggestedTags}
                    handleConfirmContexts={handleConfirmContexts}
                    convertToProject={convertToProject}
                    setConvertToProject={setConvertToProject}
                    setProjectTitleDraft={setProjectTitleDraft}
                    setNextActionDraft={setNextActionDraft}
                    projectTitleDraft={projectTitleDraft}
                    nextActionDraft={nextActionDraft}
                    handleConvertToProject={handleConvertToProject}
                    projectSearch={projectSearch}
                    setProjectSearch={setProjectSearch}
                    projects={projects}
                    areas={activeAreas}
                    filteredProjects={filteredProjects}
                    addProject={addProject}
                    handleSetProject={handleSetProject}
                    hasExactProjectMatch={hasExactProjectMatch}
                    areaById={areaById}
                    remainingCount={remainingInboxCount}
                    showProjectInRefine={projectFirst}
                    selectedProjectId={selectedProjectId}
                    setSelectedProjectId={setSelectedProjectId}
                    selectedAreaId={selectedAreaId}
                    setSelectedAreaId={setSelectedAreaId}
                    showScheduleFields={scheduleEnabled}
                    scheduleFields={scheduleFields}
                />
            )}
        </>
    );
}
