


export type ShortcutCapturePayload = {
    title: string;
    note?: string;
    project?: string;
    tags: string[];
};

export type OpenFeaturePayload = {
    feature: string | null;
};

const trimOrUndefined = (value: string | null | undefined): string | undefined => {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed : undefined;
};

const normalizeRouteFromUrl = (url: URL): string => {


    const route = trimOrUndefined(url.hostname) ?? trimOrUndefined(url.pathname.replace(/^\/+/, '')) ?? '';
    return route.toLowerCase();
};

export function isShortcutCaptureUrl(rawUrl: string): boolean {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;

    try {
        const parsed = new URL(rawUrl);
        return (parsed.protocol || '').toLowerCase() === 'mindwtr:' && normalizeRouteFromUrl(parsed) === 'capture';
    } catch {
        return false;
    }
}

const firstQueryValue = (searchParams: URLSearchParams, keys: string[]): string | undefined => {
    for (const key of keys) {
        const value = trimOrUndefined(searchParams.get(key));
        if (value) return value;
    }
    return undefined;
};

export function parseShortcutCaptureUrl(rawUrl: string): ShortcutCapturePayload | null {
    if (!isShortcutCaptureUrl(rawUrl)) return null;

    const parsed = new URL(rawUrl);

    const itemListName = trimOrUndefined(parsed.searchParams.get('itemListName'));
    const itemListElementName = trimOrUndefined(parsed.searchParams.get('itemListElementName'));
    const title = firstQueryValue(parsed.searchParams, [
        'title',
        'text',
        'name',
        'thingName',
        'itemListElementName',
        'itemListName',
    ]);
    if (!title) return null;

    const note =
        firstQueryValue(parsed.searchParams, [
            'note',
            'description',
            'body',
            'thingDescription',
            'itemListDescription',
        ]) ??
        (itemListName && itemListElementName && itemListName !== itemListElementName
            ? `List: ${itemListName}`
            : undefined);
    const project = trimOrUndefined(parsed.searchParams.get('project'));

    const tagsRaw = trimOrUndefined(parsed.searchParams.get('tags'));
    const tags = tagsRaw
        ? tagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean)
        : [];

    return {
        title,
        ...(note ? { note } : {}),
        ...(project ? { project } : {}),
        tags,
    };
}

export function normalizeShortcutTags(tags: string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const rawTag of tags) {
        const trimmed = String(rawTag || '').trim();
        if (!trimmed) continue;
        const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
        const key = prefixed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(prefixed);
    }
    return normalized;
}

export function isOpenFeatureUrl(rawUrl: string): boolean {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;

    try {
        const parsed = new URL(rawUrl);
        return (parsed.protocol || '').toLowerCase() === 'mindwtr:' && normalizeRouteFromUrl(parsed) === 'open-feature';
    } catch {
        return false;
    }
}

export function parseOpenFeatureUrl(rawUrl: string): OpenFeaturePayload | null {
    if (!isOpenFeatureUrl(rawUrl)) return null;

    const parsed = new URL(rawUrl);
    return {
        feature: trimOrUndefined(parsed.searchParams.get('feature')) ?? null,
    };
}

export type EntityOpenKind = 'task' | 'project' | 'area';
export type EntityOpenPayload = { kind: EntityOpenKind; id: string };

const ENTITY_OPEN_PARAM_KINDS: EntityOpenKind[] = ['task', 'project', 'area'];


export function isEntityOpenUrl(rawUrl: string): boolean {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;

    try {
        const parsed = new URL(rawUrl);
        return (parsed.protocol || '').toLowerCase() === 'mindwtr:' && normalizeRouteFromUrl(parsed) === 'open';
    } catch {
        return false;
    }
}

export function parseEntityOpenUrl(rawUrl: string): EntityOpenPayload | null {
    if (!isEntityOpenUrl(rawUrl)) return null;

    const parsed = new URL(rawUrl);
    for (const kind of ENTITY_OPEN_PARAM_KINDS) {
        const id = trimOrUndefined(parsed.searchParams.get(kind));
        if (id) return { kind, id };
    }
    return null;
}

export function resolveOpenFeaturePath(feature: string | null | undefined): string {
    const normalized = String(feature ?? '')
        .trim()
        .toLowerCase()
        .replace(/^feature[_-]/, '')
        .replace(/[_\s]+/g, '-');

    switch (normalized) {
        case 'capture':
        case 'quick-capture':
        case 'add-task':
        case 'new-task':
            return '/capture-quick?mode=text';
        case 'focus':
        case 'today':
        case 'next':
        case 'next-actions':
            return '/focus';
        case 'waiting':
        case 'waiting-for':
            return '/waiting';
        case 'someday':
        case 'maybe':
        case 'someday-maybe':
            return '/someday';
        case 'projects':
        case 'project-list':
            return '/projects';
        case 'review':
        case 'daily-review':
        case 'weekly-review':
            return '/review-tab';
        case 'calendar':
        case 'schedule':
            return '/calendar';
        case 'inbox':
        case '':
        default:
            return '/inbox';
    }
}
