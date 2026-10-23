import { safeParseDate } from './date';
import { tFallback, type TranslateFn } from './i18n';
import { getProjectFlowMode } from './task-utils';
import type { Project, Section } from './types';

export type ProjectDetailsMetadata = {
    summary: string;
    statusLabel: string;
    typeLabel: string;
    sequentialScopeLabel: string | null;
    sections: Array<Pick<Section, 'id' | 'title'>>;
    areaLabel: string;
    tagsLabel: string;
    hasStartDate: boolean;
    hasDueDate: boolean;
    hasReviewDate: boolean;
    startDateLabel: string;
    dueDateLabel: string;
    reviewDateLabel: string;
};

/** RN's Project Details date display, including invalid raw values. */
export function formatProjectDate(dateStr: string | undefined, notSetLabel: string): string {
    if (!dateStr) return notSetLabel;
    try {
        const parsed = safeParseDate(dateStr);
        return parsed ? parsed.toLocaleDateString() : dateStr;
    } catch {
        return dateStr;
    }
}

/** Display-only policy shared by the RN panel and native Project detail window. */
export function getProjectDetailsPresentation(
    project: Project,
    input: {
        isArchivedProject: boolean;
        areaName: string;
        sections: readonly Pick<Section, 'id' | 'title'>[];
        t: TranslateFn;
    },
): ProjectDetailsMetadata {
    const { t } = input;
    const displayStatus = input.isArchivedProject ? 'archived' : project.status;
    const statusLabel = project.cancelledAt
        ? tFallback(t, 'projects.cancelled', 'Cancelled')
        : displayStatus === 'active' ? t('status.active')
            : displayStatus === 'waiting' ? t('status.waiting')
                : displayStatus === 'someday' ? t('status.someday')
                    : tFallback(t, 'status.archived', 'Archived');
    const flowMode = getProjectFlowMode(project);
    const typeLabel = flowMode === 'sequential'
        ? tFallback(t, 'projects.sequential', 'Sequential')
        : flowMode === 'perSection'
            ? tFallback(t, 'projects.perSection', 'Per section')
            : tFallback(t, 'projects.parallel', 'Parallel');
    const noAreaLabel = tFallback(t, 'projects.noArea', 'No Area');
    const areaLabel = input.areaName || noAreaLabel;
    const sections = input.sections.map(({ id, title }) => ({ id, title }));
    const summary = [
        statusLabel,
        typeLabel,
        areaLabel !== noAreaLabel ? areaLabel : '',
        sections.length > 0 ? `${sections.length} ${tFallback(t, 'projects.sectionsLabel', 'Sections')}` : '',
    ].filter(Boolean).join(' · ');
    return {
        summary,
        statusLabel,
        typeLabel,
        sequentialScopeLabel: project.isSequential
            ? project.sequentialScope === 'section'
                ? tFallback(t, 'projects.sequentialWithinSections', 'Within sections')
                : tFallback(t, 'projects.sequentialAcrossSections', 'Across sections')
            : null,
        sections,
        areaLabel,
        tagsLabel: project.tagIds?.length ? project.tagIds.join(', ') : t('common.none'),
        hasStartDate: Boolean(project.startDate),
        hasDueDate: Boolean(project.dueDate),
        hasReviewDate: Boolean(project.reviewAt),
        startDateLabel: formatProjectDate(project.startDate, t('common.notSet')),
        dueDateLabel: formatProjectDate(project.dueDate, t('common.notSet')),
        reviewDateLabel: formatProjectDate(project.reviewAt, t('common.notSet')),
    };
}

/**
 * A review date picked on Android, as RN's date picker answers it (@react-native-community/datetimepicker
 * DatePickerModule.onDateSet): the picked `yyyy-MM-dd` [day] at the hour and minute of the value the picker [opened] on, in
 * [timeZone] (the device's), seconds and milliseconds 0, as an ISO instant. The zone's rules come from Intl (ICU on Android, as
 * Java's Calendar), never the engine's local Date conversion. As Java's lenient Calendar: a repeated hour (clocks set back)
 * resolves to its later instant, and a skipped hour (clocks set forward) moves forward. Null for a malformed day, instant or zone.
 */
export function projectReviewPickerValue(day: string, opened: string,
    timeZone: string = new Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    const at = Date.parse(opened);
    if (!match || !Number.isFinite(at)) return null;
    let format: Intl.DateTimeFormat;
    try {
        format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
            day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return null; }
    // The wall clock at an instant, as minutes counted like UTC's (so wall minus instant is the zone's offset there).
    const wall = (instant: number): number => {
        const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
        return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
    };
    const minute = 60_000;
    const openedWall = wall(Math.floor(at / minute) * minute);
    const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + (openedWall % 86_400_000);
    if (!Number.isFinite(target) || new Date(target).getUTCDate() !== Number(match[3])) return null;
    // The offsets in force a half day before and after: every transition near the target lies between them.
    const before = wall(target - 12 * 3_600_000) - (target - 12 * 3_600_000);
    const after = wall(target + 12 * 3_600_000) - (target + 12 * 3_600_000);
    const fits = [target - before, target - after].filter((instant) => wall(instant) === target);
    // Two fits: the repeated hour, its later instant. None: the skipped hour, read with the offset before it (moves forward).
    const instant = fits.length > 0 ? Math.max(...fits) : target - before;
    return new Date(instant).toISOString();
}
