import { safeParseDate, type Project, type ProjectFlowMode } from '@mindwtr/core';
import { Calendar, CalendarClock, CalendarRange, FolderOpenDot, ListOrdered, Plus, Settings2, Signal, Tags } from 'lucide-react';
import { useNativeDateInputLocale } from '../../../hooks/use-native-date-input-locale';
import { TokenAutocompleteInput } from '../../Task/TokenAutocompleteInput';
import { DateField } from '../../ui/DateField';
import { useEffect, useRef, useState } from 'react';
import { AreaColorPicker } from './AreaColorPicker';

type ProjectDetailsFieldsProps = {
    project: Project;
    selectedAreaId: string;
    sortedAreas: { id: string; name: string }[];
    noAreaId: string;
    t: (key: string) => string;
    tagDraft: string;
    tagSuggestions?: readonly string[];
    onTagDraftChange: (value: string) => void;
    onCommitTags: () => void;
    onNewArea: () => void;
    onManageAreas: () => void;
    onAreaChange: (value: string) => void;
    onColorChange?: (value: string | null) => unknown | Promise<unknown>;
    flowMode: ProjectFlowMode;
    onFlowModeChange: (mode: ProjectFlowMode) => void;
    sequentialScope: Project['sequentialScope'];
    onSequentialScopeChange: (value: Project['sequentialScope']) => void;
    status: Project['status'];
    onChangeStatus: (status: Project['status']) => void;
    startDateValue: string;
    onStartDateChange: (value: string) => void;
    dueDateValue: string;
    onDueDateChange: (value: string) => void;
    reviewAtValue: string;
    onReviewAtChange: (value: string) => void;
    readOnly?: boolean;
    readOnlyHint?: string;
};

