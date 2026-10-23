import { describe, expect, it } from 'vitest';
import { sanitizeForLog, sanitizeLogContext, sanitizeUrl } from './log-sanitize';

describe('log sanitization', () => {
    it('redacts credentials in plain text', () => {
        expect(sanitizeForLog('Authorization: Bearer secret-token')).toContain('[redacted]');
        expect(sanitizeForLog('password=hunter2')).toContain('password=[redacted]');
    });

    it('redacts private content fields in structured context', () => {
        expect(sanitizeLogContext({
            title: 'Private task title',
            description: 'Very private note',
            projectId: 'project-123',
        })).toEqual({
            title: '[redacted]',
            description: '[redacted]',
            projectId: 'project-123',
        });
    });

    it('redacts ICS urls and query secrets', () => {
        expect(sanitizeUrl('webcal://example.com/calendar.ics')).toBe('[redacted-ics-url]');
        expect(sanitizeUrl('https://example.com/sync?token=secret&ok=1')).toBe('https://example.com/sync?token=redacted&ok=1');
    });

    // Made-up strings in the public shape of each provider's key. Never a real key.
    const FAKE_KEYS: Array<[string, string]> = [
        ['openai legacy', `sk-${'A'.repeat(48)}`],
        ['openai project', `sk-proj-${'Ab1_'.repeat(6)}-${'Cd2'.repeat(10)}`],
        ['anthropic', `sk-ant-api03-${'Ef3-'.repeat(5)}${'Gh4_'.repeat(10)}`],
        ['openrouter', `sk-or-v1-${'e'.repeat(64)}`],
        ['xai', `xai-${'C'.repeat(40)}`],
        ['groq', `gsk_${'D'.repeat(40)}`],
        ['gemini', `AIza${'B'.repeat(35)}`],
    ];

    it.each(FAKE_KEYS)('redacts a %s key in free text and in context values', (_name, key) => {
        const text = sanitizeForLog(`Request failed: 401 Incorrect API key provided: ${key}.`);
        expect(text).not.toContain(key.slice(-12));
        expect(text).toContain('[redacted]');
        const context = JSON.stringify(sanitizeLogContext({ detail: `bad ${key}` }));
        expect(context).not.toContain(key.slice(-12));
    });

    // The character to the left of a key in a log line is rarely a space: it is
    // an env-var name, a percent escape or an `=`. Only a LETTER before the
    // prefix means this is an ordinary word rather than a key.
    const KEY_CONTEXTS: Array<[string, (key: string) => string]> = [
        ['an env var name', (key) => `OPENAI_${key}`],
        ['a percent escape', (key) => `q=%20${key}`],
        ['an assignment', (key) => `key=${key}`],
        ['a digit', (key) => `attempt2${key}`],
        ['the start of the text', (key) => key],
    ];

    it.each(KEY_CONTEXTS)('redacts every key shape that follows %s', (_name, wrap) => {
        for (const [provider, key] of FAKE_KEYS) {
            const text = sanitizeForLog(wrap(key));
            expect(text, `free text after ${provider}`).not.toContain(key.slice(-12));
            const context = JSON.stringify(sanitizeLogContext({ detail: wrap(key) }));
            expect(context, `context value after ${provider}`).not.toContain(key.slice(-12));
        }
    });

    it('leaves ordinary words that contain "sk-" alone', () => {
        expect(sanitizeForLog('task-management-system and risk-assessment-notes'))
            .toBe('task-management-system and risk-assessment-notes');
        // Same words at the very start of the text, where `^` also applies.
        expect(sanitizeForLog('risk-assessment-notes only')).toBe('risk-assessment-notes only');
    });

    it('keeps the character before a redacted key', () => {
        expect(sanitizeForLog(`OPENAI_${FAKE_KEYS[0][1]}`)).toBe('OPENAI_[redacted]');
        expect(sanitizeForLog(`${FAKE_KEYS[0][1]} trailing`)).toBe('[redacted] trailing');
    });
});

