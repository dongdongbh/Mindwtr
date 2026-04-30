import { useState, useCallback } from 'react';
import { DndContext, type DragEndEvent, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, ChevronDown, ChevronRight, Pencil, Check, X } from 'lucide-react';
import { DEFAULT_AREA_COLOR, translateWithFallback, useTaskStore, type Area } from '@mindwtr/core';
import { AreaColorPicker } from '../projects/AreaColorPicker';

type Labels = {
    manage: string;
};

type SettingsManagePageProps = {
    t: Labels;
    translate: (key: string) => string;
};

// ---------------------------------------------------------------------------
// Sortable area row (reused from AreaManagerModal pattern)
// ---------------------------------------------------------------------------

function SortableAreaRow({
    area,
    onDelete,
    onUpdateName,
    onUpdateColor,
    translate,
}: {
    area: Area;
    onDelete: (id: string) => void;
    onUpdateName: (id: string, name: string) => void;
    onUpdateColor: (id: string, color: string) => void;
    translate: (key: string) => string;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: area.id });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
    };
    const commitName = (raw: string) => {
        const name = raw.trim();
        if (!name || name === area.name) return;
        onUpdateName(area.id, name);
    };
    const commitColor = (color: string) => {
        if (!color || color === area.color) return;
        onUpdateColor(area.id, color);
    };

    return (
        <div ref={setNodeRef} style={style} className="flex items-center gap-2">
            <button
                type="button"
                {...attributes}
                {...listeners}
                className="h-8 w-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted flex items-center justify-center shrink-0"
                title={translate('projects.sortAreas')}
            >
                <GripVertical className="w-4 h-4" />
            </button>
            <AreaColorPicker
                value={area.color}
                onChange={commitColor}
                title={translate('projects.color')}
            />
            <input
                key={`${area.id}-${area.updatedAt}`}
                defaultValue={area.name}
                onBlur={(e) => commitName(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        commitName(e.currentTarget.value);
                        e.currentTarget.blur();
                    }
                }}
                className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-sm min-w-0"
            />
            <button
                type="button"
                onClick={() => onDelete(area.id)}
                className="text-destructive hover:bg-destructive/10 h-8 w-8 rounded-md transition-colors flex items-center justify-center shrink-0"
                title={translate('common.delete')}
            >
                <Trash2 className="w-4 h-4" />
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Token row for contexts and tags (inline rename + delete)
// ---------------------------------------------------------------------------

