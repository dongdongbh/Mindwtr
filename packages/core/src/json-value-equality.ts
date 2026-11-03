
export const taskEditValuesEqual = (left: unknown, right: unknown): boolean => {
    const canonical = (value: unknown): unknown => {
        if (value == null) return null;
        if (Array.isArray(value)) return value.map(canonical);
        if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, entry]) => [name, canonical(entry)]));
        return value;
    };
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
};
