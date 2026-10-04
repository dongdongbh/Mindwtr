import { beforeEach, describe, expect, it } from 'vitest';
import {
    buildDiagnosticsErrorEntry,
    buildDiagnosticsLogEntry,
    createDiagnosticsLog,
    DIAGNOSTICS_LOG_RELATIVE_PATH,
    diagnosticsEntryFromLogPayload,
    formatDiagnosticsLogLine,
    isDiagnosticsLoggingEnabled,
    LOG_ROTATION_CHECK_INTERVAL,
    MAX_LOG_FILE_BYTES,
    ROTATED_LOG_RETAIN_CHARS,
    type DiagnosticsLogEntry,
    type DiagnosticsLogFile,
} from './diagnostics-log';
import { addBreadcrumb, clearBreadcrumbs } from './log-breadcrumbs';

/** An in-memory log file; `append: false` leaves out append and size, as RN's legacy Expo file system has neither. */
const fakeFile = (options: { path?: string | null; append?: boolean } = {}) => {
    const path = options.path === undefined ? 'files/logs/mindwtr.log' : options.path;
    const state = { text: null as string | null, aside: null as string | null, calls: [] as string[] };
    const file: DiagnosticsLogFile = {
        path: async () => path,
        ensure: async () => {
            state.calls.push('ensure');
            if (!path) return null;
            state.text ??= '';
            return path;
        },
        exists: async () => state.text !== null,
        read: async () => {
            state.calls.push('read');
            if (state.text === null) throw new Error('missing');
            return state.text;
        },
        write: async (text) => {
            state.calls.push('write');
            state.text = text;
        },
        delete: async () => {
            state.calls.push('delete');
            if (state.text === null) return false;
            state.text = null;
            return true;
        },
        ...(options.append === false ? {} : {
            moveAside: async () => {
                state.calls.push('moveAside');
                state.aside = state.text;
                state.text = null;
            },
            append: async (line: string) => {
                state.calls.push('append');
                state.text = (state.text ?? '') + line;
                return true;
            },
            size: async () => new TextEncoder().encode(state.text ?? '').length,
        }),
    };
    return { file, state };
};

const entry = (message: string): DiagnosticsLogEntry => ({ ts: '2026-09-28T10:00:00.000Z', level: 'info', scope: 'test', message });

