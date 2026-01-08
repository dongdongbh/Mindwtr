import { useMemo, useState, memo, useEffect, useRef, useCallback } from 'react';

import { Check, Plus, Paperclip, Link2, Trash2 } from 'lucide-react';
import {
    useTaskStore,
    Attachment,
    Task,
    TaskStatus,
    TaskPriority,
    TimeEstimate,
    TaskEditorFieldId,
    type Recurrence,
    type RecurrenceRule,
    type RecurrenceStrategy,
    buildRRuleString,
    parseRRuleString,
    generateUUID,
    getStatusColor,
    Project,
    safeFormatDate,
    safeParseDate,
    createAIProvider,
    PRESET_CONTEXTS,
    PRESET_TAGS,
    type ClarifyResponse,
    type AIProviderId,
} from '@mindwtr/core';
import { cn } from '../lib/utils';
import { PromptModal } from './PromptModal';
import { useLanguage } from '../contexts/language-context';
import { Markdown } from './Markdown';
import { isTauriRuntime } from '../lib/runtime';
import { normalizeAttachmentInput } from '../lib/attachment-utils';
import { buildAIConfig, buildCopilotConfig, loadAIKey } from '../lib/ai-config';
import { WeekdaySelector } from './Task/TaskForm/WeekdaySelector';
import { TaskItemEditor } from './Task/TaskItemEditor';
import { TaskItemDisplay } from './Task/TaskItemDisplay';

