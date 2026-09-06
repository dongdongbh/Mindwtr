import { useState, useEffect, useRef, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, HelpCircle, Layers, MapPin, Trash2 } from 'lucide-react';
import {
    filterProjectsBySelectedArea,
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
    type ViewSectionDefinition,
    numericTextCollator,
} from '@mindwtr/core';
import { AreaSelector } from '../ui/AreaSelector';
import { ProjectSelector } from '../ui/ProjectSelector';
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

interface TaskItemEditorProps {
    t: (key: string) => string;
    draft: TaskDraft;
    setField: TaskDraftSetter;
    autoFocusTitle?: boolean;
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
    onCancel: () => void;
    onSubmit: (e: FormEvent) => void;
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
    onAcceptTitleSuggestion,
    isDoneActionActive = false,
    onMarkDone,
    onRequestBackdatedComplete,
    focusStar,
    onDeleteTask,
    onCancel,
    onSubmit,
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

    const compareLabels = (left: string, right: string) =>
        numericTextCollator.compare(left, right);
    const sortedProjects = [...projects].sort((a, b) => compareLabels(a.title, b.title));
    const sortedAreas = [...areas].sort((a, b) => compareLabels(a.name, b.name));
    const projectFilterAreaId = editAreaId || undefined;
    const filteredProjects = filterProjectsBySelectedArea(sortedProjects, projectFilterAreaId);
    const [schedulingOpen, setSchedulingOpen] = useState(sectionOpenDefaults.scheduling);
    const [organizationOpen, setOrganizationOpen] = useState(sectionOpenDefaults.organization);
    const [detailsOpen, setDetailsOpen] = useState(sectionOpenDefaults.details);

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

