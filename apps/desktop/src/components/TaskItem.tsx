import { useMemo, useState, memo, useEffect } from 'react';

import { Calendar as CalendarIcon, Tag, Trash2, ArrowRight, Repeat, Check, Plus, Clock, Timer, Paperclip, Link2, Pencil } from 'lucide-react';
import {
    useTaskStore,
    Attachment,
    Task,
    TaskStatus,
    TimeEstimate,
    generateUUID,
    getTaskAgeLabel,
    getTaskStaleness,
    getTaskUrgency,
    getStatusColor,
    Project,
    safeFormatDate,
    safeParseDate,
    getChecklistProgress,
    getUnblocksCount,
    stripMarkdown,
    createAIProvider,
    PRESET_CONTEXTS,
    PRESET_TAGS,
    type ClarifyResponse,
} from '@mindwtr/core';
import { cn } from '../lib/utils';
import { useLanguage } from '../contexts/language-context';
import { Markdown } from './Markdown';
import { isTauriRuntime } from '../lib/runtime';
import { buildAIConfig, buildCopilotConfig, loadAIKey } from '../lib/ai-config';

// Convert stored ISO or datetime-local strings into datetime-local input values.
function toDateTimeLocalValue(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const parsed = safeParseDate(dateStr);
    if (!parsed) return dateStr;
    return safeFormatDate(parsed, "yyyy-MM-dd'T'HH:mm", dateStr);
}

interface TaskItemProps {
    task: Task;
    project?: Project;
    isSelected?: boolean;
    onSelect?: () => void;
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: () => void;
}

