export function getTaskTokenInputSegments(value: string, multiline = false) {
    const separator = multiline ? /[,\r\n]/g : /,/g;
    const quoted = multiline
        ? /[^\S\r\n]*"((?:[^"]|"")*)"[^\S\r\n]*(?=[,\r\n]|$)/y
        : /\s*"((?:[^"]|"")*)"\s*(?=,|$)/y;
    const segments: Array<{ start: number; end: number; token: string; quoted: boolean }> = [];
    for (let start = 0; start <= value.length;) {
        quoted.lastIndex = start;
        const match = quoted.exec(value);
        separator.lastIndex = start;
        const end = match ? quoted.lastIndex : separator.exec(value)?.index ?? value.length;
        const token = match ? match[1].replace(/""/g, '"') : value.slice(start, end).trim();
        segments.push({ start, end, token, quoted: Boolean(match) });
        start = end + 1;
    }
    return segments;
}

export const splitTaskTokenInput = (value: string, multiline = false): string[] =>
    getTaskTokenInputSegments(value, multiline).map(({ token }) => token).filter(Boolean);

const needsQuotes = (token: string): boolean => /[,\r\n]|^\s*"|^[@#]\S+(?:\s+[@#]\S+)+$/.test(token);

export const formatTaskTokenInput = (tokens: readonly string[]): string => tokens
    .map((token) => needsQuotes(token) ? `"${token.replace(/"/g, '""')}"` : token)
    .join(', ');
