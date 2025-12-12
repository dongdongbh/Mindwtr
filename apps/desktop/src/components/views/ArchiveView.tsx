import { useMemo, useState } from 'react';
import { useTaskStore, sortTasks, safeFormatDate } from '@mindwtr/core';

import { Undo2, Trash2 } from 'lucide-react';

export function ArchiveView() {
    const { tasks, updateTask, deleteTask } = useTaskStore();
    // const { t } = useLanguage();
    const [searchQuery, setSearchQuery] = useState('');

    const archivedTasks = useMemo(() => {
        // Show tasks that are done or archived
        const filtered = tasks.filter(t =>
            t.status === 'archived' || t.status === 'done'
        );

        // Use standard sort
        const sorted = sortTasks(filtered);

        if (!searchQuery) return sorted;

        return sorted.filter(t =>
            t.title.toLowerCase().includes(searchQuery.toLowerCase())
        );
    }, [tasks, searchQuery]);

    const handleRestore = (taskId: string) => {
        updateTask(taskId, { status: 'inbox' }); // Restore to inbox? Or previous status? Inbox is safest.
    };

    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight">Archived</h2>
                <div className="text-sm text-muted-foreground">
                    {archivedTasks.length} tasks
                </div>
            </header>

            <div className="relative">
                <input
                    type="text"
                    placeholder="Search archived tasks..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-card border border-border rounded-lg py-2 pl-4 pr-4 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent"
                />
            </div>

            <div className="space-y-3">
                {archivedTasks.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground bg-muted/30 rounded-lg border border-dashed border-border">
                        <p>No archived tasks found.</p>
                    </div>
                ) : (
                    archivedTasks.map(task => (
                        <div key={task.id} className="bg-card border border-border rounded-lg p-4 flex items-center justify-between group hover:shadow-sm transition-all">
                            <div>
                                <h3 className="font-medium text-foreground line-through opacity-70">{task.title}</h3>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {task.dueDate && `Due: ${safeFormatDate(task.dueDate, 'P')} • `}
                                    {task.contexts?.join(', ')}
                                </p>
                            </div>
                            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    onClick={() => handleRestore(task.id)}
                                    className="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-primary transition-colors"
                                    title="Restore to Inbox"
                                >
                                    <Undo2 className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => deleteTask(task.id)}
                                    className="p-2 hover:bg-destructive/10 rounded-md text-muted-foreground hover:text-destructive transition-colors"
                                    title="Delete Permanently"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
