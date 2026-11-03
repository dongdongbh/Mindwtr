import { parseSearchQuery } from './search';

export interface SearchHighlightSegment {
    text: string;
    highlighted: boolean;
}

export type SearchHighlighter = (text: string) => SearchHighlightSegment[];

interface MatchRange {
    start: number;
    end: number;
}

const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getHighlightTerms = (query: string): string[] => {
    const parsed = parseSearchQuery(query);
    if (
        parsed.clauses.some((clause) =>
            clause.terms.some((term) => term.field !== null),
        )
    ) {
        return [];
    }

    const seen = new Set<string>();
    const terms: string[] = [];
    for (const clause of parsed.clauses) {
        for (const term of clause.terms) {
            const value = term.value.trim();
            const normalized = value.toLowerCase();
            if (term.negated || value === '' || seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            terms.push(value);
        }
    }
    return terms;
};

const findMatchRanges = (text: string, matchers: RegExp[]): MatchRange[] => {
    const ranges: MatchRange[] = [];
    for (const matcher of matchers) {
        const matches = text.matchAll(matcher);
        for (const match of matches) {
            if (match.index === undefined || !match[1]) continue;
            ranges.push({
                start: match.index,
                end: match.index + match[1].length,
            });
        }
    }

    ranges.sort(
        (left, right) => left.start - right.start || right.end - left.end,
    );
    const merged: MatchRange[] = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
};


export const createSearchHighlighter = (query: string): SearchHighlighter => {
    const terms = getHighlightTerms(query);
    const matchers = terms.map(
        (term) => new RegExp(`(?=(${escapeRegExp(term)}))`, 'giu'),
    );

    return (text: string) => {
        if (text === '') return [];
        const ranges = findMatchRanges(text, matchers);
        if (ranges.length === 0) return [{ text, highlighted: false }];

        const segments: SearchHighlightSegment[] = [];
        let cursor = 0;
        for (const range of ranges) {
            if (range.start > cursor) {
                segments.push({
                    text: text.slice(cursor, range.start),
                    highlighted: false,
                });
            }
            segments.push({
                text: text.slice(range.start, range.end),
                highlighted: true,
            });
            cursor = range.end;
        }
        if (cursor < text.length) {
            segments.push({ text: text.slice(cursor), highlighted: false });
        }
        return segments;
    };
};