const DEFAULT_TASK_EDITOR_ORDER: TaskEditorFieldId[] = [
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
const DEFAULT_TASK_EDITOR_HIDDEN: TaskEditorFieldId[] = [
    'priority',
    'contexts',
    'tags',
    'timeEstimate',
    'recurrence',
    'startTime',
    'dueDate',
    'reviewAt',
    'attachments',
    'checklist',
];
const WEEKDAY_ORDER: RecurrenceWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Convert stored ISO or datetime-local strings into datetime-local input values.
function toDateTimeLocalValue(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const parsed = safeParseDate(dateStr);
    if (!parsed) return dateStr;
    return safeFormatDate(parsed, "yyyy-MM-dd'T'HH:mm", dateStr);
}

function getRecurrenceRuleValue(recurrence: Task['recurrence']): RecurrenceRule | '' {
    if (!recurrence) return '';
    if (typeof recurrence === 'string') return recurrence as RecurrenceRule;
    return recurrence.rule || '';
}

function getRecurrenceStrategyValue(recurrence: Task['recurrence']): RecurrenceStrategy {
    if (recurrence && typeof recurrence === 'object' && recurrence.strategy === 'fluid') {
        return 'fluid';
    }
    return 'strict';
}

function getRecurrenceRRuleValue(recurrence: Task['recurrence']): string {
    if (!recurrence || typeof recurrence === 'string') return '';
    const rec = recurrence as Recurrence;
    if (rec.rrule) return rec.rrule;
    if (rec.byDay && rec.byDay.length > 0) return buildRRuleString(rec.rule, rec.byDay);
    return rec.rule ? buildRRuleString(rec.rule) : '';
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
    const { updateTask, deleteTask, moveTask, projects, tasks, areas, settings, duplicateTask, resetTaskChecklist, highlightTaskId, setHighlightTask, addProject } = useTaskStore();
    const { t } = useLanguage();
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState(task.title);
    const [editDueDate, setEditDueDate] = useState(toDateTimeLocalValue(task.dueDate));
    const [editStartTime, setEditStartTime] = useState(toDateTimeLocalValue(task.startTime));
    const [editProjectId, setEditProjectId] = useState(task.projectId || '');
    const [editContexts, setEditContexts] = useState(task.contexts?.join(', ') || '');
    const [editTags, setEditTags] = useState(task.tags?.join(', ') || '');
    const [editDescription, setEditDescription] = useState(task.description || '');
    const [showDescriptionPreview, setShowDescriptionPreview] = useState(false);
    const [editLocation, setEditLocation] = useState(task.location || '');
    const [editRecurrence, setEditRecurrence] = useState<RecurrenceRule | ''>(getRecurrenceRuleValue(task.recurrence));
    const [editRecurrenceStrategy, setEditRecurrenceStrategy] = useState<RecurrenceStrategy>(getRecurrenceStrategyValue(task.recurrence));
    const [editRecurrenceRRule, setEditRecurrenceRRule] = useState<string>(getRecurrenceRRuleValue(task.recurrence));
    const [editTimeEstimate, setEditTimeEstimate] = useState<TimeEstimate | ''>(task.timeEstimate || '');
    const [editPriority, setEditPriority] = useState<TaskPriority | ''>(task.priority || '');
    const [editReviewAt, setEditReviewAt] = useState(toDateTimeLocalValue(task.reviewAt));
    const [editAttachments, setEditAttachments] = useState<Attachment[]>(task.attachments || []);
    const [attachmentError, setAttachmentError] = useState<string | null>(null);
    const [showLinkPrompt, setShowLinkPrompt] = useState(false);
    const [showDetails, setShowDetails] = useState(false);
    const [isViewOpen, setIsViewOpen] = useState(false);
    const [aiClarifyResponse, setAiClarifyResponse] = useState<ClarifyResponse | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiBreakdownSteps, setAiBreakdownSteps] = useState<string[] | null>(null);
    const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
    const [copilotApplied, setCopilotApplied] = useState(false);
    const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
    const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
    const [isAIWorking, setIsAIWorking] = useState(false);
    const copilotAbortRef = useRef<AbortController | null>(null);
    const aiEnabled = settings?.ai?.enabled === true;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const prioritiesEnabled = settings?.features?.priorities === true;
    const timeEstimatesEnabled = settings?.features?.timeEstimates === true;
    const isHighlighted = highlightTaskId === task.id;
    const recurrenceRule = getRecurrenceRuleValue(task.recurrence);
    const recurrenceStrategy = getRecurrenceStrategyValue(task.recurrence);
    const isStagnant = (task.pushCount ?? 0) > 3;
    const monthlyAnchorDate = safeParseDate(editDueDate) ?? safeParseDate(task.dueDate) ?? new Date();
    const monthlyWeekdayCode = WEEKDAY_ORDER[monthlyAnchorDate.getDay()];
    const monthlyWeekdayLabel = safeFormatDate(monthlyAnchorDate, 'EEEE', monthlyWeekdayCode);
    const monthlyPattern = useMemo(() => {
        if (editRecurrence !== 'monthly') return 'date';
        const parsed = parseRRuleString(editRecurrenceRRule);
        const hasLast = parsed.byDay?.some((day) => String(day).startsWith('-1'));
        return hasLast ? 'last' : 'date';
    }, [editRecurrence, editRecurrenceRRule]);

    useEffect(() => {
        if (!isHighlighted) return;
        const timer = setTimeout(() => {
            setHighlightTask(null);
        }, 3500);
        return () => clearTimeout(timer);
    }, [isHighlighted, setHighlightTask]);

    const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);

    const projectContext = useMemo(() => {
        const projectId = editProjectId || task.projectId;
        if (!projectId) return null;
        const project = projectById.get(projectId);
        const projectTasks = tasks
            .filter((t) => t.projectId === projectId && t.id !== task.id && !t.deletedAt)
            .map((t) => `${t.title}${t.status ? ` (${t.status})` : ''}`)
            .filter(Boolean)
            .slice(0, 20);
        return {
            projectTitle: project?.title || '',
            projectTasks,
        };
    }, [editProjectId, projectById, task.id, task.projectId, tasks]);

    const tagOptions = useMemo(() => {
        const taskTags = tasks.flatMap((t) => t.tags || []);
        return Array.from(new Set([...PRESET_TAGS, ...taskTags])).filter(Boolean);
    }, [tasks]);

    const popularTagOptions = useMemo(() => {
        const counts = new Map<string, number>();
        tasks.forEach((t) => {
            t.tags?.forEach((tag) => {
                counts.set(tag, (counts.get(tag) || 0) + 1);
            });
        });
        const sorted = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([tag]) => tag);
        return Array.from(new Set([...sorted, ...PRESET_TAGS])).slice(0, 8);
    }, [tasks]);
    const allContexts = useMemo(() => {
        const taskContexts = tasks.flatMap((t) => t.contexts || []);
        return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).sort();
    }, [tasks]);
    const DEFAULT_PROJECT_COLOR = '#94a3b8';
    const handleCreateProject = useCallback(async (title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return null;
        const existing = projects.find((project) => project.title.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await addProject(trimmed, DEFAULT_PROJECT_COLOR);
        return created.id;
    }, [addProject, projects]);
    const visibleAttachments = (task.attachments || []).filter((a) => !a.deletedAt);
    const visibleEditAttachments = editAttachments.filter((a) => !a.deletedAt);
    const wasEditingRef = useRef(false);

    const savedOrder = settings?.gtd?.taskEditor?.order ?? [];
    const savedHidden = settings?.gtd?.taskEditor?.hidden ?? DEFAULT_TASK_EDITOR_HIDDEN;
    const disabledFields = useMemo(() => {
        const disabled = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) disabled.add('priority');
        if (!timeEstimatesEnabled) disabled.add('timeEstimate');
        return disabled;
    }, [prioritiesEnabled, timeEstimatesEnabled]);

    const taskEditorOrder = useMemo(() => {
        const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
        const normalized = savedOrder.filter((id) => known.has(id));
        const missing = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !normalized.includes(id));
        return [...normalized, ...missing].filter((id) => !disabledFields.has(id));
    }, [savedOrder, disabledFields]);
    const hiddenSet = useMemo(() => {
        const known = new Set(taskEditorOrder);
        return new Set(savedHidden.filter((id) => known.has(id)));
    }, [savedHidden, taskEditorOrder]);

    const editorFieldIds = useMemo(
        () => taskEditorOrder.filter((fieldId) => fieldId !== 'dueDate' && fieldId !== 'project'),
        [taskEditorOrder]
    );

    const hasValue = useCallback((fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return task.status !== 'inbox';
            case 'project':
                return Boolean(editProjectId || task.projectId);
            case 'priority':
                if (!prioritiesEnabled) return false;
                return Boolean(editPriority);
            case 'contexts':
                return Boolean(editContexts.trim());
            case 'description':
                return Boolean(editDescription.trim());
            case 'tags':
                return Boolean(editTags.trim());
            case 'timeEstimate':
                if (!timeEstimatesEnabled) return false;
                return Boolean(editTimeEstimate);
            case 'recurrence':
                return Boolean(editRecurrence);
            case 'startTime':
                return Boolean(editStartTime);
            case 'dueDate':
                return Boolean(editDueDate);
            case 'reviewAt':
                return Boolean(editReviewAt);
            case 'attachments':
                return visibleEditAttachments.length > 0;
            case 'checklist':
                return (task.checklist || []).length > 0;
            default:
                return false;
        }
    }, [
        editContexts,
        editDescription,
        editDueDate,
        editPriority,
        editRecurrence,
        editReviewAt,
        editStartTime,
        editTags,
        editTimeEstimate,
        prioritiesEnabled,
        task.checklist,
        task.status,
        timeEstimatesEnabled,
        visibleEditAttachments.length,
    ]);

    const showProjectField = useMemo(() => {
        return showDetails || !hiddenSet.has('project') || hasValue('project');
    }, [hasValue, hiddenSet, showDetails]);

    const fieldIdsToRender = useMemo(() => {
        if (showDetails) return editorFieldIds;
        return editorFieldIds.filter((fieldId) => !hiddenSet.has(fieldId) || hasValue(fieldId));
    }, [editorFieldIds, hasValue, hiddenSet, showDetails]);

    const renderField = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'description':
                return (
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
                );
            case 'attachments':
                return (
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
                        {attachmentError && (
                            <div className="text-xs text-red-400">{attachmentError}</div>
                        )}
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
                );
            case 'startTime':
                return (
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
                );
            case 'reviewAt':
                return (
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
                );
            case 'status':
                return (
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
                );
            case 'priority':
                return (
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.priorityLabel')}</label>
                        <select
                            value={editPriority}
                            aria-label={t('taskEdit.priorityLabel')}
                            onChange={(e) => setEditPriority(e.target.value as TaskPriority | '')}
                            className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                        >
                            <option value="">{t('common.none')}</option>
                            <option value="low">{t('priority.low')}</option>
                            <option value="medium">{t('priority.medium')}</option>
                            <option value="high">{t('priority.high')}</option>
                            <option value="urgent">{t('priority.urgent')}</option>
                        </select>
                    </div>
                );
            case 'recurrence':
                return (
                    <div className="flex flex-col gap-1 w-full">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.recurrenceLabel')}</label>
                        <select
                            value={editRecurrence}
                            aria-label="Recurrence"
                            onChange={(e) => {
                                const value = e.target.value as RecurrenceRule | '';
                                setEditRecurrence(value);
                                if (value === 'weekly') {
                                    const parsed = parseRRuleString(editRecurrenceRRule);
                                    if (!editRecurrenceRRule || parsed.rule !== 'weekly') {
                                        setEditRecurrenceRRule(buildRRuleString('weekly'));
                                    }
                                }
                                if (value === 'monthly') {
                                    const parsed = parseRRuleString(editRecurrenceRRule);
                                    if (!editRecurrenceRRule || parsed.rule !== 'monthly') {
                                        setEditRecurrenceRRule(buildRRuleString('monthly'));
                                    }
                                }
                                if (!value) {
                                    setEditRecurrenceRRule('');
                                }
                            }}
                            className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
                        >
                            <option value="">{t('recurrence.none')}</option>
                            <option value="daily">{t('recurrence.daily')}</option>
                            <option value="weekly">{t('recurrence.weekly')}</option>
                            <option value="monthly">{t('recurrence.monthly')}</option>
                            <option value="yearly">{t('recurrence.yearly')}</option>
                        </select>
                        {editRecurrence && (
                            <label className="flex items-center gap-2 pt-1 text-[10px] text-muted-foreground">
                                <input
                                    type="checkbox"
                                    checked={editRecurrenceStrategy === 'fluid'}
                                    onChange={(e) => setEditRecurrenceStrategy(e.target.checked ? 'fluid' : 'strict')}
                                    className="accent-primary"
                                />
                                {t('recurrence.afterCompletion')}
                            </label>
                        )}
                        {editRecurrence === 'weekly' && (
                            <div className="pt-1">
                                <span className="text-[10px] text-muted-foreground">Repeat on</span>
                                <WeekdaySelector
                                    value={editRecurrenceRRule || buildRRuleString('weekly')}
                                    onChange={(rrule) => setEditRecurrenceRRule(rrule)}
                                    className="pt-1"
                                />
                            </div>
                        )}
                        {editRecurrence === 'monthly' && (
                            <div className="pt-1 space-y-2">
                                <span className="text-[10px] text-muted-foreground">Repeat on</span>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setEditRecurrenceRRule(buildRRuleString('monthly'))}
                                        className={cn(
                                            'text-[10px] px-2 py-1 rounded border transition-colors',
                                            monthlyPattern === 'date'
                                                ? 'bg-primary text-primary-foreground border-primary'
                                                : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                                        )}
                                    >
                                        {t('recurrence.monthlyOnDay')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setEditRecurrenceRRule(`FREQ=MONTHLY;BYDAY=-1${monthlyWeekdayCode}`)}
                                        className={cn(
                                            'text-[10px] px-2 py-1 rounded border transition-colors',
                                            monthlyPattern === 'last'
                                                ? 'bg-primary text-primary-foreground border-primary'
                                                : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                                        )}
                                    >
                                        {t('recurrence.monthlyOnLastWeekday').replace('{weekday}', monthlyWeekdayLabel)}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                );
            case 'timeEstimate':
                return (
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
                );
            case 'contexts':
                return (
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
                );
            case 'tags':
                return (
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
                            {popularTagOptions.map(tag => {
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
                );
            case 'checklist':
                return (
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
                                        id: generateUUID(),
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
                );
            default:
                return null;
        }
    };

    useEffect(() => {
        if (isEditing && !wasEditingRef.current) {
            setShowDetails(false);
        }
        if (!isEditing) {
            wasEditingRef.current = false;
            return;
        }
        wasEditingRef.current = true;
    }, [isEditing]);

    useEffect(() => {
        if (isEditing) {
            setIsViewOpen(false);
        }
    }, [isEditing]);

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
            setAttachmentError(t('attachments.fileNotSupported'));
            return;
        }
        setAttachmentError(null);
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
        setAttachmentError(null);
        setShowLinkPrompt(true);
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
        setEditRecurrence(getRecurrenceRuleValue(task.recurrence));
        setEditRecurrenceStrategy(getRecurrenceStrategyValue(task.recurrence));
        setEditRecurrenceRRule(getRecurrenceRRuleValue(task.recurrence));
        setEditTimeEstimate(task.timeEstimate || '');
        setEditPriority(task.priority || '');
        setEditReviewAt(toDateTimeLocalValue(task.reviewAt));
        setEditAttachments(task.attachments || []);
        setAttachmentError(null);
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
        if (copilotSuggestion.timeEstimate && timeEstimatesEnabled) {
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
                if (copilotAbortRef.current) copilotAbortRef.current.abort();
                const abortController = typeof AbortController === 'function' ? new AbortController() : null;
                copilotAbortRef.current = abortController;
                const suggestion = await provider.predictMetadata(
                    {
                        title: input,
                        contexts: Array.from(new Set([...PRESET_CONTEXTS, ...currentContexts])),
                        tags: tagOptions,
                    },
                    abortController ? { signal: abortController.signal } : undefined
                );
                if (cancelled) return;
                if (!suggestion.context && (!timeEstimatesEnabled || !suggestion.timeEstimate) && !suggestion.tags?.length) {
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
            if (copilotAbortRef.current) {
                copilotAbortRef.current.abort();
                copilotAbortRef.current = null;
            }
        };
    }, [aiEnabled, aiProvider, editTitle, editDescription, editContexts, settings, timeEstimatesEnabled]);

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
            setAiError(t('ai.disabledBody'));
            return null;
        }
        const apiKey = loadAIKey(aiProvider);
        if (!apiKey) {
            setAiError(t('ai.missingKeyBody'));
            return null;
        }
        return createAIProvider(buildAIConfig(settings, apiKey));
    };

    const applyAISuggestion = (suggested: { title?: string; context?: string; timeEstimate?: TimeEstimate }) => {
        if (suggested.title) setEditTitle(suggested.title);
        if (suggested.timeEstimate && timeEstimatesEnabled) setEditTimeEstimate(suggested.timeEstimate);
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
        } finally {
            setIsAIWorking(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (editTitle.trim()) {
            const recurrenceValue: Recurrence | undefined = editRecurrence
                ? { rule: editRecurrence, strategy: editRecurrenceStrategy }
                : undefined;
            if (recurrenceValue && editRecurrenceRRule) {
                const parsed = parseRRuleString(editRecurrenceRRule);
                if (parsed.byDay && parsed.byDay.length > 0) {
                    recurrenceValue.byDay = parsed.byDay;
                }
                recurrenceValue.rrule = editRecurrenceRRule;
            }
            updateTask(task.id, {
                title: editTitle,
                dueDate: editDueDate || undefined,
                startTime: editStartTime || undefined,
                projectId: editProjectId || undefined,
                contexts: editContexts.split(',').map(c => c.trim()).filter(Boolean),
                tags: editTags.split(',').map(c => c.trim()).filter(Boolean),
                description: editDescription || undefined,
                location: editLocation || undefined,
                recurrence: recurrenceValue,
                timeEstimate: editTimeEstimate || undefined,
                priority: editPriority || undefined,
                reviewAt: editReviewAt || undefined,
                attachments: editAttachments.length > 0 ? editAttachments : undefined,
            });
            setIsEditing(false);
        }
    };

    const project = propProject || (task.projectId ? projectById.get(task.projectId) : undefined);
    const projectColor = project?.areaId ? areaById.get(project.areaId)?.color : undefined;

    return (
        <>
        <div
            data-task-id={task.id}
            onClickCapture={onSelect ? () => onSelect?.() : undefined}
            className={cn(
                "group bg-card border border-border rounded-lg p-4 hover:shadow-md transition-all animate-in fade-in slide-in-from-bottom-2 border-l-4",
                isSelected && "ring-2 ring-primary/40",
                isHighlighted && "ring-2 ring-primary/70 border-primary/40"
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

                {isEditing ? (
                    <div className="flex-1 min-w-0">
                        <TaskItemEditor
                            t={t}
                            editTitle={editTitle}
                            setEditTitle={setEditTitle}
                            resetCopilotDraft={resetCopilotDraft}
                            aiEnabled={aiEnabled}
                            isAIWorking={isAIWorking}
                            handleAIClarify={handleAIClarify}
                            handleAIBreakdown={handleAIBreakdown}
                            copilotSuggestion={copilotSuggestion}
                            copilotApplied={copilotApplied}
                            applyCopilotSuggestion={applyCopilotSuggestion}
                            copilotContext={copilotContext}
                            copilotEstimate={copilotEstimate}
                            copilotTags={copilotSuggestion?.tags ?? []}
                            timeEstimatesEnabled={timeEstimatesEnabled}
                            aiError={aiError}
                            aiBreakdownSteps={aiBreakdownSteps}
                            onAddBreakdownSteps={() => {
                                if (!aiBreakdownSteps?.length) return;
                                const newItems = aiBreakdownSteps.map((step) => ({
                                    id: generateUUID(),
                                    title: step,
                                    isCompleted: false,
                                }));
                                updateTask(task.id, { checklist: [...(task.checklist || []), ...newItems] });
                                setAiBreakdownSteps(null);
                            }}
                            onDismissBreakdown={() => setAiBreakdownSteps(null)}
                            aiClarifyResponse={aiClarifyResponse}
                            onSelectClarifyOption={(action) => {
                                setEditTitle(action);
                                setAiClarifyResponse(null);
                            }}
                            onApplyAISuggestion={() => {
                                if (aiClarifyResponse?.suggestedAction) {
                                    applyAISuggestion(aiClarifyResponse.suggestedAction);
                                }
                            }}
                            onDismissClarify={() => setAiClarifyResponse(null)}
                            projects={projects}
                            editProjectId={editProjectId}
                            setEditProjectId={setEditProjectId}
                            onCreateProject={handleCreateProject}
                            showProjectField={showProjectField}
                            editDueDate={editDueDate}
                            setEditDueDate={setEditDueDate}
                            showDetails={showDetails}
                            toggleDetails={() => setShowDetails((prev) => !prev)}
                            fieldIdsToRender={fieldIdsToRender}
                            renderField={renderField}
                            editLocation={editLocation}
                            setEditLocation={setEditLocation}
                            inputContexts={allContexts}
                            onDuplicateTask={() => duplicateTask(task.id, false)}
                            onCancel={() => {
                                resetEditState();
                                setIsEditing(false);
                            }}
                            onSubmit={handleSubmit}
                        />
                    </div>
                ) : (
                    <TaskItemDisplay
                        task={task}
                        project={project}
                        projectColor={projectColor}
                        selectionMode={selectionMode}
                        isViewOpen={isViewOpen}
                        onToggleSelect={onToggleSelect}
                        onToggleView={() => setIsViewOpen((prev) => !prev)}
                        onEdit={() => {
                            resetEditState();
                            setIsViewOpen(false);
                            setIsEditing(true);
                        }}
                        onDelete={() => deleteTask(task.id)}
                        onStatusChange={(status) => moveTask(task.id, status)}
                        openAttachment={openAttachment}
                        visibleAttachments={visibleAttachments}
                        recurrenceRule={recurrenceRule}
                        recurrenceStrategy={recurrenceStrategy}
                        prioritiesEnabled={prioritiesEnabled}
                        timeEstimatesEnabled={timeEstimatesEnabled}
                        isStagnant={isStagnant}
                        t={t}
                    />
                )}
            </div>
        </div >
        <PromptModal
            isOpen={showLinkPrompt}
            title={t('attachments.addLink')}
            description={t('attachments.linkPlaceholder')}
            placeholder={t('attachments.linkPlaceholder')}
            defaultValue=""
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setShowLinkPrompt(false)}
            onConfirm={(value) => {
                const normalized = normalizeAttachmentInput(value);
                if (!normalized.uri) return;
                const now = new Date().toISOString();
                const attachment: Attachment = {
                    id: generateUUID(),
                    kind: normalized.kind,
                    title: normalized.title,
                    uri: normalized.uri,
                    createdAt: now,
                    updatedAt: now,
                };
                setEditAttachments((prev) => [...prev, attachment]);
                setShowLinkPrompt(false);
            }}
        />
        </>
    );
});
