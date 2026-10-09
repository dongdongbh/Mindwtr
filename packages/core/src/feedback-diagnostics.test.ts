import { describe, expect, it } from 'vitest';
import { buildFeedbackDiagnostics, createFeedbackDiagnosticsBuffer, sanitizeSavedFeedbackLog } from './feedback-diagnostics';

const entry = (message: string, level: 'info' | 'warn' | 'error' = 'info', offset = 0) => ({
    ts: new Date(Date.UTC(2026, 8, 14) + offset).toISOString(), level, scope: 'sync', message,
});
const snapshot = JSON.stringify(entry('Feedback diagnostics snapshot'));

describe('feedback diagnostics', () => {
    it('keeps failures through routine traffic and expires the session buffer', () => {
        let time = 0;
        const buffer = createFeedbackDiagnosticsBuffer(() => time);
        buffer.record(entry('Unable to save', 'error'));
        for (let i = 0; i < 500; i++) buffer.record(entry(`Routine ${i}`, 'info', i));
        expect(buffer.read()).toContain('Unable to save');
        expect(buffer.read().split('\n').length).toBeLessThanOrEqual(160);
        expect(buffer.read().length).toBeLessThanOrEqual(64_000);
        time = 30 * 60_000 + 1;
        expect(buffer.read()).toBe('');
    });

    it('keeps only the latest repeated event and clears retained evidence', () => {
        const buffer = createFeedbackDiagnosticsBuffer();
        buffer.record(entry('Provider refused access', 'warn'));
        buffer.record(entry('Provider refused access', 'warn', 100));
        expect(buffer.read().split('\n')).toHaveLength(1);
        expect(JSON.parse(buffer.read()).ts).toBe(entry('', 'warn', 100).ts);
        buffer.clear();
        expect(buffer.read()).toBe('');
    });

    it('prioritizes the error over a noisy log tail and keeps complete JSON lines', () => {
        const error = JSON.stringify(entry('SYNC_FAILED', 'error'));
        const noisy = Array.from({ length: 500 }, (_, i) => JSON.stringify(entry(`Background ${i}`, 'info', i + 1)));
        const result = buildFeedbackDiagnostics([`partial old line\n${error}\n${noisy.join('\n')}`], snapshot, 500)!;
        expect(result.length).toBeLessThanOrEqual(500);
        const parsed = result.split('\n').map((line) => JSON.parse(line));
        expect(parsed.map((item) => item.message)).toContain('SYNC_FAILED');
        expect(parsed.at(-1).message).toBe('Feedback diagnostics snapshot');
    });

    it('deduplicates disk/session copies but preserves distinct failure details', () => {
        const a = { ...entry('Sync failed', 'error'), context: { reason: 'network' } };
        const b = { ...entry('Sync failed', 'error', 1), context: { reason: 'permission' } };
        const result = buildFeedbackDiagnostics([JSON.stringify(a), `${JSON.stringify(a)}\n${JSON.stringify(b)}`], snapshot)!;
        expect(result.split('\n')).toHaveLength(3);
    });

    it('bounds oversized entries without corrupting JSON', () => {
        const buffer = createFeedbackDiagnosticsBuffer();
        buffer.record(entry('Failure '.repeat(20_000), 'error'));
        const retained = JSON.parse(buffer.read());
        expect(retained.context.diagnosticTruncated).toBe('true');
        expect(buffer.read().length).toBeLessThan(8_000);
        expect(buildFeedbackDiagnostics([buffer.read()], snapshot, 1)).toBeNull();
    });

    it('passes every saved line through the log sanitizer and drops what is not a whole diagnostics line', () => {
        const saved = [
            '{"level":"info","scope":"sync","message":"rotated fragment"}',
            JSON.stringify({ ...entry('Saved task', 'warn'), context: { title: 'Private task title', count: '2' } }),
            JSON.stringify({ ...entry('Saved login', 'error'), context: { password: 'hunter2-secret', passphrase: 'correct horse battery' } }),
            'not json',
        ].join('\n');
        const lines = sanitizeSavedFeedbackLog(saved).split('\n').map((line) => JSON.parse(line));
        expect(lines.map((line) => line.message)).toEqual(['Saved task', 'Saved login']);
        for (const secret of ['Private task title', 'hunter2-secret', 'correct horse battery']) expect(JSON.stringify(lines)).not.toContain(secret);
        expect(lines[0].context).toEqual({ title: '[redacted]', count: '2' });
        expect(sanitizeSavedFeedbackLog(null)).toBe('');
    });
});
