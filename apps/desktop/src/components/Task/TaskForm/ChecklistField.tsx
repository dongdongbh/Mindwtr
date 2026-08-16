import {
    closestCenter,
    DndContext,
    KeyboardSensor,
    PointerSensor,
    type DragEndEvent,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
    applyMarkdownKeyboardShortcut,
    applyMarkdownPairInsertion,
    generateUUID,
    isMarkdownEditorAssistEnabled,
    parsePastedChecklistItems,
    useTaskStore,
    type MarkdownSelection,
    type MarkdownToolbarResult,
    type Task,
} from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { taskEditorLabelClassName } from '../task-editor-label';
import {
    captureScrollSnapshot,
    focusElementWithoutScroll,
    restoreScrollSnapshotSoon,
} from '../../../lib/scroll-preservation';

type ChecklistFieldProps = {
    t: (key: string) => string;
    taskId: string;
    checklist: Task['checklist'];
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    resetTaskChecklist: (taskId: string) => void;
};

const isRangeSelection = (selection: MarkdownSelection | null | undefined): selection is MarkdownSelection => (
    selection != null && selection.start !== selection.end
);

const getPairInsertionSelection = (
    currentValue: string,
    eventSelection: MarkdownSelection,
    pairSnapshot: { value: string; selection: MarkdownSelection } | null | undefined,
    fallbackSelection: MarkdownSelection | null | undefined,
): MarkdownSelection => {
    if (eventSelection.start !== eventSelection.end) {
        return eventSelection;
    }
    if (pairSnapshot?.value === currentValue && isRangeSelection(pairSnapshot.selection)) {
        return pairSnapshot.selection;
    }
    if (isRangeSelection(fallbackSelection)) {
        return fallbackSelection;
    }
    return eventSelection;
};

const areChecklistsEqual = (a: Task['checklist'], b: Task['checklist']): boolean => {
    if (a === b) return true;
    const listA = a || [];
    const listB = b || [];
    if (listA.length !== listB.length) return false;
    for (let i = 0; i < listA.length; i += 1) {
        const itemA = listA[i];
        const itemB = listB[i];
        if (!itemA || !itemB) return false;
        if (itemA.id !== itemB.id) return false;
        if (itemA.title !== itemB.title) return false;
        if (itemA.isCompleted !== itemB.isCompleted) return false;
    }
    return true;
};

export const reorderChecklistItems = (
    checklist: Task['checklist'],
    activeId: string,
    overId: string,
): Task['checklist'] => {
    const list = checklist || [];
    const oldIndex = list.findIndex((item) => item.id === activeId);
    const newIndex = list.findIndex((item) => item.id === overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return list;

    const next = [...list];
    const [moved] = next.splice(oldIndex, 1);
    if (!moved) return list;
    next.splice(newIndex, 0, moved);
    return next;
};

function SortableChecklistRow({
    canReorder,
    children,
    dragLabel,
    itemId,
}: {
    canReorder: boolean;
    children: (props: { handle: ReactNode; isDragging: boolean }) => ReactNode;
    dragLabel: string;
    itemId: string;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: itemId,
        disabled: !canReorder,
    });
    const style: CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : 1,
    };
    const handle = canReorder ? (
        <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={dragLabel}
            title={dragLabel}
            onClick={(event) => event.stopPropagation()}
            className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                'border border-transparent text-muted-foreground opacity-100 transition-colors',
                'hover:border-border/70 hover:bg-muted/70 hover:text-foreground',
                'focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary/30',
                'focus-visible:opacity-100 cursor-grab active:cursor-grabbing touch-none',
            )}
        >
            <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>
    ) : null;

    return (
        <div ref={setNodeRef} style={style} className="relative flex items-center gap-2 group/item">
            {children({ handle, isDragging })}
        </div>
    );
}