describe('diagnostics log', () => {
    let enabled = true;
    beforeEach(() => {
        enabled = true;
        clearBreadcrumbs();
    });

    it('keeps the log where React Native keeps it, with its size cap', () => {
        expect(DIAGNOSTICS_LOG_RELATIVE_PATH).toBe('logs/mindwtr.log');
        expect([MAX_LOG_FILE_BYTES, ROTATED_LOG_RETAIN_CHARS, LOG_ROTATION_CHECK_INTERVAL]).toEqual([500_000, 250_000, 50]);
    });

    it('writes a line only while debug logging is on, or when forced', async () => {
        const { file, state } = fakeFile();
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [file] });
        enabled = false;
        await expect(log.append(entry('off'))).resolves.toBeNull();
        expect(state.calls).toEqual([]);
        await expect(log.append(entry('forced'), { force: true })).resolves.toBe('files/logs/mindwtr.log');
        enabled = true;
        await expect(log.append(entry('on'))).resolves.toBe('files/logs/mindwtr.log');
        expect(state.text).toBe(`${JSON.stringify(entry('forced'))}\n${JSON.stringify(entry('on'))}\n`);
        expect(isDiagnosticsLoggingEnabled({ diagnostics: { loggingEnabled: true } })).toBe(true);
        expect(isDiagnosticsLoggingEnabled({ diagnostics: {} })).toBe(false);
        expect(isDiagnosticsLoggingEnabled(undefined)).toBe(false);
    });

    it('formats one JSON line per entry in React Native\'s key order', () => {
        const line = formatDiagnosticsLogLine({ ts: 't', level: 'error', scope: 's', message: 'm', stack: 'st', context: { a: '1' } });
        expect(line).toBe('{"ts":"t","level":"error","scope":"s","message":"m","stack":"st","context":{"a":"1"}}\n');
    });

    it('sanitizes messages, stacks, context and URLs', () => {
        addBreadcrumb('view:inbox');
        const info = buildDiagnosticsLogEntry('warn', 'Request failed token=private-secret', {
            extra: { password: 'hunter2', url: 'https://alex:pw@example.com/dav?token=abc', count: 3 },
        });
        expect(info).toMatchObject({ level: 'warn', scope: 'warn', context: { password: '[redacted]', count: '3' } });
        expect(JSON.stringify(info)).not.toMatch(/private-secret|hunter2|alex:pw|token=abc/);

        const error = new Error('Upload failed Authorization: Bearer abc.def.ghi');
        error.stack = 'Error: at upload (token=stack-secret)';
        const failed = buildDiagnosticsErrorEntry(error, { scope: 'sync', url: 'https://alex:pw@example.com/dav', extra: { step: 'upload' } });
        expect(failed).toMatchObject({ level: 'error', scope: 'sync', context: { step: 'upload' } });
        expect(failed.context?.breadcrumbs).toMatch(/:view:inbox$/);
        expect(failed.context?.url).toBeDefined();
        expect(JSON.stringify(failed)).not.toMatch(/abc\.def\.ghi|stack-secret|alex:pw/);
        // An info line never has a stack key; an error without one leaves it out of the JSON.
        expect(Object.keys(info)).toEqual(['ts', 'level', 'scope', 'message', 'context']);
        expect(formatDiagnosticsLogLine(buildDiagnosticsErrorEntry('plain', { scope: 'x' }))).not.toContain('"stack"');
    });

    it('turns a core logger payload into the line React Native\'s bridge writes', () => {
        const error = new TypeError('bad');
        const line = diagnosticsEntryFromLogPayload({ level: 'error', message: 'Save failed', category: 'storage', error, context: { table: 'tasks' } });
        expect(line).toMatchObject({ level: 'error', scope: 'core', message: 'Save failed',
            context: { table: 'tasks', category: 'storage', error: 'bad', errorName: 'TypeError' } });
        expect(line.context?.errorStack).toBeDefined();
        expect(diagnosticsEntryFromLogPayload({ level: 'info', message: 'Debug logging enabled', scope: 'diagnostics' }))
            .toEqual({ ts: expect.any(String), level: 'info', scope: 'diagnostics', message: 'Debug logging enabled', context: undefined });
    });

    it('trims the file to its last 250,000 characters once it passes 500,000 bytes', async () => {
        const { file, state } = fakeFile();
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [file] });
        await log.append(entry('first'));
        state.text = `${'x'.repeat(MAX_LOG_FILE_BYTES - 10)}\n`;
        await log.append(entry('over the cap'));
        expect(state.text.length).toBe(ROTATED_LOG_RETAIN_CHARS);
        expect(state.text.endsWith(`${JSON.stringify(entry('over the cap'))}\n`)).toBe(true);
        // Under the cap nothing is rewritten.
        state.calls.length = 0;
        await log.append(entry('small'));
        expect(state.calls).toEqual(['ensure', 'append']);
    });

    it('rewrites a file that cannot append, trimming by characters as React Native\'s fallback does', async () => {
        const { file, state } = fakeFile({ append: false });
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [file] });
        await log.append(entry('one'));
        expect(state.text).toBe(formatDiagnosticsLogLine(entry('one')));
        state.text = 'y'.repeat(MAX_LOG_FILE_BYTES);
        await log.append(entry('two'));
        expect(state.text.length).toBe(ROTATED_LOG_RETAIN_CHARS);
        expect(state.text.endsWith(formatDiagnosticsLogLine(entry('two')))).toBe(true);
    });

    it('never erases the log when the file cannot be read: the line is dropped instead', async () => {
        // RN's app-log.ts read '' after a failed read and rewrote the whole log as the one new line.
        const rewrite = fakeFile({ append: false });
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [rewrite.file] });
        await log.append(entry('kept'));
        rewrite.file.read = async () => { throw new Error('read failed'); };
        await expect(log.append(entry('dropped'))).resolves.toBeNull();
        expect(rewrite.state.text).toBe(formatDiagnosticsLogLine(entry('kept')));

        // And its trim after an append wrote '' (an empty log) when the read failed.
        const appending = fakeFile();
        const trimmed = createDiagnosticsLog({ isEnabled: () => enabled, files: [appending.file] });
        await trimmed.append(entry('first'));
        appending.state.text = 'z'.repeat(MAX_LOG_FILE_BYTES);
        appending.file.read = async () => { throw new Error('read failed'); };
        await trimmed.append(entry('second'));
        expect(appending.state.text).toBe(`${'z'.repeat(MAX_LOG_FILE_BYTES)}${formatDiagnosticsLogLine(entry('second'))}`);
    });

    it('keeps logging when a file over the cap cannot be read, and moves it aside past twice the cap', async () => {
        // A failed trim read used to stop the log for good: every later line returned null until Clear log.
        const { file, state } = fakeFile();
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [file] });
        const unreadable = 'u'.repeat(MAX_LOG_FILE_BYTES + 1);
        state.text = unreadable;
        file.read = async () => { throw new Error('not valid UTF-8'); };
        for (let i = 0; i < 5; i += 1) await expect(log.append(entry(`fresh ${i}`))).resolves.toBe('files/logs/mindwtr.log');
        expect(state.text.startsWith(unreadable)).toBe(true);
        expect(state.text.endsWith(formatDiagnosticsLogLine(entry('fresh 4')))).toBe(true);
        // Past twice the cap it is moved aside whole (nothing erased) and a new file starts; 60 lines cross a 50th write.
        const huge = 'u'.repeat(2 * MAX_LOG_FILE_BYTES + 1);
        state.text = huge;
        for (let i = 0; i < 60; i += 1) await expect(log.append(entry(`later ${i}`))).resolves.toBe('files/logs/mindwtr.log');
        expect(state.aside?.startsWith(huge)).toBe(true);
        expect(state.calls.filter((call) => call === 'moveAside')).toHaveLength(1);
        expect(state.text).toContain(JSON.stringify(entry('later 59')));
        expect(state.text.length).toBeLessThan(MAX_LOG_FILE_BYTES);
    });

    it('writes a line once when the trim after its append fails', async () => {
        // RN's app-log.ts caught that failure and wrote the line again through its legacy file (the same file on disk).
        const primary = fakeFile();
        const fallback = fakeFile({ path: 'legacy/logs/mindwtr.log', append: false });
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [primary.file, fallback.file] });
        await log.append(entry('first'));
        primary.state.text = `${'w'.repeat(MAX_LOG_FILE_BYTES)}\n`;
        primary.file.write = async () => { throw new Error('write failed'); };
        await expect(log.append(entry('once'))).resolves.toBe('files/logs/mindwtr.log');
        expect(primary.state.text.split(formatDiagnosticsLogLine(entry('once'))).length - 1).toBe(1);
        expect(fallback.state.text).toBeNull();
    });

    it('hands every operation to the next file when one is unavailable or fails', async () => {
        const missing = fakeFile({ path: null });
        const broken = fakeFile();
        broken.file.ensure = async () => { throw new Error('disk'); };
        broken.file.exists = async () => { throw new Error('disk'); };
        broken.file.delete = async () => { throw new Error('disk'); };
        const fallback = fakeFile({ path: 'legacy/logs/mindwtr.log', append: false });
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [missing.file, broken.file, fallback.file] });
        await expect(log.path()).resolves.toBe('files/logs/mindwtr.log');
        await expect(log.append(entry('kept'))).resolves.toBe('legacy/logs/mindwtr.log');
        await expect(log.ensurePath()).resolves.toBe('legacy/logs/mindwtr.log');
        await expect(log.read()).resolves.toBe(JSON.stringify(entry('kept')));
        await log.clear();
        expect(fallback.state.text).toBeNull();
        await expect(log.read()).resolves.toBeNull();
        const none = createDiagnosticsLog({ isEnabled: () => enabled, files: [missing.file] });
        await expect(none.append(entry('lost'))).resolves.toBeNull();
        await expect(none.ensurePath()).resolves.toBeNull();
    });

    it('runs writes, reads and clears one at a time, in the order they came', async () => {
        const { file, state } = fakeFile();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const append = file.append!;
        file.append = async (line) => {
            if (line.includes('slow')) await held;
            return append(line);
        };
        const log = createDiagnosticsLog({ isEnabled: () => enabled, files: [file] });
        const slow = log.append(entry('slow'));
        const fast = log.append(entry('fast'));
        const read = log.read();
        const cleared = log.clear();
        const after = log.append(entry('after'));
        await Promise.resolve();
        expect(state.text ?? '').toBe('');
        release();
        await expect(read).resolves.toBe(`${JSON.stringify(entry('slow'))}\n${JSON.stringify(entry('fast'))}`);
        await Promise.all([slow, fast, cleared, after]);
        expect(state.text).toBe(formatDiagnosticsLogLine(entry('after')));
        await expect(log.serialize(async () => 'queued')).resolves.toBe('queued');
    });
});

