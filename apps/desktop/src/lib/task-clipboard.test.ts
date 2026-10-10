import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyTaskTitles } from './task-clipboard';

const mocks = vi.hoisted(() => ({
    info: vi.fn(), warn: vi.fn(), toast: vi.fn(), write: vi.fn(),
}));
vi.mock('./app-log', () => ({ logInfo: mocks.info, logWarn: mocks.warn }));
vi.mock('../store/ui-store', () => ({ useUiStore: { getState: () => ({ showToast: mocks.toast }) } }));

const t = (key: string) => key;
const tasks = [{ title: 'Private task', description: 'Private description' }];

describe('task clipboard diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        mocks.info.mockResolvedValue(null);
        mocks.warn.mockResolvedValue(null);
        mocks.write.mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText: mocks.write }, userActivation: { isActive: true } });
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    });

    it('copies titles and reports the menu outcome without task content', async () => {
        await copyTaskTitles(tasks, t, false, 'menu');
        expect(mocks.write).toHaveBeenCalledExactlyOnceWith('Private task');
        expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('Title copied', 'success');
        expect(mocks.info).toHaveBeenCalledExactlyOnceWith('Task clipboard write completed', {
            scope: 'clipboard',
            extra: { releaseCheck: 'v1.3.5/task-copy-diagnostics', source: 'menu', outcome: 'copied',
                documentFocused: true, activationSupported: true, activationActive: true, clipboardAvailable: true },
        });
        expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('Private');
    });

    it('preserves descriptions and multi-title formatting for shortcuts', async () => {
        await copyTaskTitles([...tasks, { title: 'Second', description: '  ' }], t, true);
        expect(mocks.write).toHaveBeenCalledExactlyOnceWith('Private task\n\nPrivate description\nSecond');
        expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('Task copied to clipboard', 'success');
        expect(mocks.info.mock.calls[0][1].extra.source).toBe('shortcut');
    });

    it('does nothing for empty input', async () => {
        await copyTaskTitles([], t);
        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.toast).not.toHaveBeenCalled();
        expect(mocks.info).not.toHaveBeenCalled();
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    it.each([
        [new DOMException('Private task https://name:credential@example.com', 'NotAllowedError'), 'NotAllowedError'],
        [new Error('Private task https://name:credential@example.com'), 'other'],
        [Object.assign(new Error('Private task'), { name: 'Private exception name' }), 'other'],
        ['Private task', 'other'],
    ])('reports only a bounded failure category', async (error, errorKind) => {
        mocks.write.mockRejectedValueOnce(error);
        await copyTaskTitles(tasks, t, false, 'menu');
        expect(mocks.info).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('Task clipboard write failed', {
            scope: 'clipboard',
            extra: { releaseCheck: 'v1.3.5/task-copy-diagnostics', source: 'menu', outcome: 'failed',
                documentFocused: true, activationSupported: true, activationActive: true, clipboardAvailable: true, errorKind },
        });
        expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('Could not copy task', 'error');
        expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/Private|credential|example\.com/);
    });

    it('records missing clipboard and activation APIs without throwing', async () => {
        vi.stubGlobal('navigator', {});
        await copyTaskTitles(tasks, t);
        expect(mocks.warn.mock.calls[0][1].extra).toMatchObject({
            clipboardAvailable: false, activationSupported: false, activationActive: null, errorKind: 'unavailable',
        });
        expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('Could not copy task', 'error');
    });

    it('captures focus and activation before a pending write settles', async () => {
        let rejectWrite!: (reason: unknown) => void;
        mocks.write.mockReturnValueOnce(new Promise((_, reject) => { rejectWrite = reject; }));
        const result = copyTaskTitles(tasks, t);
        expect(mocks.write).toHaveBeenCalledOnce();
        expect(mocks.info).not.toHaveBeenCalled();
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(mocks.toast).not.toHaveBeenCalled();
        vi.mocked(document.hasFocus).mockReturnValue(false);
        vi.stubGlobal('navigator', { clipboard: { writeText: mocks.write }, userActivation: { isActive: false } });
        rejectWrite(new DOMException('denied', 'NotAllowedError'));
        await result;
        expect(mocks.warn.mock.calls[0][1].extra).toMatchObject({ documentFocused: true, activationActive: true });
    });

    it('does not turn a logging rejection into a copy failure', async () => {
        mocks.info.mockRejectedValueOnce(new Error('Log unavailable'));
        await copyTaskTitles(tasks, t);
        expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('Title copied', 'success');
        expect(mocks.warn).not.toHaveBeenCalled();
    });
});
