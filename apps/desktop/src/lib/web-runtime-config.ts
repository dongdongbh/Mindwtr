


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


export function getWebDefaultCloudUrl(): Promise<string> {
    if (!cachedDefault) {
        cachedDefault = resolveDefault().catch(() => '');
    }
    return cachedDefault;
}

export function resetWebDefaultCloudUrlForTests(): void {
    cachedDefault = null;
}
