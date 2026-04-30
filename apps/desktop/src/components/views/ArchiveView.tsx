import { memo, useMemo, useState, useEffect, useCallback, useLayoutEffect, useRef, type UIEvent } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, sortTasksBy, safeFormatDate } from '@mindwtr/core';
import type { Task, TaskSortBy } from '@mindwtr/core';

import { Undo2, Trash2 } from 'lucide-react';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import {
    LIST_VIRTUALIZATION_THRESHOLD,
    LIST_VIRTUAL_ROW_ESTIMATE,
    LIST_VIRTUAL_OVERSCAN,
    useVirtualList,
} from './list/useVirtualList';

type ArchiveTaskRowInnerProps = {
    task: Task;
    onRestore: (taskId: string) => void;
    onDelete: (taskId: string) => void;
    t: (key: string) => string;
};

const ArchiveTaskRowInner = memo(function ArchiveTaskRowInner({
    task,
    onRestore,
    onDelete,
    t,
}: ArchiveTaskRowInnerProps) {
    const handleRestore = useCallback(() => onRestore(task.id), [onRestore, task.id]);
    const handleDelete = useCallback(() => onDelete(task.id), [onDelete, task.id]);

    return (
        <div className="rounded-lg px-3 py-3 flex items-center justify-between group hover:bg-muted/50 transition-colors">
            <div>
                <h3 className="font-medium text-foreground line-through opacity-70">{task.title}</h3>
                <p className="text-xs text-muted-foreground mt-1">
                    {task.dueDate && `${t('taskEdit.dueDateLabel')}: ${safeFormatDate(task.dueDate, 'P')} • `}
                    {task.contexts?.join(', ')}
                </p>
            </div>
            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={handleRestore}
                    className="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-primary transition-colors"
                    title={t('archived.restoreToInbox')}
                >
                    <Undo2 className="w-4 h-4" />
                </button>
                <button
                    onClick={handleDelete}
                    className="p-2 hover:bg-destructive/10 rounded-md text-muted-foreground hover:text-destructive transition-colors"
                    title={t('archived.deletePermanently')}
                >
                    <Trash2 className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
});

type VirtualArchiveTaskRowProps = ArchiveTaskRowInnerProps & {
    top: number;
    onMeasure: (id: string, height: number) => void;
};

const VirtualArchiveTaskRow = memo(function VirtualArchiveTaskRow({
    task,
    top,
    onRestore,
    onDelete,
    onMeasure,
    t,
}: VirtualArchiveTaskRowProps) {
    const rowRef = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
        const node = rowRef.current;
        if (!node) return;
        const nextHeight = Math.ceil(node.getBoundingClientRect().height);
        onMeasure(task.id, nextHeight);
    }, [task.id, task.updatedAt, onMeasure]);

    return (
        <div ref={rowRef} style={{ position: 'absolute', top, left: 0, right: 0 }}>
            <div className="border-b border-border/30">
                <ArchiveTaskRowInner task={task} onRestore={onRestore} onDelete={onDelete} t={t} />
            </div>
        </div>
    );
});

