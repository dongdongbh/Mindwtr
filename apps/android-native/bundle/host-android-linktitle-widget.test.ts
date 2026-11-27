import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const slice = (from: string, to: string) => {
    const start = entry.indexOf(from);
    const end = entry.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error(`host-entry slice ${from.trim()} unavailable`);
    return entry.slice(start, end);
};
const transpile = (code: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(code);

const portOf = (methods: string, state: Record<string, unknown>) => {
    const context = { submit: (work: () => Promise<unknown>) => work(), requireSaved: () => undefined, unwrap: (value: unknown) => value, ...state } as Record<string, unknown>;
    vm.runInNewContext(transpile(`globalThis.port = {${methods}};`), context);
    return context.port as Record<string, (...args: unknown[]) => Promise<unknown>>;
};

describe('native Android Today widget filter hold', () => {
    const focusPort = () => {
        const pushed: unknown[] = [];
        const reads: unknown[] = [];
        const port = portOf(`${slice('    focus(limit: number, ', '    focusWindow(')}`, {
            contract: { getFocus: (input: { controls?: { savedFilterId?: string } }) => {
                reads.push(input);
                return { controls: { widgetFilter: { criteria: { contexts: [input.controls?.savedFilterId ?? 'main'] } } } };
            } },
            cacheIOSFocusWidgetFilter: () => undefined,
            widgets: { focusFilter: (filter: unknown) => pushed.push(filter) },
            todayWidgetFilterHeld: false,
        });
        return { port, pushed, reads };
    };

    it('keeps a saved list opened from a widget out of the Today widget until the main controls return', async () => {
        const { port, pushed, reads } = focusPort();
        await port.focus(50, '{}');
        expect(pushed).toEqual([{ criteria: { contexts: ['main'] } }]);

        await port.focus(50, '{}', JSON.stringify({ type: 'applySavedFilter', id: 'errands', todayWidgetFilter: 'hold' }));
        await port.focus(50, '{"savedFilterId":"errands"}');
        await port.focus(1, '{"savedFilterId":"errands"}', '{"type":"sort","sortBy":"title"}');
        expect(pushed).toHaveLength(1);
        expect(reads[1]).toEqual({ limit: 50, controls: {}, controlEdit: { type: 'applySavedFilter', id: 'errands' } });

        await port.focus(50, '{"savedFilterId":"home"}', '{"todayWidgetFilter":"release"}');
        expect(reads[4]).toEqual({ limit: 50, controls: { savedFilterId: 'home' } });
        expect(pushed).toEqual([{ criteria: { contexts: ['main'] } }, { criteria: { contexts: ['home'] } }]);
    });
});

describe('native Android captured link titles', () => {
    const capturePort = () => {
        const enriched: unknown[] = [];
        const saved = (taskId: string) => async () => ({ kind: 'saved', taskId });
        const port = portOf(`${slice('    captureSubmit(json: string)', '    capturePrepare(')}${slice('    captureCommit(json: string)', '    captureLinesPrepare(')}`
            + `${slice('    captureModalSubmit(json: string)', '    captureModalLines(')}${slice('    ingest(requestId: string)', '    ingestAudio(')}`, {
            taskResult: (_operation: string, result: unknown) => result,
            contract: {
                submitQuickCapture: saved('quick'),
                commitPreparedQuickCapture: saved('copilot'),
                submitCaptureModal: saved('modal'),
                ingestPendingCaptures: async (input: { onTextCaptureSaved: (id: string, text: string) => void }) => {
                    input.onTextCaptureSaved('shared', 'https://example.org/shared');
                    return { ingested: 1 };
                },
            },
            enrichAndroidCaptureTitle: (...args: unknown[]) => enriched.push(args),
            pendingCaptureQueue: {}, lastAppliedRecord: {},
        });
        return { port, enriched };
    };

    it('starts the title lookup after each single capture save and each queued share', async () => {
        const { port, enriched } = capturePort();
        await port.captureSubmit(JSON.stringify({ text: 'https://example.org/quick' }));
        await port.captureCommit(JSON.stringify({ request: { capture: { text: 'https://example.org/copilot' } } }));
        await port.captureCommit(JSON.stringify({ request: { text: 'https://example.org/prepared' } }));
        await port.captureModalSubmit(JSON.stringify({ draft: { text: 'https://example.org/modal' } }));
        await port.ingest('request');
        expect(enriched).toEqual([
            ['quick', 'https://example.org/quick'],
            ['copilot', 'https://example.org/copilot'],
            ['copilot', 'https://example.org/prepared'],
            ['modal', 'https://example.org/modal'],
            ['shared', 'https://example.org/shared'],
        ]);
    });

    it('leaves the URL title alone when the save opens the editor, so a late title never makes the edit stale', async () => {
        const { port, enriched } = capturePort();
        await port.captureSubmit(JSON.stringify({ text: 'https://example.org/quick', openAfterSave: true }));
        await port.captureCommit(JSON.stringify({ request: { capture: { text: 'https://example.org/copilot', openAfterSave: true } } }));
        await port.captureCommit(JSON.stringify({ request: { text: 'https://example.org/prepared', openAfterSave: true } }));
        await port.captureModalSubmit(JSON.stringify({ draft: { text: 'https://example.org/modal' }, openAfterSave: true }));
        expect(enriched).toEqual([]);
    });

    it('offers the Look up page titles row only to native Android', () => {
        const reads = slice('const MENU_READS: Record<string, (input: never) => Reply> = {', '\n};\n');
        const general = reads.slice(reads.indexOf('    generalSettings: '), reads.indexOf('    gtdSettings: '));
        const run = (platform: string) => {
            const inputs: unknown[] = [];
            const context = { globalThis: { __mindwtrHostPlatform: platform }, nativeAppSearch: null,
                contract: { getGeneralSettings: (input: unknown) => inputs.push(input) } } as Record<string, unknown>;
            vm.runInNewContext(transpile(`globalThis.reads = {${general}};`), context);
            (context.globalThis as { reads: { generalSettings: (input: unknown) => void } }).reads.generalSettings({ deviceTheme: 'dark' });
            return inputs[0];
        };
        expect(run('android')).toEqual({ deviceTheme: 'dark', fetchLinkTitlesRow: true });
        expect(run('ios')).toEqual({ deviceTheme: 'dark' });
    });

    it('settles draft attachments before looking up titles for new bare links', async () => {
        const order: string[] = [];
        const requests = slice('const ATTACHMENT_REQUESTS: Record<string, (input: never) => Promise<Reply>> = {', '\n};\n');
        const settle = requests.slice(requests.indexOf('    settleTaskDraftAttachments: '), requests.indexOf('    prepareSharedFiles: '));
        const context = {
            contract: { settleTaskDraftAttachments: async () => { order.push('settle'); return { ok: true, value: { deleted: 0 } }; } },
            enrichAndroidEditorLinkTitles: (input: { taskId: string }) => order.push(`titles:${input.taskId}`),
        } as Record<string, unknown>;
        vm.runInNewContext(transpile(`globalThis.requests = {${settle}};`), context);
        const run = (context.requests as { settleTaskDraftAttachments: (input: unknown) => Promise<unknown> }).settleTaskDraftAttachments;
        expect(await run({ taskId: 't' })).toEqual({ ok: true, value: { deleted: 0 } });
        expect(order).toEqual(['settle', 'titles:t']);
    });
});
