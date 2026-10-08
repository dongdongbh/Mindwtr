import { useCallback, useEffect, useState } from 'react';
import {
    ArrowRight,
    BookOpen,
    CalendarDays,
    CheckSquare2,
    Clock3,
    ExternalLink,
    FileText,
    FolderKanban,
    Loader2,
    Plus,
    RefreshCw,
    Settings,
    Square,
    Tags,
} from 'lucide-react';

import { DEFAULT_TASKNOTES_FOLDER, safeFormatDate, translateWithFallback, useTaskStore, type ObsidianTask, type Task } from '@mindwtr/core';

import { ObsidianService } from '../../lib/obsidian-service';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { cn } from '../../lib/utils';
import { LIST_END_GAP } from './list/list-toolbar';
import { useLanguage } from '../../contexts/language-context';
import { useObsidianStore } from '../../store/obsidian-store';
import { useUiStore } from '../../store/ui-store';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';

const navigateToSettings = () => {
    dispatchNavigateEvent('settings');
};

const pageShellClassName = 'h-full px-4 pt-3';
const pageContentClassName = 'mx-auto w-full max-w-[84rem] min-w-0 2xl:max-w-[88rem]';
const MAX_TASKNOTES_DETECTED_PATHS = 6;
const OBSIDIAN_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:obsidian:v1';

type ObsidianPersistedViewState = {
    showCompleted: boolean;
};

const DEFAULT_OBSIDIAN_VIEW_STATE: ObsidianPersistedViewState = {
    showCompleted: false,
};

function sanitizeObsidianViewState(value: unknown, fallback: ObsidianPersistedViewState): ObsidianPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<ObsidianPersistedViewState>
        : {};
    return {
        showCompleted: typeof parsed.showCompleted === 'boolean'
            ? parsed.showCompleted
            : fallback.showCompleted,
    };
}

const resolveTaskNotesCreationFolder = (tasks: ObsidianTask[]): string => {
    const folders = tasks
        .filter((task) => task.format === 'tasknotes')
        .map((task) => {
            const parts = task.source.relativeFilePath.split('/');
            parts.pop();
            return parts.join('/');
        })
        .filter(Boolean);
    if (folders.length === 0) {
        return DEFAULT_TASKNOTES_FOLDER;
    }

    const counts = new Map<string, number>();
    for (const folder of folders) {
        counts.set(folder, (counts.get(folder) || 0) + 1);
    }

    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
        || DEFAULT_TASKNOTES_FOLDER;
};

const formatTaskNotesDate = (value: string | null | undefined): string | null => {
    if (!value) return null;
    return safeFormatDate(value, value.includes('T') ? 'PPp' : 'PP', value);
};


const uniqueNonEmptyStrings = (items: Array<string | null | undefined>): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const trimmed = item?.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
};

const normalizeImportedContext = (value: string): string | null => {
    const trimmed = value.trim().replace(/^@+/, '');
    return trimmed ? `@${trimmed}` : null;
};

const normalizeObsidianIdentityText = (value: string): string => (
    value.trim().replace(/\s+/g, ' ').toLowerCase()
);

type ObsidianSourceAttachmentIdentity = {
    id: string;
    stablePrefix: string;
};

const buildObsidianSourceAttachmentIdentity = (
    task: ObsidianTask,
    scannedTasks: ObsidianTask[],
): ObsidianSourceAttachmentIdentity => {
    const normalizedText = normalizeObsidianIdentityText(task.text);
    const matchingTasks = scannedTasks
        .filter((candidate) => (
            candidate.source.vaultName === task.source.vaultName
            && candidate.source.relativeFilePath === task.source.relativeFilePath
            && candidate.format === task.format
            && normalizeObsidianIdentityText(candidate.text) === normalizedText
        ))
        .sort((left, right) => (
            left.source.lineNumber - right.source.lineNumber || left.id.localeCompare(right.id)
        ));
    const occurrence = Math.max(0, matchingTasks.findIndex((candidate) => candidate.id === task.id));
    const fingerprint = [
        encodeURIComponent(task.source.vaultName),
        encodeURIComponent(task.source.relativeFilePath),
        task.format,
        encodeURIComponent(normalizedText),
        String(occurrence),
    ].join(':');
    const stablePrefix = `obsidian-source:v2:${fingerprint}`;
    return {
        id: `${stablePrefix}:${task.id}`,
        stablePrefix,
    };
};

