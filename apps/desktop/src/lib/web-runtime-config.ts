// Self-hosted web (PWA) deployments can preseed the Cloud sync URL so a fresh
// browser only asks for the token (#1125). Two sources, in order:
//   1. /runtime-config.json — written by the app container's entrypoint from
//      MINDWTR_DEFAULT_CLOUD_URL (split-origin deployments).
//   2. Same-origin detection — when the PWA is served on the same domain as the
//      cloud API (the documented single-domain compose), /health answers with
//      the cloud server's JSON and the app's own origin is the right default.
// The result is a FORM PREFILL only: nothing is persisted until the user saves,
// and an already-configured URL is never touched.

const PROBE_TIMEOUT_MS = 3000;

type WebRuntimeConfig = { defaultCloudUrl?: unknown };

let cachedDefault: Promise<string> | null = null;

const fetchWithTimeout = async (path: string): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        return await fetch(path, { cache: 'no-store', signal: controller.signal });
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
};

const readExplicitDefault = async (): Promise<string> => {
    const response = await fetchWithTimeout('/runtime-config.json');
    if (!response?.ok) return '';
    try {
        const config = await response.json() as WebRuntimeConfig;
        return typeof config?.defaultCloudUrl === 'string' ? config.defaultCloudUrl.trim() : '';
    } catch {
        return '';
    }
};

const sameOriginCloudDetected = async (): Promise<boolean> => {
    const response = await fetchWithTimeout('/health');
    if (!response?.ok) return false;
    try {
        // The SPA fallback answers unknown paths with index.html and status 200,
        // so a 200 alone proves nothing: only the cloud server's JSON body counts.
        const body = await response.json() as { ok?: unknown };
        return body?.ok === true;
    } catch {
        return false;
    }
};

const resolveDefault = async (): Promise<string> => {
    const explicit = await readExplicitDefault();
    if (explicit) return explicit;
    return (await sameOriginCloudDetected()) ? window.location.origin : '';
};

/** Resolved once per session; every failure path yields '' (prefill nothing). */
export function getWebDefaultCloudUrl(): Promise<string> {
    if (!cachedDefault) {
        cachedDefault = resolveDefault().catch(() => '');
    }
    return cachedDefault;
}

export function resetWebDefaultCloudUrlForTests(): void {
    cachedDefault = null;
}
