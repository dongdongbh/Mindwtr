import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, CalendarClock, ChevronRight, Copy, MapPin, Tag, Trash2, X } from 'lucide-react';
import {
    hasTimeComponent,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type Area,
    type StoreActionResult,
    type Task,
} from '@mindwtr/core';

import { reportError } from '../../lib/report-error';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { AreaSelector } from '../ui/AreaSelector';
import { normalizeDateInputValue } from './task-item-helpers';
import { ContextsField } from './fields/TaskMetadataFields';

const VIEWPORT_MARGIN_PX = 8;
const PANEL_GAP_PX = 8;
const MENU_WIDTH_PX = 224;
const MENU_HEIGHT_EDITABLE_PX = 238;
const MENU_HEIGHT_READ_ONLY_PX = 88;

type QuickPanelId = 'dueDate' | 'reviewAt' | 'area' | 'contexts' | null;

interface TaskQuickActionMenuProps {
    task: Task;
    x: number;
    y: number;
    t: (key: string) => string;
    nativeDateInputLocale: string;
    contextOptions: string[];
    areas: Area[];
    readOnly: boolean;
    onClose: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onCreateArea: (name: string) => Promise<string | null>;
    onUpdateTask: (updates: Partial<Task>) => Promise<StoreActionResult>;
}

const clamp = (value: number, min: number, max: number) => {
    if (max <= min) return min;
    return Math.min(Math.max(value, min), max);
};

const parseTokenInput = (value: string) => Array.from(new Set(
    value
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
));

const getDueDateDraft = (value?: string) => {
    if (!value) return { date: '', time: '' };
    const parsed = safeParseDate(value);
    if (!parsed) return { date: '', time: '' };
    return {
        date: safeFormatDate(parsed, 'yyyy-MM-dd', value),
        time: hasTimeComponent(value) ? safeFormatDate(parsed, 'HH:mm', value) : '',
    };
};

