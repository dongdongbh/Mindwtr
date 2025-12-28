export function parseJson<T>(raw: string): T {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error('AI response was empty.');
    }
    const cleaned = trimmed
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
    try {
        return JSON.parse(cleaned) as T;
    } catch (error) {
        const objectStart = cleaned.indexOf('{');
        const objectEnd = cleaned.lastIndexOf('}');
        if (objectStart !== -1 && objectEnd > objectStart) {
            const sliced = cleaned.slice(objectStart, objectEnd + 1);
            return JSON.parse(sliced) as T;
        }
        const arrayStart = cleaned.indexOf('[');
        const arrayEnd = cleaned.lastIndexOf(']');
        if (arrayStart !== -1 && arrayEnd > arrayStart) {
            const sliced = cleaned.slice(arrayStart, arrayEnd + 1);
            return JSON.parse(sliced) as T;
        }
        const message = error instanceof Error ? error.message : String(error);
        const preview = cleaned.length > 240 ? `${cleaned.slice(0, 240)}…` : cleaned;
        throw new Error(`AI JSON parse error: ${message}. Raw: ${preview}`);
    }
}

const TIME_ESTIMATE_MAP: Record<string, string> = {
    '5m': '5min',
    '5min': '5min',
    '10m': '10min',
    '10min': '10min',
    '15m': '15min',
    '15min': '15min',
    '30m': '30min',
    '30min': '30min',
    '1h': '1hr',
    '1hr': '1hr',
    '2h': '2hr',
    '2hr': '2hr',
    '3h': '3hr',
    '3hr': '3hr',
    '4h': '4hr',
    '4hr': '4hr',
    '4h+': '4hr+',
    '4hr+': '4hr+',
};

export function normalizeTimeEstimate(value?: string): string | undefined {
    if (!value) return undefined;
    const key = value.trim().toLowerCase();
    return TIME_ESTIMATE_MAP[key];
}

export function normalizeTags(tags?: string[] | null): string[] {
    if (!tags || tags.length === 0) return [];
    const normalized = tags
        .map((tag) => String(tag).trim())
        .filter(Boolean)
        .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
    return Array.from(new Set(normalized));
}
