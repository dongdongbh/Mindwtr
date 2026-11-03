import { DEFAULT_FOCUS_SORT_BY } from './focus-sections';
import type { FilterCriteria, SortField } from './types';


export interface FocusWidgetFilter {
    criteria: FilterCriteria;
    sortBy: SortField;

    sortOrder?: 'asc' | 'desc';
}

export const NO_FOCUS_WIDGET_FILTER: FocusWidgetFilter = { criteria: {}, sortBy: DEFAULT_FOCUS_SORT_BY };

let current: FocusWidgetFilter = NO_FOCUS_WIDGET_FILTER;


export function focusWidgetFilterKey(filter: FocusWidgetFilter): string {
    return JSON.stringify([filter.criteria, filter.sortBy, filter.sortOrder ?? null]);
}

export function getFocusWidgetFilter(): FocusWidgetFilter {
    return current;
}


export function setFocusWidgetFilter(next: FocusWidgetFilter): boolean {
    if (focusWidgetFilterKey(next) === focusWidgetFilterKey(current)) return false;
    current = next;
    return true;
}

export function resetFocusWidgetFilter(): void {
    current = NO_FOCUS_WIDGET_FILTER;
}