export function TaskQuickActionMenu({
    task,
    x,
    y,
    t,
    nativeDateInputLocale,
    contextOptions,
    areas,
    readOnly,
    onClose,
    onDuplicate,
    onDelete,
    onCreateArea,
    onUpdateTask,
}: TaskQuickActionMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const dueButtonRef = useRef<HTMLButtonElement | null>(null);
    const reviewButtonRef = useRef<HTMLButtonElement | null>(null);
    const areaButtonRef = useRef<HTMLButtonElement | null>(null);
    const contextsButtonRef = useRef<HTMLButtonElement | null>(null);
    const [activePanel, setActivePanel] = useState<QuickPanelId>(null);
    const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
    const initialDueDraft = getDueDateDraft(task.dueDate);
    const initialReviewDraft = getDueDateDraft(task.reviewAt);
    const initialAreaDraft = task.areaId || '';
    const initialContextsDraft = task.contexts?.join(', ') || '';
    const [dueDateDraft, setDueDateDraft] = useState(initialDueDraft.date);
    const [dueTimeDraft, setDueTimeDraft] = useState(initialDueDraft.time);
    const [reviewDateDraft, setReviewDateDraft] = useState(initialReviewDraft.date);
    const [reviewTimeDraft, setReviewTimeDraft] = useState(initialReviewDraft.time);
    const [areaDraft, setAreaDraft] = useState(initialAreaDraft);
    const [contextsDraft, setContextsDraft] = useState(initialContextsDraft);
    const [savingPanel, setSavingPanel] = useState<Exclude<QuickPanelId, null> | null>(null);
    const dueLabel = tFallback(t, 'taskEdit.dueDateLabel', 'Due Date');
    const reviewLabel = tFallback(t, 'taskEdit.reviewDateLabel', 'Review Date');
    const areaLabel = tFallback(t, 'taskEdit.areaLabel', 'Area');
    const contextsLabel = tFallback(t, 'taskEdit.contextsLabel', 'Contexts');
    const noAreaLabel = tFallback(t, 'taskEdit.noAreaOption', 'No Area');
    const duplicateLabel = tFallback(t, 'projects.duplicate', 'Duplicate');
    const deleteLabel = tFallback(t, 'common.delete', 'Delete');
    const saveLabel = tFallback(t, 'common.save', 'Save');
    const cancelLabel = tFallback(t, 'common.cancel', 'Cancel');
    const clearLabel = tFallback(t, 'common.clear', 'Clear');
    const moreOptionsLabel = tFallback(t, 'taskEdit.moreOptions', 'More options');
    const searchAreasLabel = tFallback(t, 'areas.search', 'Search areas');
    const noMatchesLabel = tFallback(t, 'common.noMatches', 'No matches');
    const createAreaLabel = tFallback(t, 'areas.create', 'Create area');
    const canEditArea = !task.projectId;
    const normalizedInitialContexts = parseTokenInput(initialContextsDraft);
    const normalizedDraftContexts = parseTokenInput(contextsDraft);
    const dueDraftChanged = dueDateDraft !== initialDueDraft.date || dueTimeDraft !== initialDueDraft.time;
    const reviewDraftChanged = reviewDateDraft !== initialReviewDraft.date || reviewTimeDraft !== initialReviewDraft.time;
    const areaDraftChanged = areaDraft !== initialAreaDraft;
    const contextsDraftChanged = normalizedDraftContexts.join('\u0000') !== normalizedInitialContexts.join('\u0000');

    useEffect(() => {
        const nextDueDraft = getDueDateDraft(task.dueDate);
        const nextReviewDraft = getDueDateDraft(task.reviewAt);
        setDueDateDraft(nextDueDraft.date);
        setDueTimeDraft(nextDueDraft.time);
        setReviewDateDraft(nextReviewDraft.date);
        setReviewTimeDraft(nextReviewDraft.time);
        setAreaDraft(task.areaId || '');
        setContextsDraft(task.contexts?.join(', ') || '');
    }, [task.areaId, task.contexts, task.dueDate, task.id, task.reviewAt]);

    useEffect(() => {
        const focusTarget = dueButtonRef.current
            ?? reviewButtonRef.current
            ?? areaButtonRef.current
            ?? contextsButtonRef.current
            ?? menuRef.current?.querySelector<HTMLButtonElement>('button');
        focusTarget?.focus();
    }, []);

    useEffect(() => {
        const handlePointer = (event: Event) => {
            const target = event.target as Node | null;
            if (target && (menuRef.current?.contains(target) || panelRef.current?.contains(target))) return;
            onClose();
        };
        const handleScrollOrResize = () => onClose();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (activePanel) {
                setActivePanel(null);
                return;
            }
            onClose();
        };
        window.addEventListener('mousedown', handlePointer);
        window.addEventListener('scroll', handleScrollOrResize, true);
        window.addEventListener('resize', handleScrollOrResize);
        window.addEventListener('contextmenu', handlePointer);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', handlePointer);
            window.removeEventListener('scroll', handleScrollOrResize, true);
            window.removeEventListener('resize', handleScrollOrResize);
            window.removeEventListener('contextmenu', handlePointer);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [activePanel, onClose]);

    const menuPosition = {
        left: clamp(
            x,
            VIEWPORT_MARGIN_PX,
            window.innerWidth - MENU_WIDTH_PX - VIEWPORT_MARGIN_PX,
        ),
        top: clamp(
            y,
            VIEWPORT_MARGIN_PX,
            window.innerHeight - (readOnly ? MENU_HEIGHT_READ_ONLY_PX : MENU_HEIGHT_EDITABLE_PX) - VIEWPORT_MARGIN_PX,
        ),
    };

    useLayoutEffect(() => {
        if (!activePanel) {
            setPanelPosition(null);
            return;
        }
        const anchor = activePanel === 'dueDate'
            ? dueButtonRef.current
            : activePanel === 'reviewAt'
                ? reviewButtonRef.current
                : activePanel === 'area'
                    ? areaButtonRef.current
                    : contextsButtonRef.current;
        const panel = panelRef.current;
        if (!anchor || !panel) return;
        const anchorRect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const preferredLeft = anchorRect.right + PANEL_GAP_PX;
        const fallbackLeft = anchorRect.left - panelRect.width - PANEL_GAP_PX;
        const shouldOpenLeft = preferredLeft + panelRect.width > window.innerWidth - VIEWPORT_MARGIN_PX
            && fallbackLeft >= VIEWPORT_MARGIN_PX;

        setPanelPosition({
            left: clamp(
                shouldOpenLeft ? fallbackLeft : preferredLeft,
                VIEWPORT_MARGIN_PX,
                window.innerWidth - panelRect.width - VIEWPORT_MARGIN_PX,
            ),
            top: clamp(
                anchorRect.top,
                VIEWPORT_MARGIN_PX,
                window.innerHeight - panelRect.height - VIEWPORT_MARGIN_PX,
            ),
        });
    }, [activePanel, menuPosition.left, menuPosition.top]);

    if (typeof document === 'undefined') return null;

    const openPanel = (panelId: Exclude<QuickPanelId, null>) => {
        if (panelId === activePanel) {
            setPanelPosition(null);
            setActivePanel(null);
            return;
        }
        setPanelPosition(null);
        if (panelId === 'dueDate') {
            const nextDueDraft = getDueDateDraft(task.dueDate);
            setDueDateDraft(nextDueDraft.date);
            setDueTimeDraft(nextDueDraft.time);
        } else if (panelId === 'reviewAt') {
            const nextReviewDraft = getDueDateDraft(task.reviewAt);
            setReviewDateDraft(nextReviewDraft.date);
            setReviewTimeDraft(nextReviewDraft.time);
        } else if (panelId === 'area') {
            setAreaDraft(task.areaId || '');
        } else {
            setContextsDraft(task.contexts?.join(', ') || '');
        }
        setActivePanel(panelId);
    };

    const handleDueDateSave = async () => {
        setSavingPanel('dueDate');
        try {
            const normalizedDate = normalizeDateInputValue(dueDateDraft);
            const nextDueDate = normalizedDate
                ? (dueTimeDraft ? `${normalizedDate}T${dueTimeDraft}` : normalizedDate)
                : undefined;
            const result = await onUpdateTask({ dueDate: nextDueDate });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task due date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task due date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleReviewDateSave = async () => {
        setSavingPanel('reviewAt');
        try {
            const normalizedDate = normalizeDateInputValue(reviewDateDraft);
            const nextReviewAt = normalizedDate
                ? (reviewTimeDraft ? `${normalizedDate}T${reviewTimeDraft}` : normalizedDate)
                : undefined;
            const result = await onUpdateTask({ reviewAt: nextReviewAt });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task review date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task review date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleAreaSave = async () => {
        setSavingPanel('area');
        try {
            const result = await onUpdateTask({ areaId: areaDraft || undefined });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task area');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task area from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleContextsSave = async () => {
        setSavingPanel('contexts');
        try {
            const result = await onUpdateTask({ contexts: parseTokenInput(contextsDraft) });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task contexts');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task contexts from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const renderMenuAction = ({
        ref,
        icon,
        label,
        active = false,
        onClick,
        showChevron = false,
    }: {
        ref?: RefObject<HTMLButtonElement | null>;
        icon: ReactNode;
        label: string;
        active?: boolean;
        onClick: () => void;
        showChevron?: boolean;
    }) => (
        <button
            ref={ref}
            type="button"
            role="menuitem"
            aria-haspopup={showChevron ? 'dialog' : undefined}
            aria-expanded={showChevron ? active : undefined}
            onClick={onClick}
            className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                active ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted',
            )}
        >
            <span className="text-muted-foreground">{icon}</span>
            <span className="flex-1 truncate">{label}</span>
            {showChevron ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : null}
        </button>
    );

    return createPortal(
        <>
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={moreOptionsLabel}
                    className="fixed z-50 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                    style={{ top: menuPosition.top, left: menuPosition.left }}
                    onContextMenu={(event) => event.preventDefault()}
                >
                {!readOnly && renderMenuAction({
                    ref: dueButtonRef,
                    icon: <Calendar className="h-4 w-4" />,
                    label: `${dueLabel}…`,
                    active: activePanel === 'dueDate',
                    onClick: () => openPanel('dueDate'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: reviewButtonRef,
                    icon: <CalendarClock className="h-4 w-4" />,
                    label: `${reviewLabel}…`,
                    active: activePanel === 'reviewAt',
                    onClick: () => openPanel('reviewAt'),
                    showChevron: true,
                })}
                {!readOnly && canEditArea && renderMenuAction({
                    ref: areaButtonRef,
                    icon: <MapPin className="h-4 w-4" />,
                    label: `${areaLabel}…`,
                    active: activePanel === 'area',
                    onClick: () => openPanel('area'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: contextsButtonRef,
                    icon: <Tag className="h-4 w-4" />,
                    label: `${contextsLabel}…`,
                    active: activePanel === 'contexts',
                    onClick: () => openPanel('contexts'),
                    showChevron: true,
                })}
                {!readOnly ? <div className="my-1 h-px bg-border/70" role="separator" /> : null}
                {renderMenuAction({
                    icon: <Copy className="h-4 w-4" />,
                    label: duplicateLabel,
                    onClick: () => {
                        onDuplicate();
                        onClose();
                    },
                })}
                {renderMenuAction({
                    icon: <Trash2 className="h-4 w-4" />,
                    label: deleteLabel,
                    onClick: () => {
                        onDelete();
                        onClose();
                    },
                })}
            </div>

            {activePanel && (
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={
                        activePanel === 'dueDate'
                            ? dueLabel
                            : activePanel === 'reviewAt'
                                ? reviewLabel
                                : activePanel === 'area'
                                    ? areaLabel
                                    : contextsLabel
                    }
                    className="fixed z-50 w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
                    style={{
                        top: panelPosition?.top ?? menuPosition.top,
                        left: panelPosition?.left ?? (menuPosition.left + 188),
                        visibility: panelPosition ? 'visible' : 'hidden',
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    {activePanel === 'dueDate' ? (
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">{dueLabel}</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="date"
                                        lang={nativeDateInputLocale}
                                        aria-label={dueLabel}
                                        value={dueDateDraft}
                                        onChange={(event) => {
                                            const nextValue = normalizeDateInputValue(event.target.value);
                                            setDueDateDraft(nextValue);
                                            if (!nextValue) {
                                                setDueTimeDraft('');
                                            }
                                        }}
                                        className="flex-1 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    />
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.dueTime')}
                                        value={dueTimeDraft}
                                        disabled={!dueDateDraft}
                                        onChange={(event) => setDueTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setDueDateDraft('');
                                            setDueTimeDraft('');
                                        }}
                                        className="shrink-0 rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        aria-label={`${clearLabel} ${dueLabel}`}
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setDueDateDraft(initialDueDraft.date);
                                        setDueTimeDraft(initialDueDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleDueDateSave}
                                    loading={savingPanel === 'dueDate'}
                                    disabled={!dueDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'reviewAt' ? (
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">{reviewLabel}</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="date"
                                        lang={nativeDateInputLocale}
                                        aria-label={reviewLabel}
                                        value={reviewDateDraft}
                                        onChange={(event) => {
                                            const nextValue = normalizeDateInputValue(event.target.value);
                                            setReviewDateDraft(nextValue);
                                            if (!nextValue) {
                                                setReviewTimeDraft('');
                                            }
                                        }}
                                        className="flex-1 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    />
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.reviewTime')}
                                        value={reviewTimeDraft}
                                        disabled={!reviewDateDraft}
                                        onChange={(event) => setReviewTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setReviewDateDraft('');
                                            setReviewTimeDraft('');
                                        }}
                                        className="shrink-0 rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        aria-label={`${clearLabel} ${reviewLabel}`}
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setReviewDateDraft(initialReviewDraft.date);
                                        setReviewTimeDraft(initialReviewDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleReviewDateSave}
                                    loading={savingPanel === 'reviewAt'}
                                    disabled={!reviewDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'area' ? (
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">{areaLabel}</label>
                                <AreaSelector
                                    areas={areas}
                                    value={areaDraft}
                                    onChange={setAreaDraft}
                                    onCreateArea={onCreateArea}
                                    placeholder={noAreaLabel}
                                    noAreaLabel={noAreaLabel}
                                    searchPlaceholder={searchAreasLabel}
                                    noMatchesLabel={noMatchesLabel}
                                    createAreaLabel={createAreaLabel}
                                    className="w-full"
                                />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setAreaDraft(initialAreaDraft);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleAreaSave}
                                    loading={savingPanel === 'area'}
                                    disabled={!areaDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <ContextsField
                                t={t}
                                value={contextsDraft}
                                options={contextOptions}
                                onChange={setContextsDraft}
                            />
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setContextsDraft(initialContextsDraft);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleContextsSave}
                                    loading={savingPanel === 'contexts'}
                                    disabled={!contextsDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </>,
        document.body,
    );
}
