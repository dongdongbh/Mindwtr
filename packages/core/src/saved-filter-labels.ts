import { safeFormatDate } from './date';
import type { FilterCriteria } from './types';

export type SavedFilterCriteriaChip = {
    id: string;
    label: string;
    color?: string;
};

export type SavedFilterCriteriaChipOptions = {
    formatDate?: (value: string) => string;
    getAreaColor?: (areaId: string) => string | undefined;
    getAreaLabel?: (areaId: string) => string | undefined;
    resolveText?: (key: string, fallback: string) => string;
    translate?: (key: string) => string;
};

const AREA_CHIP_PREFIX = 'area:';
const STATUS_CHIP_PREFIX = 'status:';
const ASSIGNED_CHIP_PREFIX = 'assigned:';
const LOCATION_CHIP_PREFIX = 'location:';

const DATE_RANGE_PRESET_LABELS: Record<string, string> = {
    today: 'Today',
    this_week: 'This week',
    this_month: 'This month',
    overdue: 'Overdue',
    no_date: 'No date',
    next_7_days: 'Next 7 days',
    overdue_next_7_days: 'Overdue + next 7 days',
    next_14_days: 'Next 14 days',
    next_30_days: 'Next 30 days',
    upcoming: 'All upcoming',
};

function titleCase(value: string): string {
    return value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function resolveText(options: SavedFilterCriteriaChipOptions, key: string, fallback: string): string {
    if (options.resolveText) return options.resolveText(key, fallback);
    const translated = options.translate?.(key);
    return translated && translated !== key ? translated : fallback;
}

function formatDateValue(value: string, options: SavedFilterCriteriaChipOptions): string {
    return options.formatDate?.(value) ?? safeFormatDate(value, 'P', value);
}

function formatDateRange(
    label: string,
    range: FilterCriteria['dueDateRange'],
    options: SavedFilterCriteriaChipOptions,
): string | null {
    if (!range) return null;
    if ('preset' in range) {
        const fallback = DATE_RANGE_PRESET_LABELS[range.preset] ?? titleCase(range.preset);
        return `${label}: ${resolveText(options, `filters.datePreset.${range.preset}`, fallback)}`;
    }

    const from = range.from ? formatDateValue(range.from, options) : '';
    const to = range.to ? formatDateValue(range.to, options) : '';
    if (from && to) return `${label}: ${from} - ${to}`;
    if (from) return `${label}: ${resolveText(options, 'filters.after', 'After')} ${from}`;
    if (to) return `${label}: ${resolveText(options, 'filters.before', 'Before')} ${to}`;
    return null;
}

function formatMinutes(minutes: number): string {
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function formatTimeEstimateRange(
    range: FilterCriteria['timeEstimateRange'],
    options: SavedFilterCriteriaChipOptions,
): string | null {
    if (!range) return null;
    const label = resolveText(options, 'filters.timeEstimate', 'Time estimate');
    const min = typeof range.min === 'number' ? formatMinutes(range.min) : '';
    const max = typeof range.max === 'number' ? formatMinutes(range.max) : '';
    if (min && max) return `${label}: ${min} - ${max}`;
    if (min) return `${label}: >= ${min}`;
    if (max) return `${label}: <= ${max}`;
    return null;
}

export function buildAdvancedFilterCriteriaChips(
    criteria: FilterCriteria,
    options: SavedFilterCriteriaChipOptions = {},
): SavedFilterCriteriaChip[] {
    const chips: SavedFilterCriteriaChip[] = [];
    const areaLabel = resolveText(options, 'taskEdit.areaLabel', 'Area');
    criteria.areas?.forEach((areaId) => {
        chips.push({
            id: `area:${areaId}`,
            label: `${areaLabel}: ${options.getAreaLabel?.(areaId) ?? areaId}`,
            color: options.getAreaColor?.(areaId),
        });
    });

    const statusLabel = resolveText(options, 'taskEdit.statusLabel', 'Status');
    criteria.statuses?.forEach((status) => {
        chips.push({
            id: `status:${status}`,
            label: `${statusLabel}: ${resolveText(options, `status.${status}`, titleCase(status))}`,
        });
    });

    const assignedLabel = resolveText(options, 'taskEdit.assignedTo', 'Assigned To');
    criteria.assignedTo?.forEach((assignee) => {
        chips.push({
            id: `assigned:${assignee}`,
            label: `${assignedLabel}: ${assignee}`,
        });
    });

    const locationLabel = resolveText(options, 'taskEdit.locationLabel', 'Location');
    criteria.locations?.forEach((location) => {
        chips.push({
            id: `location:${location}`,
            label: `${locationLabel}: ${location}`,
        });
    });

    const dueDateLabel = resolveText(options, 'taskEdit.dueDateLabel', 'Due Date');
    const dueDateRange = formatDateRange(dueDateLabel, criteria.dueDateRange, options);
    if (dueDateRange) chips.push({ id: 'dueDateRange', label: dueDateRange });

    const startDateLabel = resolveText(options, 'taskEdit.startDateLabel', 'Start Date');
    const startDateRange = formatDateRange(startDateLabel, criteria.startDateRange, options);
    if (startDateRange) chips.push({ id: 'startDateRange', label: startDateRange });

    const taskDatesLabel = resolveText(options, 'filters.taskDates', 'Task dates');
    const anyDateRange = formatDateRange(taskDatesLabel, criteria.anyDateRange, options);
    if (anyDateRange) chips.push({ id: 'anyDateRange', label: anyDateRange });

    const timeEstimateRange = formatTimeEstimateRange(criteria.timeEstimateRange, options);
    if (timeEstimateRange) chips.push({ id: 'timeEstimateRange', label: timeEstimateRange });

    if (criteria.hasDescription !== undefined) {
        chips.push({
            id: 'hasDescription',
            label: criteria.hasDescription
                ? resolveText(options, 'filters.hasDescription', 'Has description')
                : resolveText(options, 'filters.noDescription', 'No description'),
        });
    }

    if (criteria.isStarred !== undefined) {
        chips.push({
            id: 'isStarred',
            label: criteria.isStarred
                ? resolveText(options, 'filters.starred', 'Starred')
                : resolveText(options, 'filters.notStarred', 'Not starred'),
        });
    }

    return chips;
}

// Also runs on stored criteria (a saved filter as written), so a value
// matches by its trimmed text, as the reader shows it, and a value this build
// does not understand stays.
function removeListItem<T extends string>(values: T[] | undefined, target: string): T[] | undefined {
    if (!Array.isArray(values)) return values;
    const next = values.filter((value) => typeof value !== 'string' || value.trim() !== target);
    return next.length > 0 ? next : undefined;
}

export function removeAdvancedFilterCriteriaChip(criteria: FilterCriteria, chipId: string): FilterCriteria {
    if (chipId.startsWith(AREA_CHIP_PREFIX)) {
        const next = { ...criteria };
        const areas = removeListItem(criteria.areas, chipId.slice(AREA_CHIP_PREFIX.length));
        if (areas) next.areas = areas;
        else delete next.areas;
        return next;
    }

    if (chipId.startsWith(STATUS_CHIP_PREFIX)) {
        const next = { ...criteria };
        const statuses = removeListItem(criteria.statuses, chipId.slice(STATUS_CHIP_PREFIX.length));
        if (statuses) next.statuses = statuses;
        else delete next.statuses;
        return next;
    }

    if (chipId.startsWith(ASSIGNED_CHIP_PREFIX)) {
        const next = { ...criteria };
        const assignedTo = removeListItem(criteria.assignedTo, chipId.slice(ASSIGNED_CHIP_PREFIX.length));
        if (assignedTo) next.assignedTo = assignedTo;
        else delete next.assignedTo;
        return next;
    }

    if (chipId.startsWith(LOCATION_CHIP_PREFIX)) {
        const next = { ...criteria };
        const locations = removeListItem(criteria.locations, chipId.slice(LOCATION_CHIP_PREFIX.length));
        if (locations) next.locations = locations;
        else delete next.locations;
        return next;
    }

    if (chipId === 'dueDateRange') {
        const { dueDateRange: _removed, ...next } = criteria;
        return next;
    }

    if (chipId === 'startDateRange') {
        const { startDateRange: _removed, ...next } = criteria;
        return next;
    }

    if (chipId === 'anyDateRange') {
        const { anyDateRange: _removed, ...next } = criteria;
        return next;
    }

    if (chipId === 'timeEstimateRange') {
        const { timeEstimateRange: _removed, ...next } = criteria;
        return next;
    }

    if (chipId === 'hasDescription') {
        const { hasDescription: _removed, ...next } = criteria;
        return next;
    }

    if (chipId === 'isStarred') {
        const { isStarred: _removed, ...next } = criteria;
        return next;
    }

    return criteria;
}
