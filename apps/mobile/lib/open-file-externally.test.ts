import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    platformOS: 'android' as string,
    startActivityAsync: vi.fn(),
    getContentUriAsync: vi.fn(async (uri: string) => `content://mindwtr/${uri.split('/').pop()}`),
}));

vi.mock('react-native', () => ({
    Platform: { get OS() { return mocked.platformOS; } },
}));

vi.mock('expo-intent-launcher', () => ({
    startActivityAsync: mocked.startActivityAsync,
}));

vi.mock('./file-system', () => ({
    getContentUriAsync: mocked.getContentUriAsync,
}));

import { tryOpenWithAndroidViewer, __openFileExternallyTestUtils } from './open-file-externally';

beforeEach(() => {
    mocked.platformOS = 'android';
    mocked.startActivityAsync.mockReset();
    mocked.startActivityAsync.mockResolvedValue({ resultCode: 0 });
    mocked.getContentUriAsync.mockClear();
});

describe('tryOpenWithAndroidViewer', () => {
    it('fires ACTION_VIEW with a granted content URI and the stored mime type', async () => {
        const handled = await tryOpenWithAndroidViewer('file:///attachments/report.pdf', 'application/pdf');
        expect(handled).toBe(true);
        expect(mocked.startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', {
            data: 'content://mindwtr/report.pdf',
            flags: 1,
            type: 'application/pdf',
        });
    });

    it('falls back to the extension when the attachment carries no mime type', async () => {
        await tryOpenWithAndroidViewer('file:///attachments/report.pdf', undefined);
        expect(mocked.startActivityAsync).toHaveBeenCalledWith(
            'android.intent.action.VIEW',
            expect.objectContaining({ type: 'application/pdf' }),
        );
    });

    it('returns false when no viewer accepts the intent, so the caller can share instead', async () => {
        mocked.startActivityAsync.mockRejectedValue(new Error('No Activity found to handle Intent'));
        expect(await tryOpenWithAndroidViewer('file:///a/report.pdf', 'application/pdf')).toBe(false);
    });

    it('is a no-op off Android', async () => {
        mocked.platformOS = 'ios';
        expect(await tryOpenWithAndroidViewer('file:///a/report.pdf', 'application/pdf')).toBe(false);
        expect(mocked.startActivityAsync).not.toHaveBeenCalled();
    });
});

describe('resolveViewMimeType', () => {
    const { resolveViewMimeType } = __openFileExternallyTestUtils;

    it('prefers the stored mime type and ignores query strings on the fallback path', () => {
        expect(resolveViewMimeType('file:///a/x.pdf', 'text/plain')).toBe('text/plain');
        expect(resolveViewMimeType('file:///a/x.PDF?version=2')).toBe('application/pdf');
        expect(resolveViewMimeType('file:///a/unknown.xyz')).toBe('*/*');
    });
});