const buildMindwtrTaskInitialProps = (
    task: ObsidianTask,
    sourceUri: string,
    sourceTitle: string,
    sourceAttachmentId: string,
): Partial<Task> => {
    const metadata = task.taskNotesData ?? task.dataviewData;
    const now = new Date().toISOString();
    const status = task.completed ? 'done' : (task.taskNotesData?.mindwtrStatus ?? 'inbox');
    const attachment = {
        id: sourceAttachmentId,
        kind: 'link' as const,
        title: sourceTitle,
        uri: sourceUri,
        createdAt: now,
        updatedAt: now,
    };

    return {
        status,
        priority: metadata?.priority ?? undefined,
        dueDate: metadata?.dueDate ?? undefined,
        startTime: metadata?.scheduledDate ?? undefined,
        completedAt: task.completed ? (task.taskNotesData?.completedDate ?? now) : undefined,
        contexts: uniqueNonEmptyStrings((metadata?.contexts ?? []).map(normalizeImportedContext)),
        tags: uniqueNonEmptyStrings([...task.tags, ...(task.dataviewData?.tags ?? [])]),
        attachments: [attachment],
    };
};

const hasObsidianSourceAttachment = (
    task: Task,
    sourceIdentity: ObsidianSourceAttachmentIdentity,
    sourceUri: string,
    sourceTaskText: string,
): boolean => {
    if (task.deletedAt) return false;
    const normalizedSourceText = normalizeObsidianIdentityText(sourceTaskText);
    const isLegacyTitleMatch = normalizeObsidianIdentityText(task.title) === normalizedSourceText;
    return task.attachments?.some((attachment) => (
        !attachment.deletedAt
        && attachment.kind === 'link'
        && (
            attachment.id === sourceIdentity.id
            || attachment.id.startsWith(`${sourceIdentity.stablePrefix}:`)
            || (
                isLegacyTitleMatch
                && !attachment.id.startsWith('obsidian-source:')
                && attachment.uri === sourceUri
            )
        )
    )) === true;
};

