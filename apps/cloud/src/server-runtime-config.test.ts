import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { startCloudServer } from './server';
import {
    CLOUD_NUMERIC_ENVIRONMENT_KEYS,
    resolveCloudRuntimeConfig,
} from './server-runtime-config';

describe('resolveCloudRuntimeConfig', () => {
    const numericEnvironmentKeys = [
        'PORT',
        'MINDWTR_CLOUD_RATE_WINDOW_MS',
        'MINDWTR_CLOUD_RATE_MAX',
        'MINDWTR_CLOUD_ATTACHMENT_RATE_MAX',
        'MINDWTR_CLOUD_MAX_BODY_BYTES',
        'MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES',
        'MINDWTR_CLOUD_ANY_TOKEN_MAX_NAMESPACES',
        'MINDWTR_CLOUD_RATE_CLEANUP_MS',
        'MINDWTR_CLOUD_REQUEST_TIMEOUT_MS',
        'MINDWTR_CLOUD_SLOW_REQUEST_MS',
        'MINDWTR_CLOUD_MAX_TASK_TITLE_LENGTH',
        'MINDWTR_CLOUD_MAX_TASK_QUICK_ADD_LENGTH',
        'MINDWTR_CLOUD_MAX_AREA_NAME_LENGTH',
        'MINDWTR_CLOUD_MAX_ITEMS_PER_COLLECTION',
        'MINDWTR_CLOUD_LIST_DEFAULT_LIMIT',
        'MINDWTR_CLOUD_LIST_MAX_LIMIT',
        'MINDWTR_CLOUD_RATE_MAX_KEYS',
        'MINDWTR_CLOUD_AUTH_FAILURE_RATE_MAX',
    ] as const;

    test('rejects every malformed numeric control with the exact environment variable name', () => {
        for (const key of numericEnvironmentKeys) {
            expect(() => resolveCloudRuntimeConfig({ [key]: 'not-a-number' })).toThrow(key);
            expect(() => resolveCloudRuntimeConfig({ [key]: '' })).toThrow(key);
            expect(() => resolveCloudRuntimeConfig({ [key]: '1.5' })).toThrow(key);
        }
    });

    test('documents every numeric environment control in the deployable example', () => {
        const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
        expect(CLOUD_NUMERIC_ENVIRONMENT_KEYS).toEqual(numericEnvironmentKeys);
        for (const key of numericEnvironmentKeys) {
            expect(example).toContain(`${key}=`);
        }
    });

    test('keeps the deployed defaults and rate-dependent attachment default', () => {
        expect(resolveCloudRuntimeConfig({})).toEqual({
            port: 8787,
            rateWindowMs: 60_000,
            rateMax: 120,
            attachmentRateMax: 120,
            maxBodyBytes: 2_000_000,
            maxAttachmentBytes: 50_000_000,
            anyTokenMaxNamespaces: 32,
            rateCleanupMs: 60_000,
            requestTimeoutMs: 30_000,
            slowRequestMs: 1_000,
            maxTaskTitleLength: 500,
            maxTaskQuickAddLength: 2_000,
            maxAreaNameLength: 200,
            maxItemsPerCollection: 50_000,
            listDefaultLimit: 200,
            listMaxLimit: 1_000,
            rateMaxKeys: 10_000,
            authFailureRateMax: 30,
        });
        expect(resolveCloudRuntimeConfig({ MINDWTR_CLOUD_RATE_MAX: '77' }).attachmentRateMax).toBe(77);
    });

    test('allows zero only for port, namespace capacity, and the slow-request log threshold', () => {
        const resolved = resolveCloudRuntimeConfig({
            PORT: '0',
            MINDWTR_CLOUD_ANY_TOKEN_MAX_NAMESPACES: '0',
            MINDWTR_CLOUD_SLOW_REQUEST_MS: '0',
        });
        expect(resolved.port).toBe(0);
        expect(resolved.anyTokenMaxNamespaces).toBe(0);
        expect(resolved.slowRequestMs).toBe(0);

        expect(() => resolveCloudRuntimeConfig({ MINDWTR_CLOUD_RATE_MAX: '0' }))
            .toThrow('MINDWTR_CLOUD_RATE_MAX');
        expect(() => resolveCloudRuntimeConfig({ PORT: '65536' })).toThrow('PORT');
    });

    test('validates deployed values even when a programmatic override exists', () => {
        expect(() => resolveCloudRuntimeConfig(
            { MINDWTR_CLOUD_RATE_MAX: 'broken' },
            { rateMax: 10 },
        )).toThrow('MINDWTR_CLOUD_RATE_MAX');
    });

    test('rejects malformed configuration before creating the data directory', async () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-invalid-config-'));
        const dataDir = join(sandbox, 'must-not-exist');
        const previousValue = process.env.MINDWTR_CLOUD_REQUEST_TIMEOUT_MS;
        process.env.MINDWTR_CLOUD_REQUEST_TIMEOUT_MS = 'disabled';
        try {
            await expect(startCloudServer({
                host: '127.0.0.1',
                port: 0,
                dataDir,
                allowedAuthTokens: ['runtime-config-test-token-1234567890'],
            })).rejects.toThrow('MINDWTR_CLOUD_REQUEST_TIMEOUT_MS');
            expect(existsSync(dataDir)).toBe(false);
        } finally {
            if (previousValue === undefined) {
                delete process.env.MINDWTR_CLOUD_REQUEST_TIMEOUT_MS;
            } else {
                process.env.MINDWTR_CLOUD_REQUEST_TIMEOUT_MS = previousValue;
            }
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});
