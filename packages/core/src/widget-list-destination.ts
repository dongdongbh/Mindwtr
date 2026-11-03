import { normalizeWidgetTokenListId } from './widget-lists';
import { getFocusWidgetFilter } from './focus-widget-filter';
import type { Language } from './i18n/i18n-types';
import type { AppData } from './types';
import { createWidgetPayloadProjection } from './widget-payload';


export function normalizeWidgetListDestinationId(value: unknown): string | null {
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    if (value === 'next' || value === 'upcoming') return value;
    const tokenId = normalizeWidgetTokenListId(value);
    if (tokenId) return tokenId;
    for (const prefix of ['filter:', 'project:']) {
        if (value.startsWith(prefix) && value.slice(prefix.length).trim().length > 0) return value;
    }
    return null;
}

export function resolveWidgetListDestination(data: AppData, language: Language, value: unknown) {
    const id = normalizeWidgetListDestinationId(value);
    if (!id) return null;


    return createWidgetPayloadProjection(data, language, {
        listIds: [id],
        focusFilter: getFocusWidgetFilter(),
    }).getTaskList(id);
}
