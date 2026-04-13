import { useMemo, useState, useEffect } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, sortTasksBy, safeFormatDate } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { Undo2, Trash2 } from 'lucide-react';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

export function TrashView() {
    const perf = usePerformanceMonitor('TrashView');
    const { _allTasks, restoreTask, purgeTask, purgeDeletedTasks, settings } = useTaskStore(
        (state) => ({
            _allTasks: state._allTasks,
            restoreTask: state.restoreTask,
            purgeTask: state.purgeTask,
            purgeDeletedTasks: state.purgeDeletedTasks,
            settings: state.settings,
        }),
        shallow
    );
    const { t } = useLanguage();
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const [searchQuery, setSearchQuery] = useState('');
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('TrashView', perf.metrics, 'simple');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const trashedTasks = useMemo(() => {
        const filtered = _allTasks.filter((task) => task.deletedAt && !task.purgedAt);
        const sorted = sortTasksBy(filtered, sortBy);
        if (!searchQuery) return sorted;
        const query = searchQuery.toLowerCase();
        return sorted.filter((task) => task.title.toLowerCase().includes(query));
    }, [_allTasks, searchQuery, sortBy]);

    const handleClearTrash = async () => {
        if (trashedTasks.length === 0) return;
        const confirmed = await requestConfirmation({
            title: t('trash.clearAllConfirm'),
            description: t('trash.clearAllConfirmBody'),
            confirmLabel: t('trash.clearAll'),
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (!confirmed) return;
        purgeDeletedTasks();
    };

    return (
        <ErrorBoundary>
            <div className="space-y-6">
            <header className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight">{t('trash.title')}</h2>
                <div className="flex items-center gap-3">
                    <div className="text-sm text-muted-foreground">
                        {trashedTasks.length} {t('common.tasks')}
                    </div>
                    <button
                        onClick={handleClearTrash}
                        disabled={trashedTasks.length === 0}
                        className="text-xs px-3 py-1 rounded-md border transition-colors bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {t('trash.clearAll')}
                    </button>
                </div>
            </header>

            <div className="relative">
                <input
                    type="text"
                    placeholder={t('trash.searchPlaceholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-card border border-border rounded-lg py-2 pl-4 pr-4 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent"
                />
            </div>

            <div className="divide-y divide-border/30">
                {trashedTasks.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground bg-muted/30 rounded-lg border border-dashed border-border">
                        <p>{t('trash.noTasksFound')}</p>
                        <p className="text-xs mt-2">{t('trash.emptyHint')}</p>
                    </div>
                ) : (
                    trashedTasks.map((task) => (
                        <div
                            key={task.id}
                            className="rounded-lg px-3 py-3 flex items-center justify-between group hover:bg-muted/50 transition-colors"
                        >
                            <div>
                                <h3 className="font-medium text-foreground line-through opacity-70">{task.title}</h3>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {task.deletedAt && `${t('trash.deletedAt')}: ${safeFormatDate(task.deletedAt, 'P')}`}
                                </p>
                            </div>
                            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    onClick={() => restoreTask(task.id)}
                                    className="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-primary transition-colors"
                                    title={t('trash.restoreToInbox')}
                                >
                                    <Undo2 className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => purgeTask(task.id)}
                                    className="p-2 hover:bg-destructive/10 rounded-md text-muted-foreground hover:text-destructive transition-colors"
                                    title={t('trash.deletePermanently')}
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>
            </div>
            {confirmModal}
        </ErrorBoundary>
    );
}
