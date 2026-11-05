import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { loadQuickCaptureFixture, seedQuickCaptureStore } from './quick-capture-model.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { readNativeCaptureCopilotApplied, readNativeCaptureCopilotEdit, readNativeCaptureCopilotSuggestion } from './native-capture-copilot';

const fixture = loadQuickCaptureFixture();
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
async function open() {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(fixture.now));
    await seedQuickCaptureStore(fixture, { settings: 'base' });
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    const settings = useTaskStore.getState().settings;
    useTaskStore.setState({ settings: { ...settings, ai: { enabled: true }, taxonomy: {
        contexts: [{ token: '@unused', updatedAt: fixture.now, rev: 1, revBy: 'device' }],
        tags: [{ token: '#unused', updatedAt: fixture.now, rev: 1, revBy: 'device' }, { token: '#deleted', deletedAt: fixture.now, updatedAt: fixture.now, rev: 1, revBy: 'device' }],
    } } });
    return { host, options: value(host.openQuickCapture()).options };
}
afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('native capture copilot projection and explicit Apply', () => {
    it('offers bounded used-plus-saved choices and sends the planned title without note text', async () => {
        const { host, options } = await open();
        const result = value(host.getCaptureCopilotOptions({ text: 'Call the bank /note:private parsed note',
            options: { ...options, note: 'Private More note' }, applied: { tags: [] }, aiKey: { required: false, available: false } }));
        expect(result.request?.title).toBe('Call the bank');
        expect(result.request?.contexts).toContain('@unused');
        expect(result.request?.tags).toContain('#unused');
        expect(result.request?.tags).not.toContain('#deleted');
        expect(JSON.stringify(result)).not.toContain('private parsed note');
        expect(JSON.stringify(result)).not.toContain('Private More note');
        expect(Object.keys(result).sort()).toEqual(['applied', 'labels', 'request', 'revision']);
        const legacy = value(host.getQuickCaptureView({ text: 'Call the bank', options }));
        expect(legacy).not.toHaveProperty('copilot');
        expect(Object.keys(legacy.options).sort()).toEqual(Object.keys(options).sort());
    });

    it('keeps ordinary capture available when disabled, missing a required key, too short or multiline', async () => {
        const { host, options } = await open();
        const input = { text: 'Call bank', options, applied: { tags: [] }, aiKey: { required: true, available: false } };
        expect(value(host.getCaptureCopilotOptions(input)).request).toBeNull();
        expect(value(host.getCaptureCopilotOptions({ ...input, text: 'abc', aiKey: { required: false, available: false } })).request).toBeNull();
        const multi = value(host.getCaptureCopilotOptions({ ...input, text: 'One\nTwo', applied: { context: '@phone', tags: ['#work'] } }));
        expect(multi).toMatchObject({ request: null, applied: { tags: [] } });
        useTaskStore.setState((state) => ({ settings: { ...state.settings, ai: { enabled: false } } }));
        expect(value(host.getCaptureCopilotOptions({ ...input, aiKey: { required: false, available: false } })).request).toBeNull();
        expect(host.getQuickCaptureView({ text: input.text, options })).toMatchObject({ ok: true });
    });

    it('projects exact chip edits, applies only offered parts, and changes no stored task', async () => {
        const { host, options } = await open();
        const text = 'Call the bank';
        const question = value(host.getCaptureCopilotOptions({ text, options, applied: { tags: [] }, aiKey: { required: false, available: false } }));
        const before = structuredClone(useTaskStore.getState()._allTasks);
        const input = { text, options, revision: question.revision, suggestion: {
            language: 'en', context: '@phone', tags: ['#finance'], timeEstimate: '15min' as const }, applied: { tags: [] }, edit: null };
        const offered = value(host.editCaptureCopilot(input));
        expect(offered.chips.map((chip) => chip.label)).toEqual(['@phone', '15min', '#finance']);
        expect(offered.applyAll).not.toBeNull();
        const applied = value(host.editCaptureCopilot({ ...input, edit: offered.applyAll!.edit }));
        expect(applied).toMatchObject({ chips: [], applyAll: null,
            applied: { context: '@phone', tags: ['#finance'], timeEstimate: '15min' } });
        expect(applied.appliedLabel).toContain('@phone');
        expect(host.editCaptureCopilot({ ...input, edit: { type: 'apply', parts: [{ kind: 'tag', value: '#not-offered' }] } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState()._allTasks).toEqual(before);
    });

    it('rejects stale title/options/language revisions and hides estimates while the feature is off', async () => {
        const { host, options } = await open();
        const text = 'Call the bank';
        const question = value(host.getCaptureCopilotOptions({ text, options, applied: { tags: [] }, aiKey: { required: false, available: false } }));
        const input = { text, options, revision: question.revision, suggestion: { language: 'en', timeEstimate: '15min' as const }, applied: { tags: [] }, edit: null };
        expect(host.editCaptureCopilot({ ...input, text: 'Changed task title' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.editCaptureCopilot({ ...input, options: { ...options, note: 'Changed note' } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        value(await host.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' }));
        expect(host.editCaptureCopilot(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState((state) => ({ settings: { ...state.settings, features: { ...state.settings.features, timeEstimates: false } } }));
        const fresh = value(host.getCaptureCopilotOptions({ text, options, applied: { tags: [] }, aiKey: { required: false, available: false } }));
        expect(value(host.editCaptureCopilot({ ...input, revision: fresh.revision })).chips).toEqual([]);
        expect(value(host.editCaptureCopilot({ ...input, text: 'One\nTwo', applied: { context: '@phone', tags: ['#work'] } })))
            .toEqual({ suggestion: null, applied: { tags: [] }, chips: [], applyAll: null, appliedLabel: null });
    });

    it('rejects unsupported model fields/estimates, duplicate tokens and forged part kinds', () => {
        expect(readNativeCaptureCopilotSuggestion({ language: 'en', timeEstimate: 'tomorrow' })).toBeUndefined();
        expect(readNativeCaptureCopilotSuggestion({ language: 'en', tags: ['#same', '#same'] })).toBeUndefined();
        expect(readNativeCaptureCopilotSuggestion({ language: 'en', instruction: 'run a command' })).toBeUndefined();
        expect(readNativeCaptureCopilotApplied({ tags: [], extra: true })).toBeNull();
        expect(readNativeCaptureCopilotEdit({ type: 'apply', parts: [{ kind: 'status', value: 'done' }] })).toBeUndefined();
        expect(readNativeCaptureCopilotSuggestion({ language: 'en', context: '@phone\n/due:today' })).toBeUndefined();
    });
});