describe('diagnostics checked clear', () => {
    const strictFile = (options: Parameters<typeof fakeFile>[0] = {}) => {
        const fixture = fakeFile(options);
        fixture.file.isAbsent = async () => {
            fixture.state.calls.push('isAbsent');
            return fixture.state.text === null;
        };
        return fixture;
    };
    const logFor = (...files: DiagnosticsLogFile[]) => createDiagnosticsLog({ isEnabled: () => true, files });

    it('confirms an absent main without creating a directory or reading retained siblings', async () => {
        const { file, state } = strictFile();
        state.aside = 'retained unreadable bytes';
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'alreadyAbsent' });
        expect(state.calls).toEqual(['delete', 'isAbsent']);
        expect(state.aside).toBe('retained unreadable bytes');
    });

    it('confirms deletion without reading unreadable text or deleting retained siblings', async () => {
        const { file, state } = strictFile();
        state.text = 'unreadable main';
        state.aside = 'retained unreadable bytes';
        file.read = async () => { throw new Error('invalid UTF-8'); };
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'cleared' });
        expect(state.text).toBeNull();
        expect(state.aside).toBe('retained unreadable bytes');
        expect(state.calls).toEqual(['delete', 'isAbsent']);
    });

    it.each(['false', 'throw', 'true-with-present-target'] as const)('does not claim deletion when delete returns %s and the entry remains', async (answer) => {
        const { file, state } = strictFile();
        state.text = 'keep';
        file.delete = async () => {
            if (answer === 'throw') throw new Error('permission');
            return answer === 'true-with-present-target';
        };
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'unconfirmed' });
        expect(state.text).toBe('keep');
    });

    it('can prove final absence after deletion throws without claiming ownership of that deletion', async () => {
        const { file, state } = strictFile();
        state.text = 'before';
        file.delete = async () => { state.text = null; throw new Error('late failure'); };
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'alreadyAbsent' });
    });

    it('does not treat exists false for a directory as strict absence', async () => {
        const { file } = strictFile();
        file.exists = async () => false;
        file.isAbsent = async () => false;
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'unconfirmed' });
    });

    it('reports unavailable when every path is unavailable, including no adapters', async () => {
        const { file, state } = strictFile({ path: null });
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'unavailable' });
        await expect(logFor().clearChecked()).resolves.toEqual({ outcome: 'unavailable' });
        expect(state.calls).toEqual(['delete']);
    });

    it('leaves older adapters without a strict probe unconfirmed after deletion', async () => {
        const { file, state } = fakeFile();
        state.text = 'before';
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'unconfirmed' });
        expect(state.text).toBeNull();
    });

    it.each([1, 'true', {}])('requires literal true from a runtime probe, refusing truthy %j', async (answer) => {
        const { file, state } = strictFile();
        state.text = 'before';
        // JavaScript file ports can violate the declared return type; truthiness proves no absence.
        file.isAbsent = async () => answer as unknown as boolean;
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'unconfirmed' });
        expect(state.text).toBeNull();
    });

    it.each(['path', 'probe'] as const)('fails closed for an uncertain %s even after successful deletion', async (operation) => {
        const { file, state } = strictFile();
        state.text = 'before';
        if (operation === 'path') file.path = async () => { throw new Error('I/O'); };
        else file.isAbsent = async () => { throw new Error('permission'); };
        await expect(logFor(file).clearChecked()).resolves.toEqual({ outcome: 'unconfirmed' });
        expect(state.text).toBeNull();
    });

    it('keeps fallback deletion order when the primary is unavailable', async () => {
        const primary = strictFile({ path: null });
        const fallback = strictFile({ path: 'legacy/logs/mindwtr.log' });
        fallback.state.text = 'fallback';
        await expect(logFor(primary.file, fallback.file).clearChecked()).resolves.toEqual({ outcome: 'cleared' });
        expect(primary.state.calls).toEqual(['delete']);
        expect(fallback.state.calls).toEqual(['delete', 'isAbsent']);
    });

    it.each(['present', 'probe-error', 'path-error'] as const)('does not hide an unresolved %s primary behind a deleted fallback', async (failure) => {
        const primary = strictFile();
        const fallback = strictFile({ path: 'legacy/logs/mindwtr.log' });
        primary.state.text = 'primary';
        primary.file.delete = async () => false;
        if (failure === 'probe-error') primary.file.isAbsent = async () => { throw new Error('permission'); };
        if (failure === 'path-error') primary.file.path = async () => { throw new Error('I/O'); };
        fallback.state.text = 'fallback';
        await expect(logFor(primary.file, fallback.file).clearChecked()).resolves.toEqual({ outcome: 'unconfirmed' });
        expect(primary.state.text).toBe('primary');
        expect(fallback.state.text).toBeNull();
    });

    it.each([true, false])('stops deleting after the first success but still verifies the fallback (absent=%s)', async (absent) => {
        const first = strictFile();
        const fallback = strictFile({ path: 'legacy/logs/mindwtr.log' });
        first.state.text = 'first';
        fallback.state.text = absent ? null : 'retained distinct fallback';
        await expect(logFor(first.file, fallback.file).clearChecked()).resolves.toEqual({ outcome: absent ? 'cleared' : 'unconfirmed' });
        expect(fallback.state.calls).toEqual(['isAbsent']);
        expect(fallback.state.text).toBe(absent ? null : 'retained distinct fallback');
    });

    it('verifies aliases safely without a second deletion', async () => {
        const { file, state } = strictFile();
        state.text = 'before';
        await expect(logFor(file, file).clearChecked()).resolves.toEqual({ outcome: 'cleared' });
        expect(state.calls).toEqual(['delete', 'isAbsent', 'isAbsent']);
    });

    it('keeps append, deletion, strict verification and later append in one ordered queue', async () => {
        const { file, state } = strictFile();
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const entered = new Promise<void>((resolve) => { started = resolve; });
        const append = file.append!;
        file.append = async (line) => {
            if (line.includes('earlier')) { started(); await held; }
            return append(line);
        };
        const log = logFor(file);
        const before = log.append(entry('earlier'));
        const clear = log.clearChecked();
        const after = log.append(entry('later'));
        await entered;
        expect(state.calls).not.toContain('delete');
        release();
        await expect(clear).resolves.toEqual({ outcome: 'cleared' });
        await Promise.all([before, after]);
        expect(state.text).toBe(formatDiagnosticsLogLine(entry('later')));
        expect(state.calls).toEqual(['ensure', 'append', 'delete', 'isAbsent', 'ensure', 'append']);
    });

    it('does not poison later queue work when strict verification fails', async () => {
        const { file, state } = strictFile();
        file.isAbsent = async () => { throw new Error('permission'); };
        const log = logFor(file);
        await expect(log.clearChecked()).resolves.toEqual({ outcome: 'unconfirmed' });
        await expect(log.append(entry('after'))).resolves.toBe('files/logs/mindwtr.log');
        expect(state.text).toBe(formatDiagnosticsLogLine(entry('after')));
    });

    it('preserves old clear fallback behavior without paths, probes or new outcomes', async () => {
        const first = strictFile();
        const fallback = strictFile({ path: 'legacy/logs/mindwtr.log' });
        first.state.text = 'first';
        fallback.state.text = 'second';
        await expect(logFor(first.file, fallback.file).clear()).resolves.toBeUndefined();
        expect(first.state.calls).toEqual(['delete']);
        expect(fallback.state.calls).toEqual([]);
        expect(fallback.state.text).toBe('second');
    });
});
