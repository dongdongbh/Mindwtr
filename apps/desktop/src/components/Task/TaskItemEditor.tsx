import { useState, useEffect, useRef, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { ContextualHelp } from '../ContextualHelp';
import { ArrowRight, Check, FolderPlus, HelpCircle, Layers, MapPin, Rows3, Trash2 } from 'lucide-react';
import {
    buildTaskMovePatch,
    resolveAutoTextDirection,
    setTaskViewSectionId,
    tFallback,
    type Area,
    type Project,
    type Section,
    type TaskDraft,
    type TaskDraftSetter,
    type TaskEditorFieldId,
    type TaskEditorSectionId,
    type TaskMoveDestination,
    type ViewSectionDefinition,
} from '@mindwtr/core';
import { DestinationSelector } from '../ui/DestinationSelector';
import { SectionSelector } from '../ui/SectionSelector';
import { SomedaySectionSelector } from '../ui/SomedaySectionSelector';
import { TaskInput, type TaskInputAcceptedSuggestion } from './TaskInput';
import { cn } from '../../lib/utils';
import {
    QUICK_ADD_FIELD_TOKENS,
    QuickAddTokenBadge,
    taskEditorLabelClassName,
    TaskEditorFieldLabel,
} from './task-editor-label';
import { findAttachmentsSection } from './task-item-helpers';
import { FocusStarIcon } from '../FocusStarIcon';
import { TaskEditorAiMenu, TaskEditorAiPanels } from './TaskEditorAiPanels';
import type { useTaskItemAi } from './useTaskItemAi';
import { TaskEditorSection } from './TaskEditorSection';

interface TaskItemEditorProps {
    t: (key: string) => string;
    draft: TaskDraft;
    setField: TaskDraftSetter;
    autoFocusTitle?: boolean;
    isModalEditor?: boolean;
    // One seam for the whole AI feature: the editor forwards it to the menu
    // and panel components and otherwise knows nothing about AI.
    ai: ReturnType<typeof useTaskItemAi>;
    timeEstimatesEnabled: boolean;
    projects: Project[];
    sections: Section[];
    areas: Area[];
    somedaySections: ViewSectionDefinition[];
    onCreateProject: (title: string, areaId?: string) => Promise<string | null>;
    onCreateArea?: (name: string) => Promise<string | null>;
    onCreateSection?: (title: string) => Promise<string | null>;
    onCreateSomedaySection: (title: string) => Promise<string | null>;
    organizerFields: TaskEditorFieldId[];
    basicFieldsBeforeOrganizers: TaskEditorFieldId[];
    basicFieldsAfterOrganizers: TaskEditorFieldId[];
    schedulingFields: TaskEditorFieldId[];
    organizationFields: TaskEditorFieldId[];
    detailsFields: TaskEditorFieldId[];
    sectionCounts: {
        scheduling: number;
        organization: number;
        details: number;
    };
    sectionOpenDefaults: Record<TaskEditorSectionId, boolean>;
    renderField: (fieldId: TaskEditorFieldId) => ReactNode;
    language: string;
    inputContexts: string[];
    /** Known people for the title's %Person suggestions; without it `%` offers nothing (#1255). */
    inputPeople?: string[];
    onAcceptTitleSuggestion?: (suggestion: TaskInputAcceptedSuggestion) => boolean | Promise<boolean>;
    isDoneActionActive?: boolean;
    onMarkDone?: () => void;
    onRequestBackdatedComplete?: () => void;
    focusStar?: {
        isFocused: boolean;
        title: string;
        onToggle: () => void;
    };
    onDeleteTask?: () => void;
    onPromoteToProject?: () => void;
    onConvertToSection?: () => void;
    onCancel: () => void;
    onSubmit: (e: FormEvent) => void;
    isImportingFiles?: boolean;
    onFilesDropped?: (files: File[]) => void;
}

function appendCommaToken(value: string, token: string): string {
    const normalizedToken = token.trim();
    if (!normalizedToken) return value;
    const tokens = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    if (tokens.some((item) => item.toLowerCase() === normalizedToken.toLowerCase())) {
        return tokens.join(', ');
    }
    return [...tokens, normalizedToken].join(', ');
}

function ensureTokenPrefix(value: string, prefix: '@' | '#'): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed.replace(/^[@#]+/, '')}`;
}

export function TaskItemEditor({
    t,
    draft,
    setField,
    autoFocusTitle = false,
    isModalEditor = false,
    ai,
    timeEstimatesEnabled,
    projects,
    sections,
    areas,
    somedaySections,
    onCreateProject,
    onCreateArea,
    onCreateSection,
    onCreateSomedaySection,
    organizerFields,
    basicFieldsBeforeOrganizers,
    basicFieldsAfterOrganizers,
    schedulingFields,
    organizationFields,
    detailsFields,
    sectionCounts,
    sectionOpenDefaults,
    renderField,
    language,
    inputContexts,
    inputPeople,
    onAcceptTitleSuggestion,
    isDoneActionActive = false,
    onMarkDone,
    onRequestBackdatedComplete,
    focusStar,
    onDeleteTask,
    onPromoteToProject,
    onConvertToSection,
    onCancel,
    onSubmit,
    isImportingFiles = false,
    onFilesDropped,
}: TaskItemEditorProps) {
    // Draft values and setField bindings, under the names the form below was
    // written against.
    const {
        title: editTitle,
        contexts: editContexts,
        tags: editTags,
        projectId: editProjectId,
        sectionId: editSectionId,
        viewSectionIds: editViewSectionIds,
        areaId: editAreaId,
        status: editStatus,
    } = draft;
    const setEditTitle = (value: string) => setField('title', value);
    const setEditContexts = (value: string) => setField('contexts', value);
    const setEditTags = (value: string) => setField('tags', value);
    const setEditProjectId = (value: string) => setField('projectId', value);
    const setEditSectionId = (value: string) => setField('sectionId', value);
    const setEditAreaId = (value: string) => setField('areaId', value);
    const titleDirection = resolveAutoTextDirection(editTitle, language);
    const { resetCopilotDraft } = ai;
    const taskEditorLayoutHelpLabel = tFallback(t, 'taskEdit.editorLayoutHelpLabel', 'Editor layout help');
    const taskEditorLayoutHelpText = tFallback(
        t,
        'taskEdit.editorLayoutHelpText',
        'You can customize which fields appear here in Settings -> GTD -> Task Editor Layout.'
    );
    const [editorLayoutHelpOpen, setEditorLayoutHelpOpen] = useState(false);

    const showProjectDestination = organizerFields.includes('project');
    const showAreaDestination = organizerFields.includes('area');
    const destinationValue: TaskMoveDestination = editProjectId
        ? { kind: 'project', id: editProjectId }
        : editAreaId
            ? { kind: 'area', id: editAreaId }
            : { kind: 'none' };
    const setDestination = (selection: TaskMoveDestination) => {
        const patch = buildTaskMovePatch(selection, { projectId: editProjectId, sectionId: editSectionId });
        setEditProjectId(patch.projectId ?? '');
        setEditAreaId(patch.areaId ?? '');
        setEditSectionId(patch.sectionId ?? '');
    };
    const [schedulingOpen, setSchedulingOpen] = useState(() => sectionOpenDefaults.scheduling || sectionCounts.scheduling > 0);
    const [organizationOpen, setOrganizationOpen] = useState(() => sectionOpenDefaults.organization || sectionCounts.organization > 0);
    const [detailsOpen, setDetailsOpen] = useState(() => sectionOpenDefaults.details || sectionCounts.details > 0);

    // Attachments can live in any of the three collapsible sections (user
    // configurable layout); a dropped file needs to expand whichever one
    // holds it and scroll it into view so the drop isn't invisible feedback.
    const attachmentsSection = findAttachmentsSection(schedulingFields, organizationFields, detailsFields);
    const attachmentsFieldRef = useRef<HTMLDivElement | null>(null);
    const [isFileDragOver, setIsFileDragOver] = useState(false);
    const [revealAttachmentsToken, setRevealAttachmentsToken] = useState(0);

    const isFileDrag = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));

    const handleFormDragOver = (event: DragEvent<HTMLFormElement>) => {
        if (!onFilesDropped || !isFileDrag(event)) return;
        event.preventDefault();
        setIsFileDragOver(true);
    };

    // dragleave also fires when the pointer crosses into a child element, which
    // would flicker the ring off for the whole drag if not guarded.
    const handleFormDragLeave = (event: DragEvent<HTMLFormElement>) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setIsFileDragOver(false);
    };

    const handleFormDrop = (event: DragEvent<HTMLFormElement>) => {
        if (!onFilesDropped || !isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setIsFileDragOver(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        onFilesDropped(files);
        if (attachmentsSection === 'scheduling') setSchedulingOpen(true);
        else if (attachmentsSection === 'organization') setOrganizationOpen(true);
        else if (attachmentsSection === 'details') setDetailsOpen(true);
        if (attachmentsSection) setRevealAttachmentsToken((prev) => prev + 1);
    };

    // Expanding a section and scrolling to it in the same tick scrolls to a
    // node that isn't laid out yet; wait a frame after the open-state update
    // has painted before scrolling.
    useEffect(() => {
        if (revealAttachmentsToken === 0) return;
        const raf = requestAnimationFrame(() => {
            attachmentsFieldRef.current?.scrollIntoView({ block: 'nearest' });
        });
        return () => cancelAnimationFrame(raf);
    }, [revealAttachmentsToken]);
    const handleTitleSuggestionAccept = async (suggestion: TaskInputAcceptedSuggestion) => {
        resetCopilotDraft();
        if (await onAcceptTitleSuggestion?.(suggestion)) {
            return true;
        }
        if (suggestion.kind === 'context') {
            setEditContexts(appendCommaToken(editContexts, ensureTokenPrefix(suggestion.value, '@')));
            return true;
        }
        if (suggestion.kind === 'tag') {
            setEditTags(appendCommaToken(editTags, ensureTokenPrefix(suggestion.value, '#')));
            return true;
        }
        if (suggestion.kind === 'project') {
            setEditProjectId(suggestion.projectId);
            setEditSectionId('');
            setEditAreaId('');
            return true;
        }
        if (suggestion.kind === 'createProject') {
            if (!suggestion.projectId) return false;
            setEditProjectId(suggestion.projectId);
            setEditSectionId('');
            setEditAreaId('');
            return true;
        }
        if (suggestion.kind === 'area') {
            setEditAreaId(suggestion.areaId);
            setEditProjectId('');
            setEditSectionId('');
            return true;
        }
        if (suggestion.kind === 'command' && suggestion.command === 'area') {
            const name = suggestion.value.trim().toLowerCase();
            const matched = name ? areas.find((area) => area.name.toLowerCase() === name) : undefined;
            if (!matched) return false;
            setEditAreaId(matched.id);
            setEditProjectId('');
            setEditSectionId('');
            return true;
        }
        return false;
    };

    const detailsSection = detailsFields.length > 0 && (
        <div className="min-w-0">
            <TaskEditorSection
                title={t('taskEdit.details')}
                count={sectionCounts.details}
                open={detailsOpen}
                onToggle={() => setDetailsOpen((prev) => !prev)}
            >
                {detailsFields.map((fieldId) => (
                    <div key={fieldId} ref={fieldId === 'attachments' ? attachmentsFieldRef : undefined}>{renderField(fieldId)}</div>
                ))}
            </TaskEditorSection>
        </div>
    );

    return (
        <form
            onSubmit={(event) => {
                if (isImportingFiles) { event.preventDefault(); return; }
                onSubmit(event);
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    onCancel();
                    return;
                }
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const form = event.currentTarget as HTMLFormElement;
                    if (typeof form.requestSubmit === 'function') {
                        form.requestSubmit();
                    } else {
                        if (!isImportingFiles) onSubmit(event as unknown as FormEvent);
                    }
                }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDragOver={handleFormDragOver}
            onDragLeave={handleFormDragLeave}
            onDrop={handleFormDrop}
            className={cn(
                'flex flex-col gap-3',
                isModalEditor ? 'max-h-[calc(90vh-3rem)]' : 'max-h-[80vh]',
                isFileDragOver && 'ring-2 ring-primary/50',
            )}
        >
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 pl-1 -ml-1 pt-1 -mt-1 pb-1 -mb-1 space-y-3">
                <div className="flex items-start gap-3 pt-0.5">
                    {onMarkDone && (
                        <button
                            type="button"
                            onClick={onMarkDone}
                            onContextMenu={onRequestBackdatedComplete ? (event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onRequestBackdatedComplete();
                            } : undefined}
                            aria-label={t('status.done')}
                            aria-pressed={isDoneActionActive}
                            title={onRequestBackdatedComplete
                                ? tFallback(t, 'task.completeBackdateHint', 'Right-click to complete with a different time')
                                : t('status.done')}
                            className={cn(
                                'mt-0.5 inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-card motion-reduce:transition-none',
                                isDoneActionActive
                                    ? 'border-success bg-success text-success-foreground shadow-sm'
                                    : 'border-border bg-muted/30 text-muted-foreground hover:border-success/50 hover:bg-success/10 hover:text-success'
                            )}
                        >
                            <Check className="h-4 w-4" aria-hidden="true" />
                        </button>
                    )}
                    <TaskInput
                        autoFocus={autoFocusTitle}
                        value={editTitle}
                        onChange={(value) => {
                            setEditTitle(value);
                            resetCopilotDraft();
                        }}
                        projects={projects}
                        contexts={inputContexts}
                        people={inputPeople}
                        areas={areas}
                        onCreateProject={onCreateProject}
                        onAcceptSuggestion={handleTitleSuggestionAccept}
                        placeholder={t('taskEdit.titleLabel')}
                        ariaLabel={t('taskEdit.titleLabel')}
                        className={cn(
                            'w-full rounded-sm bg-transparent border-b border-primary/60 px-1 pb-1.5 pt-0 font-semibold text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:ring-0 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1 focus-visible:ring-offset-card outline-none motion-reduce:transition-none',
                            isModalEditor ? 'text-2xl leading-9' : 'text-lg leading-7',
                        )}
                        containerClassName="flex-1 min-w-0"
                        dir={titleDirection}
                    />
                    {focusStar && (
                        <button
                            type="button"
                            onClick={focusStar.onToggle}
                            aria-label={focusStar.title}
                            aria-pressed={focusStar.isFocused}
                            title={focusStar.title}
                            className={cn(
                                'p-2 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                                focusStar.isFocused
                                    ? 'text-warning hover:bg-warning/10'
                                    : 'text-muted-foreground hover:text-warning hover:bg-muted/60',
                            )}
                        >
                            <FocusStarIcon filled={focusStar.isFocused} className="w-4 h-4" />
                        </button>
                    )}
                    <TaskEditorAiMenu ai={ai} t={t} />
                </div>
            <TaskEditorAiPanels ai={ai} timeEstimatesEnabled={timeEstimatesEnabled} t={t} />
            <div className={cn(
                'flex flex-col gap-3',
                isModalEditor && detailsFields.length > 0 && 'lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6',
            )}>
            {isModalEditor && detailsSection}
            <div className={cn(
                'min-w-0 space-y-3',
                isModalEditor && detailsFields.length > 0 && 'lg:border-l lg:border-border lg:pl-6',
            )}>
            {basicFieldsBeforeOrganizers.length > 0 && (
                <div className="space-y-3">
                    {basicFieldsBeforeOrganizers.map((fieldId) => (
                        <div key={fieldId}>{renderField(fieldId)}</div>
                    ))}
                </div>
            )}
            {organizerFields.length > 0 && (
                <div className={cn('flex gap-4', isModalEditor ? 'flex-col' : 'flex-wrap')}>
                    {organizerFields.map((fieldId, index) => {
                        if (fieldId === 'area' || fieldId === 'project') {
                            const firstDestinationIndex = organizerFields.findIndex((id) => id === 'area' || id === 'project');
                            if (index !== firstDestinationIndex) return null;
                            return (
                                <div key="destination" className="flex flex-col gap-1 flex-1 min-w-0">
                                    <TaskEditorFieldLabel icon={MapPin}>
                                        {t('task.destination')}
                                        {showProjectDestination && <QuickAddTokenBadge t={t} token={QUICK_ADD_FIELD_TOKENS.project} />}
                                        {showAreaDestination && <QuickAddTokenBadge t={t} token={QUICK_ADD_FIELD_TOKENS.area} />}
                                    </TaskEditorFieldLabel>
                                    <DestinationSelector
                                        projects={projects}
                                        areas={areas}
                                        value={destinationValue}
                                        onChange={setDestination}
                                        onCreateProject={(title) => onCreateProject(title, editAreaId || undefined)}
                                        onCreateArea={onCreateArea}
                                        destinationLabel={t('task.destination')}
                                        projectsLabel={t('projects.title')}
                            areasLabel={t('areas.manage')}
                                        noneLabel={t('common.none')}
                                        searchPlaceholder={t('common.search')}
                                        noMatchesLabel={t('common.noMatches')}
                                        createProjectLabel={t('projects.new')}
                                        createAreaLabel={t('areas.new')}
                                        showProjects={showProjectDestination}
                                        showAreas={showAreaDestination}
                                        className="w-full"
                                    />
                                </div>
                            );
                        }
                        if (fieldId === 'section') {
                            if (!editProjectId) return null;
                            return (
                                <div key={fieldId} className="flex flex-col gap-1 flex-1 min-w-0">
                                    <TaskEditorFieldLabel icon={Layers}>{t('taskEdit.sectionLabel')}</TaskEditorFieldLabel>
                                    <SectionSelector
                                        sections={sections}
                                        value={editSectionId}
                                        onChange={setEditSectionId}
                                        onCreateSection={onCreateSection}
                                        placeholder={t('taskEdit.noSectionOption')}
                                        noSectionLabel={t('taskEdit.noSectionOption')}
                                        searchPlaceholder={t('sections.search')}
                                        noMatchesLabel={t('common.noMatches')}
                                        createSectionLabel={t('projects.addSection')}
                                        className="w-full"
                                    />
                                </div>
                            );
                        }
                        return null;
                    })}
                </div>
            )}
            {editStatus === 'someday' && (
                <div className="flex flex-col gap-1">
                    <label className={taskEditorLabelClassName} htmlFor="task-edit-someday-section">
                        {tFallback(t, 'viewSections.somedaySection', 'Someday section')}
                    </label>
                    <SomedaySectionSelector
                        id="task-edit-someday-section"
                        sections={somedaySections}
                        value={editViewSectionIds?.someday}
                        onChange={(sectionId) => setField(
                            'viewSectionIds',
                            setTaskViewSectionId(editViewSectionIds, 'someday', sectionId),
                        )}
                        onCreateSection={onCreateSomedaySection}
                        t={t}
                        className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                </div>
            )}
            {basicFieldsAfterOrganizers.length > 0 && (
                <div className="space-y-3">
                    {basicFieldsAfterOrganizers.map((fieldId) => (
                        <div key={fieldId}>{renderField(fieldId)}</div>
                    ))}
                </div>
            )}
            <div className="space-y-3">
                {(schedulingFields.length > 0 || detailsFields.length > 0) && (
                    <ContextualHelp topic={schedulingOpen && schedulingFields.length > 0 ? 'scheduling' : 'details'} t={t} />
                )}
                <div>
                    {schedulingFields.length > 0 && (
                        <TaskEditorSection
                            title={t('taskEdit.scheduling')}
                            count={sectionCounts.scheduling}
                            open={schedulingOpen}
                            onToggle={() => setSchedulingOpen((prev) => !prev)}
                        >
                            {schedulingFields.map((fieldId) => (
                                <div key={fieldId} ref={fieldId === 'attachments' ? attachmentsFieldRef : undefined}>{renderField(fieldId)}</div>
                            ))}
                        </TaskEditorSection>
                    )}
                    {organizationFields.length > 0 && (
                        <TaskEditorSection
                            title={t('taskEdit.organization')}
                            count={sectionCounts.organization}
                            open={organizationOpen}
                            onToggle={() => setOrganizationOpen((prev) => !prev)}
                        >
                            {organizationFields.map((fieldId) => (
                                <div key={fieldId} ref={fieldId === 'attachments' ? attachmentsFieldRef : undefined}>{renderField(fieldId)}</div>
                            ))}
                        </TaskEditorSection>
                    )}
                </div>
            </div>
            </div>
            {!isModalEditor && detailsSection}
            </div>
            </div>
            <div className={cn(
                'flex shrink-0 flex-wrap items-center gap-2',
                isModalEditor ? 'border-t border-border pt-4' : 'pt-1',
            )}>
                <div className="relative">
                    <button
                        type="button"
                        aria-label={taskEditorLayoutHelpLabel}
                        aria-expanded={editorLayoutHelpOpen}
                        title={taskEditorLayoutHelpLabel}
                        onClick={() => setEditorLayoutHelpOpen((open) => !open)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {editorLayoutHelpOpen && (
                        <div
                            role="note"
                            className="absolute bottom-9 left-0 z-30 w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-lg"
                        >
                            {taskEditorLayoutHelpText}
                        </div>
                    )}
                </div>
                {editStatus === 'reference' && (
                    <button
                        type="button"
                        onClick={() => setField('status', 'next')}
                        className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('reference.convertToAction')}
                    </button>
                )}
                {onPromoteToProject && (
                    <button
                        type="button"
                        onClick={onPromoteToProject}
                        className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('task.createProjectFromTask')}
                    </button>
                )}
                {onConvertToSection && (
                    <button
                        type="button"
                        onClick={onConvertToSection}
                        className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        <Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('task.convertToSection')}
                    </button>
                )}
                {onDeleteTask && (
                    <button
                        type="button"
                        onClick={onDeleteTask}
                        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
                    >
                        <Trash2 className="w-3 h-3" aria-hidden="true" />
                        {t('common.delete')}
                    </button>
                )}
                <div className="flex flex-wrap gap-2 ml-auto">
                    <button
                        disabled={isImportingFiles}
                        type="submit"
                        className={cn(
                            'bg-primary text-primary-foreground hover:bg-primary/90',
                            isModalEditor ? 'min-h-10 rounded-md px-4 py-2 text-sm' : 'rounded px-3 py-1.5 text-xs',
                        )}
                    >
                        {t('common.save')}
                    </button>
                    <button
                        type="button"
                        onClick={onCancel}
                        className={cn(
                            'bg-muted text-muted-foreground hover:bg-muted/80',
                            isModalEditor ? 'min-h-10 rounded-md px-4 py-2 text-sm' : 'rounded px-3 py-1.5 text-xs',
                        )}
                    >
                        {t('common.cancel')}
                    </button>
                </div>
            </div>
        </form>
    );
}