export function ChecklistField({
    t,
    taskId,
    checklist,
    updateTask,
    resetTaskChecklist,
}: ChecklistFieldProps) {
    const markdownEditorAssist = useTaskStore((state) => isMarkdownEditorAssistEnabled(state.settings));
    const [checklistDraft, setChecklistDraft] = useState<Task['checklist']>(checklist || []);
    const checklistDraftRef = useRef<Task['checklist']>(checklist || []);
    const checklistDirtyRef = useRef(false);
    const checklistInputRefs = useRef<Array<HTMLInputElement | null>>([]);
    const checklistSelectionRefs = useRef<Array<MarkdownSelection>>([]);
    const lastChecklistPairSelectionRefs = useRef<Array<{ value: string; selection: MarkdownSelection } | null>>([]);

    const lastTaskIdRef = useRef(taskId);

    useEffect(() => {
        checklistInputRefs.current = [];
        checklistSelectionRefs.current = [];
        lastChecklistPairSelectionRefs.current = [];
    }, [taskId]);

    // Adopt external checklist changes, but never clobber in-progress typing:
    // a dirty draft only resets when switching to a different task.
    useEffect(() => {
        const taskChanged = lastTaskIdRef.current !== taskId;
        lastTaskIdRef.current = taskId;
        if (!taskChanged && checklistDirtyRef.current) return;
        const incoming = checklist || [];
        if (!taskChanged && areChecklistsEqual(incoming, checklistDraftRef.current)) return;
        setChecklistDraft(incoming);
        checklistDraftRef.current = incoming;
        checklistDirtyRef.current = false;
    }, [taskId, checklist]);

    const updateChecklistDraft = useCallback((next: Task['checklist']) => {
        setChecklistDraft(next);
        checklistDraftRef.current = next;
        checklistDirtyRef.current = true;
    }, []);

    const commitChecklistUpdate = useCallback((nextChecklist: Task['checklist']) => {
        updateTask(taskId, { checklist: nextChecklist });
    }, [taskId, updateTask]);

    const commitChecklistDraft = useCallback((next?: Task['checklist']) => {
        const payload = next ?? checklistDraftRef.current;
        if (!checklistDirtyRef.current && next === undefined) return;
        checklistDirtyRef.current = false;
        commitChecklistUpdate(payload);
    }, [commitChecklistUpdate]);

    // Blank rows are a typing convenience (Enter mints the next row before it
    // has text), not content — they are dropped when editing moves on, so a
    // saved task never keeps a trailing empty item (#1045).
    const dropEmptyChecklistItems = useCallback(() => {
        const list = checklistDraftRef.current || [];
        const filtered = list.filter((item) => item.title.trim() !== '');
        if (filtered.length === list.length) return false;
        setChecklistDraft(filtered);
        checklistDraftRef.current = filtered;
        checklistDirtyRef.current = false;
        commitChecklistUpdate(filtered);
        return true;
    }, [commitChecklistUpdate]);

    // True unmount-only flush (deps intentionally empty, latest committer kept
    // in a ref): keying this on commitChecklistUpdate would re-run the cleanup
    // on every parent re-render and strip the blank row mid-typing.
    const commitChecklistUpdateRef = useRef(commitChecklistUpdate);
    commitChecklistUpdateRef.current = commitChecklistUpdate;
    useEffect(() => () => {
        const list = checklistDraftRef.current || [];
        const filtered = list.filter((item) => item.title.trim() !== '');
        if (checklistDirtyRef.current || filtered.length !== list.length) {
            commitChecklistUpdateRef.current(filtered);
        }
    }, []);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 6,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );

    const focusChecklistIndex = useCallback((index: number, source?: HTMLElement) => {
        const scrollSnapshot = captureScrollSnapshot(source);
        const scheduleFocus = typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame.bind(window)
            : (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0);
        scheduleFocus(() => {
            const input = checklistInputRefs.current[index];
            if (!input) return;
            focusElementWithoutScroll(input, scrollSnapshot);
            restoreScrollSnapshotSoon(scrollSnapshot);
        });
    }, []);

    const getInputSelection = useCallback((input: HTMLInputElement): MarkdownSelection => ({
        start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length,
    }), []);

    const restoreInputSelection = useCallback((input: HTMLInputElement, selection: MarkdownSelection) => {
        const applySelection = () => {
            input.setSelectionRange(selection.start, selection.end);
        };
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(applySelection);
        } else {
            window.setTimeout(applySelection, 0);
        }
    }, []);

    const updateChecklistItemTitle = useCallback((index: number, title: string) => {
        const nextList = (checklistDraftRef.current || []).map((entry, i) =>
            i === index ? { ...entry, title } : entry
        );
        updateChecklistDraft(nextList);
    }, [updateChecklistDraft]);

    const applyChecklistMarkdownResult = useCallback((
        index: number,
        result: MarkdownToolbarResult,
        source: HTMLInputElement,
        rememberPairRange = false,
    ) => {
        updateChecklistItemTitle(index, result.value);
        checklistSelectionRefs.current[index] = result.selection;
        lastChecklistPairSelectionRefs.current[index] = rememberPairRange && isRangeSelection(result.selection)
            ? { value: result.value, selection: result.selection }
            : null;
        restoreInputSelection(source, result.selection);
    }, [restoreInputSelection, updateChecklistItemTitle]);

    const handleChecklistPaste = useCallback((index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const normalized = text.replace(/\r\n?/g, '\n');
        if (!normalized.includes('\n')) return;
        event.preventDefault();
        const list = checklistDraftRef.current || [];
        const current = list[index];
        if (!current) return;
        const selection = getInputSelection(event.currentTarget);
        const newlineIndex = normalized.indexOf('\n');
        const firstSegment = normalized.slice(0, newlineIndex);
        const restItems = parsePastedChecklistItems(normalized.slice(newlineIndex + 1));
        const replacingWholeTitle = selection.start === 0 && selection.end === current.title.length;
        // Replacing the whole title is a list import (markers stripped); a
        // mid-text paste splices the raw first segment like a plain text edit.
        const firstParsed = parsePastedChecklistItems(firstSegment)[0];
        const updatedCurrent = replacingWholeTitle
            ? {
                ...current,
                title: firstParsed?.title ?? '',
                isCompleted: current.isCompleted || (firstParsed?.isCompleted ?? false),
            }
            : {
                ...current,
                title: `${current.title.slice(0, selection.start)}${firstSegment}${current.title.slice(selection.end)}`,
            };
        const cursor = replacingWholeTitle ? updatedCurrent.title.length : selection.start + firstSegment.length;
        checklistSelectionRefs.current[index] = { start: cursor, end: cursor };
        lastChecklistPairSelectionRefs.current[index] = null;
        const inserted = restItems.map((item) => ({
            id: generateUUID(),
            title: item.title,
            isCompleted: item.isCompleted,
        }));
        const nextList = [...list.slice(0, index), updatedCurrent, ...inserted, ...list.slice(index + 1)];
        setChecklistDraft(nextList);
        checklistDraftRef.current = nextList;
        checklistDirtyRef.current = false;
        commitChecklistUpdate(nextList);
    }, [commitChecklistUpdate, getInputSelection]);

    const handleChecklistDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const nextList = reorderChecklistItems(
            checklistDraftRef.current,
            String(active.id),
            String(over.id),
        );
        if (areChecklistsEqual(nextList, checklistDraftRef.current)) return;
        setChecklistDraft(nextList);
        checklistDraftRef.current = nextList;
        checklistDirtyRef.current = false;
        commitChecklistUpdate(nextList);
    }, [commitChecklistUpdate]);

    const checklistItems = checklistDraft || [];
    const canReorderChecklist = checklistItems.length > 1;

    return (
        <div
            className="flex flex-col gap-2 w-full pt-2 border-t border-border/50"
            onBlur={(event) => {
                // Only when focus leaves the checklist entirely — moving between
                // rows (Enter, Tab, clicks) must keep the just-minted blank row.
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                if (!dropEmptyChecklistItems()) {
                    commitChecklistDraft();
                }
            }}
        >
            <label className={taskEditorLabelClassName}>{t('taskEdit.checklist')}</label>
            <div className="space-y-2 pr-3">
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleChecklistDragEnd}>
                    <SortableContext items={checklistItems.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                        {checklistItems.map((item, index) => (
                            <SortableChecklistRow
                                key={item.id || index}
                                itemId={item.id}
                                canReorder={canReorderChecklist}
                                dragLabel="Drag checklist item"
                            >
                                {({ handle }) => (
                                    <>
                                        {handle}
                                        <button
                                            type="button"
                                            aria-label={`${t('taskEdit.checklist')} ${index + 1}`}
                                            onClick={() => {
                                                const newList = checklistItems.map((entry, i) =>
                                                    i === index ? { ...entry, isCompleted: !entry.isCompleted } : entry
                                                );
                                                setChecklistDraft(newList);
                                                checklistDraftRef.current = newList;
                                                checklistDirtyRef.current = false;
                                                commitChecklistUpdate(newList);
                                            }}
                                            className={cn(
                                                'w-4 h-4 shrink-0 border rounded flex items-center justify-center transition-colors',
                                                item.isCompleted
                                                    ? 'bg-primary border-primary text-primary-foreground'
                                                    : 'border-muted-foreground hover:border-primary'
                                            )}
                                        >
                                            {item.isCompleted && <Check className="w-3 h-3" />}
                                        </button>
                                        <input
                                            type="text"
                                            value={item.title}
                                            ref={(node) => {
                                                checklistInputRefs.current[index] = node;
                                            }}
                                            onChange={(event) => {
                                                const previousSelection = checklistSelectionRefs.current[index]
                                                    ?? getInputSelection(event.currentTarget);
                                                const pairedInsertion = applyMarkdownPairInsertion(
                                                    item.title,
                                                    event.target.value,
                                                    previousSelection,
                                                    { assist: markdownEditorAssist },
                                                );
                                                if (pairedInsertion) {
                                                    applyChecklistMarkdownResult(index, pairedInsertion, event.currentTarget, true);
                                                    return;
                                                }
                                                lastChecklistPairSelectionRefs.current[index] = null;
                                                updateChecklistItemTitle(index, event.target.value);
                                                checklistSelectionRefs.current[index] = getInputSelection(event.currentTarget);
                                            }}
                                            onPaste={(event) => {
                                                handleChecklistPaste(index, event);
                                            }}
                                            onBlur={() => {
                                                commitChecklistDraft();
                                            }}
                                            onSelect={(event) => {
                                                const selection = getInputSelection(event.currentTarget);
                                                checklistSelectionRefs.current[index] = selection;
                                                if (isRangeSelection(selection)) {
                                                    lastChecklistPairSelectionRefs.current[index] = null;
                                                }
                                            }}
                                            onKeyDown={(event) => {
                                                const currentValue = event.currentTarget.value;
                                                const eventSelection = getInputSelection(event.currentTarget);
                                                const lowerKey = event.key.toLowerCase();
                                                if ((event.metaKey || event.ctrlKey) && !event.altKey) {
                                                    if (lowerKey !== 'b' && lowerKey !== 'i') return;
                                                    checklistSelectionRefs.current[index] = eventSelection;
                                                    const next = applyMarkdownKeyboardShortcut(currentValue, eventSelection, {
                                                        key: event.key,
                                                        ctrlKey: event.ctrlKey,
                                                        metaKey: event.metaKey,
                                                    });
                                                    if (!next) return;
                                                    event.preventDefault();
                                                    applyChecklistMarkdownResult(index, next, event.currentTarget);
                                                    return;
                                                }
                                                if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
                                                    const selection = getPairInsertionSelection(
                                                        currentValue,
                                                        eventSelection,
                                                        lastChecklistPairSelectionRefs.current[index],
                                                        checklistSelectionRefs.current[index],
                                                    );
                                                    checklistSelectionRefs.current[index] = selection;
                                                    const next = applyMarkdownPairInsertion(
                                                        currentValue,
                                                        `${currentValue.slice(0, selection.start)}${event.key}${currentValue.slice(selection.end)}`,
                                                        selection,
                                                        { assist: markdownEditorAssist },
                                                    );
                                                    if (!next) return;
                                                    event.preventDefault();
                                                    applyChecklistMarkdownResult(index, next, event.currentTarget, true);
                                                    return;
                                                }
                                                lastChecklistPairSelectionRefs.current[index] = null;
                                                if (event.key === 'Enter') {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    const newItem = {
                                                        id: generateUUID(),
                                                        title: '',
                                                        isCompleted: false,
                                                    };
                                                    const nextList = [...checklistItems];
                                                    nextList.splice(index + 1, 0, newItem);
                                                    setChecklistDraft(nextList);
                                                    checklistDraftRef.current = nextList;
                                                    checklistDirtyRef.current = false;
                                                    commitChecklistUpdate(nextList);
                                                    focusChecklistIndex(index + 1, event.currentTarget);
                                                    return;
                                                }
                                                if (event.key === 'Backspace' && item.title.length === 0) {
                                                    event.preventDefault();
                                                    const nextList = checklistItems.filter((_, i) => i !== index);
                                                    setChecklistDraft(nextList);
                                                    checklistDraftRef.current = nextList;
                                                    checklistDirtyRef.current = false;
                                                    commitChecklistUpdate(nextList);
                                                    const nextIndex = Math.max(0, index - 1);
                                                    if (nextList.length > 0) {
                                                        focusChecklistIndex(nextIndex, event.currentTarget);
                                                    }
                                                    return;
                                                }
                                                if (event.key === 'Tab') {
                                                    event.stopPropagation();
                                                    const nextIndex = event.shiftKey ? index - 1 : index + 1;
                                                    if (nextIndex >= 0 && nextIndex < checklistItems.length) {
                                                        event.preventDefault();
                                                        focusChecklistIndex(nextIndex, event.currentTarget);
                                                    } else {
                                                        commitChecklistDraft();
                                                    }
                                                }
                                            }}
                                            className={cn(
                                                'flex-1 bg-transparent text-sm focus:outline-none border-b border-transparent focus:border-primary/50 px-1',
                                                item.isCompleted && 'text-muted-foreground line-through'
                                            )}
                                            placeholder={t('taskEdit.itemNamePlaceholder')}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const newList = checklistItems.filter((_, i) => i !== index);
                                                setChecklistDraft(newList);
                                                checklistDraftRef.current = newList;
                                                checklistDirtyRef.current = false;
                                                commitChecklistUpdate(newList);
                                            }}
                                            aria-label={t('common.delete')}
                                            className="p-1 text-muted-foreground opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 focus-visible:opacity-100 hover:text-destructive [@media(hover:none)]:opacity-100"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </>
                                )}
                            </SortableChecklistRow>
                        ))}
                    </SortableContext>
                </DndContext>
                <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                        const source = document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : undefined;
                        const newItem = {
                            id: generateUUID(),
                            title: '',
                            isCompleted: false,
                        };
                        const nextList = [...(checklistDraft || []), newItem];
                        setChecklistDraft(nextList);
                        checklistDraftRef.current = nextList;
                        checklistDirtyRef.current = false;
                        commitChecklistUpdate(nextList);
                        focusChecklistIndex(nextList.length - 1, source);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            event.stopPropagation();
                            const newItem = {
                                id: generateUUID(),
                                title: '',
                                isCompleted: false,
                            };
                            const nextList = [...(checklistDraft || []), newItem];
                            setChecklistDraft(nextList);
                            checklistDraftRef.current = nextList;
                            checklistDirtyRef.current = false;
                            commitChecklistUpdate(nextList);
                            focusChecklistIndex(nextList.length - 1, event.currentTarget);
                        }
                    }}
                    className="flex items-center gap-1 text-xs font-medium text-info hover:text-info/80"
                >
                    <Plus className="w-3 h-3" />
                    {t('taskEdit.addItem')}
                </button>
                {(checklistDraft || []).length > 0 && (
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => resetTaskChecklist(taskId)}
                            className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                        >
                            {t('taskEdit.resetChecklist')}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