export const TaskItem = memo(function TaskItem({
    task,
    project: propProject,
    isSelected,
    onSelect,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect,
}: TaskItemProps) {
    const { updateTask, deleteTask, moveTask, projects, tasks, settings, duplicateTask, resetTaskChecklist } = useTaskStore();
    const { t, language } = useLanguage();
    const [isEditing, setIsEditing] = useState(false);
    const [isChecklistOpen, setIsChecklistOpen] = useState(false);
    const [editTitle, setEditTitle] = useState(task.title);
    const [editDueDate, setEditDueDate] = useState(toDateTimeLocalValue(task.dueDate));
    const [editStartTime, setEditStartTime] = useState(toDateTimeLocalValue(task.startTime));
    const [editProjectId, setEditProjectId] = useState(task.projectId || '');
    const [editContexts, setEditContexts] = useState(task.contexts?.join(', ') || '');
    const [editTags, setEditTags] = useState(task.tags?.join(', ') || '');
    const [editDescription, setEditDescription] = useState(task.description || '');
    const [showDescriptionPreview, setShowDescriptionPreview] = useState(false);
    const [editLocation, setEditLocation] = useState(task.location || '');
    const [editRecurrence, setEditRecurrence] = useState(task.recurrence || '');
    const [editTimeEstimate, setEditTimeEstimate] = useState<TimeEstimate | ''>(task.timeEstimate || '');
    const [editReviewAt, setEditReviewAt] = useState(toDateTimeLocalValue(task.reviewAt));
    const [editBlockedByTaskIds, setEditBlockedByTaskIds] = useState<string[]>(task.blockedByTaskIds || []);
    const [editAttachments, setEditAttachments] = useState<Attachment[]>(task.attachments || []);
    const [aiClarifyResponse, setAiClarifyResponse] = useState<ClarifyResponse | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiBreakdownSteps, setAiBreakdownSteps] = useState<string[] | null>(null);
    const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
    const [copilotApplied, setCopilotApplied] = useState(false);
    const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
    const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
    const [isAIWorking, setIsAIWorking] = useState(false);
    const aiEnabled = settings?.ai?.enabled === true;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as 'openai' | 'gemini';

    const projectContext = useMemo(() => {
        const projectId = editProjectId || task.projectId;
        if (!projectId) return null;
        const project = projects.find((p) => p.id === projectId);
        const projectTasks = tasks
            .filter((t) => t.projectId === projectId && t.id !== task.id && !t.deletedAt)
            .map((t) => `${t.title}${t.status ? ` (${t.status})` : ''}`)
            .filter(Boolean)
            .slice(0, 20);
        return {
            projectTitle: project?.title || '',
            projectTasks,
        };
    }, [editProjectId, projects, task.id, task.projectId, tasks]);

    const tagOptions = useMemo(() => {
        const taskTags = tasks.flatMap((t) => t.tags || []);
        return Array.from(new Set([...PRESET_TAGS, ...taskTags])).filter(Boolean);
    }, [tasks]);

    const ageLabel = getTaskAgeLabel(task.createdAt, language);
    const checklistProgress = getChecklistProgress(task);
    const unblocksCount = getUnblocksCount(task.id, tasks ?? []);
    const visibleAttachments = (task.attachments || []).filter((a) => !a.deletedAt);
    const visibleEditAttachments = editAttachments.filter((a) => !a.deletedAt);

    const openAttachment = (attachment: Attachment) => {
        if (attachment.kind === 'link') {
            window.open(attachment.uri, '_blank');
            return;
        }
        const url = attachment.uri.startsWith('file://') ? attachment.uri : `file://${attachment.uri}`;
        window.open(url, '_blank');
    };

    const addFileAttachment = async () => {
        if (!isTauriRuntime()) {
            alert(t('attachments.fileNotSupported'));
            return;
        }
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            multiple: false,
            directory: false,
            title: t('attachments.addFile'),
        });
        if (!selected || typeof selected !== 'string') return;
        const now = new Date().toISOString();
        const title = selected.split(/[/\\]/).pop() || selected;
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'file',
            title,
            uri: selected,
            createdAt: now,
            updatedAt: now,
        };
        setEditAttachments((prev) => [...prev, attachment]);
    };

    const addLinkAttachment = () => {
        const url = window.prompt(t('attachments.addLink'), t('attachments.linkPlaceholder'));
        if (!url) return;
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'link',
            title: url,
            uri: url,
            createdAt: now,
            updatedAt: now,
        };
        setEditAttachments((prev) => [...prev, attachment]);
    };

    const removeAttachment = (id: string) => {
        const now = new Date().toISOString();
        setEditAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, deletedAt: now, updatedAt: now } : a))
        );
    };

    const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        moveTask(task.id, e.target.value as TaskStatus);
    };

    const resetEditState = () => {
        setEditTitle(task.title);
        setEditDueDate(toDateTimeLocalValue(task.dueDate));
        setEditStartTime(toDateTimeLocalValue(task.startTime));
        setEditProjectId(task.projectId || '');
        setEditContexts(task.contexts?.join(', ') || '');
        setEditTags(task.tags?.join(', ') || '');
        setEditDescription(task.description || '');
        setEditLocation(task.location || '');
        setEditRecurrence(task.recurrence || '');
        setEditTimeEstimate(task.timeEstimate || '');
        setEditReviewAt(toDateTimeLocalValue(task.reviewAt));
        setEditBlockedByTaskIds(task.blockedByTaskIds || []);
        setEditAttachments(task.attachments || []);
        setShowDescriptionPreview(false);
        setAiClarifyResponse(null);
        setAiError(null);
        setAiBreakdownSteps(null);
        setCopilotSuggestion(null);
        setCopilotApplied(false);
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
    };

    const resetCopilotDraft = () => {
        setCopilotApplied(false);
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
    };

    const applyCopilotSuggestion = () => {
        if (!copilotSuggestion) return;
        if (copilotSuggestion.context) {
            const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
            const nextContexts = Array.from(new Set([...currentContexts, copilotSuggestion.context]));
            setEditContexts(nextContexts.join(', '));
            setCopilotContext(copilotSuggestion.context);
        }
        if (copilotSuggestion.tags?.length) {
            const currentTags = editTags.split(',').map((t) => t.trim()).filter(Boolean);
            const nextTags = Array.from(new Set([...currentTags, ...copilotSuggestion.tags]));
            setEditTags(nextTags.join(', '));
        }
        if (copilotSuggestion.timeEstimate) {
            setEditTimeEstimate(copilotSuggestion.timeEstimate);
            setCopilotEstimate(copilotSuggestion.timeEstimate);
        }
        setCopilotApplied(true);
    };

    useEffect(() => {
        if (!aiEnabled) {
            setCopilotSuggestion(null);
            return;
        }
        const apiKey = loadAIKey(aiProvider);
        if (!apiKey) {
            setCopilotSuggestion(null);
            return;
        }
        const title = editTitle.trim();
        const description = editDescription.trim();
        const input = [title, description].filter(Boolean).join('\n');
        if (input.length < 4) {
            setCopilotSuggestion(null);
            return;
        }
        let cancelled = false;
        const handle = setTimeout(async () => {
            try {
                const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
                const provider = createAIProvider(buildCopilotConfig(settings, apiKey));
                const suggestion = await provider.predictMetadata({
                    title: input,
                    contexts: Array.from(new Set([...PRESET_CONTEXTS, ...currentContexts])),
                    tags: tagOptions,
                });
                if (cancelled) return;
                if (!suggestion.context && !suggestion.timeEstimate && !suggestion.tags?.length) {
                    setCopilotSuggestion(null);
                } else {
                    setCopilotSuggestion(suggestion);
                }
            } catch {
                if (!cancelled) {
                    setCopilotSuggestion(null);
                }
            }
        }, 800);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [aiEnabled, aiProvider, editTitle, editDescription, editContexts, settings]);

    const logAIDebug = async (context: string, message: string) => {
        if (!isTauriRuntime()) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('log_ai_debug', {
                context,
                message,
                provider: aiProvider,
                model: settings?.ai?.model ?? '',
                taskId: task.id,
            });
        } catch (error) {
            console.warn('AI debug log failed', error);
        }
    };

    const getAIProvider = () => {
        if (!aiEnabled) {
            alert(t('ai.disabledBody'));
            return null;
        }
        const apiKey = loadAIKey(aiProvider);
        if (!apiKey) {
            alert(t('ai.missingKeyBody'));
            return null;
        }
        return createAIProvider(buildAIConfig(settings, apiKey));
    };

    const applyAISuggestion = (suggested: { title?: string; context?: string; timeEstimate?: TimeEstimate }) => {
        if (suggested.title) setEditTitle(suggested.title);
        if (suggested.timeEstimate) setEditTimeEstimate(suggested.timeEstimate);
        if (suggested.context) {
            const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
            const nextContexts = Array.from(new Set([...currentContexts, suggested.context]));
            setEditContexts(nextContexts.join(', '));
        }
        setAiClarifyResponse(null);
    };

    const handleAIClarify = async () => {
        if (isAIWorking) return;
        const title = editTitle.trim();
        if (!title) return;
        const provider = getAIProvider();
        if (!provider) return;
        setIsAIWorking(true);
        setAiError(null);
        setAiBreakdownSteps(null);
        try {
            const currentContexts = editContexts.split(',').map((c) => c.trim()).filter(Boolean);
            const response = await provider.clarifyTask({
                title,
                contexts: Array.from(new Set([...PRESET_CONTEXTS, ...currentContexts])),
                ...(projectContext ?? {}),
            });
            setAiClarifyResponse(response);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message);
            await logAIDebug('clarify', message);
            console.warn(error);
            alert(`${t('ai.errorBody')}\n\n${message}`);
        } finally {
            setIsAIWorking(false);
        }
    };

    const handleAIBreakdown = async () => {
        if (isAIWorking) return;
        const title = editTitle.trim();
        if (!title) return;
        const provider = getAIProvider();
        if (!provider) return;
        setIsAIWorking(true);
        setAiError(null);
        setAiBreakdownSteps(null);
        try {
            const response = await provider.breakDownTask({
                title,
                description: editDescription,
                ...(projectContext ?? {}),
            });
            const steps = response.steps.map((step) => step.trim()).filter(Boolean).slice(0, 8);
            if (steps.length === 0) return;
            setAiBreakdownSteps(steps);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message);
            await logAIDebug('breakdown', message);
            console.warn(error);
            alert(`${t('ai.errorBody')}\n\n${message}`);
        } finally {
            setIsAIWorking(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (editTitle.trim()) {
            updateTask(task.id, {
                title: editTitle,
                dueDate: editDueDate || undefined,
                startTime: editStartTime || undefined,
                projectId: editProjectId || undefined,
                contexts: editContexts.split(',').map(c => c.trim()).filter(Boolean),
                tags: editTags.split(',').map(c => c.trim()).filter(Boolean),
                description: editDescription || undefined,
                location: editLocation || undefined,
                recurrence: editRecurrence || undefined,
                timeEstimate: editTimeEstimate || undefined,
                reviewAt: editReviewAt || undefined,
                blockedByTaskIds: editBlockedByTaskIds.length > 0 ? editBlockedByTaskIds : undefined,
                attachments: editAttachments.length > 0 ? editAttachments : undefined,
            });
            setIsEditing(false);
        }
    };

    // Urgency Logic
    const getUrgencyColor = () => {
        const urgency = getTaskUrgency(task);
        switch (urgency) {
            case 'overdue': return 'text-destructive font-bold';
            case 'urgent': return 'text-orange-500 font-medium';
            case 'upcoming': return 'text-yellow-600';
            default: return 'text-muted-foreground';
        }
    };

    const project = propProject || projects.find(p => p.id === task.projectId);

    return (
        <div
            data-task-id={task.id}
            onClickCapture={() => onSelect?.()}
            className={cn(
                "group bg-card border border-border rounded-lg p-4 hover:shadow-md transition-all animate-in fade-in slide-in-from-bottom-2 border-l-4",
                isSelected && "ring-2 ring-primary/40"
            )}
            style={{ borderLeftColor: getStatusColor(task.status).border }}
        >
            <div className="flex items-start gap-3">
                {selectionMode && (
                    <input
                        type="checkbox"
                        aria-label="Select task"
                        checked={isMultiSelected}
                        onChange={() => onToggleSelect?.()}
                        className="mt-1.5 h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
                    />
                )}

                <div className="flex-1 min-w-0">
                    {isEditing ? (
                        <form
                            onSubmit={handleSubmit}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            className="space-y-3"
                        >
                            <input
                                autoFocus
                                type="text"
                                aria-label="Task title"
                                value={editTitle}
                                onChange={(e) => {
                                    setEditTitle(e.target.value);
                                    resetCopilotDraft();
                                }}
                                className="w-full bg-transparent border-b border-primary/50 p-1 text-base font-medium focus:ring-0 focus:border-primary outline-none"
                                placeholder={t('taskEdit.titleLabel')}
                            />
                            {aiEnabled && (
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={handleAIClarify}
                                        disabled={isAIWorking}
                                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground disabled:opacity-60"
                                    >
                                        {t('taskEdit.aiClarify')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleAIBreakdown}
                                        disabled={isAIWorking}
                                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground disabled:opacity-60"
                                    >
                                        {t('taskEdit.aiBreakdown')}
                                    </button>
                                </div>
                            )}
                            {aiEnabled && copilotSuggestion && !copilotApplied && (
                                <button
                                    type="button"
                                    onClick={applyCopilotSuggestion}
                                    className="text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground hover:bg-muted/60 transition-colors text-left"
                                >
                                    ✨ {t('copilot.suggested')}{' '}
                                    {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                                    {copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
                                    {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                                    <span className="ml-2 text-muted-foreground/70">{t('copilot.applyHint')}</span>
                                </button>
                            )}
                            {aiEnabled && copilotApplied && (
                                <div className="text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground">
                                    ✅ {t('copilot.applied')}{' '}
                                    {copilotContext ? `${copilotContext} ` : ''}
                                    {copilotEstimate ? `${copilotEstimate}` : ''}
                                    {copilotSuggestion?.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                                </div>
                            )}
                            {aiEnabled && aiError && (
                                <div className="text-xs text-muted-foreground border border-border rounded-md p-2 bg-muted/20 break-words whitespace-pre-wrap">
                                    {aiError}
                                </div>
                            )}
                            {aiEnabled && aiBreakdownSteps && (
                                <div className="border border-border rounded-md p-2 space-y-2 text-xs">
                                    <div className="text-muted-foreground">{t('ai.breakdownTitle')}</div>
                                    <div className="space-y-1">
                                        {aiBreakdownSteps.map((step, index) => (
                                            <div key={`${step}-${index}`} className="text-foreground">
                                                {index + 1}. {step}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const newItems = aiBreakdownSteps.map((step) => ({
                                                    id: generateUUID(),
                                                    title: step,
                                                    isCompleted: false,
                                                }));
                                                updateTask(task.id, { checklist: [...(task.checklist || []), ...newItems] });
                                                setAiBreakdownSteps(null);
                                            }}
                                            className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                        >
                                            {t('ai.addSteps')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setAiBreakdownSteps(null)}
                                            className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                                        >
                                            {t('common.cancel')}
                                        </button>
                                    </div>
                                </div>
                            )}
                            {aiEnabled && aiClarifyResponse && (
                                <div className="border border-border rounded-md p-2 space-y-2 text-xs">
                                    <div className="text-muted-foreground">{aiClarifyResponse.question}</div>
                                    <div className="flex flex-wrap gap-2">
                                        {aiClarifyResponse.options.map((option) => (
                                            <button
                                                key={option.label}
                                                type="button"
                                                onClick={() => {
                                                    setEditTitle(option.action);
                                                    setAiClarifyResponse(null);
                                                }}
                                                className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                        {aiClarifyResponse.suggestedAction?.title && (
                                            <button
                                                type="button"
                                                onClick={() => applyAISuggestion(aiClarifyResponse.suggestedAction!)}
                                                className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                            >
                                                {t('ai.applySuggestion')}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => setAiClarifyResponse(null)}
                                            className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                                        >
                                            {t('common.cancel')}
                                        </button>
                                    </div>
                                </div>
                            )}
	                            <div className="flex flex-col gap-2">
	                                <div className="flex items-center justify-between">
	                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.descriptionLabel')}</label>
	                                    <button
	                                        type="button"
	                                        onClick={() => setShowDescriptionPreview((v) => !v)}
	                                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
	                                    >
	                                        {showDescriptionPreview ? t('markdown.edit') : t('markdown.preview')}
	                                    </button>
	                                </div>
	                                {showDescriptionPreview ? (
	                                    <div className="text-xs bg-muted/30 border border-border rounded px-2 py-2">
	                                        <Markdown markdown={editDescription || ''} />
	                                    </div>
	                                ) : (
	                                    <textarea
	                                        aria-label="Task description"
	                                        value={editDescription}
	                                        onChange={(e) => {
                                                setEditDescription(e.target.value);
                                                resetCopilotDraft();
                                            }}
	                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 min-h-[60px] resize-y"
	                                        placeholder={t('taskEdit.descriptionPlaceholder')}
	                                    />
	                                )}
	                            </div>

	                            <div className="flex flex-col gap-2">
	                                <div className="flex items-center justify-between">
	                                    <label className="text-xs text-muted-foreground font-medium">{t('attachments.title')}</label>
	                                    <div className="flex items-center gap-2">
	                                        <button
	                                            type="button"
	                                            onClick={addFileAttachment}
	                                            className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1"
	                                        >
	                                            <Paperclip className="w-3 h-3" />
	                                            {t('attachments.addFile')}
	                                        </button>
	                                        <button
	                                            type="button"
	                                            onClick={addLinkAttachment}
	                                            className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1"
	                                        >
	                                            <Link2 className="w-3 h-3" />
	                                            {t('attachments.addLink')}
	                                        </button>
	                                    </div>
	                                </div>
	                                {visibleEditAttachments.length === 0 ? (
	                                    <p className="text-xs text-muted-foreground">{t('common.none')}</p>
	                                ) : (
	                                    <div className="space-y-1">
	                                        {visibleEditAttachments.map((attachment) => (
	                                            <div key={attachment.id} className="flex items-center justify-between gap-2 text-xs">
	                                                <button
	                                                    type="button"
	                                                    onClick={(e) => {
	                                                        e.preventDefault();
	                                                        e.stopPropagation();
	                                                        openAttachment(attachment);
	                                                    }}
	                                                    className="truncate text-primary hover:underline"
	                                                    title={attachment.title}
	                                                >
	                                                    {attachment.title}
	                                                </button>
	                                                <button
	                                                    type="button"
	                                                    onClick={() => removeAttachment(attachment.id)}
	                                                    className="text-muted-foreground hover:text-foreground"
	                                                >
	                                                    {t('attachments.remove')}
	                                                </button>
	                                            </div>
	                                        ))}
	                                    </div>
	                                )}
	                            </div>
	                            <div className="flex flex-wrap gap-4">
	                                <div className="flex flex-col gap-1">
	                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.startDateLabel')}</label>
	                                    <input
                                        type="datetime-local"
                                        aria-label="Start time"
	                                        value={editStartTime}
	                                        onChange={(e) => setEditStartTime(e.target.value)}
	                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
	                                    />
                                </div>
		                                <div className="flex flex-col gap-1">
		                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.dueDateLabel')}</label>
		                                    <input
	                                        type="datetime-local"
	                                        aria-label="Deadline"
		                                        value={editDueDate}
		                                        onChange={(e) => setEditDueDate(e.target.value)}
		                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
		                                    />
	                                </div>
		                                <div className="flex flex-col gap-1">
		                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.reviewDateLabel')}</label>
		                                    <input
	                                        type="datetime-local"
	                                        aria-label="Review date"
		                                        value={editReviewAt}
		                                        onChange={(e) => setEditReviewAt(e.target.value)}
		                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
		                                    />
	                                </div>
		                                <div className="flex flex-col gap-1">
		                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.statusLabel')}</label>
			                                    <select
		                                        value={task.status}
		                                        aria-label="Status"
		                                        onChange={handleStatusChange}
		                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
				                                    >
			                                        <option value="inbox">{t('status.inbox')}</option>
			                                        <option value="next">{t('status.next')}</option>
			                                        <option value="waiting">{t('status.waiting')}</option>
			                                        <option value="someday">{t('status.someday')}</option>
			                                        <option value="done">{t('status.done')}</option>
			                                    </select>
		                                </div>
		                                <div className="flex flex-col gap-1">
		                                    <label className="text-xs text-muted-foreground font-medium">{t('projects.title')}</label>
		                                    <select
	                                        value={editProjectId}
	                                        aria-label="Project"
	                                        onChange={(e) => setEditProjectId(e.target.value)}
			                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
			                                    >
		                                        <option value="">{t('taskEdit.noProjectOption')}</option>
			                                        {projects.map(p => (
			                                            <option key={p.id} value={p.id}>{p.title}</option>
			                                        ))}
			                                    </select>
			                                </div>
			                                <div className="flex flex-col gap-1 min-w-[180px]">
			                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.blockedByLabel')}</label>
			                                    <select
			                                        multiple
			                                        value={editBlockedByTaskIds}
			                                        aria-label="Blocked by"
				                                        onChange={(e) => {
				                                            const selected = Array.from(e.target.selectedOptions).map(o => o.value);
				                                            setEditBlockedByTaskIds(selected);
				                                        }}
				                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 h-20 text-foreground"
				                                    >
                                        {(tasks ?? [])
                                            .filter(otherTask => otherTask.id !== task.id && !otherTask.deletedAt)
                                            .map(otherTask => (
                                                <option key={otherTask.id} value={otherTask.id}>
                                                    {otherTask.title}
			                                                </option>
			                                            ))}
			                                    </select>
			                                </div>
			                                <div className="flex flex-col gap-1">
			                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.locationLabel')}</label>
			                                    <input
                                        type="text"
                                        aria-label="Location"
	                                        value={editLocation}
	                                        onChange={(e) => setEditLocation(e.target.value)}
			                                        placeholder={t('taskEdit.locationPlaceholder')}
			                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground placeholder:text-muted-foreground"
			                                    />
		                                </div>
		                                <div className="flex flex-col gap-1 w-full">
		                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.recurrenceLabel')}</label>
		                                    <select
	                                        value={editRecurrence}
	                                        aria-label="Recurrence"
			                                        onChange={(e) => setEditRecurrence(e.target.value)}
			                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
			                                    >
		                                        <option value="">{t('recurrence.none')}</option>
		                                        <option value="daily">{t('recurrence.daily')}</option>
		                                        <option value="weekly">{t('recurrence.weekly')}</option>
		                                        <option value="monthly">{t('recurrence.monthly')}</option>
		                                        <option value="yearly">{t('recurrence.yearly')}</option>
		                                    </select>
		                                </div>
		                                <div className="flex flex-col gap-1 w-full">
		                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.timeEstimateLabel')}</label>
		                                    <select
	                                        value={editTimeEstimate}
	                                        aria-label="Time estimate"
			                                        onChange={(e) => setEditTimeEstimate(e.target.value as TimeEstimate | '')}
			                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
			                                    >
		                                        <option value="">{t('common.none')}</option>
		                                        <option value="5min">5m</option>
		                                        <option value="10min">10m</option>
		                                        <option value="15min">15m</option>
		                                        <option value="30min">30m</option>
		                                        <option value="1hr">1h</option>
		                                        <option value="2hr">2h</option>
		                                        <option value="3hr">3h</option>
		                                        <option value="4hr">4h</option>
		                                        <option value="4hr+">4h+</option>
		                                    </select>
		                                </div>
		                                <div className="flex flex-col gap-1 w-full">
		                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.contextsLabel')}</label>
		                                    <input
                                        type="text"
                                        aria-label="Contexts"
	                                        value={editContexts}
	                                        onChange={(e) => setEditContexts(e.target.value)}
	                                        placeholder="@home, @work"
	                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground placeholder:text-muted-foreground"
	                                    />
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        {['@home', '@work', '@errands', '@computer', '@phone'].map(tag => {
                                            const currentTags = editContexts.split(',').map(t => t.trim()).filter(Boolean);
                                            const isActive = currentTags.includes(tag);
                                            return (
                                                <button
                                                    key={tag}
                                                    type="button"
                                                    onClick={() => {
                                                        let newTags;
                                                        if (isActive) {
                                                            newTags = currentTags.filter(t => t !== tag);
                                                        } else {
                                                            newTags = [...currentTags, tag];
                                                        }
                                                        setEditContexts(newTags.join(', '));
                                                    }}
                                                    className={cn(
                                                        "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                                                        isActive
                                                            ? "bg-primary/10 border-primary text-primary"
                                                            : "bg-transparent border-border text-muted-foreground hover:border-primary/50"
                                                    )}
                                                >
                                                    {tag}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div className="flex flex-col gap-1 w-full">
                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.tagsLabel')}</label>
                                    <input
                                        type="text"
                                        aria-label="Tags"
	                                        value={editTags}
	                                        onChange={(e) => setEditTags(e.target.value)}
	                                        placeholder="#urgent, #idea"
	                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground placeholder:text-muted-foreground"
	                                    />
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        {((() => {
                                            // Compute most frequent tags (hashtags)
                                            // Note: In a real app we might want to memoize this or pass it down,
                                            // but for this inline component, we'll compute it from store tasks
                                            const allTasks = tasks || [];
                                            const PRESET_TAGS = ['#creative', '#focused', '#lowenergy', '#routine'];

                                            const counts = new Map<string, number>();
                                            allTasks.forEach(t => {
                                                t.tags?.forEach(tag => {
                                                    counts.set(tag, (counts.get(tag) || 0) + 1);
                                                });
                                            });

                                            const sorted = Array.from(counts.entries())
                                                .sort((a, b) => b[1] - a[1])
                                                .map(([tag]) => tag);

                                            return Array.from(new Set([...sorted, ...PRESET_TAGS])).slice(0, 8);
                                        })()).map(tag => {
                                            const currentTags = editTags.split(',').map(t => t.trim()).filter(Boolean);
                                            const isActive = currentTags.includes(tag);
                                            return (
                                                <button
                                                    key={tag}
                                                    type="button"
                                                    onClick={() => {
                                                        let newTags;
                                                        if (isActive) {
                                                            newTags = currentTags.filter(t => t !== tag);
                                                        } else {
                                                            newTags = [...currentTags, tag];
                                                        }
                                                        setEditTags(newTags.join(', '));
                                                    }}
                                                    className={cn(
                                                        "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                                                        isActive
                                                            ? "bg-primary/10 border-primary text-primary"
                                                            : "bg-transparent border-border text-muted-foreground hover:border-primary/50"
                                                    )}
                                                >
                                                    {tag}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div className="flex flex-col gap-2 w-full pt-2 border-t border-border/50">
                                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.checklist')}</label>
                                    <div className="space-y-2">
                                        {(task.checklist || []).map((item, index) => (
                                            <div key={item.id || index} className="flex items-center gap-2 group/item">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const newList = (task.checklist || []).map((item, i) =>
                                                            i === index ? { ...item, isCompleted: !item.isCompleted } : item
                                                        );
                                                        updateTask(task.id, { checklist: newList });
                                                    }}
                                                    className={cn(
                                                        "w-4 h-4 border rounded flex items-center justify-center transition-colors",
                                                        item.isCompleted
                                                            ? "bg-primary border-primary text-primary-foreground"
                                                            : "border-muted-foreground hover:border-primary"
                                                    )}
                                                >
                                                    {item.isCompleted && <Check className="w-3 h-3" />}
                                                </button>
                                                <input
                                                    type="text"
                                                    value={item.title}
                                                    onChange={(e) => {
                                                        const newList = (task.checklist || []).map((item, i) =>
                                                            i === index ? { ...item, title: e.target.value } : item
                                                        );
                                                        updateTask(task.id, { checklist: newList });
                                                    }}
                                                    className={cn(
                                                        "flex-1 bg-transparent text-sm focus:outline-none border-b border-transparent focus:border-primary/50 px-1",
                                                        item.isCompleted && "text-muted-foreground line-through"
                                                    )}
                                                    placeholder={t('taskEdit.itemNamePlaceholder')}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const newList = (task.checklist || []).filter((_, i) => i !== index);
                                                        updateTask(task.id, { checklist: newList });
                                                    }}
                                                    className="opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive p-1"
                                                >
                                                    <Trash2 className="w-3 h-3" />
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const newItem = {
                                                    id: Date.now().toString(),
                                                    title: '',
                                                    isCompleted: false
                                                };
                                                updateTask(task.id, {
                                                    checklist: [...(task.checklist || []), newItem]
                                                });
                                            }}
                                            className="text-xs text-blue-500 hover:text-blue-600 font-medium flex items-center gap-1"
                                        >
                                            <Plus className="w-3 h-3" />
                                            {t('taskEdit.addItem')}
                                        </button>
                                        {(task.checklist || []).length > 0 && (
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => resetTaskChecklist(task.id)}
                                                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                                                >
                                                    {t('taskEdit.resetChecklist')}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                {(task.checklist || []).length > 0 && (
                                    <div className="mt-3 space-y-1 pl-1">
                                        {(task.checklist || []).map((item, i) => (
                                            <div key={item.id || i} className="flex items-center gap-2 text-xs text-muted-foreground">
                                                <div className={cn(
                                                    "w-3 h-3 border rounded flex items-center justify-center",
                                                    item.isCompleted ? "bg-muted-foreground/20 border-muted-foreground" : "border-muted-foreground"
                                                )}>
                                                    {item.isCompleted && <Check className="w-2 h-2" />}
                                                </div>
                                                <span className={cn(item.isCompleted && "line-through")}>{item.title}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex gap-2 pt-1">
                                <button
                                    type="button"
                                    onClick={() => duplicateTask(task.id, false)}
                                    className="text-xs px-3 py-1.5 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                                >
                                    {t('taskEdit.duplicateTask')}
                                </button>
                                <button
                                    type="submit"
                                    className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded hover:bg-primary/90"
                                >
                                    {t('common.save')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        resetEditState();
                                        setIsEditing(false);
                                    }}
                                    className="text-xs bg-muted text-muted-foreground px-3 py-1.5 rounded hover:bg-muted/80"
                                >
                                    {t('common.cancel')}
                                </button>
                            </div>
                        </form>
	                    ) : (
	                        <div
	                            data-task-edit-trigger
	                            onClick={() => {
	                                if (selectionMode) {
	                                    onToggleSelect?.();
	                                }
	                            }}
	                            onDoubleClick={() => {
	                                if (!selectionMode) {
	                                    setIsEditing(true);
	                                }
	                            }}
	                            className={cn(
	                                "group/content rounded -ml-2 pl-2 pr-1 py-1 transition-colors",
	                                selectionMode ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
	                            )}
	                        >
                            <div
                                className={cn(
                                    "text-base font-medium truncate group-hover/content:text-primary transition-colors",
                                    task.status === 'done' && "line-through text-muted-foreground"
                                )}
                            >
                                {task.title}
                            </div>

	                            {task.description && (
	                                <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
	                                    {stripMarkdown(task.description)}
	                                </p>
	                            )}

	                            {visibleAttachments.length > 0 && (
	                                <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-muted-foreground">
	                                    <Paperclip className="w-3 h-3" />
	                                    {visibleAttachments.slice(0, 2).map((attachment) => (
	                                        <button
	                                            key={attachment.id}
	                                            type="button"
	                                            onClick={(e) => {
	                                                e.preventDefault();
	                                                e.stopPropagation();
	                                                openAttachment(attachment);
	                                            }}
	                                            className="truncate hover:underline"
	                                            title={attachment.title}
	                                        >
	                                            {attachment.title}
	                                        </button>
	                                    ))}
	                                    {visibleAttachments.length > 2 && (
	                                        <span className="opacity-80">+{visibleAttachments.length - 2}</span>
	                                    )}
	                                </div>
	                            )}

                            <div className="flex flex-wrap items-center gap-4 mt-2 text-xs">
                                {project && (
                                    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/50 text-accent-foreground font-medium text-[10px]">
                                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
                                        {project.title}
                                    </div>
                                )}
                                {task.startTime && (
                                    <div className="flex items-center gap-1 text-blue-500/80" title={t('taskEdit.startDateLabel')}>
                                        <ArrowRight className="w-3 h-3" />
                                        {safeFormatDate(task.startTime, 'MMM d, HH:mm')}
                                    </div>
                                )}
                                {task.dueDate && (
                                    <div className={cn("flex items-center gap-1", getUrgencyColor())} title={t('taskEdit.dueDateLabel')}>
                                        <CalendarIcon className="w-3 h-3" />
                                        {safeFormatDate(task.dueDate, 'MMM d, HH:mm')}
                                    </div>
                                )}
                                {task.location && (
                                    <div className="flex items-center gap-1 text-muted-foreground" title={t('taskEdit.locationLabel')}>
                                        <span className="font-medium">📍 {task.location}</span>
                                    </div>
                                )}
                                {task.recurrence && (
                                    <div className="flex items-center gap-1 text-purple-600" title={t('taskEdit.recurrenceLabel')}>
                                        <Repeat className="w-3 h-3" />
                                        <span>{t(`recurrence.${task.recurrence}`)}</span>
                                    </div>
                                )}
                                {task.contexts?.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        {task.contexts.map(ctx => (
                                            <span key={ctx} className="text-muted-foreground hover:text-foreground transition-colors">
                                                {ctx}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {task.tags.length > 0 && (
                                    <div className="flex items-center gap-1 text-muted-foreground">
                                        <Tag className="w-3 h-3" />
                                        {task.tags.join(', ')}
                                    </div>
                                )}
                                {checklistProgress && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setIsChecklistOpen((v) => !v);
                                        }}
                                        className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                                        title={t('checklist.progress')}
                                    >
                                        <span className="font-medium">
                                            {checklistProgress.completed}/{checklistProgress.total}
                                        </span>
                                        <div className="w-16 h-1 bg-muted rounded overflow-hidden">
                                            <div
                                                className="h-full bg-primary"
                                                style={{ width: `${Math.round(checklistProgress.percent * 100)}%` }}
                                            />
                                        </div>
                                    </button>
                                )}
                                {unblocksCount > 0 && (
                                    <div className="text-muted-foreground text-xs">
                                        {t('taskEdit.unblocksLabel')} {unblocksCount}
                                    </div>
                                )}
                                {/* Task Age Indicator */}
                                {task.status !== 'done' && ageLabel && (
                                    <div className={cn(
                                        "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full",
                                        getTaskStaleness(task.createdAt) === 'fresh' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                                        getTaskStaleness(task.createdAt) === 'aging' && 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
                                        getTaskStaleness(task.createdAt) === 'stale' && 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
                                        getTaskStaleness(task.createdAt) === 'very-stale' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                    )} title="Task age">
                                        <Clock className="w-3 h-3" />
                                        {ageLabel}
                                    </div>
                                )}
                                {/* Time Estimate Badge */}
                                {task.timeEstimate && (
                                    <div className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" title="Estimated time">
                                        <Timer className="w-3 h-3" />
                                        {String(task.timeEstimate).endsWith('min')
                                            ? String(task.timeEstimate).replace('min', 'm')
                                            : String(task.timeEstimate).endsWith('hr+')
                                                ? String(task.timeEstimate).replace('hr+', 'h+')
                                                : String(task.timeEstimate).endsWith('hr')
                                                    ? String(task.timeEstimate).replace('hr', 'h')
                                                    : String(task.timeEstimate)}
                                    </div>
                                )}
                            </div>

                            {!isEditing && isChecklistOpen && (task.checklist || []).length > 0 && (
                                <div
                                    className="mt-3 space-y-1 pl-1"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    {(task.checklist || []).map((item, index) => (
                                        <div key={item.id || index} className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const newList = (task.checklist || []).map((it, i) =>
                                                        i === index ? { ...it, isCompleted: !it.isCompleted } : it
                                                    );
                                                    updateTask(task.id, { checklist: newList });
                                                }}
                                                className={cn(
                                                    "w-3 h-3 border rounded flex items-center justify-center transition-colors",
                                                    item.isCompleted
                                                        ? "bg-primary border-primary text-primary-foreground"
                                                        : "border-muted-foreground hover:border-primary"
                                                )}
                                            >
                                                {item.isCompleted && <Check className="w-2 h-2" />}
                                            </button>
                                            <span className={cn(item.isCompleted && "line-through")}>{item.title}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

	                {!isEditing && (
	                    <div
	                        className="relative flex items-center gap-2"
	                        onPointerDown={(e) => e.stopPropagation()}
	                    >
	                        <button
	                            type="button"
	                            onClick={() => {
	                                resetEditState();
	                                setIsEditing(true);
	                            }}
	                            aria-label={t('common.edit')}
	                            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
	                        >
	                            <Pencil className="w-4 h-4" />
	                        </button>
		                        <select
		                            value={task.status}
		                            aria-label="Task status"
		                            onChange={handleStatusChange}
		                            className="text-xs px-2 py-1 rounded cursor-pointer bg-muted/50 text-foreground border border-border hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
		                        >
		                            <option value="inbox">{t('status.inbox')}</option>
		                            <option value="next">{t('status.next')}</option>
	                            <option value="waiting">{t('status.waiting')}</option>
	                            <option value="someday">{t('status.someday')}</option>
	                            <option value="done">{t('status.done')}</option>
	                        </select>

                        <button
                            onClick={() => deleteTask(task.id)}
                            aria-label="Delete task"
                            className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-red-500/20"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>
        </div >
    );
});
