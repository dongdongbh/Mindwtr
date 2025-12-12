import { useMemo } from 'react';
import { useTaskStore, Task, getTaskAgeLabel, getTaskStaleness, type TaskStatus, safeFormatDate, safeParseDate } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { Clock, Star, Calendar, AlertCircle, PlayCircle, ArrowRight, type LucideIcon } from 'lucide-react';

export function AgendaView() {
    const { tasks, updateTask } = useTaskStore();
    const { t } = useLanguage();

    // Filter active tasks
    const activeTasks = useMemo(() =>
        tasks.filter(t => !t.deletedAt && t.status !== 'done' && t.status !== 'archived'),
        [tasks]
    );

    // Today's Focus: tasks marked as isFocusedToday (max 3)
    const focusedTasks = useMemo(() =>
        activeTasks.filter(t => t.isFocusedToday).slice(0, 3),
        [activeTasks]
    );

    const focusedCount = focusedTasks.length;

    // Categorize tasks
    const sections = useMemo(() => {
        const now = new Date();
        const todayStr = now.toDateString();

        const inProgress = activeTasks.filter(t => t.status === 'in-progress' && !t.isFocusedToday);
        const overdue = activeTasks.filter(t => {
            if (!t.dueDate) return false;
            const dueDate = safeParseDate(t.dueDate);
            return dueDate && dueDate < now && t.status !== 'in-progress' && !t.isFocusedToday;
        });
        const dueToday = activeTasks.filter(t => {
            if (!t.dueDate) return false;
            const dueDate = safeParseDate(t.dueDate);
            return dueDate && dueDate.toDateString() === todayStr &&
                t.status !== 'in-progress' && !t.isFocusedToday;
        });
        const nextActions = activeTasks.filter(t =>
            t.status === 'next' && !t.isFocusedToday
        ).slice(0, 5);

        return { inProgress, overdue, dueToday, nextActions };
    }, [activeTasks]);

    const handleToggleFocus = (taskId: string) => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        if (task.isFocusedToday) {
            updateTask(taskId, { isFocusedToday: false });
        } else if (focusedCount < 3) {
            updateTask(taskId, { isFocusedToday: true });
        }
    };

    const handleStatusChange = (taskId: string, status: string) => {
        updateTask(taskId, { status: status as TaskStatus });
    };

    const TaskCard = ({ task, showFocusToggle = true }: { task: Task; showFocusToggle?: boolean }) => {
        const canFocus = task.isFocusedToday || focusedCount < 3;
        const ageLabel = getTaskAgeLabel(task.createdAt);
        const staleness = getTaskStaleness(task.createdAt);

        return (
            <div className={cn(
                "bg-card border rounded-lg p-4 hover:shadow-md transition-all",
                task.isFocusedToday && "border-yellow-500 bg-yellow-50/50 dark:bg-yellow-950/20"
            )}>
                <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            {task.isFocusedToday && <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />}
                            <span className={cn(
                                "font-medium truncate",
                                task.status === 'done' && "line-through text-muted-foreground"
                            )}>
                                {task.title}
                            </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
                            {task.status && (
                                <span className={cn(
                                    "px-2 py-0.5 rounded-full text-white",
                                    task.status === 'in-progress' && "bg-red-500",
                                    task.status === 'next' && "bg-blue-500",
                                    task.status === 'todo' && "bg-green-500",
                                    task.status === 'waiting' && "bg-orange-500"
                                )}>
                                    {task.status}
                                </span>
                            )}

                            {task.dueDate && (
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <Calendar className="w-3 h-3" />
                                    {safeFormatDate(task.dueDate, 'P')}
                                </span>
                            )}

                            {ageLabel && task.status !== 'done' && (
                                <span className={cn(
                                    "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]",
                                    staleness === 'fresh' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                                    staleness === 'aging' && 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
                                    staleness === 'stale' && 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
                                    staleness === 'very-stale' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                )}>
                                    <Clock className="w-3 h-3" />
                                    {ageLabel}
                                </span>
                            )}

                            {task.contexts?.slice(0, 2).map(ctx => (
                                <span key={ctx} className="text-muted-foreground">{ctx}</span>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {showFocusToggle && (
                            <button
                                onClick={() => handleToggleFocus(task.id)}
                                disabled={!canFocus && !task.isFocusedToday}
                                className={cn(
                                    "p-1.5 rounded-full transition-colors",
                                    task.isFocusedToday
                                        ? "text-yellow-500 hover:bg-yellow-100 dark:hover:bg-yellow-900/30"
                                        : canFocus
                                            ? "text-muted-foreground hover:text-yellow-500 hover:bg-muted"
                                            : "text-muted-foreground/30 cursor-not-allowed"
                                )}
                                title={task.isFocusedToday ? "Remove from focus" : focusedCount >= 3 ? "Max 3 focus items" : "Add to today's focus"}
                            >
                                <Star className={cn("w-4 h-4", task.isFocusedToday && "fill-current")} />
                            </button>
                        )}

                        <select
                            value={task.status}
                            onChange={(e) => handleStatusChange(task.id, e.target.value)}
                            className="text-xs px-2 py-1 rounded bg-muted border border-border"
                        >
                            <option value="todo">Todo</option>
                            <option value="next">Next</option>
                            <option value="in-progress">In Progress</option>
                            <option value="done">Done</option>
                        </select>
                    </div>
                </div>
            </div>
        );
    };

    const Section = ({ title, icon: Icon, tasks, color }: {
        title: string;
        icon: LucideIcon;
        tasks: Task[];
        color: string;
    }) => {
        if (tasks.length === 0) return null;

        return (
            <div className="space-y-3">
                <h3 className={cn("font-semibold flex items-center gap-2", color)}>
                    <Icon className="w-5 h-5" />
                    {title}
                    <span className="text-muted-foreground font-normal">({tasks.length})</span>
                </h3>
                <div className="space-y-2">
                    {tasks.map(task => (
                        <TaskCard key={task.id} task={task} />
                    ))}
                </div>
            </div>
        );
    };

    const totalActive = activeTasks.length;

    return (
        <div className="space-y-6 max-w-4xl">
            <header>
                <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                    <Calendar className="w-8 h-8" />
                    {t('agenda.title')}
                </h2>
                <p className="text-muted-foreground">
                    {totalActive} {t('agenda.active')}
                </p>
            </header>

            {/* Today's Focus Section */}
            <div className="bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-950/20 dark:to-orange-950/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-6">
                <h3 className="font-bold text-lg flex items-center gap-2 mb-4">
                    <Star className="w-5 h-5 text-yellow-500 fill-yellow-500" />
                    {t('agenda.todaysFocus')}
                    <span className="text-sm font-normal text-muted-foreground">
                        ({focusedCount}/3)
                    </span>
                </h3>

                {focusedTasks.length > 0 ? (
                    <div className="space-y-2">
                        {focusedTasks.map(task => (
                            <TaskCard key={task.id} task={task} showFocusToggle={true} />
                        ))}
                    </div>
                ) : (
                    <p className="text-muted-foreground text-center py-4">
                        ⭐ Click the star on any task below to add it to today's focus (max 3)
                    </p>
                )}
            </div>

            {/* Other Sections */}
            <div className="space-y-6">
                <Section
                    title={t('agenda.inProgress')}
                    icon={PlayCircle}
                    tasks={sections.inProgress}
                    color="text-red-600"
                />

                <Section
                    title={t('agenda.overdue')}
                    icon={AlertCircle}
                    tasks={sections.overdue}
                    color="text-red-600"
                />

                <Section
                    title={t('agenda.dueToday')}
                    icon={Calendar}
                    tasks={sections.dueToday}
                    color="text-yellow-600"
                />

                <Section
                    title={t('agenda.nextActions')}
                    icon={ArrowRight}
                    tasks={sections.nextActions}
                    color="text-blue-600"
                />
            </div>

            {totalActive === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                    <p className="text-4xl mb-4">✨</p>
                    <p className="text-lg font-medium">{t('agenda.allClear')}</p>
                    <p>{t('agenda.noTasks')}</p>
                </div>
            )}
        </div>
    );
}