export function ProjectDetailsFields({
    project,
    selectedAreaId,
    sortedAreas,
    noAreaId,
    t,
    tagDraft,
    tagSuggestions = [],
    onTagDraftChange,
    onCommitTags,
    onNewArea,
    onManageAreas,
    onAreaChange,
    onColorChange,
    flowMode,
    onFlowModeChange,
    sequentialScope,
    onSequentialScopeChange,
    status,
    onChangeStatus,
    startDateValue,
    onStartDateChange,
    dueDateValue,
    onDueDateChange,
    reviewAtValue,
    onReviewAtChange,
    readOnly = false,
    readOnlyHint,
}: ProjectDetailsFieldsProps) {
    const [colorSaving, setColorSaving] = useState(false);
    const [colorError, setColorError] = useState(false);
    const [colorIntent, setColorIntent] = useState<string | null>(null);
    const colorGeneration = useRef(0);
    useEffect(() => {
        colorGeneration.current += 1;
        setColorSaving(false); setColorError(false); setColorIntent(null);
    }, [project.id]);
    const resolveText = (key: string, fallback: string) => {
        const value = t(key);
        return value && value !== key ? value : fallback;
    };
    const resolvedSequenceModeLabel = resolveText('projects.sequenceMode', 'Flow Mode');
    const resolvedSequentialScope = sequentialScope === 'section' ? 'section' : 'project';
    const { nativeDateInputLocale, dateFormatSetting } = useNativeDateInputLocale();
    const saveColor = async (value: string | null) => {
        const generation = colorGeneration.current;
        setColorIntent(value);
        setColorSaving(true);
        setColorError(false);
        try {
            const result = await onColorChange?.(value);
            if (result && typeof result === 'object' && 'success' in result && result.success === false) throw new Error('Save refused');
        } catch { if (colorGeneration.current === generation) setColorError(true); }
        finally { if (colorGeneration.current === generation) setColorSaving(false); }
    };

    return (
        <section id="project-details-fields" className="border-b border-border/50 py-3">
            {readOnly ? (
                <p id="archived-project-details-hint" className="mb-3 text-xs text-muted-foreground" role="note">
                    {readOnlyHint}
                </p>
            ) : null}
            <fieldset
                aria-describedby={readOnly ? 'archived-project-details-hint' : undefined}
                className="m-0 min-w-0 border-0 p-0 disabled:opacity-70"
                disabled={readOnly}
                title={readOnly ? readOnlyHint : undefined}
            >
            <div data-project-details-grid className="grid grid-cols-1 gap-x-2 gap-y-2 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
                {onColorChange && <div className="min-w-0 space-y-1">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{resolveText('projects.color', 'Project color')}</div>
                    <fieldset disabled={colorSaving} className="flex items-center gap-2">
                        <AreaColorPicker value={project.colorOverride ?? undefined} onChange={(value) => { void saveColor(value ?? null); }}
                            title={resolveText('projects.color', 'Project color')}
                            noneLabel={resolveText('projects.useAreaColor', 'Use Area color')}
                            customLabel={resolveText('projects.colorCustom', 'Custom color')}
                            applyLabel={t('common.save')} cancelLabel={t('common.cancel')} />
                        <span className="truncate text-xs text-muted-foreground">{project.colorOverride ?? resolveText('projects.useAreaColor', 'Use Area color')}</span>
                    </fieldset>
                    {colorError && <div role="alert" className="text-xs text-destructive">
                        {resolveText('projects.colorSaveFailed', 'Color could not be saved.')}{' '}
                        <button type="button" disabled={colorSaving} className="underline" onClick={() => { void saveColor(colorIntent); }}>{t('common.retry')}</button>
                    </div>}
                </div>}
                <div className="min-w-0 space-y-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <Signal className="h-3.5 w-3.5" />
                        {t('projects.statusLabel')}
                    </label>
                    <select
                        value={status}
                        onChange={(e) => onChangeStatus(e.target.value as Project['status'])}
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={status === 'archived'}
                    >
                        <option value="active">{t('status.active')}</option>
                        <option value="waiting">{t('status.waiting')}</option>
                        <option value="someday">{t('status.someday')}</option>
                    </select>
                </div>

                <div className="min-w-0 space-y-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <ListOrdered className="h-3.5 w-3.5" />
                        {resolvedSequenceModeLabel}
                    </label>
                    <select
                        value={flowMode}
                        onChange={(e) => onFlowModeChange(e.target.value as ProjectFlowMode)}
                        aria-label={resolvedSequenceModeLabel}
                        title={flowMode === 'sequential'
                            ? t('projects.sequentialTooltip')
                            : flowMode === 'perSection'
                                ? resolveText('projects.perSectionTooltip', 'Per section: each section is Parallel or Sequential, chosen from its menu.')
                                : t('projects.parallelTooltip')}
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    >
                        <option value="parallel">{t('projects.parallel')}</option>
                        <option value="sequential">{t('projects.sequential')}</option>
                        <option value="perSection">{resolveText('projects.perSection', 'Per section')}</option>
                    </select>
                </div>

                {flowMode === 'sequential' && (
                    <div className="min-w-0 space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                            <ListOrdered className="h-3.5 w-3.5" />
                            {resolveText('projects.sequentialScope', 'Sequential Scope')}
                        </label>
                        <select
                            value={resolvedSequentialScope}
                            onChange={(e) => onSequentialScopeChange(e.target.value as Project['sequentialScope'])}
                            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                        >
                            <option value="project">
                                {resolveText('projects.sequentialAcrossSections', 'Across sections')}
                            </option>
                            <option value="section">
                                {resolveText('projects.sequentialWithinSections', 'Within sections')}
                            </option>
                        </select>
                    </div>
                )}

                <div className="min-w-0 space-y-1 sm:col-span-2 xl:col-span-2 2xl:col-span-2">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <FolderOpenDot className="h-3.5 w-3.5" />
                        {t('projects.areaLabel')}
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            key={`${project.id}-area`}
                            value={selectedAreaId}
                            onChange={(e) => onAreaChange(e.target.value)}
                            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                        >
                            <option value={noAreaId}>{t('projects.noArea')}</option>
                            {sortedAreas.map((area) => (
                                <option key={area.id} value={area.id}>
                                    {area.name}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={onNewArea}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                            title={t('projects.create')}
                            aria-label={t('projects.create')}
                        >
                            <Plus className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={onManageAreas}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                            title={t('projects.manageAreas')}
                            aria-label={t('projects.manageAreas')}
                        >
                            <Settings2 className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                <div className="min-w-0 space-y-1 sm:col-span-2 xl:col-span-2 2xl:col-span-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <Tags className="h-3.5 w-3.5" />
                        {t('taskEdit.tagsLabel')}
                    </label>
                    <TokenAutocompleteInput
                        key={`${project.id}-tags`}
                        value={tagDraft}
                        onChange={onTagDraftChange}
                        suggestions={tagSuggestions}
                        prefix="#"
                        ariaLabel={t('taskEdit.tagsLabel')}
                        onBlur={onCommitTags}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                onCommitTags();
                                e.currentTarget.blur();
                            }
                        }}
                        placeholder="#feature, #client"
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    />
                </div>

                <div className="min-w-0 space-y-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <CalendarRange className="h-3.5 w-3.5" />
                        {t('taskEdit.startDateLabel')}
                    </label>
                    <DateField
                        key={`${project.id}-start`}
                        t={t}
                        dateAriaLabel={t('taskEdit.startDateLabel')}
                        dateValue={startDateValue}
                        selectedDate={safeParseDate(startDateValue)}
                        dateFormatSetting={dateFormatSetting}
                        nativeDateInputLocale={nativeDateInputLocale}
                        dateInputClassName="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                        className="max-w-none"
                        hasValue={Boolean(startDateValue)}
                        onDateChange={onStartDateChange}
                        onClear={() => onStartDateChange('')}
                    />
                </div>

                <div className="min-w-0 space-y-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <Calendar className="h-3.5 w-3.5" />
                        {t('taskEdit.dueDateLabel')}
                    </label>
                    <DateField
                        key={`${project.id}-due`}
                        t={t}
                        dateAriaLabel={t('taskEdit.dueDateLabel')}
                        dateValue={dueDateValue}
                        selectedDate={safeParseDate(dueDateValue)}
                        dateFormatSetting={dateFormatSetting}
                        nativeDateInputLocale={nativeDateInputLocale}
                        dateInputClassName="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                        className="max-w-none"
                        hasValue={Boolean(dueDateValue)}
                        onDateChange={onDueDateChange}
                        onClear={() => onDueDateChange('')}
                    />
                </div>

                <div className="min-w-0 space-y-1">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <CalendarClock className="h-3.5 w-3.5" />
                        {t('projects.reviewAt')}
                    </label>
                    <input
                        key={`${project.id}-review`}
                        type="datetime-local"
                        defaultValue={reviewAtValue}
                        onBlur={(e) => onReviewAtChange(e.target.value)}
                        aria-describedby="project-review-date-hint"
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    />
                </div>
            </div>
            <p id="project-review-date-hint" className="sr-only">
                {t('projects.reviewAtHint')}
            </p>
            </fieldset>
        </section>
    );
}
