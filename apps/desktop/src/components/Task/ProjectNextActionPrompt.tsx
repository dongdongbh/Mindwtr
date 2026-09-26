import { useId } from 'react';
import { formatI18nTemplate, translateWithFallback, type Task } from '@mindwtr/core';
import { Button } from '../ui/Button';
import { Dialog, DialogBody, DialogHeader } from '../ui/Dialog';

type ProjectNextActionPromptProps = {
    candidates: Task[];
    isOpen: boolean;
    newTitle: string;
    projectTitle: string;
    scope?: 'project' | 'section';
    sectionTitle?: string;
    isAddingTask?: boolean;
    titleLocked?: boolean;
    onAddTask: () => void;
    onAddTaskAndEdit: () => void;
    onCancel: () => void;
    onChooseTask: (taskId: string) => void;
    onCompleteProject: () => void;
    onNewTitleChange: (value: string) => void;
    t: (key: string) => string;
};

export function ProjectNextActionPrompt({
    candidates,
    isOpen,
    newTitle,
    projectTitle,
    scope = 'project',
    sectionTitle,
    isAddingTask = false,
    titleLocked = false,
    onAddTask,
    onAddTaskAndEdit,
    onCancel,
    onChooseTask,
    onCompleteProject,
    onNewTitleChange,
    t,
}: ProjectNextActionPromptProps) {
    const titleId = useId();
    const descriptionId = useId();
    const candidateLabelId = useId();
    const inputId = useId();
    const canAddTask = newTitle.trim().length > 0;
    const resolveText = (key: string, fallback: string) => translateWithFallback(t, key, fallback);
    const description = scope === 'section' && sectionTitle
        ? formatI18nTemplate(resolveText(
            'projects.nextActionPromptSectionDesc',
            'Choose or add the next action for {{section}} in {{project}}.',
        ), { section: sectionTitle, project: projectTitle })
        : formatI18nTemplate(resolveText(
            'projects.nextActionPromptDesc',
            'Choose or add the next action for {{project}}.',
        ), { project: projectTitle });

    if (!isOpen) return null;

    return (
        <Dialog
            onClose={onCancel}
            labelledBy={titleId}
            describedBy={descriptionId}
            placement="top"
            overlayClassName="pt-[16vh]"
            // Capped under the 16vh offset so the candidate list scrolls rather
            // than pushing the Add/Skip buttons off a short window (#957).
            panelClassName="max-w-lg max-h-[70vh]"
        >
            <DialogHeader className="px-4 py-3 border-b">
                <h3 id={titleId} className="font-semibold">
                    {resolveText('projects.nextActionPromptTitle', "What's the next action?")}
                </h3>
                <p id={descriptionId} className="text-xs text-muted-foreground mt-1">
                    {description}
                </p>
            </DialogHeader>
            <DialogBody className="p-4 space-y-4">
                {candidates.length > 0 && (
                    <div className="space-y-2">
                        <p id={candidateLabelId} className="text-xs font-medium text-muted-foreground">
                            {resolveText('projects.nextActionPromptChooseExisting', 'Choose an existing task')}
                        </p>
                        <div className="max-h-52 overflow-y-auto space-y-2" role="list" aria-labelledby={candidateLabelId}>
                            {candidates.map((candidate) => (
                                <button
                                    key={candidate.id}
                                    type="button"
                                    disabled={isAddingTask}
                                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                                    onClick={() => onChooseTask(candidate.id)}
                                >
                                    <span className="block text-sm font-medium">{candidate.title}</span>
                                    <span className="block text-xs text-muted-foreground mt-0.5">
                                        {t(`status.${candidate.status}`)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="space-y-2">
                    <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
                        {resolveText('projects.nextActionPromptAddNew', 'Add a new next action')}
                    </label>
                    <input
                        id={inputId}
                        autoFocus
                        type="text"
                        value={newTitle}
                        disabled={isAddingTask || titleLocked}
                        onChange={(event) => onNewTitleChange(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                onCancel();
                            }
                            if (event.key === 'Enter' && canAddTask && !isAddingTask) {
                                event.preventDefault();
                                onAddTask();
                            }
                        }}
                        placeholder={resolveText('projects.nextActionPromptPlaceholder', 'New next action...')}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 shadow-sm transition-colors focus:border-transparent focus:ring-2 focus:ring-primary"
                    />
                </div>

                <div className="flex flex-wrap justify-between items-center gap-2">
                    {scope === 'section' ? <span /> : (
                        <Button variant="ghost" onClick={onCompleteProject} disabled={isAddingTask}>
                            {resolveText('projects.nextActionPromptComplete', 'Complete project')}
                        </Button>
                    )}
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="secondary" onClick={onCancel}>
                            {resolveText('common.skip', 'Skip')}
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={onAddTaskAndEdit}
                            disabled={!canAddTask || isAddingTask}
                        >
                            {resolveText('quickAdd.saveAndEdit', 'Save & edit')}
                        </Button>
                        <Button onClick={onAddTask} disabled={!canAddTask || isAddingTask}>
                            {resolveText('projects.nextActionPromptAddButton', 'Add next action')}
                        </Button>
                    </div>
                </div>
            </DialogBody>
        </Dialog>
    );
}
