import { useState, useCallback } from 'react';
import { DndContext, type DragEndEvent, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, ChevronDown, ChevronRight, Pencil, Check, X, ExternalLink } from 'lucide-react';
import { DEFAULT_AREA_COLOR, formatI18nTemplate, getPersonNameKey, translateWithFallback, useTaskStore, type Area, type Person,
    baseTextCollator,
} from '@mindwtr/core';
import { AreaColorPicker } from '../projects/AreaColorPicker';
import { reportError } from '../../../lib/report-error';
import { isTauriRuntime } from '../../../lib/runtime';
import type { ConfirmationRequestOptions } from '../../../hooks/useConfirmDialog';

type Labels = {
    manage: string;
};

type SettingsManagePageProps = {
    t: Labels;
    translate: (key: string) => string;
    requestConfirmation: (options: ConfirmationRequestOptions) => Promise<boolean>;
};

const SAFE_PERSON_REFERENCE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'obsidian:']);

const isSafePersonReferenceLink = (value: string | undefined): value is string => {
    const trimmed = value?.trim();
    if (!trimmed) return false;
    try {
        const url = new URL(trimmed);
        return SAFE_PERSON_REFERENCE_PROTOCOLS.has(url.protocol);
    } catch {
        return false;
    }
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
    onUpdateColor: (id: string, color: string | undefined) => void;
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
    const commitColor = (color: string | undefined) => {
        if (color === area.color) return;
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
                noneLabel={translate('projects.colorNone')}
                customLabel={translate('projects.colorCustom')}
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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                title={translate('common.edit')}
            >
                <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
                type="button"
                onClick={() => onDelete(value)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-destructive opacity-0 transition-colors hover:bg-destructive/10 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                title={translate('common.delete')}
            >
                <Trash2 className="w-4 h-4" />
            </button>
        </div>
    );
}

function PersonRow({
    person,
    taskCount,
    onDelete,
    onRename,
    onUpdate,
    resolveText,
    translate,
}: {
    person: Person;
    taskCount: number;
    onDelete: (id: string) => void;
    onRename: (id: string, name: string) => void;
    onUpdate: (id: string, updates: Partial<Person>) => void;
    resolveText: (key: string, fallback: string) => string;
    translate: (key: string) => string;
}) {
    const commitName = (raw: string) => {
        const name = raw.trim();
        if (!name || name === person.name) return;
        onRename(person.id, name);
    };
    const commitNote = (raw: string) => {
        const note = raw.trim();
        if ((person.note ?? '') === note) return;
        onUpdate(person.id, { note: note || undefined });
    };
    const commitReferenceLink = (raw: string) => {
        const referenceLink = raw.trim();
        if ((person.referenceLink ?? '') === referenceLink) return;
        onUpdate(person.id, { referenceLink: referenceLink || undefined });
    };
    const openReferenceLink = async () => {
        const referenceLink = person.referenceLink?.trim();
        if (!isSafePersonReferenceLink(referenceLink)) return;
        let openError: unknown = null;
        if (isTauriRuntime()) {
            try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(referenceLink);
                return;
            } catch (error) {
                openError = error;
            }
        }
        const opened = window.open(referenceLink, '_blank', 'noopener,noreferrer');
        if (!opened) {
            reportError('Failed to open person reference link', openError ?? new Error('Popup blocked'));
        }
    };
    const canOpenReferenceLink = isSafePersonReferenceLink(person.referenceLink);

    return (
        <div className="rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center gap-2">
                <input
                    key={`${person.id}-name-${person.updatedAt}`}
                    defaultValue={person.name}
                    onBlur={(e) => commitName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            commitName(e.currentTarget.value);
                            e.currentTarget.blur();
                        }
                    }}
                    aria-label={resolveText('people.name', 'Name')}
                    className="min-w-0 flex-1 bg-background border border-border rounded px-2 py-1 text-sm"
                />
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {taskCount} {translate('common.tasks')}
                </span>
                <button
                    type="button"
                    onClick={() => void openReferenceLink()}
                    disabled={!canOpenReferenceLink}
                    className="text-muted-foreground hover:text-foreground hover:bg-muted h-8 w-8 rounded-md transition-colors flex items-center justify-center shrink-0 disabled:opacity-40 disabled:hover:bg-transparent"
                    title={resolveText('people.openReference', 'Open reference link')}
                >
                    <ExternalLink className="w-3.5 h-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() => onDelete(person.id)}
                    className="text-destructive hover:bg-destructive/10 h-8 w-8 rounded-md transition-colors flex items-center justify-center shrink-0"
                    title={translate('common.delete')}
                >
                    <Trash2 className="w-4 h-4" />
                </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
                <input
                    key={`${person.id}-note-${person.updatedAt}`}
                    defaultValue={person.note ?? ''}
                    onBlur={(e) => commitNote(e.target.value)}
                    placeholder={resolveText('people.notePlaceholder', 'Note')}
                    aria-label={resolveText('people.note', 'Note')}
                    className="min-w-0 bg-background border border-border rounded px-2 py-1 text-xs"
                />
                <input
                    key={`${person.id}-reference-${person.updatedAt}`}
                    defaultValue={person.referenceLink ?? ''}
                    onBlur={(e) => commitReferenceLink(e.target.value)}
                    placeholder={resolveText('people.referencePlaceholder', 'Reference link, including obsidian://')}
                    aria-label={resolveText('people.referenceLink', 'Reference link')}
                    className="min-w-0 bg-background border border-border rounded px-2 py-1 text-xs"
                />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function ManageSection({
    settingsKey,
    title,
    count,
    defaultOpen = false,
    children,
}: {
    settingsKey?: string;
    title: string;
    count: number;
    defaultOpen?: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="rounded-lg border border-border bg-card overflow-visible">
            <button
                type="button"
                data-settings-key={settingsKey}
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

export function SettingsManagePage({ t: _t, translate, requestConfirmation }: SettingsManagePageProps) {
    const areas = useTaskStore((s) => s.areas);
    const people = useTaskStore((s) => s.people);
    const tasks = useTaskStore((s) => s.tasks);
    const addArea = useTaskStore((s) => s.addArea);
    const updateArea = useTaskStore((s) => s.updateArea);
    const deleteArea = useTaskStore((s) => s.deleteArea);
    const reorderAreas = useTaskStore((s) => s.reorderAreas);
    const deleteTag = useTaskStore((s) => s.deleteTag);
    const renameTag = useTaskStore((s) => s.renameTag);
    const deleteContext = useTaskStore((s) => s.deleteContext);
    const renameContext = useTaskStore((s) => s.renameContext);
    const addPerson = useTaskStore((s) => s.addPerson);
    const updatePerson = useTaskStore((s) => s.updatePerson);
    const renamePerson = useTaskStore((s) => s.renamePerson);
    const deletePerson = useTaskStore((s) => s.deletePerson);
    const getDerivedState = useTaskStore((s) => s.getDerivedState);

    const { allContexts, allTags } = getDerivedState();

    // Sort areas by order
    const sortedAreas = [...areas].sort((a, b) => a.order - b.order);
    const sortedPeople = [...people].sort((a, b) => baseTextCollator.compare(a.name, b.name));
    const assignedTaskCountByPerson = new Map<string, number>();
    tasks.forEach((task) => {
        if (task.deletedAt) return;
        const key = getPersonNameKey(task.assignedTo);
        if (!key) return;
        assignedTaskCountByPerson.set(key, (assignedTaskCountByPerson.get(key) ?? 0) + 1);
    });

    // New area form
    const [newAreaName, setNewAreaName] = useState('');
    const [newAreaColor, setNewAreaColor] = useState<string | undefined>(DEFAULT_AREA_COLOR);
    const [isCreatingArea, setIsCreatingArea] = useState(false);
    const [newPersonName, setNewPersonName] = useState('');
    const [isCreatingPerson, setIsCreatingPerson] = useState(false);

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

    const handleCreatePerson = useCallback(async () => {
        const name = newPersonName.trim();
        if (!name) return;
        setIsCreatingPerson(true);
        try {
            await addPerson(name);
            setNewPersonName('');
        } finally {
            setIsCreatingPerson(false);
        }
    }, [addPerson, newPersonName]);

    const resolveText = (key: string, fallback: string) => {
        return translateWithFallback(translate, key, fallback);
    };
    const confirmDelete = useCallback(async (messageKey: string, fallback: string, onConfirm: () => void) => {
        const confirmed = await requestConfirmation({
            title: resolveText('common.delete', 'Delete'),
            description: formatI18nTemplate(resolveText(messageKey, fallback), {}),
            confirmLabel: resolveText('common.delete', 'Delete'),
            cancelLabel: resolveText('common.cancel', 'Cancel'),
        });
        if (confirmed) onConfirm();
    }, [requestConfirmation, resolveText]);

    return (
        <div className="space-y-6">
            {/* Areas */}
            <ManageSection
                settingsKey="manageAreas"
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
                                        onDelete={(id) => void confirmDelete('areas.deleteConfirm', 'Delete this area? Projects and tasks in this area will be kept and moved to unassigned.', () => void deleteArea(id))}
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
                            noneLabel={translate('projects.colorNone')}
                            customLabel={translate('projects.colorCustom')}
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

            {/* People */}
            <ManageSection
                settingsKey="managePeople"
                title={resolveText('people.title', 'People')}
                count={sortedPeople.length}
            >
                {sortedPeople.length === 0 && (
                    <div className="text-sm text-muted-foreground py-2">
                        {resolveText('people.empty', 'No people yet')}
                    </div>
                )}
                {sortedPeople.map((person) => (
                    <PersonRow
                        key={person.id}
                        person={person}
                        taskCount={assignedTaskCountByPerson.get(getPersonNameKey(person.name)) ?? 0}
                        onRename={(id, name) => void renamePerson(id, name, { updateTasks: true })}
                        onUpdate={(id, updates) => void updatePerson(id, updates)}
                        onDelete={(id) => void confirmDelete('people.deleteConfirm', 'Delete this person? Tasks assigned to them will be kept and moved to unassigned.', () => void deletePerson(id))}
                        resolveText={resolveText}
                        translate={translate}
                    />
                ))}
                <div className="border-t border-border/50 pt-3 space-y-2">
                    <label className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                        {resolveText('people.new', 'New Person')}
                    </label>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={newPersonName}
                            onChange={(e) => setNewPersonName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleCreatePerson();
                                }
                            }}
                            placeholder={resolveText('people.namePlaceholder', 'Person name')}
                            className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-sm"
                        />
                        <button
                            type="button"
                            onClick={() => void handleCreatePerson()}
                            disabled={isCreatingPerson || !newPersonName.trim()}
                            className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                            {isCreatingPerson ? resolveText('common.loading', 'Loading...') : resolveText('people.create', 'Create')}
                        </button>
                    </div>
                </div>
            </ManageSection>

            {/* Contexts */}
            <ManageSection
                settingsKey="manageContexts"
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
                settingsKey="manageTags"
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
