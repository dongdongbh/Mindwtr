import { useState, memo } from 'react';

import { Calendar as CalendarIcon, Tag, Trash2, ArrowRight, Repeat, Check, Plus, Clock, Timer } from 'lucide-react';
import { Task, TaskStatus, TimeEstimate, getTaskAgeLabel, getTaskStaleness, getTaskUrgency, getStatusColor, Project, safeFormatDate } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { cn } from '../lib/utils';


interface TaskItemProps {
    task: Task;
    project?: Project;
}

export const TaskItem = memo(function TaskItem({ task, project: propProject }: TaskItemProps) {
    const { updateTask, deleteTask, moveTask, projects, tasks } = useTaskStore();
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState(task.title);
    const [editDueDate, setEditDueDate] = useState(task.dueDate || '');
    const [editStartTime, setEditStartTime] = useState(task.startTime || '');
    const [editProjectId, setEditProjectId] = useState(task.projectId || '');
    const [editContexts, setEditContexts] = useState(task.contexts?.join(', ') || '');
    const [editTags, setEditTags] = useState(task.tags?.join(', ') || '');
    const [editDescription, setEditDescription] = useState(task.description || '');
    const [editLocation, setEditLocation] = useState(task.location || '');
    const [editRecurrence, setEditRecurrence] = useState(task.recurrence || '');
    const [editTimeEstimate, setEditTimeEstimate] = useState<TimeEstimate | ''>(task.timeEstimate || '');

    const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        moveTask(task.id, e.target.value as TaskStatus);
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
                timeEstimate: editTimeEstimate || undefined
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
            className="group bg-card border border-border rounded-lg p-4 hover:shadow-md transition-all animate-in fade-in slide-in-from-bottom-2 border-l-4"
            style={{ borderLeftColor: getStatusColor(task.status).border }}
        >
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    aria-label="Mark task as done"
                    checked={task.status === 'done'}
                    onChange={() => moveTask(task.id, task.status === 'done' ? 'inbox' : 'done')}
                    className="mt-1.5 h-4 w-4 rounded border-primary text-primary focus:ring-primary cursor-pointer"
                />

                <div className="flex-1 min-w-0">
                    {isEditing ? (
                        <form onSubmit={handleSubmit} className="space-y-3">
                            <input
                                autoFocus
                                type="text"
                                aria-label="Task title"
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                className="w-full bg-transparent border-b border-primary/50 p-1 text-base font-medium focus:ring-0 focus:border-primary outline-none"
                                placeholder="Task title"
                            />
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground font-medium">Description</label>
                                <textarea
                                    aria-label="Task description"
                                    value={editDescription}
                                    onChange={(e) => setEditDescription(e.target.value)}
                                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 min-h-[60px] resize-y"
                                    placeholder="Add notes..."
                                />
                            </div>
                            <div className="flex flex-wrap gap-4">
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground font-medium">Start Time</label>
                                    <input
                                        type="datetime-local"
                                        aria-label="Start time"
                                        value={editStartTime}
                                        onChange={(e) => setEditStartTime(e.target.value)}
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground font-medium">Deadline</label>
                                    <input
                                        type="datetime-local"
                                        aria-label="Deadline"
                                        value={editDueDate}
                                        onChange={(e) => setEditDueDate(e.target.value)}
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground font-medium">Status</label>
                                    <select
                                        value={task.status}
                                        aria-label="Status"
                                        onChange={handleStatusChange}
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1"
                                    >
                                        <option value="inbox">Inbox</option>
                                        <option value="todo">Todo</option>
                                        <option value="next">Next</option>
                                        <option value="in-progress">In Progress</option>
                                        <option value="waiting">Waiting</option>
                                        <option value="someday">Someday</option>
                                        <option value="done">Done</option>
                                        <option value="archived">Archived</option>
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground font-medium">Project</label>
                                    <select
                                        value={editProjectId}
                                        aria-label="Project"
                                        onChange={(e) => setEditProjectId(e.target.value)}
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1"
                                    >
                                        <option value="">No Project</option>
                                        {projects.map(p => (
                                            <option key={p.id} value={p.id}>{p.title}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground font-medium">Location</label>
                                    <input
                                        type="text"
                                        aria-label="Location"
                                        value={editLocation}
                                        onChange={(e) => setEditLocation(e.target.value)}
                                        placeholder="e.g. Office"
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1"
                                    />
                                </div>
                                <div className="flex flex-col gap-1 w-full">
                                    <label className="text-xs text-muted-foreground font-medium">Recurrence</label>
                                    <select
                                        value={editRecurrence}
                                        aria-label="Recurrence"
                                        onChange={(e) => setEditRecurrence(e.target.value)}
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full"
                                    >
                                        <option value="">None</option>
                                        <option value="daily">Daily</option>
                                        <option value="weekly">Weekly</option>
                                        <option value="monthly">Monthly</option>
                                        <option value="yearly">Yearly</option>
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1 w-full">
                                    <label className="text-xs text-muted-foreground font-medium">Time Estimate</label>
                                    <select
                                        value={editTimeEstimate}
                                        aria-label="Time estimate"
                                        onChange={(e) => setEditTimeEstimate(e.target.value as TimeEstimate | '')}
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full"
                                    >
                                        <option value="">No estimate</option>
                                        <option value="5min">5 minutes</option>
                                        <option value="15min">15 minutes</option>
                                        <option value="30min">30 minutes</option>
                                        <option value="1hr">1 hour</option>
                                        <option value="2hr+">2+ hours</option>
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1 w-full">
                                    <label className="text-xs text-muted-foreground font-medium">Contexts (comma separated)</label>
                                    <input
                                        type="text"
                                        aria-label="Contexts"
                                        value={editContexts}
                                        onChange={(e) => setEditContexts(e.target.value)}
                                        placeholder="@home, @work"
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full"
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
                                    <label className="text-xs text-muted-foreground font-medium">Tags (comma separated)</label>
                                    <input
                                        type="text"
                                        aria-label="Tags"
                                        value={editTags}
                                        onChange={(e) => setEditTags(e.target.value)}
                                        placeholder="#urgent, #idea"
                                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full"
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
                                    <label className="text-xs text-muted-foreground font-medium">Checklist</label>
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
                                                    placeholder="Item name"
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
                                            Add Item
                                        </button>
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
                                    type="submit"
                                    className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded hover:bg-primary/90"
                                >
                                    Save
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsEditing(false)}
                                    className="text-xs bg-muted text-muted-foreground px-3 py-1.5 rounded hover:bg-muted/80"
                                >
                                    Cancel
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div
                            role="button"
                            tabIndex={0}
                            aria-label={`Edit task: ${task.title}, ${task.status}. Press Enter to edit.`}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setIsEditing(true);
                                }
                            }}
                            onClick={() => setIsEditing(true)}
                            className="group/content cursor-pointer rounded -ml-2 pl-2 pr-1 py-1 hover:bg-muted/40 focus:bg-muted/40 focus:ring-2 focus:ring-primary focus:outline-none transition-colors"
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
                                    {task.description}
                                </p>
                            )}

                            <div className="flex flex-wrap items-center gap-4 mt-2 text-xs">
                                {project && (
                                    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/50 text-accent-foreground font-medium text-[10px]">
                                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
                                        {project.title}
                                    </div>
                                )}
                                {task.startTime && (
                                    <div className="flex items-center gap-1 text-blue-500/80" title="Start Time">
                                        <ArrowRight className="w-3 h-3" />
                                        {safeFormatDate(task.startTime, 'MMM d, HH:mm')}
                                    </div>
                                )}
                                {task.dueDate && (
                                    <div className={cn("flex items-center gap-1", getUrgencyColor())} title="Deadline">
                                        <CalendarIcon className="w-3 h-3" />
                                        {safeFormatDate(task.dueDate, 'MMM d, HH:mm')}
                                    </div>
                                )}
                                {task.location && (
                                    <div className="flex items-center gap-1 text-muted-foreground" title="Location">
                                        <span className="font-medium">📍 {task.location}</span>
                                    </div>
                                )}
                                {task.recurrence && (
                                    <div className="flex items-center gap-1 text-purple-600" title="Recurrence">
                                        <Repeat className="w-3 h-3" />
                                        <span className="capitalize">{task.recurrence}</span>
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
                                {/* Task Age Indicator */}
                                {task.status !== 'done' && getTaskAgeLabel(task.createdAt) && (
                                    <div className={cn(
                                        "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full",
                                        getTaskStaleness(task.createdAt) === 'fresh' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                                        getTaskStaleness(task.createdAt) === 'aging' && 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
                                        getTaskStaleness(task.createdAt) === 'stale' && 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
                                        getTaskStaleness(task.createdAt) === 'very-stale' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                    )} title="Task age">
                                        <Clock className="w-3 h-3" />
                                        {getTaskAgeLabel(task.createdAt)}
                                    </div>
                                )}
                                {/* Time Estimate Badge */}
                                {task.timeEstimate && (
                                    <div className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" title="Estimated time">
                                        <Timer className="w-3 h-3" />
                                        {task.timeEstimate === '5min' && '5m'}
                                        {task.timeEstimate === '15min' && '15m'}
                                        {task.timeEstimate === '30min' && '30m'}
                                        {task.timeEstimate === '1hr' && '1h'}
                                        {task.timeEstimate === '2hr+' && '2h+'}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {!isEditing && (
                    <div
                        className="flex items-center gap-2"
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        <select
                            value={task.status}
                            aria-label="Task status"
                            onChange={handleStatusChange}
                            className="text-xs px-2 py-1 rounded cursor-pointer bg-white text-black border border-slate-400 hover:bg-slate-100"
                        >
                            <option value="inbox">Inbox</option>
                            <option value="todo">Todo</option>
                            <option value="next">Next</option>
                            <option value="in-progress">In Progress</option>
                            <option value="someday">Someday</option>
                            <option value="waiting">Waiting</option>
                            <option value="done">Done</option>
                            <option value="archived">Archived</option>
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
