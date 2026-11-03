import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { StoreTaskItem, type StoreTaskItemProps } from '../list/StoreTaskItem';


export function SortableFocusRow({
    dragAriaLabel,
    ...storeTaskItemProps
}: StoreTaskItemProps & { dragAriaLabel: string }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: storeTaskItemProps.taskId,
    });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : 1,
    };

    return (
        <div ref={setNodeRef} style={style}>
            <StoreTaskItem
                {...storeTaskItemProps}
                dragHandle={(
                    <button
                        type="button"
                        {...attributes}
                        {...listeners}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={dragAriaLabel}
                        title={dragAriaLabel}
                        className="h-6 w-6 rounded-md border border-transparent text-muted-foreground/80 hover:text-foreground hover:bg-muted/70 hover:border-border/70 flex items-center justify-center transition-colors"
                    >
                        <GripVertical className="w-3 h-3" />
                    </button>
                )}
            />
        </div>
    );
}
