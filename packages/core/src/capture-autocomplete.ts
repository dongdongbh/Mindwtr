import { isSelectableProjectForTaskAssignment } from './project-utils';
import type { Project } from './types';

export type CaptureSuggestion = { kind: 'project'; label: string; id: string } | { kind: 'token'; label: string };
export type CaptureTrigger = { start: number; end: number; marker: '@' | '#' | '+'; query: string };

export function captureAutocompleteTrigger(text: string, caret: number): CaptureTrigger | null {
    const before = text.slice(0, caret);
    const match = /(?:^|\s)([@+#])(?:"((?:\\.|[^"\\])*)|([^\s"@+#]*))$/u.exec(before);
    if (!match) return null;
    const marker = match[1];
    if (marker !== '@' && marker !== '#' && marker !== '+') return null;
    const start = before.length - match[0].trimStart().length;
    let end = caret;
    if (match[2] !== undefined) {
        while (end < text.length) {
            if (text[end] === '\\') { end += 2; continue; }
            if (text[end++] === '"') break;
        }
    } else {
        while (end < text.length && !/\s/u.test(text[end])) end += 1;
    }
    return { start, end: Math.min(end, text.length), marker,
        query: (match[2] ?? match[3]).replace(/\\(["\\])/g, '$1') };
}

export function captureAutocompleteSuggestions(trigger: CaptureTrigger | null, projects: readonly Project[], contexts: readonly string[], tags: readonly string[]): CaptureSuggestion[] {
    if (!trigger) return [];
    const query = trigger.query.toLocaleLowerCase();
    const matches = (label: string) => label.toLocaleLowerCase().includes(query);
    if (trigger.marker === '+') return projects.filter(isSelectableProjectForTaskAssignment)
        .filter(project => matches(project.title)).slice(0, 6).map(project => ({ kind: 'project', label: project.title, id: project.id }));
    return [...new Set((trigger.marker === '@' ? contexts : tags).map(token => token.startsWith(trigger.marker) ? token.slice(1) : token))]
        .filter(matches).slice(0, 6).map(label => ({ kind: 'token', label: trigger.marker + label }));
}

export function acceptCaptureSuggestion(text: string, trigger: CaptureTrigger, suggestion: CaptureSuggestion) {
    const before = text.slice(0, trigger.start);
    const after = text.slice(trigger.end);
    const name = suggestion.label.slice(1);
    const token = suggestion.kind === 'project' ? '' : trigger.marker + (/\s|["\\]/u.test(name) ? JSON.stringify(name) : name);
    const separator = token && (!after || !/^\s/u.test(after)) ? ' ' : '';
    const suffix = !token && /\s$/u.test(before) ? after.replace(/^\s+/u, '') : after;
    return { text: before + token + separator + suffix, caret: before.length + token.length + separator.length };
}
