import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { timelineOrderScope, type TimelineOrderTarget } from '../../../lib/timeline-order';

export function TimelineOrderRow({ id, target, activeScope, pending, label, selected, onKeyDown, children }: {
    id: string; target: TimelineOrderTarget | null; activeScope: string | null; pending: boolean;
    label: string; selected: boolean; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, target: TimelineOrderTarget) => void;
    children: (handle: ReactNode) => ReactNode;
}) {
    const handleRef = useRef<HTMLButtonElement | null>(null);
    const scope = target ? timelineOrderScope(target) : null;
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging, isOver } = useSortable({
        id, data: { target, scope, label }, disabled: {
            draggable: !target || pending,
            droppable: !target || pending || Boolean(activeScope && scope !== activeScope),
        },
    });
    useEffect(() => {
        if (selected) {
            handleRef.current?.focus();
            handleRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [selected]);
    const handle = target && (
        <button
            ref={(node) => { handleRef.current = node; setActivatorNodeRef(node); }}
            type="button"
            {...attributes}
            {...listeners}
            data-testid={`timeline-reorder-${target.kind}`}
            data-task-id={target.kind === 'task' ? target.id : undefined}
            data-project-id={target.kind === 'project' ? target.id : undefined}
            aria-label={label}
            aria-roledescription={label}
            aria-pressed={selected || isDragging}
            title={label}
            disabled={pending}
            onKeyDown={(event) => onKeyDown(event, target)}
            onClick={(event) => event.stopPropagation()}
            className="flex h-full w-6 shrink-0 scroll-mt-11 cursor-grab touch-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-wait"
        >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
    );
    return (
        <div ref={setNodeRef} className={cn(isDragging && 'opacity-50', (selected || isOver && !isDragging) && 'ring-2 ring-inset ring-primary')}>
            {children(handle)}
        </div>
    );
}
