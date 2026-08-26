import { type Area, type Project, type ProjectSequenceTaskCue, type StoreActionResult, type Task } from '@mindwtr/core';
import { useDraggable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2 } from 'lucide-react';
import { TaskItem } from '../../TaskItem';
import { AreaColorPicker } from './AreaColorPicker';
import type { ProjectAreaSection } from './project-area-collapse';

type AreaRowProps = {
    area: Area;
    onDelete: (areaId: string) => void;
    onUpdateName: (areaId: string, name: string) => Promise<StoreActionResult> | void;
    onUpdateColor: (areaId: string, color: string | undefined) => Promise<StoreActionResult> | void;
    t: (key: string) => string;
};

export function SortableAreaRow({
    area,
    onDelete,
    onUpdateName,
    onUpdateColor,
    t,
}: AreaRowProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: area.id });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
    };
    const commitAreaName = (rawName: string) => {
        const name = rawName.trim();
        if (!name || name === area.name) return;
        void Promise.resolve(onUpdateName(area.id, name));
    };
    const commitAreaColor = (nextColor: string | undefined) => {
        if (nextColor === area.color) return;
        void Promise.resolve(onUpdateColor(area.id, nextColor));
    };

    return (
        <div ref={setNodeRef} style={style} className="flex items-center gap-2">
            <button
                type="button"
                {...attributes}
                {...listeners}
                className="h-8 w-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted flex items-center justify-center"
                title={t('projects.sortAreas')}
            >
                <GripVertical className="w-4 h-4" />
            </button>
            <AreaColorPicker
                value={area.color}
                onChange={commitAreaColor}
                title={t('projects.color')}
                noneLabel={t('projects.colorNone')}
                customLabel={t('projects.colorCustom')}
            />
            <input
                key={`${area.id}-${area.updatedAt}`}
                defaultValue={area.name}
                onBlur={(e) => {
                    commitAreaName(e.target.value);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        commitAreaName(e.currentTarget.value);
                        e.currentTarget.blur();
                    }
                }}
                className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-sm"
            />
            <button
                type="button"
                onClick={() => onDelete(area.id)}
                className="text-destructive hover:bg-destructive/10 h-8 w-8 rounded-md transition-colors flex items-center justify-center"
                title={t('common.delete')}
            >
                <Trash2 className="w-4 h-4" />
            </button>
        </div>
    );
}

export function SortableProjectRow({
    projectId,
    section,
    children,
}: {
    projectId: string;
    section: ProjectAreaSection;
    children: (props: { handle: React.ReactNode; isDragging: boolean; isTaskOver: boolean }) => React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } = useSortable({
        id: projectId,
        data: { type: 'project', section },
    });
    const isTaskOver = isOver
        && (active?.data.current as { type?: string } | undefined)?.type === 'task'
        && section !== 'archived';
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : 1,
    };

    const handle = (
        <button
            type="button"
            {...attributes}
            {...listeners}
            data-project-selection-ignore="true"
            onClick={(event) => event.stopPropagation()}
            className="h-6 w-6 rounded-md border border-transparent text-muted-foreground/80 hover:text-foreground hover:bg-muted/70 hover:border-border/70 flex items-center justify-center transition-colors"
            title="Drag"
        >
            <GripVertical className="w-3 h-3" />
        </button>
    );

    return (
        <div ref={setNodeRef} style={style}>
            {children({ handle, isDragging, isTaskOver: Boolean(isTaskOver) })}
        </div>
    );
}

// Sequential-project rows read as "one live task, the rest queued": the
// available next action gets the tinted card, later tasks render muted.
function getSequenceCuePresentation(
    sequenceCue: ProjectSequenceTaskCue | undefined,
    availableSequenceLabel: string,
    laterSequenceLabel: string,
): { taskContainerClassName: string; title?: string } {
    if (sequenceCue === 'available') {
        return {
            taskContainerClassName: 'flex-1 min-w-0 -mx-2 -my-1 rounded-lg border border-primary/20 bg-primary/[0.04] px-2 py-1',
            title: availableSequenceLabel,
        };
    }
    if (sequenceCue === 'later') {
        return {
            taskContainerClassName: 'flex-1 min-w-0 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100',
            title: laterSequenceLabel,
        };
    }
    return { taskContainerClassName: 'flex-1 min-w-0' };
}

