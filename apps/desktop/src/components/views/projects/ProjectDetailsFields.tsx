import { safeParseDate, type Project } from '@mindwtr/core';
import { Calendar, CalendarClock, CalendarRange, FolderOpenDot, ListOrdered, Plus, Settings2, Signal, Tags } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useNativeDateInputLocale } from '../../../hooks/use-native-date-input-locale';
import { TokenAutocompleteInput } from '../../Task/TokenAutocompleteInput';
import { DateField } from '../../ui/DateField';

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
    isSequential: boolean;
    onToggleSequential: () => void;
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
    isSequential,
    onToggleSequential,
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
    const resolveText = (key: string, fallback: string) => {
        const value = t(key);
        return value && value !== key ? value : fallback;
    };
    const resolvedSequenceModeLabel = resolveText('projects.sequenceMode', 'Flow Mode');
    const resolvedSequentialScope = sequentialScope === 'section' ? 'section' : 'project';
    const { nativeDateInputLocale, dateFormatSetting } = useNativeDateInputLocale();

    return (
        <section className="py-5 border-b border-border/50">
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
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-12">
                <div className="space-y-2 min-w-0 2xl:col-span-2">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <Signal className="h-3.5 w-3.5" />
                        {t('projects.statusLabel')}
                    </label>
                    <select
                        value={status}
                        onChange={(e) => onChangeStatus(e.target.value as Project['status'])}
                        className="h-9 w-full text-sm bg-background border border-border rounded-md px-2 text-foreground disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={status === 'archived'}
                    >
                        <option value="active">{t('status.active')}</option>
                        <option value="waiting">{t('status.waiting')}</option>
                        <option value="someday">{t('status.someday')}</option>
                    </select>
                </div>

                <div className="space-y-2 min-w-0 2xl:col-span-2">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <ListOrdered className="h-3.5 w-3.5" />
                        {resolvedSequenceModeLabel}
                    </label>
                    <button
                        type="button"
                        onClick={onToggleSequential}
                        className={cn(
                            'h-9 w-full px-2 rounded-md border text-sm flex items-center justify-center gap-2 transition-colors',
                            isSequential
                                ? 'bg-primary text-primary-foreground border-primary/50'
                                : 'bg-background text-muted-foreground border-border hover:bg-muted/40 hover:text-foreground'
                        )}
                        title={isSequential ? t('projects.sequentialTooltip') : t('projects.parallelTooltip')}
                        aria-label={isSequential ? t('projects.sequential') : t('projects.parallel')}
                    >
                        <ListOrdered className="h-4 w-4" />
                        <span>{isSequential ? t('projects.sequential') : t('projects.parallel')}</span>
                    </button>
                </div>

                {isSequential && (
                    <div className="space-y-2 min-w-0 2xl:col-span-2">
                        <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                            <ListOrdered className="h-3.5 w-3.5" />
                            {resolveText('projects.sequentialScope', 'Sequential Scope')}
                        </label>
                        <select
                            value={resolvedSequentialScope}
                            onChange={(e) => onSequentialScopeChange(e.target.value as Project['sequentialScope'])}
                            className="h-9 w-full text-sm bg-background border border-border rounded-md px-2 text-foreground"
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

                <div className="space-y-2 min-w-0 md:col-span-2 2xl:col-span-4">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <FolderOpenDot className="h-3.5 w-3.5" />
                        {t('projects.areaLabel')}
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            key={`${project.id}-area`}
                            value={selectedAreaId}
                            onChange={(e) => onAreaChange(e.target.value)}
                            className="h-9 flex-1 min-w-0 text-sm bg-background border border-border rounded-md px-2 text-foreground"
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
                            className="h-9 w-9 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors inline-flex items-center justify-center"
                            title={t('projects.create')}
                            aria-label={t('projects.create')}
                        >
                            <Plus className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={onManageAreas}
                            className="h-9 w-9 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors inline-flex items-center justify-center"
                            title={t('projects.manageAreas')}
                            aria-label={t('projects.manageAreas')}
                        >
                            <Settings2 className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                <div className="space-y-2 min-w-0 md:col-span-2 2xl:col-span-2">
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
                        className="h-9 w-full text-sm bg-background border border-border rounded-md px-2 text-foreground"
                    />
                </div>

                <div className="space-y-2 min-w-0 2xl:col-span-2">
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
                        dateInputClassName="h-9 text-sm bg-background border border-border rounded-md px-2 text-foreground"
                        className="max-w-none"
                        hasValue={Boolean(startDateValue)}
                        onDateChange={onStartDateChange}
                        onClear={() => onStartDateChange('')}
                    />
                </div>

                <div className="space-y-2 min-w-0 2xl:col-span-2">
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
                        dateInputClassName="h-9 text-sm bg-background border border-border rounded-md px-2 text-foreground"
                        className="max-w-none"
                        hasValue={Boolean(dueDateValue)}
                        onDateChange={onDueDateChange}
                        onClear={() => onDueDateChange('')}
                    />
                </div>

                <div className="space-y-2 min-w-0 2xl:col-span-2">
                    <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1.5 truncate">
                        <CalendarClock className="h-3.5 w-3.5" />
                        {t('projects.reviewAt')}
                    </label>
                    <input
                        key={`${project.id}-review`}
                        type="datetime-local"
                        defaultValue={reviewAtValue}
                        onBlur={(e) => onReviewAtChange(e.target.value)}
                        className="h-9 w-full text-sm bg-background border border-border rounded-md px-2 text-foreground"
                    />
                </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
                {t('projects.reviewAtHint')}
            </p>
            </fieldset>
        </section>
    );
}
