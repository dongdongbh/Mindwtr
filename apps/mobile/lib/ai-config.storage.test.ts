import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAIConfig, buildCopilotConfig, loadAIKey, saveAIKey } from './ai-config';
import { __resetSecureSecretStoreForTests } from './secure-secret-store';

const logInfoMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('./app-log', () => ({ logInfo: logInfoMock }));

const storeMocks = vi.hoisted(() => ({
    secureAvailable: true,
    availabilityFailuresRemaining: 0,
    secureItems: new Map<string, string>(),
    asyncItems: new Map<string, string>(),
    isAvailableAsync: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
    getItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
    isAvailableAsync: storeMocks.isAvailableAsync.mockImplementation(async () => {
        if (storeMocks.availabilityFailuresRemaining > 0) {
            storeMocks.availabilityFailuresRemaining -= 1;
            throw new Error('keystore probe failed');
        }
        return storeMocks.secureAvailable;
    }),
    getItemAsync: storeMocks.getItemAsync.mockImplementation(
        async (key: string) => storeMocks.secureItems.get(key) ?? null,
    ),
    setItemAsync: storeMocks.setItemAsync.mockImplementation(async (key: string, value: string) => {
        storeMocks.secureItems.set(key, value);
    }),
    deleteItemAsync: storeMocks.deleteItemAsync.mockImplementation(async (key: string) => {
        storeMocks.secureItems.delete(key);
    }),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: storeMocks.getItem.mockImplementation(
            async (key: string) => storeMocks.asyncItems.get(key) ?? null,
        ),
        setItem: storeMocks.setItem.mockImplementation(async (key: string, value: string) => {
            storeMocks.asyncItems.set(key, value);
        }),
        removeItem: storeMocks.removeItem.mockImplementation(async (key: string) => {
            storeMocks.asyncItems.delete(key);
        }),
    },
}));

describe('AI credential storage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        logInfoMock.mockReset().mockResolvedValue(null);
        __resetSecureSecretStoreForTests();
        storeMocks.secureAvailable = true;
        storeMocks.availabilityFailuresRemaining = 0;
        storeMocks.secureItems.clear();
        storeMocks.asyncItems.clear();
    });

    it.each([buildAIConfig, buildCopilotConfig])('adds safe cancellation diagnostics to assistant and Copilot config', (buildConfig) => {
        const config = buildConfig({ ai: {
            provider: 'openai',
            baseUrl: 'http://localhost:11434/v1',
            model: 'private-model',
            requestTimeoutSeconds: 120,
        } }, 'private-credential');
        expect(config.timeoutMs).toBe(120_000);
        expect(logInfoMock).not.toHaveBeenCalled();
        config.onRequestStop?.('aborted');
        expect(logInfoMock).toHaveBeenCalledExactlyOnceWith('AI request stopped without retry', {
            scope: 'ai',
            extra: {
                releaseCheck: 'v1.3.0/ai-request-stop-once',
                outcome: 'aborted',
                provider: 'openai',
                timeoutMs: 120_000,
            },
        });
    });

    it('does not surface a diagnostics backend failure after cancellation', async () => {
        logInfoMock.mockRejectedValueOnce(new Error('diagnostics unavailable'));
        const config = buildAIConfig({ ai: { provider: 'openai' } }, '');
        expect(() => config.onRequestStop?.('aborted')).not.toThrow();
        await Promise.resolve();
    });

    it('migrates a legacy plaintext key into secure storage on read', async () => {
        storeMocks.asyncItems.set('mindwtr-ai-key:openai', 'legacy-ai-key');

        await expect(loadAIKey('openai')).resolves.toBe('legacy-ai-key');

        expect(storeMocks.secureItems.get('mindwtr-ai-key_openai')).toBe('legacy-ai-key');
        expect(storeMocks.asyncItems.has('mindwtr-ai-key:openai')).toBe(false);
    });

    it('retries a transient availability failure without writing plaintext', async () => {
        storeMocks.availabilityFailuresRemaining = 1;

        await expect(saveAIKey('openai', 'fresh-ai-key')).rejects.toThrow('keystore probe failed');
        expect(storeMocks.setItem).not.toHaveBeenCalled();

        await expect(saveAIKey('openai', 'fresh-ai-key')).resolves.toBeUndefined();
        expect(storeMocks.isAvailableAsync).toHaveBeenCalledTimes(2);
        expect(storeMocks.secureItems.get('mindwtr-ai-key_openai')).toBe('fresh-ai-key');
    });

    it('keeps a new key in memory only when secure storage is unsupported', async () => {
        storeMocks.secureAvailable = false;

        await saveAIKey('openai', 'session-ai-key');

        expect(storeMocks.setItem).not.toHaveBeenCalled();
        expect(storeMocks.secureItems.has('mindwtr-ai-key_openai')).toBe(false);
        await expect(loadAIKey('openai')).resolves.toBe('session-ai-key');
    });

    it('evacuates a legacy plaintext key into memory when secure storage is unsupported', async () => {
        storeMocks.secureAvailable = false;
        storeMocks.asyncItems.set('mindwtr-ai-key:openai', 'legacy-session-ai-key');

        await expect(loadAIKey('openai')).resolves.toBe('legacy-session-ai-key');
        expect(storeMocks.asyncItems.has('mindwtr-ai-key:openai')).toBe(false);
        await expect(loadAIKey('openai')).resolves.toBe('legacy-session-ai-key');
    });
});
