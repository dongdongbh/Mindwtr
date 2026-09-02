// Self-hosted web (PWA) deployments can preseed the Cloud sync URL so a fresh
// browser only asks for the token (#1125), and can force a login screen before
// the app renders at all. Both are read from the same runtime-config.json,
// written by the app container's entrypoint from MINDWTR_DEFAULT_CLOUD_URL and
// MINDWTR_REQUIRE_SYNC (split-origin deployments). Same-origin detection is a
// second source for the default URL only: when the PWA is served on the same
// domain as the cloud API (the documented single-domain compose), /health
// answers with the cloud server's JSON and the app's own origin is the right
// default.
// The default-URL result is a FORM PREFILL only: nothing is persisted until
// the user saves, and an already-configured URL is never touched.

const PROBE_TIMEOUT_MS = 3000;

type WebRuntimeConfig = { defaultCloudUrl?: unknown; requireSync?: unknown };

let cachedRuntimeConfig: Promise<WebRuntimeConfig | null> | null = null;
let cachedDefault: Promise<string> | null = null;
let cachedRequireSync: Promise<boolean> | null = null;

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

const fetchRuntimeConfigFile = async (): Promise<WebRuntimeConfig | null> => {
    const response = await fetchWithTimeout('/runtime-config.json');
    if (!response?.ok) return null;
    try {
        return await response.json() as WebRuntimeConfig;
    } catch {
        return null;
    }
};

const getRuntimeConfigFile = (): Promise<WebRuntimeConfig | null> => {
    if (!cachedRuntimeConfig) {
        cachedRuntimeConfig = fetchRuntimeConfigFile().catch(() => null);
    }
    return cachedRuntimeConfig;
};

const readExplicitDefault = async (): Promise<string> => {
    const config = await getRuntimeConfigFile();
    return typeof config?.defaultCloudUrl === 'string' ? config.defaultCloudUrl.trim() : '';
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

/** Resolved once per session; every failure path yields false (gate stays open). */
export function getRequireSyncFlag(): Promise<boolean> {
    if (!cachedRequireSync) {
        cachedRequireSync = getRuntimeConfigFile()
            .then((config) => config?.requireSync === true)
            .catch(() => false);
    }
    return cachedRequireSync;
}

export function resetWebDefaultCloudUrlForTests(): void {
    cachedDefault = null;
    cachedRequireSync = null;
    cachedRuntimeConfig = null;
}
