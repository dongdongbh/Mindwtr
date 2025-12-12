import { useMemo, useCallback } from 'react';
import { useTaskStore, filterTasksBySearch, sortTasksBy, Project } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { useLanguage } from '../../contexts/language-context';
import { Trash2 } from 'lucide-react';

interface SearchViewProps {
    savedSearchId: string;
    onDelete?: () => void;
}

export function SearchView({ savedSearchId, onDelete }: SearchViewProps) {
    const { tasks, projects, settings, updateSettings } = useTaskStore();
    const { t } = useLanguage();
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

    const savedSearch = settings?.savedSearches?.find(s => s.id === savedSearchId);
    const query = savedSearch?.query || '';

    const projectMap = useMemo(() => {
        return projects.reduce((acc, project) => {
            acc[project.id] = project;
            return acc;
        }, {} as Record<string, Project>);
    }, [projects]);

    const filteredTasks = useMemo(() => {
        if (!query) return [];
        return sortTasksBy(filterTasksBySearch(tasks, projects, query), sortBy);
    }, [tasks, projects, query, sortBy]);

    const handleDelete = useCallback(async () => {
        if (!savedSearch) return;
        const confirmed = window.confirm(t('search.deleteConfirm') || `Delete "${savedSearch.name}"?`);
        if (!confirmed) return;

        const updated = (settings?.savedSearches || []).filter(s => s.id !== savedSearchId);
        await updateSettings({ savedSearches: updated });
        onDelete?.();
    }, [savedSearch, savedSearchId, settings?.savedSearches, updateSettings, onDelete, t]);

    return (
        <div className="space-y-4">
            <header className="flex items-center justify-between">
                <div className="space-y-1">
                    <h2 className="text-2xl font-bold tracking-tight">
                        {savedSearch?.name || t('search.savedSearches')}
                    </h2>
                    {query && (
                        <p className="text-sm text-muted-foreground">
                            {query}
                        </p>
                    )}
                </div>
                {savedSearch && (
                    <button
                        onClick={handleDelete}
                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                        title={t('common.delete') || 'Delete'}
                    >
                        <Trash2 className="w-5 h-5" />
                    </button>
                )}
            </header>

            {filteredTasks.length === 0 && query && (
                <div className="text-sm text-muted-foreground">
                    {t('search.noResults')}
                </div>
            )}

            <div className="space-y-3">
                {filteredTasks.map(task => (
                    <TaskItem
                        key={task.id}
                        task={task}
                        project={task.projectId ? projectMap[task.projectId] : undefined}
                    />
                ))}
            </div>
        </div>
    );
}
