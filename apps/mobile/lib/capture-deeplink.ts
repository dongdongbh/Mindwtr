export type ShortcutCapturePayload = {
    title: string;
    note?: string;
    project?: string;
    tags: string[];
};

const trimOrUndefined = (value: string | null | undefined): string | undefined => {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed : undefined;
};

const normalizeRouteFromUrl = (url: URL): string => {
    // mindwtr://capture -> hostname "capture"
    // mindwtr:///capture -> pathname "/capture"
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

export function parseShortcutCaptureUrl(rawUrl: string): ShortcutCapturePayload | null {
    if (!isShortcutCaptureUrl(rawUrl)) return null;

    const parsed = new URL(rawUrl);

    const title = trimOrUndefined(parsed.searchParams.get('title')) ?? trimOrUndefined(parsed.searchParams.get('text'));
    if (!title) return null;

    const note =
        trimOrUndefined(parsed.searchParams.get('note')) ??
        trimOrUndefined(parsed.searchParams.get('description'));
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