export function ArchiveView() {
    const perf = usePerformanceMonitor('ArchiveView');
    const { _allTasks, updateTask, purgeTask, settings } = useTaskStore(
        (state) => ({
            _allTasks: state._allTasks,
            updateTask: state.updateTask,
            purgeTask: state.purgeTask,
            settings: state.settings,
        }),
        shallow
    );
    const { t } = useLanguage();
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const [searchQuery, setSearchQuery] = useState('');
    const listScrollRef = useRef<HTMLDivElement>(null);
    const rowHeightsRef = useRef<Map<string, number>>(new Map());
    const [measureVersion, setMeasureVersion] = useState(0);
    const [listScrollTop, setListScrollTop] = useState(0);
    const [listHeight, setListHeight] = useState(0);
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ArchiveView', perf.metrics, 'simple');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    useEffect(() => {
        const element = listScrollRef.current;
        if (!element) return;
        const updateHeight = () => {
            const nextHeight = element.clientHeight;
            setListHeight((current) => (current === nextHeight ? current : nextHeight));
        };
        updateHeight();
        window.addEventListener('resize', updateHeight);
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateHeight())
            : null;
        resizeObserver?.observe(element);
        return () => {
            window.removeEventListener('resize', updateHeight);
            resizeObserver?.disconnect();
        };
    }, []);

    const archivedTasks = useMemo(() => {
        const filtered = _allTasks.filter((t) => t.status === 'archived' && !t.deletedAt);

        // Use standard sort
        const sorted = sortTasksBy(filtered, sortBy);

        if (!searchQuery) return sorted;

        return sorted.filter(t =>
            t.title.toLowerCase().includes(searchQuery.toLowerCase())
        );
    }, [_allTasks, searchQuery, sortBy]);
    const shouldVirtualize = archivedTasks.length > LIST_VIRTUALIZATION_THRESHOLD;
    const handleVirtualRowMeasure = useCallback((id: string, height: number) => {
        if (rowHeightsRef.current.get(id) === height) return;
        rowHeightsRef.current.set(id, height);
        setMeasureVersion((current) => current + 1);
    }, []);
    const handleVirtualScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
        setListScrollTop(event.currentTarget.scrollTop);
    }, []);
    const { rowOffsets, totalHeight, startIndex, visibleTasks } = useVirtualList({
        tasks: archivedTasks,
        shouldVirtualize,
        rowHeightsRef,
        measureVersion,
        listScrollTop,
        listHeight,
        rowEstimate: LIST_VIRTUAL_ROW_ESTIMATE,
        overscan: LIST_VIRTUAL_OVERSCAN,
    });

    const handleRestore = useCallback((taskId: string) => {
        updateTask(taskId, { status: 'inbox' }); // Restore to inbox? Or previous status? Inbox is safest.
    }, [updateTask]);

    const handleDelete = useCallback(async (taskId: string) => {
        const task = _allTasks.find((item) => item.id === taskId);
        if (!task) return;
        const confirmed = await requestConfirmation({
            title: task.title,
            description: t('trash.deleteConfirmBody'),
            confirmLabel: t('common.delete'),
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (!confirmed) return;
        purgeTask(taskId);
    }, [_allTasks, purgeTask, requestConfirmation, t]);

    return (
        <ErrorBoundary>
            <div className={shouldVirtualize ? "flex h-full min-h-0 flex-col gap-6" : "flex flex-col gap-6"}>
            <header className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight">{t('archived.title')}</h2>
                <div className="text-sm text-muted-foreground">
                    {archivedTasks.length} {t('common.tasks')}
                </div>
            </header>

            <div className="relative">
                <input
                    type="text"
                    placeholder={t('archived.searchPlaceholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-card border border-border rounded-lg py-2 pl-4 pr-4 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent"
                />
            </div>

            <div
                ref={listScrollRef}
                onScroll={handleVirtualScroll}
                className={shouldVirtualize ? "flex-1 min-h-0 overflow-y-auto" : undefined}
            >
                {archivedTasks.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground bg-muted/30 rounded-lg border border-dashed border-border">
                        <p>{t('archived.noTasksFound')}</p>
                        <p className="text-xs mt-2">{t('archived.emptyHint')}</p>
                    </div>
                ) : shouldVirtualize ? (
                    <div style={{ height: totalHeight, position: 'relative' }}>
                        {visibleTasks.map((task, visibleIndex) => {
                            const taskIndex = startIndex + visibleIndex;
                            return (
                                <VirtualArchiveTaskRow
                                    key={task.id}
                                    task={task}
                                    top={rowOffsets[taskIndex] ?? 0}
                                    onMeasure={handleVirtualRowMeasure}
                                    onRestore={handleRestore}
                                    onDelete={handleDelete}
                                    t={t}
                                />
                            );
                        })}
                    </div>
                ) : (
                    <div className="divide-y divide-border/30">
                        {archivedTasks.map(task => (
                            <ArchiveTaskRowInner
                                key={task.id}
                                task={task}
                                onRestore={handleRestore}
                                onDelete={handleDelete}
                                t={t}
                            />
                        ))}
                    </div>
                )}
            </div>
            </div>
            {confirmModal}
        </ErrorBoundary>
    );
}
