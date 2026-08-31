import { useMemo, useState, type KeyboardEvent } from 'react';
import { Lock, Plus, StickyNote, Unlock, X } from 'lucide-react';

import type { AppData } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../../contexts/language-context';
import { closeWidgetWindow, focusMainWindow } from './widget-actions';
import { getTodayKey, isWidgetLocked, selectWidgetTasksForDay, setWidgetLocked } from './widget-data';

interface TodayNoteWidgetProps {
    data: AppData | null;
    /** False until the shared store has hydrated; writes before that would persist an incomplete snapshot. */
    canWrite: boolean;
    onRefresh: () => Promise<void>;
}

/** Sticky-note style widget listing today's tasks (due or starting today). */
export function TodayNoteWidget({ data, canWrite, onRefresh }: TodayNoteWidgetProps) {
    const { language, t } = useLanguage();
    const [locked, setLocked] = useState(() => isWidgetLocked('today'));
    const [draftTitle, setDraftTitle] = useState('');
    const [adding, setAdding] = useState(false);
    const todayKey = useMemo(() => getTodayKey(), []);
    const { dueToday, completedToday } = useMemo(
        () => selectWidgetTasksForDay(data, todayKey, { includeCompleted: true }),
        [data, todayKey],
    );

    const dayLabel = useMemo(() => {
        const formatter = new Intl.DateTimeFormat(language, { weekday: 'long', month: 'long', day: 'numeric' });
        return formatter.format(new Date());
    }, [language]);

    const openInMainWindow = () => {
        void focusMainWindow();
    };

    const submitDraft = async () => {
        const title = draftTitle.trim();
        if (!title || adding || !canWrite) return;
        setAdding(true);
        try {
            // Same shared-store write path as the calendar widget: persistence
            // stays identical to the main window, and the main window's data
            // watcher picks the file change up on its own.
            await useTaskStore.getState().addTask(title, { dueDate: todayKey });
            setDraftTitle('');
            await onRefresh();
        } catch {
            // Keep the draft text on failure so nothing is silently lost.
        } finally {
            setAdding(false);
        }
    };

    const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void submitDraft();
        }
    };

    return (
        <div className="flex h-full flex-col gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-foreground shadow-xl dark:border-amber-200/20 dark:bg-amber-900/30">
            <div className="flex items-center gap-2" data-tauri-drag-region={!locked || undefined}>
                <StickyNote className="h-4 w-4 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                <span className="text-sm font-semibold">{t('widget.today')}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">{dayLabel}</span>
                <button
                    type="button"
                    onClick={() => {
                        setWidgetLocked('today', !locked);
                        setLocked(!locked);
                    }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    aria-pressed={locked}
                    aria-label={locked ? t('widget.unlockPosition') : t('widget.lockPosition')}
                    title={locked ? t('widget.unlockPosition') : t('widget.lockPosition')}
                >
                    {locked ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
                <button
                    type="button"
                    onClick={() => void closeWidgetWindow()}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    aria-label={t('widget.close')}
                    title={t('widget.close')}
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>

            {dueToday.length === 0 && completedToday.length === 0 ? (
                <p className="flex flex-1 items-center justify-center px-2 text-center text-xs text-muted-foreground">
                    {t('widget.allClearToday')}
                </p>
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {dueToday.length > 0 && (
                        <ul className="space-y-1">
                            {dueToday.map((task) => (
                                <li key={task.id}>
                                    <button
                                        type="button"
                                        onClick={openInMainWindow}
                                        className="w-full rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-amber-100/70 focus:outline-none focus:ring-2 focus:ring-primary/40 dark:hover:bg-amber-800/40"
                                        title={task.title}
                                    >
                                        <span className={'block truncate' + (task.priority === 'high' ? ' font-semibold' : '')}>
                                            · {task.title}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {completedToday.length > 0 && (
                        <>
                            <p className="mt-2 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {t('widget.completedToday')}
                            </p>
                            <ul className="space-y-1">
                                {completedToday.map((task) => (
                                    <li key={task.id} className="truncate px-1.5 py-0.5 text-xs text-muted-foreground line-through" title={task.title}>
                                        · {task.title}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            )}

            <div className="flex min-w-0 items-center gap-1">
                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <input
                    type="text"
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onKeyDown={onDraftKeyDown}
                    onBlur={() => void submitDraft()}
                    disabled={adding}
                    placeholder={t('widget.addTaskForDay')}
                    aria-label={t('widget.addTaskForDay')}
                    className="min-w-0 flex-1 rounded border border-border/40 bg-background/40 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
            </div>
        </div>
    );
}
