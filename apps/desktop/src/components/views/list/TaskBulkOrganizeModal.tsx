import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCheck, X } from 'lucide-react';
import {
    createBulkOrganizeArea,
    createBulkOrganizeProject,
    ensureBulkOrganizeDestinationSaved,
    isSelectableProjectForTaskAssignment,
    parseBulkOrganizeTokenInput,
    safeParseDate,
    tFallback,
    type Area,
    type BulkOrganizeStatus,
    type BulkOrganizeTaskUpdateInput,
    type Project,
    type Section,
} from '@mindwtr/core';

import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { DateField } from '../../ui/DateField';
import { ProjectSelector } from '../../ui/ProjectSelector';
import { AreaSelector } from '../../ui/AreaSelector';
import { useNativeDateInputLocale } from '../../../hooks/use-native-date-input-locale';

type TaskBulkOrganizeModalProps = {
    isOpen: boolean;
    selectedCount: number;
    projects: Project[];
    areas: Area[];
    /**
     * Only set where every selected task lives in one project (the project
     * workspace). Sections belong to a project, so views without a project
     * scope get no section picker.
     */
    sectionScope?: { projectId: string; sections: Section[] };
    isApplying: boolean;
    t: (key: string) => string;
    titleKey?: string;
    titleFallback?: string;
    onApply: (input: BulkOrganizeTaskUpdateInput) => Promise<void> | void;
    onCancel: () => void;
};

const STATUS_OPTIONS: BulkOrganizeStatus[] = ['next', 'waiting', 'someday', 'reference', 'done'];
const KEEP_VALUE = '__KEEP__';
const NONE_VALUE = '__NONE__';
const bulkDateInputClassName = 'h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

