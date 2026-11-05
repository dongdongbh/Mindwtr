import { buildShareCaptureDraft } from '../../../packages/core/src/entry-points';

export function readIOSShareCaptureDraft(raw: string): { draft: { title: string; note: string } | null } {
    const invalid = () => new Error('INVALID_INPUT: Invalid iOS text share');
    if (typeof raw !== 'string' || raw.length > 256 * 1024) throw invalid();
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
    const value = input as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || !['subject', 'text', 'webUrl'].every(field => Object.prototype.hasOwnProperty.call(value, field))) throw invalid();
    const bounded = (field: unknown, maximum: number): field is string | null => field === null || typeof field === 'string' && field.length <= maximum;
    if (!bounded(value.subject, 10_000) || !bounded(value.text, 50_000) || !bounded(value.webUrl, 16_000)) throw invalid();
    if (value.webUrl !== null) {
        let url: URL;
        try { url = new URL(value.webUrl); } catch { throw invalid(); }
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw invalid();
    }
    const draft = buildShareCaptureDraft({ shareSubject: value.subject, shareText: value.text, shareWebUrl: value.webUrl });
    return { draft: draft ? { title: draft.title, note: draft.description ?? '' } : null };
}