export function ObsidianView() {
    const { t } = useLanguage();
    const showToast = useUiStore((state) => state.showToast);
    const addTask = useTaskStore((state) => state.addTask);
    const mindwtrTasks = useTaskStore((state) => state._allTasks);
    const config = useObsidianStore((state) => state.config);
    const tasks = useObsidianStore((state) => state.tasks);
    const scannedFileCount = useObsidianStore((state) => state.scannedFileCount);
    const taskNotesDetectedPaths = useObsidianStore((state) => state.taskNotesDetectedPaths);
    const importMode = useObsidianStore((state) => state.importMode);
    const hasScannedThisSession = useObsidianStore((state) => state.hasScannedThisSession);
    const isInitialized = useObsidianStore((state) => state.isInitialized);
    const isLoadingConfig = useObsidianStore((state) => state.isLoadingConfig);
    const isScanning = useObsidianStore((state) => state.isScanning);
    const isWatching = useObsidianStore((state) => state.isWatching);
    const error = useObsidianStore((state) => state.error);
    const watcherError = useObsidianStore((state) => state.watcherError);
    const loadConfig = useObsidianStore((state) => state.loadConfig);
    const rescan = useObsidianStore((state) => state.rescan);
    const clearError = useObsidianStore((state) => state.clearError);
    const [newTaskText, setNewTaskText] = useState('');
    const [isCreatingTask, setIsCreatingTask] = useState(false);
    const [pendingTaskIds, setPendingTaskIds] = useState<Record<string, true>>({});
    const [pendingMindwtrTaskIds, setPendingMindwtrTaskIds] = useState<Record<string, true>>({});
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        OBSIDIAN_VIEW_STATE_STORAGE_KEY,
        DEFAULT_OBSIDIAN_VIEW_STATE,
        sanitizeObsidianViewState
    );
    const showCompleted = persistedViewState.showCompleted;
    const setShowCompleted = useCallback((value: boolean | ((current: boolean) => boolean)) => {
        setPersistedViewState((current) => ({
            ...current,
            showCompleted: typeof value === 'function' ? value(current.showCompleted) : value,
        }));
    }, [setPersistedViewState]);

    const effectiveNewTaskFormat = config.newTaskFormat === 'auto' ? importMode : config.newTaskFormat;
    const taskNotesCreationFolder = resolveTaskNotesCreationFolder(tasks);
    const visibleTasks = showCompleted ? tasks : tasks.filter((task) => !task.completed);
    const visibleTaskNotesDetectedPaths = taskNotesDetectedPaths.slice(0, MAX_TASKNOTES_DETECTED_PATHS);
    const hiddenTaskNotesDetectedCount = Math.max(0, taskNotesDetectedPaths.length - visibleTaskNotesDetectedPaths.length);
    const hiddenCompletedCount = Math.max(0, tasks.length - visibleTasks.length);

    const resolveText = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);

    useEffect(() => {
        if (isInitialized) return;
        loadConfig().catch((scanError) => {
            showToast(String(scanError), 'error');
        });
    }, [isInitialized, loadConfig, showToast]);

    useEffect(() => {
        if (!isInitialized || isLoadingConfig || isScanning) return;
        if (!config.enabled || !config.vaultPath || hasScannedThisSession) return;
        rescan().catch((scanError) => {
            showToast(String(scanError), 'error');
        });
    }, [
        config.enabled,
        config.vaultPath,
        hasScannedThisSession,
        isInitialized,
        isLoadingConfig,
        isScanning,
        rescan,
        showToast,
    ]);

    useEffect(() => {
        if (!error) return;
        showToast(error, 'error', 5000);
        clearError();
    }, [clearError, error, showToast]);

    const handleRescan = useCallback(async () => {
        await rescan();
        const { error: nextError, warnings } = useObsidianStore.getState();
        if (nextError) {
            showToast(nextError, 'error', 5000);
            clearError();
            return;
        }
        if (warnings.length > 0) {
            showToast(warnings[0], 'info', 6000);
            return;
        }
        showToast(resolveText('obsidian.scanSuccess', 'Obsidian vault scanned.'), 'success');
    }, [clearError, resolveText, rescan, showToast]);

    const handleOpenTask = useCallback(async (taskSource: Parameters<typeof ObsidianService.openTaskInObsidian>[0]) => {
        try {
            await ObsidianService.openTaskInObsidian(taskSource);
        } catch (openError) {
            showToast(
                openError instanceof Error && openError.message.trim()
                    ? openError.message
                    : resolveText('obsidian.openFailed', 'Failed to open note in Obsidian.'),
                'error',
                5000
            );
        }
    }, [resolveText, showToast]);


    const handleBringIntoMindwtr = useCallback(async (task: typeof tasks[number]) => {
        const sourceUri = ObsidianService.buildObsidianUri(task.source);
        const sourceIdentity = buildObsidianSourceAttachmentIdentity(task, tasks);
        if (mindwtrTasks.some((existingTask) => hasObsidianSourceAttachment(
            existingTask,
            sourceIdentity,
            sourceUri,
            task.text,
        ))) {
            showToast(resolveText('obsidian.bringIntoMindwtrAlreadyExists', 'Task already exists in Mindwtr.'), 'info');
            return;
        }
        setPendingMindwtrTaskIds((current) => ({ ...current, [task.id]: true }));
        try {
            const result = await addTask(
                task.text,
                buildMindwtrTaskInitialProps(
                    task,
                    sourceUri,
                    resolveText('obsidian.sourceAttachmentTitle', 'Obsidian source'),
                    sourceIdentity.id,
                )
            );
            if (!result.success) {
                throw new Error(result.error || resolveText('obsidian.bringIntoMindwtrFailed', 'Could not add the task to Mindwtr.'));
            }
            showToast(resolveText('obsidian.bringIntoMindwtrSuccess', 'Task added to Mindwtr.'), 'success');
        } catch (bringError) {
            showToast(
                bringError instanceof Error && bringError.message.trim()
                    ? bringError.message
                    : resolveText('obsidian.bringIntoMindwtrFailed', 'Could not add the task to Mindwtr.'),
                'error',
                5000
            );
        } finally {
            setPendingMindwtrTaskIds((current) => {
                const next = { ...current };
                delete next[task.id];
                return next;
            });
        }
    }, [addTask, mindwtrTasks, resolveText, showToast, tasks]);

    const handleToggleTask = useCallback(async (task: typeof tasks[number]) => {
        if (!config.vaultPath) return;
        setPendingTaskIds((current) => ({ ...current, [task.id]: true }));
        try {
            if (task.format === 'tasknotes') {
                await ObsidianService.toggleTaskNotesTask({
                    vaultPath: config.vaultPath,
                    relativeFilePath: task.source.relativeFilePath,
                    setCompleted: !task.completed,
                });
            } else {
                await ObsidianService.toggleTask({
                    vaultPath: config.vaultPath,
                    relativeFilePath: task.source.relativeFilePath,
                    lineNumber: task.source.lineNumber,
                    taskText: task.text,
                    setCompleted: !task.completed,
                });
            }
            if (!isWatching) {
                await rescan();
            }
        } catch (toggleError) {
            showToast(
                toggleError instanceof Error && toggleError.message.trim()
                    ? toggleError.message
                    : resolveText('obsidian.toggleFailed', 'Could not update the task in Obsidian. Try rescanning the vault.'),
                'error',
                5000
            );
        } finally {
            setPendingTaskIds((current) => {
                const next = { ...current };
                delete next[task.id];
                return next;
            });
        }
    }, [config.vaultPath, isWatching, rescan, resolveText, showToast]);

    const handleCreateTask = useCallback(async () => {
        const trimmed = newTaskText.trim();
        if (!trimmed || !config.vaultPath) return;
        setIsCreatingTask(true);
        try {
            if (effectiveNewTaskFormat === 'tasknotes') {
                await ObsidianService.createTaskNotesTask({
                    vaultPath: config.vaultPath,
                    folder: taskNotesCreationFolder,
                    title: trimmed,
                });
            } else {
                await ObsidianService.createTask({
                    vaultPath: config.vaultPath,
                    relativeFilePath: config.inboxFile,
                    taskText: trimmed,
                    requiredInlineTag: config.requiredInlineTag,
                });
            }
            setNewTaskText('');
            if (!isWatching) {
                await rescan();
            }
        } catch (createError) {
            showToast(
                createError instanceof Error && createError.message.trim()
                    ? createError.message
                    : resolveText('obsidian.createFailed', 'Could not create the task in Obsidian.'),
                'error',
                5000
            );
        } finally {
            setIsCreatingTask(false);
        }
    }, [
        config.inboxFile,
        config.requiredInlineTag,
        config.vaultPath,
        effectiveNewTaskFormat,
        isWatching,
        newTaskText,
        rescan,
        resolveText,
        showToast,
        taskNotesCreationFolder,
    ]);

    if (!isInitialized || isLoadingConfig) {
        return (
            <div className={pageShellClassName}>
                <div className={cn(pageContentClassName, 'rounded-2xl border border-border bg-card p-8 text-sm text-muted-foreground')}>
                    {resolveText('common.loading', 'Loading...')}
                </div>
            </div>
        );
    }

    const hasVault = Boolean(config.vaultPath);
    const canScan = Boolean(config.vaultPath && config.enabled);
    const hasCompletedScan = hasScannedThisSession || Boolean(config.lastScannedAt);

    return (
        <div className={pageShellClassName}>
            <div className={cn(pageContentClassName, 'space-y-6', LIST_END_GAP)} data-list-end>
                <section className="rounded-3xl border border-border bg-card/95 p-8 shadow-sm">
                    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-3">
                            <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
                                <BookOpen className="h-3.5 w-3.5" />
                                {resolveText('nav.obsidian', 'Obsidian')}
                            </div>
                            <div className="space-y-2">
                                <h1 className="text-3xl font-semibold tracking-tight">
                                    {resolveText('obsidian.title', 'Obsidian Tasks')}
                                </h1>
                                <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                                    {resolveText(
                                        'obsidian.description',
                                        'Import tasks from your Obsidian vault, keep the source note visible, and bring real commitments into Mindwtr when needed.'
                                    )}
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                                <span className="rounded-full bg-muted px-3 py-1.5">
                                    {resolveText('obsidian.notesCount', 'Notes scanned')}: {scannedFileCount}
                                </span>
                                <span className="rounded-full bg-muted px-3 py-1.5">
                                    {resolveText('obsidian.tasksCount', 'Imported tasks')}: {visibleTasks.length}
                                </span>
                                {!showCompleted && hiddenCompletedCount > 0 && (
                                    <span className="rounded-full bg-muted px-3 py-1.5">
                                        {resolveText('obsidian.completedHidden', 'Completed hidden')}: {hiddenCompletedCount}
                                    </span>
                                )}
                                <span className="rounded-full bg-muted px-3 py-1.5">
                                    {resolveText('obsidian.lastScanned', 'Last scanned')}:{' '}
                                    {config.lastScannedAt
                                        ? safeFormatDate(config.lastScannedAt, 'PPpp', config.lastScannedAt)
                                        : resolveText('obsidian.neverScanned', 'Never')}
                                </span>
                                {canScan && (
                                    <span
                                        className={cn(
                                            'rounded-full px-3 py-1.5',
                                            watcherError
                                                ? 'bg-warning/15 text-warning'
                                                : isWatching
                                                    ? 'bg-success/15 text-success'
                                                    : 'bg-muted'
                                        )}
                                    >
                                        {watcherError
                                            ? resolveText('obsidian.liveUpdatesUnavailable', 'Live updates unavailable')
                                            : isWatching
                                                ? resolveText('obsidian.watching', 'Watching for changes')
                                                : resolveText('obsidian.manualRefreshOnly', 'Manual refresh only')}
                                    </span>
                                )}
                            </div>
                            {hasVault && (
                                <p className="text-xs text-muted-foreground">
                                    {resolveText('obsidian.vaultPath', 'Vault')}: <span className="font-mono">{config.vaultPath}</span>
                                </p>
                            )}
                            {watcherError && (
                                <p className="text-xs text-warning">{watcherError}</p>
                            )}
                        </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={navigateToSettings}
                            className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                        >
                            <Settings className="h-4 w-4" />
                            {resolveText('nav.settings', 'Settings')}
                        </button>
                        <button
                            type="button"
                            onClick={handleRescan}
                            disabled={!canScan || isScanning}
                            className={cn(
                                'inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors',
                                canScan && !isScanning
                                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                                    : 'bg-muted text-muted-foreground'
                            )}
                        >
                            <RefreshCw className={cn('h-4 w-4', isScanning && 'animate-spin')} />
                            {isScanning
                                ? resolveText('obsidian.rescanning', 'Scanning...')
                                : resolveText('obsidian.rescan', 'Rescan vault')}
                        </button>
                        {tasks.length > 0 && (
                            <button
                                type="button"
                                aria-label={showCompleted
                                    ? resolveText('obsidian.hideCompleted', 'Hide completed')
                                    : resolveText('obsidian.showCompleted', 'Show completed')}
                                aria-pressed={showCompleted}
                                onClick={() => setShowCompleted((current) => !current)}
                                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                            >
                                {showCompleted
                                    ? resolveText('obsidian.hideCompleted', 'Hide completed')
                                    : resolveText('obsidian.showCompleted', 'Show completed')}
                                {!showCompleted && hiddenCompletedCount > 0 && (
                                    <span aria-hidden="true" className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                        {hiddenCompletedCount}
                                    </span>
                                )}
                            </button>
                        )}
                    </div>
                    </div>
                </section>

                {canScan && (
                    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                            <div className="min-w-0 flex-1">
                                <label htmlFor="obsidian-add-task" className="text-sm font-medium">
                                    {resolveText('obsidian.addTask', 'Add task to Obsidian')}
                                </label>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {effectiveNewTaskFormat === 'tasknotes'
                                        ? (
                                            <>
                                                {resolveText('obsidian.addTaskNotesHint', 'Creates a new TaskNotes file in')}{' '}
                                                <span className="font-mono">{taskNotesCreationFolder}</span>
                                            </>
                                        )
                                        : (
                                            <>
                                                {resolveText('obsidian.addTaskHint', 'Writes to')}{' '}
                                                <span className="font-mono">{config.inboxFile}</span>
                                            </>
                                        )}
                                </p>
                            </div>
                            <div className="flex flex-1 flex-col gap-2 sm:flex-row">
                                <input
                                    id="obsidian-add-task"
                                    type="text"
                                    value={newTaskText}
                                    onChange={(event) => setNewTaskText(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            void handleCreateTask();
                                        }
                                    }}
                                    placeholder={effectiveNewTaskFormat === 'tasknotes'
                                        ? resolveText('obsidian.addTaskNotesPlaceholder', 'Create a new TaskNotes task...')
                                        : resolveText('obsidian.addTaskPlaceholder', 'Capture a task into your Obsidian inbox note...')}
                                    className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                                <button
                                    type="button"
                                    onClick={handleCreateTask}
                                    disabled={isCreatingTask || !newTaskText.trim()}
                                    className={cn(
                                        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors',
                                        !isCreatingTask && newTaskText.trim()
                                            ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                                            : 'bg-muted text-muted-foreground'
                                    )}
                                >
                                    {isCreatingTask ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                                    {isCreatingTask
                                        ? resolveText('common.saving', 'Saving...')
                                        : resolveText('obsidian.addTaskAction', 'Add task')}
                                </button>
                            </div>
                        </div>
                    </section>
                )}

                {canScan && importMode === 'tasknotes' && taskNotesDetectedPaths.length > 0 && (
                    <section className="rounded-2xl border border-info/25 bg-info/5 p-5 shadow-sm">
                        <div className="space-y-3">
                            <div>
                                <h2 className="text-sm font-semibold text-foreground">
                                    {resolveText('obsidian.taskNotesDetectedTitle', 'TaskNotes mode is active')}
                                </h2>
                                <p className="mt-1 text-sm text-foreground/85">
                                    {resolveText(
                                        'obsidian.taskNotesDetectedBody',
                                        'Mindwtr detected TaskNotes-style frontmatter in these files, so inline checklist tasks from other notes are ignored.'
                                    )}
                                </p>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {resolveText(
                                        'obsidian.taskNotesDetectedHint',
                                        'Look for a status field plus TaskNotes metadata like tags: [task], due, scheduled, contexts, projects, timeEstimate, recurrence, or completedDate.'
                                    )}
                                </p>
                            </div>
                            <div className="space-y-2">
                                {visibleTaskNotesDetectedPaths.map((path) => (
                                    <div
                                        key={path}
                                        className="rounded-xl border border-info/25 bg-background/70 px-3 py-2 text-sm text-foreground"
                                    >
                                        <span className="font-mono">{path}</span>
                                    </div>
                                ))}
                                {hiddenTaskNotesDetectedCount > 0 && (
                                    <p className="text-xs text-muted-foreground">
                                        +{hiddenTaskNotesDetectedCount} {resolveText('obsidian.taskNotesDetectedMore', 'more matching files')}
                                    </p>
                                )}
                            </div>
                        </div>
                    </section>
                )}

                {!hasVault && (
                    <section className="rounded-2xl border border-dashed border-border bg-card p-8">
                        <h2 className="text-lg font-semibold">{resolveText('obsidian.setupTitle', 'Set up an Obsidian vault')}</h2>
                        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                            {resolveText(
                                'obsidian.setupBody',
                                'Choose your vault folder in Settings -> Integrations -> Obsidian Vault, then enable the integration and rescan.'
                            )}
                        </p>
                        <button
                            type="button"
                            onClick={navigateToSettings}
                            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                        >
                            <Settings className="h-4 w-4" />
                            {resolveText('obsidian.openSettings', 'Open settings')}
                        </button>
                    </section>
                )}

                {hasVault && !config.enabled && (
                    <section className="rounded-2xl border border-border bg-card p-8">
                        <h2 className="text-lg font-semibold">{resolveText('obsidian.disabledTitle', 'Enable the integration')}</h2>
                        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                            {resolveText(
                                'obsidian.disabledBody',
                                'A vault is configured, but the integration is turned off. Enable it in Settings before scanning.'
                            )}
                        </p>
                    </section>
                )}

                {canScan && visibleTasks.length === 0 && tasks.length > 0 && hiddenCompletedCount > 0 && hasCompletedScan && !isScanning && (
                    <section className="rounded-2xl border border-border bg-card p-8">
                        <h2 className="text-lg font-semibold">
                            {resolveText('obsidian.completedOnlyTitle', 'Only completed tasks are hidden')}
                        </h2>
                        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                            {resolveText(
                                'obsidian.completedOnlyBody',
                                'This vault only has completed imported tasks right now. Turn on Show completed to inspect or reopen them.'
                            )}
                        </p>
                    </section>
                )}

                {canScan && tasks.length === 0 && hasCompletedScan && !isScanning && (
                    <section className="rounded-2xl border border-border bg-card p-8">
                        <h2 className="text-lg font-semibold">{resolveText('obsidian.emptyTitle', 'No tasks found')}</h2>
                        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                            {resolveText(
                                'obsidian.emptyBody',
                                'Mindwtr scanned the configured folders but did not find any Markdown checklist items yet.'
                            )}
                        </p>
                    </section>
                )}

                {visibleTasks.length > 0 && (
                    <section className="space-y-3">
                        {visibleTasks.map((task) => {
                            const isPending = Boolean(pendingTaskIds[task.id]);
                            const isBringingIntoMindwtr = Boolean(pendingMindwtrTaskIds[task.id]);
                            const taskNotesData = task.taskNotesData;
                            const dataviewData = task.dataviewData;
                            const metadata = taskNotesData ?? dataviewData;
                            const dueLabel = formatTaskNotesDate(metadata?.dueDate);
                            const scheduledLabel = formatTaskNotesDate(metadata?.scheduledDate);
                            const completedLabel = formatTaskNotesDate(taskNotesData?.completedDate);
                            return (
                                <article
                                    key={task.id}
                                    className="rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/30"
                                >
                                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                        <div className="min-w-0 space-y-3">
                                            <div className="flex items-start gap-3">
                                                {isPending ? (
                                                    <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
                                                ) : task.completed ? (
                                                    <CheckSquare2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                                                ) : (
                                                    <Square className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                                                )}
                                                <div className="min-w-0">
                                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                                        <span
                                                            className={cn(
                                                                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                                                                task.format === 'tasknotes'
                                                                    ? 'border-info/30 bg-info/10 text-info'
                                                                    : 'border-border/70 bg-background text-muted-foreground'
                                                            )}
                                                        >
                                                            {task.format === 'tasknotes' ? <FileText className="h-3 w-3" /> : <CheckSquare2 className="h-3 w-3" />}
                                                            {task.format === 'tasknotes'
                                                                ? resolveText('obsidian.taskNotesBadge', 'TaskNotes')
                                                                : resolveText('obsidian.inlineBadge', 'Inline')}
                                                        </span>
                                                        {taskNotesData?.mindwtrStatus && (
                                                            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                                                {taskNotesData.mindwtrStatus}
                                                            </span>
                                                        )}
                                                        {dataviewData && (
                                                            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                                                {resolveText('obsidian.dataviewBadge', 'Dataview')}
                                                            </span>
                                                        )}
                                                        {metadata?.priority && (
                                                            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                                                                {metadata.priority}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className={cn(
                                                        'text-sm leading-6 text-foreground',
                                                        task.completed && 'text-muted-foreground line-through'
                                                    )}>
                                                        {task.text}
                                                    </p>
                                                    <p className="mt-2 text-xs text-muted-foreground">
                                                        {task.format === 'tasknotes'
                                                            ? task.source.relativeFilePath
                                                            : `${task.source.relativeFilePath}:${task.source.lineNumber}`}
                                                    </p>
                                                    {metadata && (
                                                        <div className="mt-3 space-y-2">
                                                            {(dueLabel || scheduledLabel || completedLabel || metadata.timeEstimateMinutes) && (
                                                                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                                                                    {dueLabel && (
                                                                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1">
                                                                            <CalendarDays className="h-3 w-3" />
                                                                            {resolveText('obsidian.due', 'Due')}: {dueLabel}
                                                                        </span>
                                                                    )}
                                                                    {scheduledLabel && (
                                                                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1">
                                                                            <CalendarDays className="h-3 w-3" />
                                                                            {resolveText('obsidian.scheduled', 'Scheduled')}: {scheduledLabel}
                                                                        </span>
                                                                    )}
                                                                    {completedLabel && task.completed && (
                                                                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1">
                                                                            <CalendarDays className="h-3 w-3" />
                                                                            {resolveText('obsidian.completed', 'Completed')}: {completedLabel}
                                                                        </span>
                                                                    )}
                                                                    {metadata.timeEstimateMinutes && (
                                                                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1">
                                                                            <Clock3 className="h-3 w-3" />
                                                                            {metadata.timeEstimateMinutes}m
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            )}
                                                            {(metadata.contexts.length > 0 || metadata.projects.length > 0) && (
                                                                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                                                                    {metadata.contexts.map((context) => (
                                                                        <span
                                                                            key={`${task.id}-context-${context}`}
                                                                            className="rounded-full border border-border/70 bg-background px-2.5 py-1"
                                                                        >
                                                                            @{context}
                                                                        </span>
                                                                    ))}
                                                                    {metadata.projects.map((project) => (
                                                                        <span
                                                                            key={`${task.id}-project-${project}`}
                                                                            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-1"
                                                                        >
                                                                            <FolderKanban className="h-3 w-3" />
                                                                            {project}
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            )}
                                                            {taskNotesData?.bodyPreview && (
                                                                <p className="text-xs leading-5 text-muted-foreground">
                                                                    {taskNotesData.bodyPreview}
                                                                </p>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            {(task.tags.length > 0 || task.wikiLinks.length > 0) && (
                                                <div className="flex flex-wrap gap-2 pl-8">
                                                    {task.tags.map((tag) => (
                                                        <span
                                                            key={`${task.id}-tag-${tag}`}
                                                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                                                        >
                                                            <Tags className="h-3 w-3" />#{tag}
                                                        </span>
                                                    ))}
                                                    {task.wikiLinks.map((link) => (
                                                        <span
                                                            key={`${task.id}-link-${link}`}
                                                            className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground"
                                                        >
                                                            [[{link}]]
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap items-center justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void handleBringIntoMindwtr(task)}
                                                disabled={isBringingIntoMindwtr}
                                                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                                {isBringingIntoMindwtr ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <ArrowRight className="h-4 w-4" />
                                                )}
                                                {isBringingIntoMindwtr
                                                    ? resolveText('common.saving', 'Saving...')
                                                    : resolveText('obsidian.bringIntoMindwtr', 'Bring into Mindwtr')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleToggleTask(task)}
                                                disabled={isPending}
                                                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                                {isPending ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : task.completed ? (
                                                    <Square className="h-4 w-4" />
                                                ) : (
                                                    <CheckSquare2 className="h-4 w-4" />
                                                )}
                                                {isPending
                                                    ? resolveText('common.saving', 'Saving...')
                                                    : task.completed
                                                        ? resolveText('obsidian.markIncomplete', 'Mark incomplete')
                                                        : resolveText('obsidian.markComplete', 'Mark complete')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleOpenTask(task.source)}
                                                className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
                                            >
                                                <ExternalLink className="h-4 w-4" />
                                                {resolveText('obsidian.openTask', 'Open in Obsidian')}
                                            </button>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                    </section>
                )}
            </div>
        </div>
    );
}
