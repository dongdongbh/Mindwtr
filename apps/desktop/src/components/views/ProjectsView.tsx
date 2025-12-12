import { useState, useMemo } from 'react';
import { useTaskStore, Task, safeFormatDate, safeParseDate, parseQuickAdd } from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { Plus, Folder, Trash2, ListOrdered, ChevronRight, ChevronDown, CheckCircle, Archive as ArchiveIcon, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { confirm } from '@tauri-apps/plugin-dialog';

function toDateTimeLocalValue(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const parsed = safeParseDate(dateStr);
    if (!parsed) return dateStr;
    return safeFormatDate(parsed, "yyyy-MM-dd'T'HH:mm", dateStr);
}

export function ProjectsView() {
    const { projects, tasks, addProject, updateProject, deleteProject, addTask, toggleProjectFocus } = useTaskStore();
    const { t } = useLanguage();
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [newProjectTitle, setNewProjectTitle] = useState('');
    const [newProjectColor, setNewProjectColor] = useState('#3b82f6'); // Default blue
    const [notesExpanded, setNotesExpanded] = useState(false);

    // Group tasks by project to avoid O(N*M) filtering
    const tasksByProject = projects.reduce((acc, project) => {
        acc[project.id] = [];
        return acc;
    }, {} as Record<string, Task[]>);

    tasks.forEach(task => {
        if (task.projectId && !task.deletedAt && task.status !== 'done' && task.status !== 'archived') {
            if (tasksByProject[task.projectId]) {
                tasksByProject[task.projectId].push(task);
            }
        }
    });

    const groupedProjects = useMemo(() => {
        const visibleProjects = projects.filter(p => !p.deletedAt);
        const sorted = [...visibleProjects].sort((a, b) => {
            if (a.isFocused && !b.isFocused) return -1;
            if (!a.isFocused && b.isFocused) return 1;
            return a.title.localeCompare(b.title);
        });

        const groups = new Map<string, typeof sorted>();
        const noAreaLabel = t('common.none');

        for (const project of sorted) {
            const area = project.areaTitle?.trim() || noAreaLabel;
            if (!groups.has(area)) groups.set(area, []);
            groups.get(area)!.push(project);
        }

        return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    }, [projects, t]);

    const handleCreateProject = (e: React.FormEvent) => {
        e.preventDefault();
        if (newProjectTitle.trim()) {
            addProject(newProjectTitle, newProjectColor);
            setNewProjectTitle('');
            setIsCreating(false);
        }
    };

    const selectedProject = projects.find(p => p.id === selectedProjectId);
    const projectTasks = selectedProjectId
        ? tasks.filter(t => t.projectId === selectedProjectId && t.status !== 'done' && t.status !== 'archived' && !t.deletedAt)
        : [];

    return (
        <div className="flex h-full gap-6">
            {/* Sidebar List of Projects */}
            <div className="w-64 flex-shrink-0 flex flex-col gap-4 border-r border-border pr-6">
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold tracking-tight">{t('projects.title')}</h2>
                    <button
                        onClick={() => setIsCreating(true)}
                        className="p-1 hover:bg-accent rounded-md transition-colors"
                    >
                        <Plus className="w-5 h-5" />
                    </button>
                </div>

                {isCreating && (
                    <form onSubmit={handleCreateProject} className="bg-card border border-border rounded-lg p-3 space-y-3 animate-in slide-in-from-top-2">
                        <input
                            autoFocus
                            type="text"
                            value={newProjectTitle}
                            onChange={(e) => setNewProjectTitle(e.target.value)}
                            placeholder={t('projects.projectName')}
                            className="w-full bg-transparent border-b border-primary/50 p-1 text-sm focus:outline-none"
                        />
                        <div className="flex items-center gap-2">
                            <input
                                type="color"
                                value={newProjectColor}
                                onChange={(e) => setNewProjectColor(e.target.value)}
                                className="w-6 h-6 rounded cursor-pointer border-0 p-0"
                            />
                            <span className="text-xs text-muted-foreground">{t('projects.color')}</span>
                        </div>
                        <div className="flex gap-2 justify-end">
                            <button
                                type="button"
                                onClick={() => setIsCreating(false)}
                                className="text-xs px-2 py-1 hover:bg-muted rounded"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type="submit"
                                className="text-xs bg-primary text-primary-foreground px-2 py-1 rounded"
                            >
                                {t('projects.create')}
                            </button>
                        </div>
                    </form>
                )}

                <div className="space-y-3 overflow-y-auto flex-1">
                    {groupedProjects.map(([area, areaProjects]) => (
                        <div key={area} className="space-y-1">
                            <div className="px-2 pt-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                {area}
                            </div>
                            {areaProjects.map(project => {
                                const projTasks = tasksByProject[project.id] || [];
                                let nextAction = undefined;
                                let nextCandidate = undefined;
                                for (const t of projTasks) {
                                    if (t.status === 'todo') {
                                        nextAction = t;
                                        break;
                                    }
                                    if (!nextCandidate && t.status === 'next') {
                                        nextCandidate = t;
                                    }
                                }
                                nextAction = nextAction || nextCandidate;
                                const focusedCount = projects.filter(p => p.isFocused).length;

                                return (
                                    <div
                                        key={project.id}
                                        className={cn(
                                            "rounded-lg cursor-pointer transition-colors text-sm border",
                                            selectedProjectId === project.id
                                                ? "bg-accent text-accent-foreground border-accent"
                                                : project.isFocused
                                                    ? "bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20"
                                                    : "border-transparent hover:bg-muted/50"
                                        )}
                                    >
                                        <div
                                            className="flex items-center gap-2 p-2"
                                            onClick={() => setSelectedProjectId(project.id)}
                                        >
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleProjectFocus(project.id);
                                                }}
                                                className={cn(
                                                    "text-sm transition-colors",
                                                    project.isFocused ? "text-amber-500" : "text-muted-foreground hover:text-amber-500",
                                                    !project.isFocused && focusedCount >= 5 && "opacity-30 cursor-not-allowed"
                                                )}
                                                title={project.isFocused ? "Remove from focus" : focusedCount >= 5 ? "Max 5 focused projects" : "Add to focus"}
                                            >
                                                {project.isFocused ? '⭐' : '☆'}
                                            </button>
                                            <Folder className="w-4 h-4" style={{ color: project.color }} />
                                            <span className="flex-1 truncate">{project.title}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {projTasks.length}
                                            </span>
                                        </div>
                                        <div className="px-2 pb-2 pl-8">
                                            {nextAction ? (
                                                <span className="text-xs text-muted-foreground truncate block">
                                                    ↳ {nextAction.title}
                                                </span>
                                            ) : projTasks.length > 0 ? (
                                                <span className="text-xs text-amber-600 dark:text-amber-400">
                                                    ⚠️ {t('projects.noNextAction')}
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}

                    {projects.length === 0 && !isCreating && (
                        <div className="text-sm text-muted-foreground text-center py-8">
                            {t('projects.noProjects')}
                        </div>
                    )}
                </div>
            </div>

            {/* Project Details & Tasks */}
            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {selectedProject ? (
                    <>
                        <header className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-3">
                                <div className="w-4 h-4 rounded-full" style={{ backgroundColor: selectedProject.color }} />
                                <h2 className="text-2xl font-bold">{selectedProject.title}</h2>
                            </div>
                            <div className="flex items-center gap-3">
                                {/* Sequential Toggle */}
                                <button
                                    type="button"
                                    onClick={() => updateProject(selectedProject.id, { isSequential: !selectedProject.isSequential })}
                                    className={cn(
                                        "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                                        selectedProject.isSequential
                                            ? "bg-primary text-primary-foreground"
                                            : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                    )}
                                    title={selectedProject.isSequential ? t('projects.sequentialTooltip') : t('projects.parallelTooltip')}
                                >
                                    <ListOrdered className="w-4 h-4" />
                                    {selectedProject.isSequential ? t('projects.sequential') : t('projects.parallel')}
                                </button>
                                {selectedProject.status === 'active' ? (
                                    <>
                                        <button
                                            type="button"
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                const confirmed = await confirm(t('projects.completeConfirm'), {
                                                    title: t('projects.title'),
                                                    kind: 'warning'
                                                });
                                                if (confirmed) {
                                                    updateProject(selectedProject.id, { status: 'completed' });
                                                }
                                            }}
                                            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20 transition-colors"
                                        >
                                            <CheckCircle className="w-4 h-4" />
                                            {t('projects.complete')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                const confirmed = await confirm(t('projects.archiveConfirm'), {
                                                    title: t('projects.title'),
                                                    kind: 'warning'
                                                });
                                                if (confirmed) {
                                                    updateProject(selectedProject.id, { status: 'archived' });
                                                }
                                            }}
                                            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 text-muted-foreground transition-colors"
                                        >
                                            <ArchiveIcon className="w-4 h-4" />
                                            {t('projects.archive')}
                                        </button>
                                    </>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => updateProject(selectedProject.id, { status: 'active' })}
                                        className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                    >
                                        <RotateCcw className="w-4 h-4" />
                                        {t('projects.reactivate')}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        const confirmed = await confirm(t('projects.deleteConfirm'), {
                                            title: t('projects.title'),
                                            kind: 'warning'
                                        });
                                        if (confirmed) {
                                            deleteProject(selectedProject.id);
                                            setSelectedProjectId(null);
                                        }
                                    }}
                                    className="text-destructive hover:bg-destructive/10 p-2 rounded-md transition-colors"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </header>

	                        <div className="mb-6 border rounded-lg overflow-hidden bg-card">
	                            <button
	                                onClick={() => setNotesExpanded(!notesExpanded)}
	                                className="w-full flex items-center gap-2 p-2 bg-muted/30 hover:bg-muted/50 transition-colors text-sm font-medium"
	                            >
		                                {notesExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
		                                {t('project.notes')}
		                            </button>
		                            {notesExpanded && (
		                                <div className="p-0">
		                                    <textarea
		                                        className="w-full min-h-[120px] p-3 text-sm bg-transparent border-none resize-y focus:outline-none focus:bg-accent/5"
		                                        placeholder={t('projects.notesPlaceholder')}
		                                        defaultValue={selectedProject.supportNotes || ''}
		                                        onBlur={(e) => updateProject(selectedProject.id, { supportNotes: e.target.value })}
		                                    />
		                                </div>
		                            )}
		                        </div>

			                        <div className="mb-6 bg-card border border-border rounded-lg p-3 space-y-2">
			                            <label className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
			                                {t('projects.areaLabel')}
			                            </label>
			                            <input
			                                key={`${selectedProject.id}-area`}
			                                type="text"
			                                defaultValue={selectedProject.areaTitle || ''}
			                                onBlur={(e) => updateProject(selectedProject.id, { areaTitle: e.target.value || undefined })}
			                                placeholder={t('projects.areaPlaceholder')}
			                                className="w-full text-sm bg-muted/50 border border-border rounded px-2 py-1"
			                            />
			                        </div>

			                        <div className="mb-6 bg-card border border-border rounded-lg p-3 space-y-2">
			                            <label className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
			                                {t('projects.reviewAt')}
		                            </label>
	                            <input
	                                key={selectedProject.id}
	                                type="datetime-local"
	                                defaultValue={toDateTimeLocalValue(selectedProject.reviewAt)}
	                                onBlur={(e) => updateProject(selectedProject.id, { reviewAt: e.target.value || undefined })}
	                                className="w-full text-sm bg-muted/50 border border-border rounded px-2 py-1"
		                            />
		                            <p className="text-xs text-muted-foreground">
		                                {t('projects.reviewAtHint')}
		                            </p>
		                        </div>

	                        <div className="mb-6">
	                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    const form = e.target as HTMLFormElement;
                                    const input = form.elements.namedItem('taskTitle') as HTMLInputElement;
                                    if (input.value.trim()) {
                                        const { title: parsedTitle, props } = parseQuickAdd(input.value, projects);
                                        const finalTitle = parsedTitle || input.value;
                                        const initialProps: Partial<Task> = { projectId: selectedProject.id, status: 'todo', ...props };
                                        if (!props.status) initialProps.status = 'todo';
                                        if (!props.projectId) initialProps.projectId = selectedProject.id;
                                        addTask(finalTitle, initialProps);
                                        input.value = '';
                                    }
                                }}
                                className="flex gap-2"
                            >
                                <input
                                    name="taskTitle"
                                    type="text"
                                    placeholder={t('projects.addTaskPlaceholder')}
                                    className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                />
                                <button
                                    type="submit"
                                    className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
                                >
                                    {t('projects.addTask')}
                                </button>
                            </form>
                        </div>

                        <div className="flex-1 overflow-y-auto space-y-2 pr-2">
                            {projectTasks.length > 0 ? (
                                projectTasks.map(task => (
                                    <TaskItem key={task.id} task={task} project={selectedProject} />
                                ))
                            ) : (
                                <div className="text-center text-muted-foreground py-12">
                                    {t('projects.noActiveTasks')}
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <div className="text-center">
                            <Folder className="w-12 h-12 mx-auto mb-4 opacity-20" />
                            <p>{t('projects.selectProject')}</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