describe('a URL the platform cannot parse', () => {
    // The sanitizer used to call itself on such a URL (sanitizeUrl's fallback redacted the text, whose URL pass called
    // sanitizeUrl again), so any log line or sync error holding one threw "Maximum call stack size exceeded".
    it.each(['http://nas.local:99999/dav', 'https://[bad/remote.php/dav', 'webcal://[bad/calendar.ics'])('redacts %s without throwing', (url) => {
        expect(() => sanitizeForLog(`Sync failed for ${url}`)).not.toThrow();
        expect(() => sanitizeUrl(url)).not.toThrow();
        expect(() => sanitizeLogContext({ url, detail: url })).not.toThrow();
    });

    it('still removes its credentials', () => {
        const text = sanitizeForLog('GET http://alice:hunter2@nas.local:99999/dav failed');
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain('alice');
        expect(sanitizeUrl('http://alice:hunter2@nas.local:99999/dav')).not.toContain('hunter2');
    });

    it('removes a password that holds "@" too (a URL splits its user part at the last "@")', () => {
        const text = sanitizeForLog('GET http://alice:p@ss@nas.local:99999/dav failed');
        expect(text).not.toContain('ss@');
        expect(text).toContain('http://nas.local:99999/dav');
    });

    it('still hides a calendar feed', () => {
        expect(sanitizeForLog('feed webcal://[bad/calendar.ics')).not.toContain('calendar.ics');
    });

    describe('local file and document URIs', () => {
        const fileUri = 'file:///storage/emulated/0/private-folder/data.json';
        const contentUri = 'content://com.android.externalstorage.documents/tree/primary%3Aprivate-folder/document/primary%3Aprivate-folder%2Fdata.json';

        it('are redacted to the end of their line, keeping the text before them and the next lines', () => {
            const text = sanitizeForLog(`EACCES: permission denied, open '${fileUri}'; Location '${contentUri}' isn't writable.\nnext line`);
            expect(text).not.toContain('private-folder');
            expect(text).toBe("EACCES: permission denied, open '[redacted-file-uri]\nnext line");
            expect(sanitizeForLog(`Location '${contentUri}' isn't writable.`)).toBe("Location '[redacted-content-uri]");
        });

        it('are redacted in an error\'s message and stack, and in context fields at any depth or under a url key', () => {
            const error = new Error(`open failed ${fileUri}`);
            error.stack = `Error: open failed ${fileUri}\n    at read (${contentUri})`;
            expect(sanitizeForLog(error)).not.toContain('private-folder');
            const context = sanitizeLogContext({ error: `bad ${contentUri}`, nested: { list: [fileUri] }, syncUrl: fileUri, url: contentUri });
            expect(JSON.stringify(context)).not.toContain('private-folder');
            expect(sanitizeUrl(fileUri)).toBe('[redacted-file-uri]');
        });

        it('take apostrophes, parentheses and spaces with the rest of the line, in any letter case, with one slash, and after a word character', () => {
            const dads = "content://com.android.externalstorage.documents/tree/primary%3ADad's%20Notes/document/primary%3ADad's%20Notes%2Fdata.json";
            const paren = 'content://com.android.externalstorage.documents/tree/primary%3AMindwtr%20(sync)/document/primary%3AMindwtr%20(sync)%2Fdata.json';
            expect(sanitizeForLog(`Location '${dads}' isn't writable.`)).not.toContain('Notes');
            expect(sanitizeForLog(`Location '${paren}' isn't writable.`)).not.toContain('sync)');
            expect(sanitizeForLog("open 'file:///storage/emulated/0/My Folder (2)/data.json' failed")).not.toMatch(/Folder|data\.json/);
            expect(sanitizeForLog('CONTENT://com.example/tree/Private%20Name')).not.toContain('Private');
            // Outside the plain-path roots, so only the one-slash file: rule can catch it.
            expect(sanitizeForLog('java.io.File file:/tmp/private-folder/x y')).toBe('java.io.File [redacted-file-uri]');
            expect(sanitizeForLog('{"error":"\\nfile:///tmp/private-folder/x"}')).not.toContain('private-folder');
        });

        it('redact plain paths under the mobile roots to the end of their line, and keep desktop OS paths outside them', () => {
            const ios = "Calling the 'writeAsStringAsync' function has failed -> File '/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/Dad's Notes/data.json.tmp' is not writable";
            expect(sanitizeForLog(ios)).toBe("Calling the 'writeAsStringAsync' function has failed -> File '[redacted-path]");
            expect(sanitizeForLog("File '/storage/emulated/0/Students' Notes/data.json' is not writable")).toBe("File '[redacted-path]");
            expect(sanitizeForLog('/storage/emulated/0/Mindwtr Sync/data.json: open failed: EACCES (Permission denied)')).toBe('[redacted-path]');
            for (const root of ['/var/mobile/x/private-folder', '/sdcard/private-folder', '/data/user/0/app/private-folder', '/data/data/app/private-folder',
                '/storage/1A2B-3C4D/private-folder', '/storage/self/primary/private-folder']) {
                expect(sanitizeForLog(`at ${root} end\nnext`)).toBe('at [redacted-path]\nnext');
            }
            expect(sanitizeForLog('desktop data folder /home/alex/.local/share/mindwtr/data.json')).toContain('/home/alex/.local/share/mindwtr/data.json');
        });

        it('sanitize a 1 MB line of repeated quoted starts in linear time', () => {
            for (const unit of ["'file:/a'b", '"/sdcard/x"y', "'content://a'b "]) {
                const line = unit.repeat(Math.ceil((1 << 20) / unit.length));
                const started = performance.now();
                const text = sanitizeForLog(line);
                expect(performance.now() - started).toBeLessThan(1_000);
                expect(text.length).toBeLessThan(64);
            }
        });

        it('leave web addresses alone', () => {
            expect(sanitizeForLog('GET https://dav.example.com/mindwtr/data.json 412')).toBe('GET https://dav.example.com/mindwtr/data.json 412');
        });
    });
});
