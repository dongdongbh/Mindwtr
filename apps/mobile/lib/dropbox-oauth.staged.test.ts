import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizeDropbox } from './dropbox-oauth';

const mocks = vi.hoisted(() => ({
    exchangeCodeAsync: vi.fn(),
    makeRedirectUri: vi.fn(() => 'mindwtr://redirect'),
    maybeCompleteAuthSession: vi.fn(),
    promptAsync: vi.fn(),
    saveDropboxTokens: vi.fn(),
}));

vi.mock('expo-auth-session', () => ({
    AuthRequest: class {
        codeVerifier = 'pkce-verifier';

        promptAsync = mocks.promptAsync;
    },
    ResponseType: { Code: 'code' },
    exchangeCodeAsync: mocks.exchangeCodeAsync,
    makeRedirectUri: mocks.makeRedirectUri,
}));

vi.mock('expo-web-browser', () => ({
    maybeCompleteAuthSession: mocks.maybeCompleteAuthSession,
}));


vi.mock('./dropbox-auth', () => ({
    saveDropboxTokens: mocks.saveDropboxTokens,
}));

describe('authorizeDropbox', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.promptAsync.mockResolvedValue({
            type: 'success',
            params: { code: 'authorization-code' },
        });
        mocks.exchangeCodeAsync.mockResolvedValue({
            accessToken: 'candidate-access',
            refreshToken: 'candidate-refresh',
            expiresIn: 14_400,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns the OAuth bundle without promoting it to durable storage', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

        await expect(authorizeDropbox('dropbox-app-key')).resolves.toEqual({
            accessToken: 'candidate-access',
            refreshToken: 'candidate-refresh',
            expiresAt: 15_400_000,
        });
        expect(mocks.saveDropboxTokens).not.toHaveBeenCalled();
    });
});
