import { type Area, type Project, type ProjectSequenceTaskCue, type RangeSelectionOptions, type StoreActionResult, type Task } from '@mindwtr/core';
import { useDraggable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2 } from 'lucide-react';
import { TaskItem } from '../../TaskItem';
import { AreaColorPicker } from './AreaColorPicker';
import type { ProjectAreaSection } from './project-area-collapse';
import { isImeComposing } from '../../../lib/ime';

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
                applyLabel={t('common.ok')}
                cancelLabel={t('common.cancel')}
            />
            <input
                key={`${area.id}-${area.updatedAt}`}
                defaultValue={area.name}
                onBlur={(e) => {
                    commitAreaName(e.target.value);
                }}
                onKeyDown={(e) => {
                    if (isImeComposing(e)) return;
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
            aria-label="Drag"
            data-project-selection-ignore="true"
            onClick={(event) => event.stopPropagation()}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground/80 transition-colors hover:border-border/70 hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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


const NARROW_TASK_ITEM_PROPS = {
    actionsOverlay: true,
    showStatusSelect: false,
} as const;

export function SortableProjectTaskRow({
    task,
    project,
    onToggleSelect,
    sequenceCue,
    availableSequenceLabel,
    laterSequenceLabel,
    dragLabel,
    narrow,
    interactionDisabled = false,
}: {
    task: Task;
    project: Project;
    onToggleSelect?: (options?: RangeSelectionOptions) => void;
    sequenceCue?: ProjectSequenceTaskCue;
    availableSequenceLabel: string;
    laterSequenceLabel: string;
    dragLabel: string;
    narrow?: boolean;
    interactionDisabled?: boolean;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: task.id,
        data: { type: 'task', sortable: true },
        disabled: interactionDisabled,
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
                    onToggleSelect={onToggleSelect}
                    enableDoubleClickEdit
                    showProjectBadgeInActions={false}
                    showProjectBadgeInMetadata={false}
                    interactionDisabled={interactionDisabled}
                    {...(narrow ? NARROW_TASK_ITEM_PROPS : {})}
                    dragHandle={interactionDisabled ? undefined : (
                        <button
                            type="button"
                            {...attributes}
                            {...listeners}
                            onClick={(event) => event.stopPropagation()}
                            className="h-6 w-6 rounded-md border border-transparent text-muted-foreground/80 hover:text-foreground hover:bg-muted/70 hover:border-border/70 flex items-center justify-center transition-colors"
                            title={dragLabel}
                            aria-label={dragLabel}
                        >
                            <GripVertical className="w-3 h-3" />
                        </button>
                    )}
                />
            </div>
        </div>
    );
}


export function DraggableProjectTaskRow({
    task,
    project,
    onToggleSelect,
    sequenceCue,
    availableSequenceLabel,
    laterSequenceLabel,
    dragLabel,
    narrow,
    interactionDisabled = false,
}: {
    task: Task;
    project: Project;
    onToggleSelect?: (options?: RangeSelectionOptions) => void;
    sequenceCue?: ProjectSequenceTaskCue;
    availableSequenceLabel: string;
    laterSequenceLabel: string;
    dragLabel: string;
    narrow?: boolean;
    interactionDisabled?: boolean;
}) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: task.id,
        data: { type: 'task', sortable: false },
        disabled: interactionDisabled,
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
                    onToggleSelect={onToggleSelect}
                    enableDoubleClickEdit
                    showProjectBadgeInActions={false}
                    showProjectBadgeInMetadata={false}
                    interactionDisabled={interactionDisabled}
                    {...(narrow ? NARROW_TASK_ITEM_PROPS : {})}
                    dragHandle={interactionDisabled ? undefined : (
                        <button
                            type="button"
                            {...attributes}
                            {...listeners}
                            onClick={(event) => event.stopPropagation()}
                            className="h-6 w-6 rounded-md border border-transparent text-muted-foreground/80 hover:text-foreground hover:bg-muted/70 hover:border-border/70 flex items-center justify-center transition-colors"
                            title={dragLabel}
                            aria-label={dragLabel}
                        >
                            <GripVertical className="w-3 h-3" />
                        </button>
                    )}
                />
            </div>
        </div>
    );
}