export function TaskBulkOrganizeModal({
    isOpen,
    selectedCount,
    projects,
    areas,
    sectionScope,
    isApplying,
    t,
    titleKey = 'bulk.organizeTasks',
    titleFallback = 'Bulk organize tasks',
    onApply,
    onCancel,
}: TaskBulkOrganizeModalProps) {
    const [status, setStatus] = useState<BulkOrganizeStatus | typeof KEEP_VALUE>(KEEP_VALUE);
    const [projectChoice, setProjectChoice] = useState(KEEP_VALUE);
    const [areaChoice, setAreaChoice] = useState(KEEP_VALUE);
    const [sectionChoice, setSectionChoice] = useState(KEEP_VALUE);
    const [contextsInput, setContextsInput] = useState('');
    const [tagsInput, setTagsInput] = useState('');
    const [startDate, setStartDate] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [reviewDate, setReviewDate] = useState('');
    const [delegateWho, setDelegateWho] = useState('');
    const [showValidation, setShowValidation] = useState(false);
    const [createPending, setCreatePending] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const createPendingRef = useRef(false);
    const createSessionRef = useRef(0);
    const { nativeDateInputLocale, dateFormatSetting } = useNativeDateInputLocale();

    useEffect(() => {
        createSessionRef.current += 1;
        createPendingRef.current = false;
        setCreatePending(false);
        setCreateError(null);
        if (!isOpen) return;
        setStatus(KEEP_VALUE);
        setProjectChoice(KEEP_VALUE);
        setAreaChoice(KEEP_VALUE);
        setSectionChoice(KEEP_VALUE);
        setContextsInput('');
        setTagsInput('');
        setStartDate('');
        setDueDate('');
        setReviewDate('');
        setDelegateWho('');
        setShowValidation(false);
    }, [isOpen]);

    useEffect(() => () => {
        createSessionRef.current += 1;
    }, []);

    const activeProjects = useMemo(
        () => projects
            .filter(isSelectableProjectForTaskAssignment)
            .sort((a, b) => a.title.localeCompare(b.title)),
        [projects],
    );
    const activeAreas = useMemo(
        () => areas
            .filter((area) => !area.deletedAt)
            .sort((a, b) => a.name.localeCompare(b.name)),
        [areas],
    );

    if (!isOpen || typeof document === 'undefined') return null;

    const isWaiting = status === 'waiting';
    const canApply = selectedCount > 0 && (!isWaiting || delegateWho.trim().length > 0);
    const isBusy = isApplying || createPending;
    const selectedProjectId = projectChoice !== KEEP_VALUE && projectChoice !== NONE_VALUE ? projectChoice : undefined;
    // A section lives inside its project, so the picker goes quiet as soon as
    // the modal is about to move the tasks to a different project.
    const canChooseSection = sectionScope !== undefined
        && (projectChoice === KEEP_VALUE || projectChoice === sectionScope.projectId);
    const title = tFallback(t, titleKey, titleFallback);
    const startDateLabel = tFallback(t, 'taskEdit.startDateLabel', 'Start');
    const dueDateLabel = tFallback(t, 'taskEdit.dueDateLabel', 'Due');
    const reviewDateLabel = isWaiting
        ? tFallback(t, 'process.followUpLabel', 'Follow-up')
        : tFallback(t, 'taskEdit.reviewDateLabel', 'Review');

    const finishCreate = (session: number) => {
        if (createSessionRef.current !== session) return;
        createPendingRef.current = false;
        setCreatePending(false);
    };

    const handleCreateProject = async (projectTitle: string): Promise<string | null> => {
        if (isApplying || createPendingRef.current) return null;
        const session = createSessionRef.current;
        createPendingRef.current = true;
        setCreatePending(true);
        setCreateError(null);
        const explicitAreaId = areaChoice !== KEEP_VALUE && areaChoice !== NONE_VALUE
            ? areaChoice
            : undefined;
        try {
            const created = await createBulkOrganizeProject(projectTitle, explicitAreaId);
            if (createSessionRef.current !== session) return null;
            if (!created) {
                setCreateError(tFallback(t, 'projects.createFailed', 'Failed to create project'));
                return null;
            }
            return created.id;
        } catch {
            if (createSessionRef.current === session) {
                setCreateError(tFallback(t, 'projects.createFailed', 'Failed to create project'));
            }
            return null;
        } finally {
            finishCreate(session);
        }
    };

    const handleCreateArea = async (areaName: string): Promise<string | null> => {
        if (isApplying || createPendingRef.current) return null;
        const session = createSessionRef.current;
        createPendingRef.current = true;
        setCreatePending(true);
        setCreateError(null);
        try {
            const created = await createBulkOrganizeArea(areaName);
            if (createSessionRef.current !== session) return null;
            if (!created) {
                setCreateError(tFallback(t, 'projects.createAreaFailed', 'Failed to create area'));
                return null;
            }
            return created.id;
        } catch {
            if (createSessionRef.current === session) {
                setCreateError(tFallback(t, 'projects.createAreaFailed', 'Failed to create area'));
            }
            return null;
        } finally {
            finishCreate(session);
        }
    };

    const commitProjectChoice = (value: string) => {
        setProjectChoice(value);
        setCreateError(null);
        if (value !== KEEP_VALUE && value !== NONE_VALUE) {
            setAreaChoice(KEEP_VALUE);
        }
        if (sectionScope && value !== KEEP_VALUE && value !== sectionScope.projectId) {
            setSectionChoice(KEEP_VALUE);
        }
    };

    const handleProjectChoice = (value: string) => {
        if (value === KEEP_VALUE || value === NONE_VALUE) {
            commitProjectChoice(value);
            return;
        }
        if (isApplying || createPendingRef.current) return;
        const session = createSessionRef.current;
        createPendingRef.current = true;
        setCreatePending(true);
        setCreateError(null);
        void ensureBulkOrganizeDestinationSaved().then(() => {
            if (createSessionRef.current === session) commitProjectChoice(value);
        }).catch(() => {
            if (createSessionRef.current === session) {
                setCreateError(tFallback(t, 'projects.createFailed', 'Failed to create project'));
            }
        }).finally(() => finishCreate(session));
    };

    const handleAreaChoice = (value: string) => {
        if (value === KEEP_VALUE || value === NONE_VALUE) {
            setAreaChoice(value);
            setCreateError(null);
            return;
        }
        if (isApplying || createPendingRef.current) return;
        const session = createSessionRef.current;
        createPendingRef.current = true;
        setCreatePending(true);
        setCreateError(null);
        void ensureBulkOrganizeDestinationSaved().then(() => {
            if (createSessionRef.current !== session) return;
            setAreaChoice(value);
            setCreateError(null);
        }).catch(() => {
            if (createSessionRef.current === session) {
                setCreateError(tFallback(t, 'projects.createAreaFailed', 'Failed to create area'));
            }
        }).finally(() => finishCreate(session));
    };

    const apply = () => {
        if (isBusy || createPendingRef.current) return;
        if (!canApply) {
            setShowValidation(true);
            return;
        }

        const input: BulkOrganizeTaskUpdateInput = {
            contexts: parseBulkOrganizeTokenInput(contextsInput, '@'),
            tags: parseBulkOrganizeTokenInput(tagsInput, '#'),
        };

        if (status !== KEEP_VALUE) input.status = status;

        if (projectChoice !== KEEP_VALUE) {
            input.projectId = projectChoice === NONE_VALUE ? null : projectChoice;
        }
        if (!selectedProjectId && areaChoice !== KEEP_VALUE) {
            input.areaId = areaChoice === NONE_VALUE ? null : areaChoice;
        }
        if (sectionScope && canChooseSection && sectionChoice !== KEEP_VALUE) {
            input.sectionId = sectionChoice === NONE_VALUE ? null : sectionChoice;
            input.sectionProjectId = sectionScope.projectId;
        }
        if (startDate.trim()) input.startTime = startDate.trim();
        if (dueDate.trim()) input.dueDate = dueDate.trim();
        if (reviewDate.trim()) input.reviewAt = reviewDate.trim();
        if (isWaiting) input.assignedTo = delegateWho.trim();

        void onApply(input);
    };

    // Cancel is already disabled while applying; route every other dismissal
    // (X, backdrop, Escape) through the same guard.
    const cancel = () => {
        if (isBusy || createPendingRef.current) return;
        onCancel();
    };

    return (
        <Dialog
            onClose={cancel}
            labelledBy="task-bulk-organize-title"
            placement="top"
            overlayClassName="px-4 pt-[8vh]"
            panelClassName="max-w-2xl max-h-[84vh] border-border"
        >
            <DialogHeader className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                    <div className="flex items-center gap-2">
                        <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                        <h3 id="task-bulk-organize-title" className="font-semibold">
                            {title}
                        </h3>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {selectedCount} {tFallback(t, 'bulk.selected', 'selected')} - {tFallback(t, 'bulk.organizeHint', 'Apply shared organizing fields. Titles and descriptions stay unchanged.')}
                    </p>
                </div>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={cancel}
                    disabled={isBusy}
                    aria-label={tFallback(t, 'common.close', 'Close')}
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </Button>
            </DialogHeader>

            <DialogBody className="flex-1 space-y-4 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{tFallback(t, 'bulk.organizeStatus', 'Status')}</span>
                        <select
                            value={status}
                            onChange={(event) => {
                                const value = event.currentTarget.value;
                                setStatus(value === KEEP_VALUE ? KEEP_VALUE : value as BulkOrganizeStatus);
                                setShowValidation(false);
                            }}
                            className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                            <option value={KEEP_VALUE}>{tFallback(t, 'bulk.keepStatus', 'Keep status')}</option>
                            {STATUS_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                    {tFallback(t, `status.${option}`, option)}
                                </option>
                            ))}
                        </select>
                    </label>

                    <div className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{tFallback(t, 'taskEdit.projectLabel', 'Project')}</span>
                        <ProjectSelector
                            projects={activeProjects}
                            value={projectChoice}
                            onChange={handleProjectChoice}
                            onCreateProject={handleCreateProject}
                            leadingOption={{ value: KEEP_VALUE, label: tFallback(t, 'bulk.keepProject', 'Keep project') }}
                            noProjectValue={NONE_VALUE}
                            noProjectLabel={tFallback(t, 'taskEdit.noProjectOption', 'No project')}
                            placeholder={tFallback(t, 'bulk.keepProject', 'Keep project')}
                            searchPlaceholder={tFallback(t, 'projects.search', 'Search projects')}
                            noMatchesLabel={tFallback(t, 'common.noMatches', 'No matches')}
                            createProjectLabel={tFallback(t, 'projects.create', 'Create project')}
                            ariaLabel={tFallback(t, 'taskEdit.projectLabel', 'Project')}
                            disabled={isBusy}
                            closeOnCreateFailure={false}
                            controlClassName="h-9 rounded-md bg-card px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                    </div>

                    <div className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{tFallback(t, 'projects.areaLabel', 'Area')}</span>
                        <AreaSelector
                            areas={activeAreas}
                            value={areaChoice}
                            onChange={handleAreaChoice}
                            onCreateArea={handleCreateArea}
                            leadingOption={{ value: KEEP_VALUE, label: tFallback(t, 'bulk.keepArea', 'Keep area') }}
                            noAreaValue={NONE_VALUE}
                            noAreaLabel={tFallback(t, 'taskEdit.noAreaOption', 'No area')}
                            placeholder={tFallback(t, 'bulk.keepArea', 'Keep area')}
                            searchPlaceholder={tFallback(t, 'areas.search', 'Search areas')}
                            noMatchesLabel={tFallback(t, 'common.noMatches', 'No matches')}
                            createAreaLabel={tFallback(t, 'areas.create', 'Create area')}
                            ariaLabel={tFallback(t, 'projects.areaLabel', 'Area')}
                            disabled={Boolean(selectedProjectId) || isBusy}
                            closeOnCreateFailure={false}
                            controlClassName="h-9 rounded-md bg-card px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                    </div>

                    {sectionScope && sectionScope.sections.length > 0 && (
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'taskEdit.sectionLabel', 'Project section')}</span>
                            <select
                                value={sectionChoice}
                                onChange={(event) => setSectionChoice(event.currentTarget.value)}
                                disabled={!canChooseSection}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value={KEEP_VALUE}>{tFallback(t, 'bulk.keepSection', 'Keep section')}</option>
                                <option value={NONE_VALUE}>{tFallback(t, 'taskEdit.noSectionOption', 'No Section')}</option>
                                {sectionScope.sections.map((section) => (
                                    <option key={section.id} value={section.id}>
                                        {section.title}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}

                    {isWaiting && (
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'process.delegateWhoLabel', 'Waiting for')}</span>
                            <input
                                value={delegateWho}
                                onChange={(event) => {
                                    setDelegateWho(event.currentTarget.value);
                                    setShowValidation(false);
                                }}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                                placeholder={tFallback(t, 'process.delegateWhoPlaceholder', 'Person or team')}
                            />
                        </label>
                    )}
                </div>

                {/* The labels sit outside DateField: a <label> wrapper would swallow
                    clicks meant for the calendar button. */}
                <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{startDateLabel}</span>
                        <DateField
                            t={t}
                            dateAriaLabel={startDateLabel}
                            dateValue={startDate}
                            selectedDate={safeParseDate(startDate)}
                            dateFormatSetting={dateFormatSetting}
                            nativeDateInputLocale={nativeDateInputLocale}
                            dateInputClassName={bulkDateInputClassName}
                            className="max-w-none"
                            hasValue={Boolean(startDate)}
                            onDateChange={setStartDate}
                            onClear={() => setStartDate('')}
                        />
                    </div>
                    <div className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{dueDateLabel}</span>
                        <DateField
                            t={t}
                            dateAriaLabel={dueDateLabel}
                            dateValue={dueDate}
                            selectedDate={safeParseDate(dueDate)}
                            dateFormatSetting={dateFormatSetting}
                            nativeDateInputLocale={nativeDateInputLocale}
                            dateInputClassName={bulkDateInputClassName}
                            className="max-w-none"
                            hasValue={Boolean(dueDate)}
                            onDateChange={setDueDate}
                            onClear={() => setDueDate('')}
                        />
                    </div>
                    <div className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{reviewDateLabel}</span>
                        <DateField
                            t={t}
                            dateAriaLabel={reviewDateLabel}
                            dateValue={reviewDate}
                            selectedDate={safeParseDate(reviewDate)}
                            dateFormatSetting={dateFormatSetting}
                            nativeDateInputLocale={nativeDateInputLocale}
                            dateInputClassName={bulkDateInputClassName}
                            className="max-w-none"
                            hasValue={Boolean(reviewDate)}
                            onDateChange={setReviewDate}
                            onClear={() => setReviewDate('')}
                        />
                    </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{tFallback(t, 'taskEdit.contextsLabel', 'Contexts')}</span>
                        <input
                            value={contextsInput}
                            onChange={(event) => setContextsInput(event.currentTarget.value)}
                            className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            placeholder="@computer, @office"
                        />
                    </label>
                    <label className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{tFallback(t, 'taskEdit.tagsLabel', 'Tags')}</span>
                        <input
                            value={tagsInput}
                            onChange={(event) => setTagsInput(event.currentTarget.value)}
                            className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            placeholder="#project, #admin"
                        />
                    </label>
                </div>

                {showValidation && (
                    <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {tFallback(t, 'bulk.waitingPersonRequired', 'Choose who these items are waiting for.')}
                    </p>
                )}
                {createError && (
                    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {createError}
                    </p>
                )}
            </DialogBody>

            <DialogFooter className="flex justify-end gap-2 border-t border-border px-4 py-3">
                <Button variant="secondary" onClick={cancel} disabled={isBusy}>
                    {tFallback(t, 'common.cancel', 'Cancel')}
                </Button>
                <Button onClick={apply} loading={isApplying} disabled={selectedCount === 0 || createPending}>
                    {tFallback(t, 'bulk.applyToSelected', 'Apply to selected')}
                </Button>
            </DialogFooter>
        </Dialog>
    );
}
