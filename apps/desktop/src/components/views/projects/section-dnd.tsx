import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { ProjectsSectionDragData } from './projects-view-dnd';

export const getSectionHeaderId = (sectionId: string) => `project-section:${sectionId}`;

export function SortableSectionHeader({ projectId, sectionId, label, disabled, children }: {
    projectId: string;
    sectionId: string;
    label: string;
    disabled: boolean;
    children: ReactNode;
}) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
        id: getSectionHeaderId(sectionId),
        data: { type: 'project-section', projectId, sectionId } satisfies ProjectsSectionDragData,
        disabled,
    });
    return (
        <div
            ref={setNodeRef}
            className="flex items-start gap-1"
            style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
        >
            {!disabled && (
                <button
                    ref={setActivatorNodeRef}
                    type="button"
                    {...attributes}
                    {...listeners}
                    aria-label={label}
                    title={label}
                    onClick={(event) => event.stopPropagation()}
                    className="flex h-7 w-6 flex-none cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:cursor-grabbing"
                >
                    <GripVertical className="h-3.5 w-3.5" />
                </button>
            )}
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

const SECTION_CONTAINER_PREFIX = 'section:';
export const NO_SECTION_CONTAINER = `${SECTION_CONTAINER_PREFIX}none`;
export const getSectionContainerId = (sectionId?: string | null) =>
    sectionId ? `${SECTION_CONTAINER_PREFIX}${sectionId}` : NO_SECTION_CONTAINER;
export const getSectionIdFromContainer = (containerId: string) =>
    containerId === NO_SECTION_CONTAINER ? null : containerId.replace(SECTION_CONTAINER_PREFIX, '');

type SectionDropZoneProps = {
    id: string;
    className?: string;
    children: ReactNode;
};

export function SectionDropZone({ id, className, children }: SectionDropZoneProps) {
    const { setNodeRef, isOver } = useDroppable({ id, data: { zone: 'section' } });
    return (
        <div ref={setNodeRef} className={cn(className, isOver && 'ring-2 ring-primary/40')}>
            {children}
        </div>
    );
}
