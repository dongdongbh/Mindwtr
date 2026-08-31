import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, X } from 'lucide-react';
import {
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
    const { nativeDateInputLocale, dateFormatSetting } = useNativeDateInputLocale();

    useEffect(() => {
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

    const apply = () => {
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
    const cancel = () => { if (!isApplying) onCancel(); };

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
                    disabled={isApplying}
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

                    <label className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{tFallback(t, 'taskEdit.projectLabel', 'Project')}</span>
                        <select
                            value={projectChoice}
                            onChange={(event) => {
                                setProjectChoice(event.currentTarget.value);
                                if (event.currentTarget.value !== KEEP_VALUE && event.currentTarget.value !== NONE_VALUE) {
                                    setAreaChoice(KEEP_VALUE);
                                }
                            }}
                            className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                            <option value={KEEP_VALUE}>{tFallback(t, 'bulk.keepProject', 'Keep project')}</option>
                            <option value={NONE_VALUE}>{tFallback(t, 'taskEdit.noProjectOption', 'No project')}</option>
                            {activeProjects.map((project) => (
                                <option key={project.id} value={project.id}>
                                    {project.title}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="space-y-1 text-xs font-medium text-muted-foreground">
                        <span>{tFallback(t, 'projects.areaLabel', 'Area')}</span>
                        <select
                            value={areaChoice}
                            onChange={(event) => setAreaChoice(event.currentTarget.value)}
                            disabled={Boolean(selectedProjectId)}
                            className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <option value={KEEP_VALUE}>{tFallback(t, 'bulk.keepArea', 'Keep area')}</option>
                            <option value={NONE_VALUE}>{tFallback(t, 'taskEdit.noAreaOption', 'No area')}</option>
                            {activeAreas.map((area) => (
                                <option key={area.id} value={area.id}>
                                    {area.name}
                                </option>
                            ))}
                        </select>
                    </label>

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
            </DialogBody>

            <DialogFooter className="flex justify-end gap-2 border-t border-border px-4 py-3">
                <Button variant="secondary" onClick={onCancel} disabled={isApplying}>
                    {tFallback(t, 'common.cancel', 'Cancel')}
                </Button>
                <Button onClick={apply} loading={isApplying} disabled={selectedCount === 0}>
                    {tFallback(t, 'bulk.applyToSelected', 'Apply to selected')}
                </Button>
            </DialogFooter>
        </Dialog>
    );
}
