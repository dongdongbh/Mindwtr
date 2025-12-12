export function matchesHierarchicalToken(filter: string, token: string): boolean {
    const normalizedFilter = filter.replace(/\/+$/, '');
    if (token === normalizedFilter) return true;
    return token.startsWith(`${normalizedFilter}/`);
}

export function normalizePrefixedToken(value: string, prefix: '@' | '#'): string {
    if (value.startsWith(prefix)) return value;
    return `${prefix}${value}`;
}

