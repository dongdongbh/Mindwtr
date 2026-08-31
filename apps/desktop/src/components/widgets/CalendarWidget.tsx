import { useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Droplet, Lock, Plus, Trash2, Unlock, X } from 'lucide-react';

import type { AppData, Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../../contexts/language-context';
import { closeWidgetWindow, focusMainWindow } from './widget-actions';
import {
    buildWidgetMonthGrid,
    getTodayKey,
    isWidgetLocked,
    readWidgetOpacity,
    resolveWeekStart,
    setWidgetLocked,
    writeWidgetOpacity,
} from './widget-data';

interface CalendarWidgetProps {
    data: AppData | null;
    /** False until the shared store has hydrated; writes before that would persist an incomplete snapshot. */
    canWrite: boolean;
    onRefresh: () => Promise<void>;
}

const MAX_TASKS_PER_CELL = 3;

export function CalendarWidget({ data, canWrite, onRefresh }: CalendarWidgetProps) {
    const { language, t } = useLanguage();
    const now = useMemo(() => new Date(), []);
    const todayKey = useMemo(() => getTodayKey(now), [now]);
    const [selectedKey, setSelectedKey] = useState(todayKey);
    const [cursor, setCursor] = useState(() => ({ year: now.getFullYear(), monthIndex: now.getMonth() }));
    const [locked, setLocked] = useState(() => isWidgetLocked('calendar'));
    const [modalDay, setModalDay] = useState<string | null>(null);
    const [modalDraft, setModalDraft] = useState('');
    const [adding, setAdding] = useState(false);
    const [opacity, setOpacity] = useState(() => readWidgetOpacity('calendar'));
    const [opacityOpen, setOpacityOpen] = useState(false);

    const weekStart = resolveWeekStart(data?.settings.weekStart, language);

    // Tasks bucketed per day for the month grid: active tasks land on their
    // due/start day, completed tasks on their completion day.
    const tasksByDay = useMemo(() => {
        const buckets = new Map<string, Task[]>();
        const push = (key: string | null | undefined, task: Task) => {
            if (!key) return;
            const dayKey = key.slice(0, 10);
            const bucket = buckets.get(dayKey);
            if (bucket) bucket.push(task);
            else buckets.set(dayKey, [task]);
        };
        for (const task of data?.tasks ?? []) {
            if (task.status === 'done' || task.status === 'archived') {
                if (task.completedAt) push(task.completedAt, task);
                continue;
            }
            const scheduled = task.startTime ?? task.dueDate;
            if (scheduled) push(scheduled, task);
        }
        for (const bucket of buckets.values()) bucket.sort(compareCellTasks);
        return buckets;
    }, [data]);

    const grid = useMemo(
        () => buildWidgetMonthGrid(cursor.year, cursor.monthIndex, { weekStart, todayKey, dueKeys: new Set(tasksByDay.keys()), localeCode: language }),
        [cursor.year, cursor.monthIndex, weekStart, todayKey, tasksByDay, language],
    );

    const monthLabel = useMemo(() => {
        const formatter = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' });
        return formatter.format(new Date(cursor.year, cursor.monthIndex, 1));
    }, [cursor, language]);

    const modalTasks = modalDay ? tasksByDay.get(modalDay) ?? [] : [];

    const shiftMonth = (delta: number) => {
        setCursor((current) => {
            const date = new Date(current.year, current.monthIndex + delta, 1);
            return { year: date.getFullYear(), monthIndex: date.getMonth() };
        });
    };

    const toggleLock = () => {
        setWidgetLocked('calendar', !locked);
        setLocked(!locked);
    };

    const changeOpacity = (value: number) => {
        setOpacity(value);
        writeWidgetOpacity('calendar', value);
    };

    const addTaskToDay = async (dayKey: string, title: string): Promise<void> => {
        const trimmed = title.trim();
        if (!trimmed || adding || !canWrite) return;
        setAdding(true);
        try {
            // Writing goes through the shared store so persistence, validation
            // and recurrence normalization stay identical to the main window;
            // the main window's data watcher picks the file change up on its own.
            await useTaskStore.getState().addTask(trimmed, { dueDate: dayKey });
            await onRefresh();
        } catch {
            // Snapshot refresh will reconcile; the draft keeps its text on failure.
        } finally {
            setAdding(false);
        }
    };

    const onModalDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void addTaskToDay(modalDay ?? '', modalDraft).then(() => setModalDraft(''));
        }
    };

    const deleteTask = async (id: string) => {
        if (!canWrite) return;
        try {
            await useTaskStore.getState().deleteTask(id);
            await onRefresh();
        } catch {
            // Snapshot refresh will reconcile.
        }
    };

    const openDayModal = (dayKey: string) => {
        setSelectedKey(dayKey);
        setModalDraft('');
        setModalDay(dayKey);
    };

    const weekRows = Math.ceil((grid.leadingBlanks + grid.cells.length) / 7);

    return (
        <div
            className="relative flex h-full flex-col gap-2 rounded-lg border border-border p-3 text-foreground shadow-xl"
            style={{ background: `hsl(var(--popover) / ${opacity / 100})` }}
        >
            <div className="flex items-center justify-between" data-tauri-drag-region={!locked || undefined}>
                <div className="flex items-center gap-1" data-tauri-drag-region={!locked || undefined}>
                    <button
                        type="button"
                        onClick={() => shiftMonth(-1)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-label={t('widget.previousMonth')}
                    >
                        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setCursor({ year: now.getFullYear(), monthIndex: now.getMonth() })}
                        className="rounded px-2 py-0.5 text-sm font-semibold hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                        title={t('widget.backToToday')}
                    >
                        {monthLabel}
                    </button>
                    <button
                        type="button"
                        onClick={() => shiftMonth(1)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-label={t('widget.nextMonth')}
                    >
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
                <div className="relative flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setOpacityOpen(!opacityOpen)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-expanded={opacityOpen}
                        aria-label={t('widget.opacity')}
                        title={t('widget.opacity')}
                    >
                        <Droplet className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {opacityOpen && (
                        <div className="absolute right-0 top-8 z-20 flex w-40 items-center gap-2 rounded-md border border-border bg-popover p-2 shadow-lg">
                            <input
                                type="range"
                                min={40}
                                max={100}
                                step={5}
                                value={opacity}
                                onChange={(event) => changeOpacity(Number(event.target.value))}
                                className="min-w-0 flex-1 accent-[var(--primary)]"
                                aria-label={t('widget.opacity')}
                            />
                            <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground">{opacity}%</span>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={toggleLock}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-pressed={locked}
                        aria-label={locked ? t('widget.unlockPosition') : t('widget.lockPosition')}
                        title={locked ? t('widget.unlockPosition') : t('widget.lockPosition')}
                    >
                        {locked ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                    <button
                        type="button"
                        onClick={() => void closeWidgetWindow()}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        aria-label={t('widget.close')}
                        title={t('widget.close')}
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-7 text-center text-xs uppercase text-muted-foreground">
                {grid.weekdayLabels.map((label, index) => (
                    <span key={`${label}-${index}`}>{label}</span>
                ))}
            </div>
            <div
                className="grid min-h-0 flex-1 grid-cols-7 gap-1"
                style={{ gridTemplateRows: `repeat(${weekRows}, minmax(0, 1fr))` }}
            >
                {Array.from({ length: grid.leadingBlanks }).map((_, index) => (
                    <div key={`blank-${index}`} aria-hidden="true" />
                ))}
                {grid.cells.map((cell) => {
                    const cellTasks = tasksByDay.get(cell.key) ?? [];
                    const visible = cellTasks.slice(0, MAX_TASKS_PER_CELL);
                    const overflow = cellTasks.length - visible.length;
                    return (
                        <button
                            key={cell.key}
                            type="button"
                            onClick={() => openDayModal(cell.key)}
                            aria-pressed={cell.key === selectedKey}
                            className={
                                'flex min-h-0 flex-col items-stretch overflow-hidden rounded-md border p-1 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ' +
                                (cell.key === selectedKey
                                    ? 'border-primary bg-primary/10'
                                    : cell.isToday
                                        ? 'border-primary/60 bg-muted/40 hover:bg-muted'
                                        : 'border-transparent hover:bg-muted')
                            }
                        >
                            <span className="flex items-center justify-between">
                                <span
                                    className={
                                        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] ' +
                                        (cell.isToday
                                            ? 'bg-primary font-semibold text-primary-foreground'
                                            : cell.inMonth
                                                ? 'text-foreground'
                                                : 'text-muted-foreground/60')
                                    }
                                >
                                    {cell.day}
                                </span>
                                {cellTasks.length > 0 && (
                                    <span className="text-[9px] text-muted-foreground">{cellTasks.length}</span>
                                )}
                            </span>
                            <span className="mt-0.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
                                {visible.map((task) => (
                                    <span
                                        key={task.id}
                                        className={
                                            'flex items-center gap-1 text-[10px] leading-tight ' +
                                            (task.status === 'done' || task.status === 'archived'
                                                ? 'text-muted-foreground line-through'
                                                : 'text-foreground/90')
                                        }
                                    >
                                        <span
                                            className={
                                                'h-1.5 w-1.5 shrink-0 rounded-full ' +
                                                (task.status === 'done' || task.status === 'archived'
                                                    ? 'bg-muted-foreground/50'
                                                    : task.priority === 'high'
                                                        ? 'bg-red-500'
                                                        : task.priority === 'medium'
                                                            ? 'bg-amber-500'
                                                            : 'bg-primary')
                                            }
                                            aria-hidden="true"
                                        />
                                        <span className="truncate">{task.title}</span>
                                    </span>
                                ))}
                                {overflow > 0 && (
                                    <span className="text-[9px] text-muted-foreground">+{overflow}</span>
                                )}
                            </span>
                        </button>
                    );
                })}
            </div>

            <div className="flex items-center gap-2 border-t border-border pt-2">
                <button
                    type="button"
                    onClick={() => void focusMainWindow()}
                    className="shrink-0 text-left text-xs font-semibold text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    title={t('widget.openInMainWindow')}
                >
                    {formatSelectedDayLabel(selectedKey, language, todayKey, t)}
                </button>
                <span className="ml-auto text-[10px] text-muted-foreground">{t('widget.clickDayToAdd')}</span>
            </div>

            {modalDay && (
                <div
                    className="absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-background/60 p-4 backdrop-blur-[2px]"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) setModalDay(null);
                    }}
                    role="presentation"
                >
                    <div className="flex max-h-full w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-popover p-4 shadow-2xl">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold">{formatDayLabel(modalDay, language, todayKey, t)}</span>
                            <button
                                type="button"
                                onClick={() => setModalDay(null)}
                                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                aria-label={t('widget.close')}
                            >
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>
                        <div className="flex items-center gap-1">
                            <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <input
                                type="text"
                                value={modalDraft}
                                onChange={(event) => setModalDraft(event.target.value)}
                                onKeyDown={onModalDraftKeyDown}
                                disabled={adding}
                                placeholder={t('widget.addTaskForDay')}
                                aria-label={t('widget.addTaskForDay')}
                                autoFocus
                                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            {modalTasks.length === 0 ? (
                                <p className="py-3 text-center text-xs text-muted-foreground">{t('widget.noTasksForDay')}</p>
                            ) : (
                                <ul className="space-y-1">
                                    {modalTasks.map((task) => (
                                        <li key={task.id} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-muted">
                                            <span
                                                className={
                                                    'h-2 w-2 shrink-0 rounded-full ' +
                                                    (task.status === 'done' || task.status === 'archived'
                                                        ? 'bg-muted-foreground/50'
                                                        : task.priority === 'high'
                                                            ? 'bg-red-500'
                                                            : task.priority === 'medium'
                                                                ? 'bg-amber-500'
                                                                : 'bg-primary')
                                                }
                                                aria-hidden="true"
                                            />
                                            <span
                                                className={
                                                    'min-w-0 flex-1 truncate text-xs ' +
                                                    (task.status === 'done' || task.status === 'archived'
                                                        ? 'text-muted-foreground line-through'
                                                        : 'text-foreground')
                                                }
                                                title={task.title}
                                            >
                                                {task.title}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => void deleteTask(task.id)}
                                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-red-500 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/40 group-hover:opacity-100"
                                                aria-label={t('widget.deleteTask')}
                                                title={t('widget.deleteTask')}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function compareCellTasks(a: Task, b: Task): number {
    const rank = (task: Task): number => {
        if (task.status === 'done' || task.status === 'archived') return 2;
        if (task.priority === 'high') return 0;
        return 1;
    };
    const delta = rank(a) - rank(b);
    if (delta !== 0) return delta;
    if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
    return a.title.localeCompare(b.title);
}

function formatDayLabel(
    key: string,
    language: string,
    todayKey: string,
    t: (key: string) => string,
): string {
    const date = new Date(`${key}T00:00:00`);
    if (Number.isNaN(date.getTime())) return key;
    const label = new Intl.DateTimeFormat(language, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
    return key === todayKey ? `${t('widget.today')} · ${label}` : label;
}

function formatSelectedDayLabel(
    key: string,
    language: string,
    todayKey: string,
    t: (key: string) => string,
): string {
    const date = new Date(`${key}T00:00:00`);
    if (Number.isNaN(date.getTime())) return key;
    const label = new Intl.DateTimeFormat(language, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
    return key === todayKey ? `${t('widget.today')} · ${label}` : label;
}