// A row's actions strip is `shrink-0`, so in a container as narrow as a section
// column it takes its full width out of the row and the title — the only
// `min-w-0` sibling — collapses to nothing and wraps a character per line.
// `actionsOverlay` lifts the strip out of the flow instead, which is how Board
// columns have always fit a task row into ~40ch.
const NARROW_TASK_ITEM_PROPS = {
    actionsOverlay: true,
    showStatusSelect: false,
} as const;

export function SortableProjectTaskRow({
    task,
    project,
    sequenceCue,
    availableSequenceLabel,
    laterSequenceLabel,
    narrow,
}: {
    task: Task;
    project: Project;
    sequenceCue?: ProjectSequenceTaskCue;
    availableSequenceLabel: string;
    laterSequenceLabel: string;
    narrow?: boolean;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: task.id,
        data: { type: 'task', sortable: true },
    });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : 1,
    };

    const { taskContainerClassName, title } = getSequenceCuePresentation(
        sequenceCue,
        availableSequenceLabel,
        laterSequenceLabel,
    );

    return (
        <div ref={setNodeRef} style={style} className="flex items-start gap-2">
            <div
                className={taskContainerClassName}
                title={title}
            >
                <TaskItem
                    task={task}
                    project={project}
                    enableDoubleClickEdit
                    showProjectBadgeInActions={false}
                    showProjectBadgeInMetadata={false}
                    {...(narrow ? NARROW_TASK_ITEM_PROPS : {})}
                    dragHandle={(
                        <button
                            type="button"
                            {...attributes}
                            {...listeners}
                            onClick={(event) => event.stopPropagation()}
                            className="h-6 w-6 rounded-md border border-transparent text-muted-foreground/80 hover:text-foreground hover:bg-muted/70 hover:border-border/70 flex items-center justify-center transition-colors"
                            title="Drag"
                        >
                            <GripVertical className="w-3 h-3" />
                        </button>
                    )}
                />
            </div>
        </div>
    );
}

// Task row for non-default sort modes: draggable to the sidebar (move to another
// project or area) but not sortable, so the list itself is never a drop target.
export function DraggableProjectTaskRow({
    task,
    project,
    sequenceCue,
    availableSequenceLabel,
    laterSequenceLabel,
    narrow,
}: {
    task: Task;
    project: Project;
    sequenceCue?: ProjectSequenceTaskCue;
    availableSequenceLabel: string;
    laterSequenceLabel: string;
    narrow?: boolean;
}) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: task.id,
        data: { type: 'task', sortable: false },
    });
    const { taskContainerClassName, title } = getSequenceCuePresentation(
        sequenceCue,
        availableSequenceLabel,
        laterSequenceLabel,
    );

    return (
        <div ref={setNodeRef} style={{ opacity: isDragging ? 0.45 : 1 }} className="flex items-start gap-2">
            <div
                className={taskContainerClassName}
                title={title}
            >
                <TaskItem
                    task={task}
                    project={project}
                    enableDoubleClickEdit
                    showProjectBadgeInActions={false}
                    showProjectBadgeInMetadata={false}
                    {...(narrow ? NARROW_TASK_ITEM_PROPS : {})}
                    dragHandle={(
                        <button
                            type="button"
                            {...attributes}
                            {...listeners}
                            onClick={(event) => event.stopPropagation()}
                            className="h-6 w-6 rounded-md border border-transparent text-muted-foreground/80 hover:text-foreground hover:bg-muted/70 hover:border-border/70 flex items-center justify-center transition-colors"
                            title="Drag"
                        >
                            <GripVertical className="w-3 h-3" />
                        </button>
                    )}
                />
            </div>
        </div>
    );
}