    return (
        <form
            onSubmit={onSubmit}
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
                        onSubmit(event as unknown as FormEvent);
                    }
                }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDragOver={handleFormDragOver}
            onDragLeave={handleFormDragLeave}
            onDrop={handleFormDrop}
            className={cn("flex flex-col gap-3 max-h-[80vh]", isFileDragOver && "ring-2 ring-primary/50")}
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
                        areas={areas}
                        onCreateProject={onCreateProject}
                        onAcceptSuggestion={handleTitleSuggestionAccept}
                        placeholder={t('taskEdit.titleLabel')}
                        ariaLabel={t('taskEdit.titleLabel')}
                        className="w-full rounded-sm bg-transparent border-b border-primary/60 px-1 pb-1.5 pt-0 text-lg font-semibold leading-7 text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:ring-0 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1 focus-visible:ring-offset-card outline-none motion-reduce:transition-none"
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
            {basicFieldsBeforeOrganizers.length > 0 && (
                <div className="space-y-3">
                    {basicFieldsBeforeOrganizers.map((fieldId) => (
                        <div key={fieldId}>{renderField(fieldId)}</div>
                    ))}
                </div>
            )}
            {organizerFields.length > 0 && (
                <div className="flex flex-wrap gap-4">
                    {organizerFields.map((fieldId) => {
                        if (fieldId === 'area') {
                            return (
                                <div key={fieldId} className="flex flex-col gap-1 flex-1 min-w-0">
                                    <TaskEditorFieldLabel icon={MapPin}>
                                        {t('taskEdit.areaLabel')}
                                        <QuickAddTokenBadge t={t} token={QUICK_ADD_FIELD_TOKENS.area} />
                                    </TaskEditorFieldLabel>
                                    <AreaSelector
                                        areas={sortedAreas}
                                        value={editAreaId}
                                        onChange={setEditAreaId}
                                        onCreateArea={onCreateArea}
                                        placeholder={t('taskEdit.noAreaOption')}
                                        noAreaLabel={t('taskEdit.noAreaOption')}
                                        searchPlaceholder={t('areas.search')}
                                        noMatchesLabel={t('common.noMatches')}
                                        createAreaLabel={t('areas.create')}
                                        className="w-full"
                                    />
                                </div>
                            );
                        }
                        if (fieldId === 'project') {
                            return (
                                <div key={fieldId} className="flex flex-col gap-1 flex-1 min-w-0">
                                    <TaskEditorFieldLabel icon={Folder}>
                                        {t('projects.title')}
                                        <QuickAddTokenBadge t={t} token={QUICK_ADD_FIELD_TOKENS.project} />
                                    </TaskEditorFieldLabel>
                                    <ProjectSelector
                                        projects={filteredProjects}
                                        allProjects={sortedProjects}
                                        value={editProjectId}
                                        onChange={setEditProjectId}
                                        onCreateProject={(title) => onCreateProject(title, projectFilterAreaId)}
                                        placeholder={t('taskEdit.noProjectOption')}
                                        noProjectLabel={t('taskEdit.noProjectOption')}
                                        searchPlaceholder={t('projects.search')}
                                        noMatchesLabel={t('common.noMatches')}
                                        emptyLabel={projectFilterAreaId ? t('projects.noProjectsInArea') : undefined}
                                        createProjectLabel={t('projects.create')}
                                        className="w-full"
                                    />
                                </div>
                            );
                        }
                        if (fieldId === 'section') {
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
                {schedulingFields.length > 0 && (
                    <div className="border-t border-border pt-3">
                        <button
                            type="button"
                            onClick={() => setSchedulingOpen((prev) => !prev)}
                            className="w-full flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground font-semibold"
                            aria-expanded={schedulingOpen}
                        >
                            <span className="flex items-center gap-2">
                                {t('taskEdit.scheduling')}
                                {sectionCounts.scheduling > 0 && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                        {sectionCounts.scheduling}
                                    </span>
                                )}
                            </span>
                            {schedulingOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        </button>
                        {schedulingOpen && (
                            <div className="mt-3 space-y-3">
                                {schedulingFields.map((fieldId) => (
                                    <div key={fieldId} ref={fieldId === 'attachments' ? attachmentsFieldRef : undefined}>{renderField(fieldId)}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {organizationFields.length > 0 && (
                    <div className="border-t border-border pt-3">
                        <button
                            type="button"
                            onClick={() => setOrganizationOpen((prev) => !prev)}
                            className="w-full flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground font-semibold"
                            aria-expanded={organizationOpen}
                        >
                            <span className="flex items-center gap-2">
                                {t('taskEdit.organization')}
                                {sectionCounts.organization > 0 && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                        {sectionCounts.organization}
                                    </span>
                                )}
                            </span>
                            {organizationOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        </button>
                        {organizationOpen && (
                            <div className="mt-3 space-y-3">
                                {organizationFields.map((fieldId) => (
                                    <div key={fieldId} ref={fieldId === 'attachments' ? attachmentsFieldRef : undefined}>{renderField(fieldId)}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {detailsFields.length > 0 && (
                    <div className="border-t border-border pt-3">
                        <button
                            type="button"
                            onClick={() => setDetailsOpen((prev) => !prev)}
                            className="w-full flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground font-semibold"
                            aria-expanded={detailsOpen}
                        >
                            <span className="flex items-center gap-2">
                                {t('taskEdit.details')}
                                {sectionCounts.details > 0 && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                        {sectionCounts.details}
                                    </span>
                                )}
                            </span>
                            {detailsOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        </button>
                        {detailsOpen && (
                            <div className="mt-3 space-y-3">
                                {detailsFields.map((fieldId) => (
                                    <div key={fieldId} ref={fieldId === 'attachments' ? attachmentsFieldRef : undefined}>{renderField(fieldId)}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
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
                        type="submit"
                        className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded hover:bg-primary/90"
                    >
                        {t('common.save')}
                    </button>
                    <button
                        type="button"
                        onClick={onCancel}
                        className="text-xs bg-muted text-muted-foreground px-3 py-1.5 rounded hover:bg-muted/80"
                    >
                        {t('common.cancel')}
                    </button>
                </div>
            </div>
        </form>
    );
}
