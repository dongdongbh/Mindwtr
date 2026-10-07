import { sanitizeLogContext } from './log-sanitize';

/** Local, volatile diagnostics. Callers supply entries through their existing
 * sanitizers; this buffer never writes to disk or sends anything. */
type DiagnosticEntry = {
    ts: string;
    level: 'info' | 'warn' | 'error';
    scope: string;
    message: string;
    [field: string]: unknown;
};

const MAX_AGE_MS = 30 * 60_000;
const MAX_BUFFER_CHARS = 64_000;
const MAX_BUFFER_ENTRIES = 160;
const MAX_ENTRY_CHARS = 8_000;
export const FEEDBACK_DIAGNOSTICS_SOURCE_CHARS = 100_000;

function priority(entry: DiagnosticEntry): number {
    return entry.level === 'error' ? 2 : entry.level === 'warn' ? 1 : 0;
}

function signature(entry: DiagnosticEntry): string {
    const { ts: _ts, ...content } = entry;
    return JSON.stringify(content);
}

export function createFeedbackDiagnosticsBuffer(now: () => number = Date.now) {
    let entries: { entry: DiagnosticEntry; line: string; recordedAt: number; signature: string }[] = [];
    const prune = () => {
        const cutoff = now() - MAX_AGE_MS;
        entries = entries.filter((item) => item.recordedAt >= cutoff);
    };
    return {
        record(entry: DiagnosticEntry) {
            prune();
            let line = JSON.stringify(entry);
            if (line.length > MAX_ENTRY_CHARS) {
                entry = { ts: entry.ts, level: entry.level, scope: entry.scope.slice(0, 100),
                    message: entry.message.slice(0, 2_000), context: { diagnosticTruncated: 'true' } };
                line = JSON.stringify(entry);
            }
            const identity = signature(entry);
            entries = entries.filter((item) => item.signature !== identity);
            entries.push({ entry, line, recordedAt: now(), signature: identity });
            let chars = entries.reduce((total, item) => total + item.line.length + 1, 0);
            while (entries.length > MAX_BUFFER_ENTRIES || chars > MAX_BUFFER_CHARS) {
                // Routine traffic must not evict the failure that led to feedback.
                const lowest = Math.min(...entries.map((item) => priority(item.entry)));
                const index = entries.findIndex((item) => priority(item.entry) === lowest);
                chars -= entries[index].line.length + 1;
                entries.splice(index, 1);
            }
        },
        read(): string {
            prune();
            return entries.map((item) => item.line).join('\n');
        },
        clear() { entries = []; },
    };
}

/** Preserve complete JSON lines, with failures ahead of routine traffic. The
 * final snapshot reserves room for the current activity trail and capture proof. */
export function buildFeedbackDiagnostics(
    sources: readonly (string | null | undefined)[],
    snapshot: string,
    maxChars = 20_000,
): string | null {
    const budget = Math.max(0, Math.floor(maxChars));
    if (snapshot.length > budget) return null;
    const candidates = new Map<string, { entry: DiagnosticEntry; line: string }>();
    for (const source of sources) {
        for (const line of (source ?? '').split('\n')) {
            try {
                const entry = JSON.parse(line) as DiagnosticEntry;
                if (!entry || typeof entry.ts !== 'string' || !Number.isFinite(Date.parse(entry.ts))
                    || !['info', 'warn', 'error'].includes(entry.level)
                    || typeof entry.scope !== 'string' || typeof entry.message !== 'string'
                    || entry.message === 'Feedback diagnostics snapshot') continue;
                const identity = signature(entry);
                const previous = candidates.get(identity);
                if (!previous || entry.ts >= previous.entry.ts) candidates.set(identity, { entry, line });
            } catch {
                // Rotated logs can start halfway through an entry. Never attach that fragment.
            }
        }
    }
    const ranked = [...candidates.values()].sort((a, b) => (
        priority(b.entry) - priority(a.entry) || Date.parse(b.entry.ts) - Date.parse(a.entry.ts)
    ));
    let remaining = budget - snapshot.length;
    const selected: typeof ranked = [];
    for (const item of ranked) {
        if (item.line.length + 1 > remaining) continue;
        selected.push(item);
        remaining -= item.line.length + 1;
    }
    selected.sort((a, b) => Date.parse(a.entry.ts) - Date.parse(b.entry.ts));
    return [...selected.map((item) => item.line), snapshot].join('\n');
}

/**
 * The snapshot line that ends the attached diagnostics: whether debug logging is on and the recent app flow (the breadcrumbs).
 * Built in memory, so attaching never writes a log while logging is off. RN's collectFeedbackDiagnostics and the native host's.
 */
export function buildFeedbackDiagnosticsSnapshot(input: { debugLoggingEnabled: boolean; breadcrumbs: readonly string[]; now?: Date }): string {
    const { breadcrumbs } = input;
    return JSON.stringify({
        ts: (input.now ?? new Date()).toISOString(),
        level: 'info',
        scope: 'feedback',
        message: 'Feedback diagnostics snapshot',
        context: sanitizeLogContext({
            debugLoggingEnabled: input.debugLoggingEnabled,
            releaseCheck: 'v1.3.0/feedback-diagnostics',
            captureMode: 'recent-session-and-saved-log',
            breadcrumbCount: breadcrumbs.length,
            breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs.join(';') : 'none',
        }),
    });
}