function TokenRow({
    value,
    onRename,
    onDelete,
    translate,
}: {
    value: string;
    onRename: (oldValue: string, newValue: string) => void;
    onDelete: (value: string) => void;
    translate: (key: string) => string;
}) {
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState(value);

    const commitRename = () => {
        const trimmed = editValue.trim();
        if (trimmed && trimmed !== value) {
            onRename(value, trimmed);
        }
        setEditing(false);
    };

    const cancelEdit = () => {
        setEditValue(value);
        setEditing(false);
    };

    if (editing) {
        return (
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename();
                        }
                        if (e.key === 'Escape') {
                            cancelEdit();
                        }
                    }}
                    autoFocus
                    className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-sm min-w-0"
                />
                <button
                    type="button"
                    onClick={commitRename}
                    className="text-primary hover:bg-primary/10 h-8 w-8 rounded-md transition-colors flex items-center justify-center shrink-0"
                    title={translate('common.save')}
                >
                    <Check className="w-4 h-4" />
                </button>
                <button
                    type="button"
                    onClick={cancelEdit}
                    className="text-muted-foreground hover:bg-muted h-8 w-8 rounded-md transition-colors flex items-center justify-center shrink-0"
                    title={translate('common.cancel')}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2 group">
            <span className="flex-1 px-2 py-1 text-sm min-w-0 truncate">{value}</span>
            <button
                type="button"
                onClick={() => {
                    setEditValue(value);
                    setEditing(true);
                }}
                className="text-muted-foreground hover:text-foreground hover:bg-muted h-8 w-8 rounded-md transition-colors flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100"
                title={translate('common.edit')}
            >
                <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
                type="button"
                onClick={() => onDelete(value)}
                className="text-destructive hover:bg-destructive/10 h-8 w-8 rounded-md transition-colors flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100"
                title={translate('common.delete')}
            >
                <Trash2 className="w-4 h-4" />
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function ManageSection({
    title,
    count,
    defaultOpen = false,
    children,
}: {
    title: string;
    count: number;
    defaultOpen?: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            >
                {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                <span className="font-medium text-sm">{title}</span>
                <span className="text-xs text-muted-foreground ml-auto">{count}</span>
            </button>
            {open && <div className="px-4 pb-4 space-y-2">{children}</div>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SettingsManagePage({ t: _t, translate }: SettingsManagePageProps) {
    const areas = useTaskStore((s) => s.areas);
    const addArea = useTaskStore((s) => s.addArea);
    const updateArea = useTaskStore((s) => s.updateArea);
    const deleteArea = useTaskStore((s) => s.deleteArea);
    const reorderAreas = useTaskStore((s) => s.reorderAreas);
    const deleteTag = useTaskStore((s) => s.deleteTag);
    const renameTag = useTaskStore((s) => s.renameTag);
    const deleteContext = useTaskStore((s) => s.deleteContext);
    const renameContext = useTaskStore((s) => s.renameContext);
    const getDerivedState = useTaskStore((s) => s.getDerivedState);

    const { allContexts, allTags } = getDerivedState();

    // Sort areas by order
    const sortedAreas = [...areas].sort((a, b) => a.order - b.order);

    // New area form
    const [newAreaName, setNewAreaName] = useState('');
    const [newAreaColor, setNewAreaColor] = useState(DEFAULT_AREA_COLOR);
    const [isCreatingArea, setIsCreatingArea] = useState(false);

    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    const handleCreateArea = useCallback(async () => {
        const name = newAreaName.trim();
        if (!name) return;
        setIsCreatingArea(true);
        try {
            await addArea(name, { color: newAreaColor });
            setNewAreaName('');
            setNewAreaColor(DEFAULT_AREA_COLOR);
        } finally {
            setIsCreatingArea(false);
        }
    }, [newAreaName, newAreaColor, addArea]);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = sortedAreas.findIndex((a) => a.id === active.id);
        const newIndex = sortedAreas.findIndex((a) => a.id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;
        const reordered = [...sortedAreas];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        void reorderAreas(reordered.map((a) => a.id));
    }, [sortedAreas, reorderAreas]);

    const handleSortAreasByName = useCallback(() => {
        const sorted = [...sortedAreas].sort((a, b) => a.name.localeCompare(b.name));
        void reorderAreas(sorted.map((a) => a.id));
    }, [sortedAreas, reorderAreas]);

    const resolveText = (key: string, fallback: string) => {
        return translateWithFallback(translate, key, fallback);
    };

    return (
        <div className="space-y-6">
            {/* Areas */}
            <ManageSection
                title={resolveText('areas.manage', 'Manage Areas')}
                count={sortedAreas.length}
            >
                {sortedAreas.length === 0 && (
                    <div className="text-sm text-muted-foreground py-2">
                        {resolveText('projects.noArea', 'No areas')}
                    </div>
                )}
                {sortedAreas.length > 0 && (
                    <>
                        <div className="flex items-center gap-1 mb-2">
                            <button
                                type="button"
                                onClick={handleSortAreasByName}
                                className="text-xs px-2 py-1 rounded border border-border bg-muted/50 hover:bg-muted"
                            >
                                {translate('projects.sortByName')}
                            </button>
                        </div>
                        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                            <SortableContext items={sortedAreas.map((a) => a.id)} strategy={verticalListSortingStrategy}>
                                {sortedAreas.map((area) => (
                                    <SortableAreaRow
                                        key={area.id}
                                        area={area}
                                        onDelete={(id) => void deleteArea(id)}
                                        onUpdateName={(id, name) => void updateArea(id, { name })}
                                        onUpdateColor={(id, color) => void updateArea(id, { color })}
                                        translate={translate}
                                    />
                                ))}
                            </SortableContext>
                        </DndContext>
                    </>
                )}
                <div className="border-t border-border/50 pt-3 space-y-2">
                    <label className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                        {resolveText('areas.new', 'New Area')}
                    </label>
                    <div className="flex items-center gap-2">
                        <AreaColorPicker
                            value={newAreaColor}
                            onChange={setNewAreaColor}
                            title={translate('projects.color')}
                        />
                        <input
                            type="text"
                            value={newAreaName}
                            onChange={(e) => setNewAreaName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleCreateArea();
                                }
                            }}
                            placeholder={resolveText('areas.namePlaceholder', 'Area name')}
                            className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-sm"
                        />
                        <button
                            type="button"
                            onClick={() => void handleCreateArea()}
                            disabled={isCreatingArea || !newAreaName.trim()}
                            className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                            {isCreatingArea ? resolveText('common.loading', 'Loading...') : resolveText('areas.create', 'Create')}
                        </button>
                    </div>
                </div>
            </ManageSection>

            {/* Contexts */}
            <ManageSection
                title={resolveText('contexts.title', 'Contexts')}
                count={allContexts.length}
            >
                {allContexts.length === 0 && (
                    <div className="text-sm text-muted-foreground py-2">
                        {resolveText('contexts.noContexts', 'No contexts found. Add contexts like @home, @work, @computer to your tasks')}
                    </div>
                )}
                {allContexts.map((ctx) => (
                    <TokenRow
                        key={ctx}
                        value={ctx}
                        onRename={(oldVal, newVal) => void renameContext(oldVal, newVal)}
                        onDelete={(val) => void deleteContext(val)}
                        translate={translate}
                    />
                ))}
            </ManageSection>

            {/* Tags */}
            <ManageSection
                title={resolveText('contexts.tags', 'Tags')}
                count={allTags.length}
            >
                {allTags.length === 0 && (
                    <div className="text-sm text-muted-foreground py-2">
                        {resolveText('projects.noTags', 'No tags')}
                    </div>
                )}
                {allTags.map((tag) => (
                    <TokenRow
                        key={tag}
                        value={tag}
                        onRename={(oldVal, newVal) => void renameTag(oldVal, newVal)}
                        onDelete={(val) => void deleteTag(val)}
                        translate={translate}
                    />
                ))}
            </ManageSection>
        </div>
    );
}
