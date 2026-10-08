export type AppStoreInfo = { version: string; trackViewUrl: string | null };

// Preserve the mobile update checker's numeric comparison, including its
// treatment of prerelease/build suffixes and omitted version segments.
export const compareAppVersions = (v1: string, v2: string): number => {
    const parseVersionParts = (version: string): number[] => (
        version
            .trim()
            .replace(/^v/i, '')
            .split(/[+-]/)[0]
            .split('.')
            .map((part) => {
                const match = part.match(/\d+/);
                return match ? Number.parseInt(match[0], 10) : 0;
            })
    );

    const parts1 = parseVersionParts(v1);
    const parts2 = parseVersionParts(v2);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i += 1) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
};

const appStoreListingURL = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const candidate = value.trim();
    if (!candidate || candidate.length > 2_048 || candidate.includes('\\')
        || [...candidate].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return null;
    // URL shims may omit credential/port getters. Bind the original authority
    // to Apple hosts and the default HTTPS port before reading parsed fields.
    const authority = /^https:\/\/([^/?#]*)/i.exec(candidate)?.[1];
    if (!authority || !/^(?:apps|itunes)\.apple\.com(?::443)?$/i.test(authority)) return null;
    try {
        const url = new URL(candidate);
        return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
            && (url.hostname === 'apps.apple.com' || url.hostname === 'itunes.apple.com')
            && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id\d+\/?$/i.test(url.pathname)
            ? candidate : null;
    } catch { return null; }
};

/** Existing RN iOS lookup policy. Opening the returned listing stays caller-owned. */
export async function fetchAppStoreInfo(bundleIdentifier: string, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<AppStoreInfo> {
    if (typeof bundleIdentifier !== 'string' || !bundleIdentifier.trim()) {
        throw new Error('App Store lookup requires a bundle identifier');
    }
    const lookupURL = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleIdentifier)}`;
    const lookupUrls = [lookupURL, `${lookupURL}&country=US`];
    let lastError: Error | null = null;
    let bestMatch: AppStoreInfo | null = null;

    for (const baseUrl of lookupUrls) {
        const separator = baseUrl.includes('?') ? '&' : '?';
        const url = `${baseUrl}${separator}_=${Date.now()}`;
        const response = await fetcher(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mindwtr-App',
            },
            cache: 'no-store',
        });
        if (!response.ok) {
            lastError = new Error(`App Store lookup failed (${url}): ${response.status}`);
            continue;
        }
        const payload = await response.json() as { results?: { version?: unknown; trackViewUrl?: unknown }[] };
        const candidate = Array.isArray(payload.results) ? payload.results[0] : null;
        const version = typeof candidate?.version === 'string' ? candidate.version.trim() : '';
        if (!version) {
            lastError = new Error(`Unable to parse App Store version from ${url}`);
            continue;
        }
        const trackViewUrl = appStoreListingURL(candidate?.trackViewUrl);
        if (!bestMatch || compareAppVersions(version, bestMatch.version) > 0) {
            bestMatch = { version, trackViewUrl };
        }
    }

    if (bestMatch) return bestMatch;
    if (lastError) throw lastError;
    throw new Error('Unable to fetch App Store version');
}
