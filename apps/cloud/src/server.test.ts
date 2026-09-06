import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { connect } from 'net';
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdtempSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { CLOUD_SYNC_TOKEN_PATTERN, cloudHeadJson, cloudPutJson, TASK_SORT_BY_VALUES, type AppData, type Task } from '@mindwtr/core';
import {
    getAuthFailureRateKey,
    getAuthFailureTokenRateKey,
    getClientIp,
    getToken,
    isAuthorizedToken,
    parseAllowedAuthTokens,
    parseTrustedProxyIps,
    resolveAllowedAuthTokensFromEnv,
    toRateLimitRoute,
    tokenToKey,
} from './server-auth';
import {
    BEARER_TOKEN_PATTERN,
    CLOUD_AREA_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_AREA_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_LOG_MESSAGES,
    CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS,
    corsOrigin,
    createInternalServerErrorResponse,
    errorResponse,
    preflightResponse,
} from './server-config';
import {
    __serverDataCacheTestUtils,
    dataMetadataResponse,
    isTrustedValidatedDataFile,
    loadAppData,
    writeCloudData,
} from './server-data-cache';
import {
    createRequestAbortError,
    createWriteLockRunner,
    isBodyReadError,
    isPathWithinRoot,
    normalizeAttachmentRelativePath,
    pathContainsSymlink,
    readJsonBody,
    resolveAttachmentPath,
    writeData,
    type DurableRemovalFileSystem,
} from './server-storage';
import {
    asStatus,
    validateAppData,
    validateEntityProps,
} from './server-validation';
import {
    canonicalCloudRoute,
    resolveServerMergeTimestamp,
    shouldLogCloudRequest,
    startCloudServer,
    type CloudRequestCompletion,
} from './server';
import { pruneOrphanedCalendarFeeds, revokeCalendarFeed } from './server-calendar-feed';

const expireFileForOrphanGc = (path: string): void => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(path, staleTime, staleTime);
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitForChildExit = async (
    child: ChildProcess,
    timeoutMs: number,
): Promise<{ timedOut: boolean; code: number | null }> => {
    if (child.exitCode !== null || child.signalCode !== null) {
        return { timedOut: false, code: child.exitCode };
    }
    return new Promise((resolve) => {
        const onExit = (code: number | null) => {
            clearTimeout(timeout);
            resolve({ timedOut: false, code });
        };
        const timeout = setTimeout(() => {
            child.off('exit', onExit);
            resolve({ timedOut: true, code: null });
        }, timeoutMs);
        child.once('exit', onExit);
    });
};
const collectChildStderr = (child: ChildProcess): (() => string) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
    });
    return () => stderr.trim();
};

const makeTestTask = (overrides: Pick<Task, 'id' | 'title'> & Partial<Task>): Task => ({
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

describe('cloud server utils', () => {
    test('ratchets cloud logging through static allowlisted messages and the centralized writer', () => {
        const allowlistedMessages = new Set<string>(CLOUD_LOG_MESSAGES);
        const observedMessages = new Set<string>();
        const violations: string[] = [];
        const productionSources = readdirSync(testDirectory)
            .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

        for (const name of productionSources) {
            const source = readFileSync(join(testDirectory, name), 'utf8');
            if (name !== 'server-config.ts' && /process\.(?:stdout|stderr)\.write\s*\(/.test(source)) {
                violations.push(`${name}: direct process log write`);
            }
            if (/\b(?:logInfo|logWarn|logFailureWarn|logError)\s*\(\s*`/.test(source)) {
                violations.push(`${name}: dynamic log message`);
            }
            for (const match of source.matchAll(
                /\b(?:logInfo|logWarn|logFailureWarn|logError)\s*\(\s*(['"])([^'"\r\n]+)\1/g,
            )) {
                const message = match[2];
                if (message) observedMessages.add(message);
                if (message && !allowlistedMessages.has(message)) {
                    violations.push(`${name}: unallowlisted log message: ${message}`);
                }
            }
        }

        expect(violations).toEqual([]);
        expect([...allowlistedMessages].filter((message) => !observedMessages.has(message))).toEqual([]);
    });

    test('startup logs do not expose the configured cloud data path', async () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-startup-log-'));
        const privateDataDir = join(sandbox, 'operator-private', 'cloud-root');
        const captured: string[] = [];
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        });
        const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        });
        let server: Awaited<ReturnType<typeof startCloudServer>> | null = null;

        try {
            server = await startCloudServer({
                host: '127.0.0.1',
                port: 0,
                dataDir: privateDataDir,
                allowedAuthTokens: new Set(['startup-log-token-1234567890']),
            });
            const serializedLogs = captured.join('');
            expect(serializedLogs).not.toContain(privateDataDir);
            expect(serializedLogs).not.toContain('operator-private');
        } finally {
            server?.stop();
            stdoutSpy.mockRestore();
            stderrSpy.mockRestore();
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    test('BEARER_TOKEN_PATTERN stays identical to core CLOUD_SYNC_TOKEN_PATTERN', () => {
        // server-config.ts keeps a literal copy because the dependency-free
        // schema:check CI job imports it without workspace deps installed.
        expect(BEARER_TOKEN_PATTERN.source).toBe(CLOUD_SYNC_TOKEN_PATTERN.source);
        expect(BEARER_TOKEN_PATTERN.flags).toBe(CLOUD_SYNC_TOKEN_PATTERN.flags);
    });

    test('parses bearer token and hashes it', () => {
        const req = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer demo-token-1234567890' },
        });
        const token = getToken(req);
        expect(token).toBe('demo-token-1234567890');
        expect(tokenToKey(token!)).toHaveLength(64);

        const base64TokenReq = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer YWxhZGRpbjpvcGVuL3Nlc2FtZT0=' },
        });
        expect(getToken(base64TokenReq)).toBe('YWxhZGRpbjpvcGVuL3Nlc2FtZT0=');

        const shortTokenReq = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer short' },
        });
        expect(getToken(shortTokenReq)).toBeNull();

        const tokenWithWhitespaceReq = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer token with spaces' },
        });
        expect(getToken(tokenWithWhitespaceReq)).toBeNull();
    });

    test('parses optional auth token allowlist', () => {
        expect(parseAllowedAuthTokens('')).toBeNull();
        const tokens = parseAllowedAuthTokens(
            'token-alpha-1234567890, token-beta-1234567890 ,token-gamma-1234567890'
        );
        expect(tokens?.size).toBe(3);
        expect(tokens?.digests.every((digest) => digest.length === 32)).toBe(true);
        expect(isAuthorizedToken('token-beta-1234567890', tokens || null)).toBe(true);
        expect(isAuthorizedToken('token-delta-1234567890', tokens || null)).toBe(false);
        expect(isAuthorizedToken('any', null)).toBe(true);
    });

    test('throws on a configured token that is too short, naming position and length but never the token', () => {
        expect(() => parseAllowedAuthTokens('token-alpha-1234567890,short8ch')).toThrow(
            'Configured auth token #2 is invalid: tokens must be 20-512 characters of letters, numbers, or . _ ~ + / = - (got 8 characters).'
        );
        try {
            parseAllowedAuthTokens('short8ch');
            throw new Error('expected parseAllowedAuthTokens to throw');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).not.toContain('short8ch');
        }
    });

    test('accepts the minimum and maximum valid token lengths', () => {
        const minToken = 'a'.repeat(20);
        const maxToken = 'a'.repeat(512);
        const tokens = parseAllowedAuthTokens(`${minToken},${maxToken}`);
        expect(tokens?.size).toBe(2);
        expect(isAuthorizedToken(minToken, tokens || null)).toBe(true);
        expect(isAuthorizedToken(maxToken, tokens || null)).toBe(true);
    });

    test('rejects a token over the maximum length and tokens with disallowed characters', () => {
        const tooLongToken = 'a'.repeat(513);
        expect(() => parseAllowedAuthTokens(tooLongToken)).toThrow(
            'Configured auth token #1 is invalid'
        );
        expect(() => parseAllowedAuthTokens('valid-token-1234567890,not a valid token!!!!')).toThrow(
            'Configured auth token #2 is invalid'
        );
    });

    test('resolves auth tokens from both current and legacy env var names', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-auth-'));
        const authTokensFile = join(tempDir, 'auth-tokens.txt');
        const legacyTokenFile = join(tempDir, 'legacy-token.txt');
        try {
            writeFileSync(authTokensFile, 'file-alpha-1234567890,file-beta-1234567890\n');
            writeFileSync(legacyTokenFile, 'legacy-file-token-1234567890\n');

            const primaryOnly = resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_AUTH_TOKENS: 'primary-alpha-1234567890,primary-beta-1234567890',
            });
            expect(primaryOnly).not.toBeNull();
            expect(isAuthorizedToken('primary-alpha-1234567890', primaryOnly)).toBe(true);
            expect(isAuthorizedToken('primary-beta-1234567890', primaryOnly)).toBe(true);

            const legacyOnly = resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_TOKEN: 'legacy-token-1234567890',
            });
            expect(legacyOnly).not.toBeNull();
            expect(isAuthorizedToken('legacy-token-1234567890', legacyOnly)).toBe(true);

            const combined = resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_AUTH_TOKENS: 'combined-new-1234567890',
                MINDWTR_CLOUD_TOKEN: 'legacy-token-1234567890',
            });
            expect(isAuthorizedToken('combined-new-1234567890', combined)).toBe(true);
            expect(isAuthorizedToken('legacy-token-1234567890', combined)).toBe(true);

            const fileOnly = resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_AUTH_TOKENS_FILE: authTokensFile,
            });
            expect(isAuthorizedToken('file-alpha-1234567890', fileOnly)).toBe(true);
            expect(isAuthorizedToken('file-beta-1234567890', fileOnly)).toBe(true);

            const legacyFileOnly = resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_TOKEN_FILE: legacyTokenFile,
            });
            expect(isAuthorizedToken('legacy-file-token-1234567890', legacyFileOnly)).toBe(true);

            const mixedWithFile = resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_AUTH_TOKENS: 'inline-token-1234567890',
                MINDWTR_CLOUD_AUTH_TOKENS_FILE: authTokensFile,
            });
            expect(isAuthorizedToken('inline-token-1234567890', mixedWithFile)).toBe(true);
            expect(isAuthorizedToken('file-alpha-1234567890', mixedWithFile)).toBe(true);
            expect(isAuthorizedToken('file-beta-1234567890', mixedWithFile)).toBe(true);

            const allowAny = resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_ALLOW_ANY_TOKEN: 'true',
            });
            expect(allowAny).toBeNull();

            expect(() => resolveAllowedAuthTokensFromEnv({})).toThrow(
                'Cloud auth is not configured.'
            );

            expect(() => resolveAllowedAuthTokensFromEnv({
                MINDWTR_CLOUD_AUTH_TOKENS: 'too-short',
            })).toThrow('Configured auth token #1 is invalid');
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('ignores proxy IP headers unless explicitly trusted', () => {
        const req = new Request('http://localhost/v1/data', {
            headers: {
                'x-forwarded-for': '203.0.113.10, 10.0.0.1',
                'cf-connecting-ip': '203.0.113.11',
                'x-real-ip': '203.0.113.12',
            },
        });

        expect(getClientIp(req)).toBe('unknown');
        expect(getClientIp(req, true)).toBe('unknown');
        expect(getClientIp(req, {
            trustProxyHeaders: true,
            requestIpAddress: '198.51.100.1',
            trustedProxyIps: new Set(['10.0.0.1']),
        })).toBe('unknown');
        expect(getClientIp(req, {
            trustProxyHeaders: true,
            requestIpAddress: '10.0.0.1',
            trustedProxyIps: new Set(['10.0.0.1']),
        })).toBe('203.0.113.10');
    });

    test('parses trusted proxy IP allowlists', () => {
        expect(Array.from(parseTrustedProxyIps(' 10.0.0.1, ::ffff:127.0.0.1 ,, '))).toEqual([
            '10.0.0.1',
            '127.0.0.1',
        ]);
    });

    test('derives auth failure rate keys from the best available client identity', () => {
        const token = 'demo-token-1234567890';
        const req = new Request('http://localhost/v1/data', {
            headers: {
                authorization: `Bearer ${token}`,
                'x-forwarded-for': '203.0.113.10, 10.0.0.1',
            },
        });

        expect(getAuthFailureRateKey(req, {
            trustProxyHeaders: true,
            trustedProxyIps: new Set(['127.0.0.1']),
            requestIpAddress: '127.0.0.1',
        })).toBe('auth-failure:ip:203.0.113.10');

        expect(getAuthFailureRateKey(req, {
            trustProxyHeaders: true,
            trustedProxyIps: new Set(['10.0.0.1']),
            requestIpAddress: '127.0.0.1',
        })).toBe('auth-failure:ip:127.0.0.1');

        expect(getAuthFailureRateKey(req, {
            trustProxyHeaders: false,
            requestIpAddress: '127.0.0.1',
        })).toBe('auth-failure:ip:127.0.0.1');

        expect(getAuthFailureRateKey(req, {
            trustProxyHeaders: false,
            requestIpAddress: '127.0.0.1',
        })).toBe(getAuthFailureRateKey(new Request('http://localhost/v1/data', {
            headers: { authorization: 'Bearer another-invalid-token-1234567890' },
        }), {
            trustProxyHeaders: false,
            requestIpAddress: '127.0.0.1',
        }));

        expect(getAuthFailureRateKey(req, {
            trustProxyHeaders: false,
            requestIpAddress: null,
        })).toBe('auth-failure:ip:unknown');

        expect(getAuthFailureTokenRateKey({ token })).toBe(
            `auth-failure:token:${tokenToKey(token)}`
        );

        expect(getAuthFailureTokenRateKey({
            authHeader: 'Bearer malformed',
        })).toBe(`auth-failure:header:${tokenToKey('Bearer malformed')}`);
    });

    test('rejects invalid app data payload', () => {
        const result = validateAppData({ tasks: 'invalid', projects: [] });
        expect(result.ok).toBe(false);
    });

    test('applies CORS headers to error responses', () => {
        const response = errorResponse('Unauthorized', 401);

        expect(response.status).toBe(401);
        expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(corsOrigin);
        expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, If-Match');
        expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS');
    });

    test('returns no-content CORS preflight responses', async () => {
        const response = preflightResponse();

        expect(response.status).toBe(204);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(corsOrigin);
        expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, If-Match');
        expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS');
        expect(await response.text()).toBe('');
    });

    test('includes a request id in internal server error responses', async () => {
        const response = createInternalServerErrorResponse('Internal server error', 'req-test-123');

        expect(response.status).toBe(500);
        expect(response.headers.get('X-Request-Id')).toBe('req-test-123');
        const body = await response.json();
        expect(body.error).toBe('Internal server error');
        expect(body.requestId).toBe('req-test-123');
    });

    test('rejects invalid task status and timestamps in app data', () => {
        const invalidStatus = validateAppData({
            tasks: [{
                id: 't1',
                title: 'Task 1',
                status: 'todo',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            }],
            projects: [],
        });
        expect(invalidStatus.ok).toBe(false);

        const invalidTimestamp = validateAppData({
            tasks: [{
                id: 't1',
                title: 'Task 1',
                status: 'inbox',
                createdAt: 'invalid',
                updatedAt: '2024-01-01T00:00:00.000Z',
            }],
            projects: [],
        });
        expect(invalidTimestamp.ok).toBe(false);
    });

    test('accepts null optional deletedAt timestamps while requiring area createdAt/updatedAt', () => {
     const iso = '2024-01-01T00:00:00.000Z';
     const result = validateAppData({
         tasks: [{
             id: 't1',
             title: 'Task',
             status: 'inbox',
             createdAt: iso,
             updatedAt: iso,
             deletedAt: null,
         }],
         projects: [{
             id: 'p1',
             title: 'Project',
             status: 'active',
             createdAt: iso,
             updatedAt: iso,
             deletedAt: null,
         }],
         sections: [{
             id: 's1',
             projectId: 'p1',
             title: 'Section',
             createdAt: iso,
             updatedAt: iso,
             deletedAt: null,
         }],
         areas: [{
             id: 'a1',
             name: 'Area',
             createdAt: iso,
             updatedAt: iso,
             deletedAt: null,
         }],
     });
     expect(result.ok).toBe(true);
    });

    test('rejects live records with broken project, section, or area references', () => {
        const iso = '2024-01-01T00:00:00.000Z';

        const invalidTaskProject = validateAppData({
            tasks: [{
                id: 't1',
                title: 'Task',
                status: 'inbox',
                projectId: 'missing-project',
                createdAt: iso,
                updatedAt: iso,
            }],
            projects: [],
            sections: [],
            areas: [],
        });
        expect(invalidTaskProject.ok).toBe(false);

        const invalidTaskSection = validateAppData({
            tasks: [{
                id: 't1',
                title: 'Task',
                status: 'inbox',
                projectId: 'p1',
                sectionId: 's1',
                createdAt: iso,
                updatedAt: iso,
            }],
            projects: [{
                id: 'p1',
                title: 'Project',
                status: 'active',
                color: '#000000',
                order: 0,
                tagIds: [],
                createdAt: iso,
                updatedAt: iso,
            }],
            sections: [],
            areas: [],
        });
        expect(invalidTaskSection.ok).toBe(false);

        const invalidProjectArea = validateAppData({
            tasks: [],
            projects: [{
                id: 'p1',
                title: 'Project',
                status: 'active',
                color: '#000000',
                order: 0,
                tagIds: [],
                areaId: 'missing-area',
                createdAt: iso,
                updatedAt: iso,
            }],
            sections: [],
            areas: [],
        });
        expect(invalidProjectArea.ok).toBe(false);
    });

    test('accepts only core task statuses', () => {
        expect(asStatus('reference')).toBe('reference');
        expect(asStatus('todo')).toBeNull();
        expect(asStatus('in-progress')).toBeNull();
    });

    // Table test for the validateEntityProps() consolidation: covers all 8
    // (kind, mode) pairs that used to be eight near-identical
    // validate{Task,Project,Section,Area}{Creation,Patch}Props functions. Each
    // pair is checked against a real allowlisted key (pulled from the same
    // CLOUD_*_ALLOWED_PROP_KEYS the server enforces, so this can't drift out of
    // sync with the allowlist) and a key no kind/mode ever allows.
    const ENTITY_PROPS_ALLOWED_KEYS: Record<'task' | 'project' | 'section' | 'area', Record<'create' | 'patch', ReadonlySet<string>>> = {
        task: { create: CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS, patch: CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS },
        project: { create: CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS, patch: CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS },
        section: { create: CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS, patch: CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS },
        area: { create: CLOUD_AREA_CREATION_ALLOWED_PROP_KEYS, patch: CLOUD_AREA_PATCH_ALLOWED_PROP_KEYS },
    };

    test('validateEntityProps enforces the right allowlist for every (kind, mode) pair', () => {
        for (const kind of ['task', 'project', 'section', 'area'] as const) {
            for (const mode of ['create', 'patch'] as const) {
                const label = `${kind} ${mode}`;
                const allowedKeys = ENTITY_PROPS_ALLOWED_KEYS[kind][mode];
                const [sampleValidKey] = allowedKeys;
                if (!sampleValidKey) throw new Error(`${label} allowlist should be non-empty`);

                const validResult = validateEntityProps(kind, mode, { [sampleValidKey]: undefined });
                if (!validResult.ok) throw new Error(`${label} should accept ${sampleValidKey}, got: ${validResult.error}`);

                const invalidResult = validateEntityProps(kind, mode, { __never_a_real_prop__: true });
                if (invalidResult.ok) throw new Error(`${label} should reject an unlisted key`);
                expect(invalidResult.error).toContain('__never_a_real_prop__');
                expect(invalidResult.error).toContain(kind);
            }
        }

        // Non-object input is rejected for every pair too.
        for (const kind of ['task', 'project', 'section', 'area'] as const) {
            for (const mode of ['create', 'patch'] as const) {
                const result = validateEntityProps(kind, mode, 'not-an-object');
                expect(result.ok).toBe(false);
            }
        }
    });

    test('rejects reserved task creation props', () => {
        expect(validateEntityProps('task', 'create', {
            status: 'next',
            energyLevel: 'medium',
            assignedTo: 'person-1',
            projectId: 'p1',
            showFutureRecurrence: true,
            suppressMindwtrReminders: true,
        }).ok).toBe(true);

        const invalid = validateEntityProps('task', 'create', {
            status: 'next',
            rev: 99,
            deletedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(invalid.ok).toBe(false);
        if (invalid.ok) throw new Error('Expected invalid task props');
        expect(invalid.error).toContain('rev');
        expect(invalid.error).toContain('deletedAt');
    });

    test('rejects reserved task patch props', () => {
        expect(validateEntityProps('task', 'patch', {
            title: 'Renamed',
            status: 'next',
            energyLevel: 'low',
            assignedTo: 'person-2',
            order: 1,
            suppressMindwtrReminders: false,
        }).ok).toBe(true);

        const invalid = validateEntityProps('task', 'patch', {
            id: 'override',
            createdAt: '2026-01-01T00:00:00.000Z',
            arbitrary: 'value',
        });
        expect(invalid.ok).toBe(false);
        if (invalid.ok) throw new Error('Expected invalid task patch props');
        expect(invalid.error).toContain('id');
        expect(invalid.error).toContain('createdAt');
        expect(invalid.error).toContain('arbitrary');
    });

    test('validates schedule task prop values before REST writes', () => {
        expect(validateEntityProps('task', 'create', {
            status: 'next',
            repeatReminderMinutes: 15,
            relativeStartOffset: { amount: -3, unit: 'day' },
            recurrence: { rule: 'weekly', seriesId: 'series-1', byDay: ['MO'] },
        }).ok).toBe(true);
        expect(validateEntityProps('task', 'patch', {
            repeatReminderMinutes: 0,
            recurrence: 'FREQ=DAILY;INTERVAL=2',
        }).ok).toBe(true);

        const invalidRepeat = validateEntityProps('task', 'create', { repeatReminderMinutes: 7 });
        expect(invalidRepeat.ok).toBe(false);
        if (invalidRepeat.ok) throw new Error('Expected invalid repeatReminderMinutes');
        expect(invalidRepeat.error).toContain('repeatReminderMinutes');

        const invalidOffset = validateEntityProps('task', 'patch', { relativeStartOffset: { amount: 3, unit: 'day' } });
        expect(invalidOffset.ok).toBe(false);
        if (invalidOffset.ok) throw new Error('Expected invalid relativeStartOffset');
        expect(invalidOffset.error).toContain('relativeStartOffset');

        const invalidRecurrence = validateEntityProps('task', 'patch', { recurrence: { rule: 'daily', arbitrary: true } });
        expect(invalidRecurrence.ok).toBe(false);
        if (invalidRecurrence.ok) throw new Error('Expected invalid recurrence');
        expect(invalidRecurrence.error).toContain('recurrence');

        const invalidRecurrenceValue = validateEntityProps('task', 'patch', { recurrence: { rule: 'weekly', byDay: ['NOPE'] } });
        expect(invalidRecurrenceValue.ok).toBe(false);
        if (invalidRecurrenceValue.ok) throw new Error('Expected invalid recurrence value');
        expect(invalidRecurrenceValue.error).toContain('recurrence');
    });

    test('validates schedule task prop values in app data snapshots', () => {
        const baseTask = makeTestTask({ id: 't1', title: 'Task' });

        const valid = validateAppData({
            tasks: [{
                ...baseTask,
                repeatReminderMinutes: 15,
                relativeStartOffset: { amount: -3, unit: 'day' },
                recurrence: { rule: 'weekly', byDay: ['MO'] },
            }],
            projects: [],
        });
        expect(valid.ok).toBe(true);

        const invalidRepeat = validateAppData({
            tasks: [{ ...baseTask, repeatReminderMinutes: 7 }],
            projects: [],
        });
        expect(invalidRepeat.ok).toBe(false);
        if (invalidRepeat.ok) throw new Error('Expected invalid repeatReminderMinutes');
        expect(invalidRepeat.error).toContain('repeatReminderMinutes');

        const invalidOffset = validateAppData({
            tasks: [{ ...baseTask, relativeStartOffset: { amount: 3, unit: 'day' } }],
            projects: [],
        });
        expect(invalidOffset.ok).toBe(false);
        if (invalidOffset.ok) throw new Error('Expected invalid relativeStartOffset');
        expect(invalidOffset.error).toContain('relativeStartOffset');

        const invalidRecurrence = validateAppData({
            tasks: [{ ...baseTask, recurrence: { rule: 'weekly', byDay: ['NOPE'] } }],
            projects: [],
        });
        expect(invalidRecurrence.ok).toBe(false);
        if (invalidRecurrence.ok) throw new Error('Expected invalid recurrence');
        expect(invalidRecurrence.error).toContain('recurrence');
    });

    test('accepts Task.viewSectionIds on the deployed open task shape', () => {
        const baseTask = makeTestTask({ id: 'view-section-task', title: 'Task' });
        const result = validateAppData({
            tasks: [{
                ...baseTask,
                viewSectionIds: {
                    someday: 'books',
                },
            }],
            projects: [],
            settings: {
                gtd: {
                    viewSections: {
                        someday: [{ id: 'books', title: 'Books to read', order: 0 }],
                    },
                },
            },
        });
        expect(result.ok).toBe(true);
    });

    test('validates forward-compatible viewSectionIds values without allowlisting scope keys', () => {
        const baseTask = makeTestTask({ id: 'view-section-task', title: 'Task' });
        const futureScope = validateAppData({
            tasks: [{
                ...baseTask,
                viewSectionIds: { futureScopeAddedByNewerClient: 'future-heading' },
            }],
            projects: [],
        });
        expect(futureScope.ok).toBe(true);

        const invalid = validateAppData({
            tasks: [{ ...baseTask, viewSectionIds: { someday: 42 } }],
            projects: [],
        });
        expect(invalid.ok).toBe(false);
        if (invalid.ok) throw new Error('Expected invalid viewSectionIds');
        expect(invalid.error).toContain('viewSectionIds');
    });

    test('validates settings.attachments.pendingRemoteDeletes structure', () => {
        const iso = '2024-01-01T00:00:00.000Z';
        const base = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
        };
        const valid = validateAppData({
            ...base,
            settings: {
                attachments: {
                    pendingRemoteDeletes: [{
                        cloudKey: 'attachments/file-1.png',
                        title: 'file-1',
                        attempts: 2,
                        lastErrorAt: iso,
                    }],
                },
            },
        });
        expect(valid.ok).toBe(true);

        const invalidCloudKey = validateAppData({
            ...base,
            settings: {
                attachments: {
                    pendingRemoteDeletes: [{ cloudKey: '../escape' }],
                },
            },
        });
        expect(invalidCloudKey.ok).toBe(false);

        const invalidAttempts = validateAppData({
            ...base,
            settings: {
                attachments: {
                    pendingRemoteDeletes: [{ cloudKey: 'attachments/file-2.png', attempts: -1 }],
                },
            },
        });
        expect(invalidAttempts.ok).toBe(false);
    });

    test('normalizes rate limit routes for task item endpoints', () => {
        expect(toRateLimitRoute('/v1/tasks/abc')).toBe('/v1/tasks/:id');
        expect(toRateLimitRoute('/v1/tasks/abc/complete')).toBe('/v1/tasks/:id/:action');
        expect(toRateLimitRoute('/v1/tasks')).toBe('/v1/tasks');
    });

    test('enforces JSON body size limit without relying on content-length', async () => {
        const body = JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} });
        const req = new Request('http://localhost/v1/data', {
            method: 'PUT',
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                },
            }),
            duplex: 'half' as RequestDuplex,
        });
        const parsed = await readJsonBody(req, 10);
        expect(isBodyReadError(parsed)).toBe(true);
        if (!isBodyReadError(parsed)) throw new Error('Expected body read error');
        expect(parsed.__mindwtrError.message).toBe('Payload too large');
        expect(parsed.__mindwtrError.status).toBe(413);
    });

    test('returns request timeout when body read is aborted', async () => {
        const controller = new AbortController();
        const req = new Request('http://localhost/v1/data', {
            method: 'PUT',
            body: new ReadableStream({
                start(streamController) {
                    streamController.enqueue(new TextEncoder().encode('{"tasks":['));
                },
                cancel() {
                    return undefined;
                },
            }),
            duplex: 'half' as RequestDuplex,
        });

        controller.abort(new Error('Request timed out'));
        const parsed = await readJsonBody(req, 1024, controller.signal);
        expect(isBodyReadError(parsed)).toBe(true);
        if (!isBodyReadError(parsed)) throw new Error('Expected body read error');
        expect(parsed.__mindwtrError.message).toBe('Request timed out');
        expect(parsed.__mindwtrError.status).toBe(408);
    });

    test('normalizes attachment paths with allowlist and segment checks', () => {
        expect(normalizeAttachmentRelativePath('folder/file.txt')).toBe('folder/file.txt');
        expect(normalizeAttachmentRelativePath('/folder/file.txt/')).toBe('folder/file.txt');
        expect(normalizeAttachmentRelativePath('%2e%2e/secret')).toBeNull();
        expect(normalizeAttachmentRelativePath('%252e%252e/secret')).toBeNull();
        expect(normalizeAttachmentRelativePath('%25252e%25252e/secret')).toBeNull();
        expect(normalizeAttachmentRelativePath('../secret')).toBeNull();
        expect(normalizeAttachmentRelativePath('folder\\\\file.txt')).toBeNull();
        expect(normalizeAttachmentRelativePath('folder/file?.txt')).toBeNull();
    });

    test('checks whether resolved path stays inside root directory', () => {
        expect(isPathWithinRoot('/data/ns/attachments/file.txt', '/data/ns/attachments')).toBe(true);
        expect(isPathWithinRoot('/data/ns/attachments', '/data/ns/attachments')).toBe(true);
        expect(isPathWithinRoot('/data/ns/attachments-evil/file.txt', '/data/ns/attachments')).toBe(false);
    });

    test('detects symlink segments in attachment paths', () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-symlink-check-'));
        const root = join(sandbox, 'root');
        const outside = join(sandbox, 'outside');
        mkdirSync(root, { recursive: true });
        mkdirSync(outside, { recursive: true });

        const normalDir = join(root, 'plain');
        mkdirSync(normalDir, { recursive: true });
        expect(pathContainsSymlink(root, normalDir)).toBe(false);

        const linkDir = join(root, 'linked');
        symlinkSync(outside, linkDir);
        expect(pathContainsSymlink(root, linkDir)).toBe(true);

        rmSync(sandbox, { recursive: true, force: true });
    });

    test('does not create attachment roots through a symlinked namespace', () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-attachment-root-'));
        const dataDirForTest = join(sandbox, 'data');
        const outside = join(sandbox, 'outside');
        const key = 'namespace-key';
        mkdirSync(dataDirForTest, { recursive: true });
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(dataDirForTest, key), 'dir');

        const resolvedPath = resolveAttachmentPath(dataDirForTest, key, 'folder/file.bin', { create: true });

        expect(resolvedPath).toBeNull();
        expect(existsSync(join(outside, 'attachments'))).toBe(false);

        rmSync(sandbox, { recursive: true, force: true });
    });

    // Regression for the read-triggered namespace-cap bypass: resolveAttachmentPath
    // used to mkdir `<dataDir>/<key>/attachments` unconditionally, so a plain GET (or
    // DELETE) from a token that had never written anything permanently planted its
    // namespace directory — which both exempted it from ensureNamespaceWriteAllowed
    // and consumed a maxAnyTokenNamespaces slot, without ever storing data.
    test('resolves a read-only attachment path without creating the namespace directory', () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-attachment-readonly-resolve-'));
        const dataDirForTest = join(sandbox, 'data');
        mkdirSync(dataDirForTest, { recursive: true });
        const key = 'namespace-key-readonly';

        const resolvedForGet = resolveAttachmentPath(dataDirForTest, key, 'folder/file.bin', { create: false });
        expect(resolvedForGet).not.toBeNull();
        expect(existsSync(join(dataDirForTest, key))).toBe(false);

        const resolvedForDelete = resolveAttachmentPath(dataDirForTest, key, 'folder/file.bin', { create: false });
        expect(resolvedForDelete).not.toBeNull();
        expect(existsSync(join(dataDirForTest, key))).toBe(false);

        rmSync(sandbox, { recursive: true, force: true });
    });

    test('write lock runner executes each queued write once, even after a failure', async () => {
        const withWriteLock = createWriteLockRunner();
        let failingCalls = 0;
        let succeedingCalls = 0;

        const first = withWriteLock('key', async () => {
            failingCalls += 1;
            throw new Error('boom');
        });
        const second = withWriteLock('key', async () => {
            succeedingCalls += 1;
            return 'ok';
        });

        expect(withWriteLock.getPendingLockCount()).toBe(1);
        await expect(first).rejects.toThrow('boom');
        await expect(second).resolves.toBe('ok');
        expect(failingCalls).toBe(1);
        expect(succeedingCalls).toBe(1);
        expect(withWriteLock.getPendingLockCount()).toBe(0);
    });

    test('write lock runner rechecks storage authority before creating lock state', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-lock-authority-'));
        let storageCurrent = true;
        let handlerCalled = false;
        const withWriteLock = createWriteLockRunner(dataRoot, () => {
            if (!storageCurrent) throw new Error('storage root changed');
        });
        storageCurrent = false;

        await expect(withWriteLock('namespace', async () => {
            handlerCalled = true;
        })).rejects.toThrow('storage root changed');
        expect(handlerCalled).toBe(false);
        expect(readdirSync(dataRoot)).toEqual([]);

        rmSync(dataRoot, { recursive: true, force: true });
    });

    test('write lock runner rejects a serialized result after storage authority changes', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-lock-result-authority-'));
        let storageCurrent = true;
        const withWriteLock = createWriteLockRunner(dataRoot, () => {
            if (!storageCurrent) throw new Error('storage root changed');
        });

        await expect(withWriteLock('namespace', async () => {
            storageCurrent = false;
            return 'replacement-root-data';
        })).rejects.toThrow('storage root changed');

        rmSync(dataRoot, { recursive: true, force: true });
    });

    test('bounds cross-process lock files independently of attacker-controlled keys', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-lock-shards-'));
        try {
            const withWriteLock = createWriteLockRunner(dir);
            for (let index = 0; index < 96; index += 1) {
                await withWriteLock(`untrusted-token-key-${index}`, async () => undefined);
            }

            const lockDir = join(dir, '.locks');
            const lockFiles = existsSync(lockDir)
                ? readdirSync(lockDir).filter((name) => name.endsWith('.sqlite'))
                : [];
            expect(lockFiles.length).toBeGreaterThan(0);
            expect(lockFiles.length).toBeLessThanOrEqual(64);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('cancels a queued in-process lock wait when its request is aborted', async () => {
        const withWriteLock = createWriteLockRunner();
        let releaseHolder!: () => void;
        const holderGate = new Promise<void>((resolve) => {
            releaseHolder = resolve;
        });
        const holder = withWriteLock('key', async () => holderGate);
        const abortController = new AbortController();
        const abortableWithWriteLock = withWriteLock as unknown as <T>(
            key: string,
            handler: () => Promise<T>,
            signal?: AbortSignal,
        ) => Promise<T>;
        const waiter = abortableWithWriteLock('key', async () => 'unexpected', abortController.signal);

        abortController.abort(createRequestAbortError('Request timed out', 408));
        const outcome = await Promise.race([
            waiter.then(
                () => ({ kind: 'resolved' as const }),
                (error: unknown) => ({ kind: 'rejected' as const, error }),
            ),
            delay(200).then(() => ({ kind: 'timed-out' as const })),
        ]);

        releaseHolder();
        await holder;
        await waiter.catch(() => undefined);
        for (let attempt = 0; attempt < 20 && withWriteLock.getPendingLockCount() > 0; attempt += 1) {
            await delay(1);
        }
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
            expect((outcome.error as { status?: number }).status).toBe(408);
        }
        expect(withWriteLock.getPendingLockCount()).toBe(0);
    });

    test('cancels a cross-process lock poll when its request is aborted', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-lock-abort-'));
        const holderLock = createWriteLockRunner(dir);
        const waiterLock = createWriteLockRunner(dir);
        let releaseHolder!: () => void;
        let markHolderReady!: () => void;
        const holderGate = new Promise<void>((resolve) => {
            releaseHolder = resolve;
        });
        const holderReady = new Promise<void>((resolve) => {
            markHolderReady = resolve;
        });
        const holder = holderLock('same-key', async () => {
            markHolderReady();
            return holderGate;
        });
        try {
            await holderReady;
            const abortController = new AbortController();
            const waiter = waiterLock('same-key', async () => 'unexpected', abortController.signal);
            await delay(25);
            abortController.abort(createRequestAbortError('Request timed out', 408));

            const outcome = await Promise.race([
                waiter.then(
                    () => ({ kind: 'resolved' as const }),
                    (error: unknown) => ({ kind: 'rejected' as const, error }),
                ),
                delay(200).then(() => ({ kind: 'timed-out' as const })),
            ]);
            expect(outcome.kind).toBe('rejected');
            if (outcome.kind === 'rejected') {
                expect((outcome.error as { status?: number }).status).toBe(408);
            }
        } finally {
            releaseHolder();
            await holder;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('releases the cross-process write lock immediately when its owner crashes', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-lock-crash-'));
        const workerPath = join(testDirectory, 'test-fixtures', 'cloud-lock-worker.ts');
        const holderReadyPath = join(dir, 'holder-ready');
        const contenderReadyPath = join(dir, 'contender-ready');
        const holder = spawn(process.execPath, [workerPath, 'hold', dir, holderReadyPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const holderStderr = collectChildStderr(holder);
        let contender: ChildProcess | null = null;
        try {
            for (let attempt = 0; attempt < 1_000 && !existsSync(holderReadyPath); attempt += 1) {
                await delay(10);
            }
            if (!existsSync(holderReadyPath)) {
                throw new Error(`Lock holder did not become ready: ${holderStderr()}`);
            }
            expect(existsSync(holderReadyPath)).toBe(true);
            holder.kill('SIGKILL');
            const holderExit = await waitForChildExit(holder, 5_000);
            if (holderExit.timedOut) {
                throw new Error(`Lock holder did not exit after SIGKILL: ${holderStderr()}`);
            }
            expect(holderExit.timedOut).toBe(false);

            contender = spawn(process.execPath, [workerPath, 'acquire', dir, contenderReadyPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const contenderStderr = collectChildStderr(contender);
            const exit = await waitForChildExit(contender, 5_000);
            if (exit.timedOut || exit.code !== 0 || !existsSync(contenderReadyPath)) {
                throw new Error(`Lock contender failed: ${JSON.stringify(exit)} ${contenderStderr()}`);
            }
            expect(exit).toEqual({ timedOut: false, code: 0 });
            expect(existsSync(contenderReadyPath)).toBe(true);
        } finally {
            holder.kill('SIGKILL');
            contender?.kill('SIGKILL');
            if (contender) await waitForChildExit(contender, 1_000);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('serializes a real two-process read-modify-write stress run', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-lock-stress-'));
        const workerPath = join(testDirectory, 'test-fixtures', 'cloud-lock-worker.ts');
        const firstDonePath = join(dir, 'first-done');
        const secondDonePath = join(dir, 'second-done');
        const counterPath = join(dir, 'cross-process-counter.txt');
        const workers = [
            spawn(process.execPath, [workerPath, 'increment', dir, firstDonePath, '30'], {
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
            spawn(process.execPath, [workerPath, 'increment', dir, secondDonePath, '30'], {
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        ];
        try {
            const exits = await Promise.all(workers.map((worker) => waitForChildExit(worker, 10_000)));
            expect(exits).toEqual([
                { timedOut: false, code: 0 },
                { timedOut: false, code: 0 },
            ]);
            expect(existsSync(firstDonePath)).toBe(true);
            expect(existsSync(secondDonePath)).toBe(true);
            expect(Number(readFileSync(counterPath, 'utf8'))).toBe(60);
        } finally {
            for (const worker of workers) worker.kill('SIGKILL');
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('writeData atomically replaces the JSON file and cleans up temp files', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-write-data-'));
        const filePath = join(dir, 'data.json');

        writeData(filePath, { ok: true, version: 1 });
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ ok: true, version: 1 });

        writeData(filePath, { ok: true, version: 2 });
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ ok: true, version: 2 });
        expect(readdirSync(dir)).toEqual(['data.json']);

        rmSync(dir, { recursive: true, force: true });
    });

    test('writeData never recreates a missing storage root', () => {
        const parent = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-missing-root-'));
        const missingRoot = join(parent, 'data');

        expect(() => writeData(join(missingRoot, 'namespace.json'), { ok: true }))
            .toThrow('Cloud data directory is unsafe');
        expect(existsSync(missingRoot)).toBe(false);

        rmSync(parent, { recursive: true, force: true });
    });

    test('caches parsed app data for unchanged data files without leaking caller mutations', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-load-cache-'));
        const filePath = join(dir, 'data.json');
        const iso = '2026-01-01T00:00:00.000Z';
        const data: AppData = {
            tasks: [makeTestTask({
                id: 'task-1',
                title: 'Cached',
                createdAt: iso,
                updatedAt: iso,
            })],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        try {
            __serverDataCacheTestUtils.clearDataCaches();
            writeFileSync(filePath, JSON.stringify(data));

            const first = loadAppData(filePath);
            first.tasks.push(makeTestTask({
                id: 'caller-mutation',
                title: 'Caller mutation',
                createdAt: iso,
                updatedAt: iso,
            }));

            const second = loadAppData(filePath);

            expect(__serverDataCacheTestUtils.getParsedDataCacheSize()).toBe(1);
            expect(second.tasks.map((task) => task.id)).toEqual(['task-1']);
        } finally {
            __serverDataCacheTestUtils.clearDataCaches();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('does not cache write caller object references', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-write-cache-'));
        const filePath = join(dir, 'data.json');
        const iso = '2026-01-01T00:00:00.000Z';
        const data: AppData = {
            tasks: [makeTestTask({
                id: 'task-1',
                title: 'Written',
                createdAt: iso,
                updatedAt: iso,
            })],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        try {
            __serverDataCacheTestUtils.clearDataCaches();
            writeCloudData(filePath, data);
            data.tasks.push(makeTestTask({
                id: 'caller-mutation',
                title: 'Caller mutation',
                createdAt: iso,
                updatedAt: iso,
            }));

            const loaded = loadAppData(filePath);

            expect(__serverDataCacheTestUtils.getParsedDataCacheSize()).toBe(1);
            expect(loaded.tasks.map((task) => task.id)).toEqual(['task-1']);
        } finally {
            __serverDataCacheTestUtils.clearDataCaches();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('bounds parsed app data cache entries', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-cache-bound-'));
        const iso = '2026-01-01T00:00:00.000Z';

        try {
            __serverDataCacheTestUtils.clearDataCaches();
            const maxEntries = __serverDataCacheTestUtils.getDataCacheMaxEntries();
            for (let index = 0; index < maxEntries + 3; index += 1) {
                const filePath = join(dir, `data-${index}.json`);
                writeCloudData(filePath, {
                    tasks: [makeTestTask({
                        id: `task-${index}`,
                        title: `Task ${index}`,
                        createdAt: iso,
                        updatedAt: iso,
                    })],
                    projects: [],
                    sections: [],
                    areas: [],
                    settings: {},
                });
            }

            expect(__serverDataCacheTestUtils.getParsedDataCacheSize()).toBe(maxEntries);
        } finally {
            __serverDataCacheTestUtils.clearDataCaches();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('promotes parsed app data cache hits before eviction', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-cache-lru-'));
        const iso = '2026-01-01T00:00:00.000Z';

        try {
            __serverDataCacheTestUtils.clearDataCaches();
            const maxEntries = __serverDataCacheTestUtils.getDataCacheMaxEntries();
            const filePaths: string[] = [];
            for (let index = 0; index < maxEntries; index += 1) {
                const filePath = join(dir, `data-${index}.json`);
                filePaths.push(filePath);
                writeCloudData(filePath, {
                    tasks: [makeTestTask({
                        id: `task-${index}`,
                        title: `Task ${index}`,
                        createdAt: iso,
                        updatedAt: iso,
                    })],
                    projects: [],
                    sections: [],
                    areas: [],
                    settings: {},
                });
            }

            loadAppData(filePaths[0]!);
            writeCloudData(join(dir, 'data-extra.json'), {
                tasks: [makeTestTask({
                    id: 'task-extra',
                    title: 'Task extra',
                    createdAt: iso,
                    updatedAt: iso,
                })],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            });

            expect(__serverDataCacheTestUtils.hasParsedDataCacheEntry(filePaths[0]!)).toBe(true);
            expect(__serverDataCacheTestUtils.hasParsedDataCacheEntry(filePaths[1]!)).toBe(false);
        } finally {
            __serverDataCacheTestUtils.clearDataCaches();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('bounds validated data and metadata cache entries with LRU promotion', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-cache-bound-all-'));
        const iso = '2026-01-01T00:00:00.000Z';

        try {
            __serverDataCacheTestUtils.clearDataCaches();
            const maxEntries = __serverDataCacheTestUtils.getDataCacheMaxEntries();
            const filePaths: string[] = [];
            for (let index = 0; index < maxEntries; index += 1) {
                const filePath = join(dir, `data-${index}.json`);
                filePaths.push(filePath);
                writeCloudData(filePath, {
                    tasks: [makeTestTask({
                        id: `task-${index}`,
                        title: `Task ${index}`,
                        createdAt: iso,
                        updatedAt: iso,
                    })],
                    projects: [],
                    sections: [],
                    areas: [],
                    settings: {},
                });
                dataMetadataResponse(filePath);
            }

            expect(isTrustedValidatedDataFile(filePaths[0]!)).toBe(true);
            dataMetadataResponse(filePaths[0]!);
            const extraPath = join(dir, 'data-extra.json');
            writeCloudData(extraPath, {
                tasks: [makeTestTask({
                    id: 'task-extra',
                    title: 'Task extra',
                    createdAt: iso,
                    updatedAt: iso,
                })],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            });
            dataMetadataResponse(extraPath);

            expect(__serverDataCacheTestUtils.getValidatedDataCacheSize()).toBe(maxEntries);
            expect(__serverDataCacheTestUtils.getDataMetadataCacheSize()).toBe(maxEntries);
            expect(__serverDataCacheTestUtils.hasValidatedDataCacheEntry(filePaths[0]!)).toBe(true);
            expect(__serverDataCacheTestUtils.hasValidatedDataCacheEntry(filePaths[1]!)).toBe(false);
            expect(__serverDataCacheTestUtils.hasDataMetadataCacheEntry(filePaths[0]!)).toBe(true);
            expect(__serverDataCacheTestUtils.hasDataMetadataCacheEntry(filePaths[1]!)).toBe(false);
        } finally {
            __serverDataCacheTestUtils.clearDataCaches();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('uses server time for merge repair timestamps without spreading large payloads', () => {
        const startedAt = Date.now();
        const iso = '2026-01-01T00:00:00.000Z';
        const data: AppData = {
            tasks: Array.from({ length: 60_000 }, (_, index) => makeTestTask({
                id: `task-${index}`,
                title: `Task ${index}`,
                createdAt: iso,
                updatedAt: index === 59_999 ? '2026-01-02T00:00:00.000Z' : iso,
            })),
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        const resolved = Date.parse(resolveServerMergeTimestamp(data));
        expect(Number.isFinite(resolved)).toBe(true);
        expect(resolved).toBeGreaterThanOrEqual(startedAt);
        expect(resolved).toBeLessThanOrEqual(Date.now());
    });

    test('does not trust future payload timestamps for server merge repairs', () => {
        const startedAt = Date.now();
        const iso = '2026-01-01T00:00:00.000Z';
        const farFuture = new Date(startedAt + 365 * 24 * 60 * 60 * 1000).toISOString();
        const data: AppData = {
            tasks: [makeTestTask({
                id: 'task-future',
                title: 'Future task',
                createdAt: iso,
                updatedAt: farFuture,
            })],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };

        const resolved = Date.parse(resolveServerMergeTimestamp(data));
        expect(Number.isFinite(resolved)).toBe(true);
        expect(resolved).toBeGreaterThanOrEqual(startedAt);
        expect(resolved).toBeLessThanOrEqual(Date.now());
    });
});

describe('cloud server namespace mode', () => {
    test('keeps arbitrary HEAD probes from allocating unbounded lock files or namespaces', async () => {
        const tempDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-head-lock-growth-'));
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: tempDataDir,
            allowedAuthTokens: null,
            maxAnyTokenNamespaces: 1,
            maxPerWindow: 200,
        });
        try {
            const url = `http://127.0.0.1:${server.port}`;
            for (let index = 0; index < 80; index += 1) {
                const response = await fetch(`${url}/v1/data`, {
                    method: 'HEAD',
                    headers: { Authorization: `Bearer head-probe-token-${index}-1234567890` },
                });
                expect(response.status).toBe(404);
            }

            expect(readdirSync(tempDataDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0);
            const lockFiles = readdirSync(join(tempDataDir, '.locks'))
                .filter((name) => name.endsWith('.sqlite'));
            expect(lockFiles.length).toBeLessThanOrEqual(64);
        } finally {
            server.stop();
            rmSync(tempDataDir, { recursive: true, force: true });
        }
    });

    test('admits only one concurrent first writer when a single any-token namespace remains', async () => {
        const tempDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-namespace-race-'));
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: tempDataDir,
            allowedAuthTokens: null,
            maxAnyTokenNamespaces: 1,
        });
        const url = `http://127.0.0.1:${server.port}`;
        let releaseBodies!: () => void;
        const bodyGate = new Promise<void>((resolve) => {
            releaseBodies = resolve;
        });
        const payload = JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} });
        const createGatedBody = () => new ReadableStream<Uint8Array>({
            start(controller) {
                const splitAt = Math.floor(payload.length / 2);
                controller.enqueue(new TextEncoder().encode(payload.slice(0, splitAt)));
                void bodyGate.then(() => {
                    controller.enqueue(new TextEncoder().encode(payload.slice(splitAt)));
                    controller.close();
                });
            },
        });

        try {
            const write = (token: string) => fetch(`${url}/v1/data`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: createGatedBody(),
                duplex: 'half',
            });
            const first = write('namespace-race-token-one-1234567890');
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const namespaceCount = readdirSync(tempDataDir)
                    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
                if (namespaceCount === 1) break;
                await delay(10);
            }
            expect(readdirSync(tempDataDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);

            const secondStatus = await Promise.race([
                write('namespace-race-token-two-1234567890').then((response) => response.status),
                delay(500).then(() => 'timed-out' as const),
            ]);
            expect(secondStatus).toBe(403);
            releaseBodies();

            expect((await first).status).toBe(200);
            expect(readdirSync(tempDataDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);
        } finally {
            releaseBodies();
            server.stop();
            rmSync(tempDataDir, { recursive: true, force: true });
        }
    });

    test('enforces namespace admission across two cloud server processes', async () => {
        const tempDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-namespace-process-race-'));
        const workerPath = join(testDirectory, 'test-fixtures', 'cloud-server-worker.ts');
        const readyPaths = [join(tempDataDir, 'server-one-ready'), join(tempDataDir, 'server-two-ready')];
        const workers = readyPaths.map((readyPath) => spawn(
            process.execPath,
            [workerPath, tempDataDir, readyPath],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        ));
        const workerStderr = workers.map(collectChildStderr);
        let releaseBodies!: () => void;
        const bodyGate = new Promise<void>((resolve) => {
            releaseBodies = resolve;
        });
        const payload = JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} });
        const createGatedBody = () => new ReadableStream<Uint8Array>({
            start(controller) {
                const splitAt = Math.floor(payload.length / 2);
                controller.enqueue(new TextEncoder().encode(payload.slice(0, splitAt)));
                void bodyGate.then(() => {
                    controller.enqueue(new TextEncoder().encode(payload.slice(splitAt)));
                    controller.close();
                });
            },
        });

        try {
            for (let attempt = 0; attempt < 1_000 && readyPaths.some((path) => !existsSync(path)); attempt += 1) {
                await delay(10);
            }
            if (!readyPaths.every((path) => existsSync(path))) {
                const stderr = workerStderr.map((readStderr) => readStderr()).filter(Boolean).join('\n');
                throw new Error(`Cloud server workers did not become ready: ${stderr}`);
            }
            expect(readyPaths.every((path) => existsSync(path))).toBe(true);
            const ports = readyPaths.map((path) => Number(readFileSync(path, 'utf8')));
            const requests = ports.map((port, index) => fetch(`http://127.0.0.1:${port}/v1/data`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer namespace-process-token-${index}-1234567890`,
                    'content-type': 'application/json',
                },
                body: createGatedBody(),
                duplex: 'half',
            }));
            await delay(50);
            releaseBodies();

            const responses = await Promise.all(requests);
            expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
            expect(readdirSync(tempDataDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);
        } finally {
            releaseBodies();
            for (const worker of workers) worker.kill('SIGKILL');
            await Promise.all(workers.map((worker) => waitForChildExit(worker, 5_000)));
            rmSync(tempDataDir, { recursive: true, force: true });
        }
    // Two spawned server processes on a loaded CI runner need more than bun's
    // 5 s default (flaked 2026-08-31 and 2026-09-02).
    }, 20_000);

    test('caps new namespace creation when any-token mode is enabled', async () => {
        const tempDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-namespace-test-'));
        const firstToken = 'namespace-token-one-1234567890';
        const secondToken = 'namespace-token-two-1234567890';
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: tempDataDir,
            allowedAuthTokens: null,
            maxAnyTokenNamespaces: 1,
        });
        const url = `http://127.0.0.1:${server.port}`;
        try {
            const firstResponse = await fetch(`${url}/v1/data`, {
                headers: { Authorization: `Bearer ${firstToken}` },
            });
            expect(firstResponse.status).toBe(200);

            const secondResponse = await fetch(`${url}/v1/data`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${secondToken}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            });
            expect(secondResponse.status).toBe(403);
            expect((await secondResponse.json()).error).toBe('Token namespace limit reached');

            const existingNamespaceResponse = await fetch(`${url}/v1/data`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${firstToken}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            });
            expect(existingNamespaceResponse.status).toBe(200);
        } finally {
            server.stop();
            rmSync(tempDataDir, { recursive: true, force: true });
        }
    });

    // Table test for the withNamespace() extraction: every namespaced write route
    // must consult the namespace cap through the same shared guard, so a route
    // added later can't silently skip it the way /v1/attachments/orphans did
    // (it copied the auth/rate-limit preamble by hand and dropped the guard call).
    // Regression coverage: this test fails against the pre-refactor server.ts for
    // the two /v1/attachments/orphans cases (verified manually: they returned 200
    // instead of 403 before withNamespace existed).
    const NAMESPACED_WRITE_ROUTES: Array<{ name: string; method: string; path: string; body?: unknown }> = [
        { name: 'POST /v1/tasks', method: 'POST', path: '/v1/tasks', body: { title: 'Namespace probe' } },
        { name: 'PATCH /v1/tasks/:id', method: 'PATCH', path: '/v1/tasks/00000000-0000-4000-8000-000000000000', body: { title: 'x' } },
        { name: 'DELETE /v1/tasks/:id', method: 'DELETE', path: '/v1/tasks/00000000-0000-4000-8000-000000000000' },
        { name: 'POST /v1/tasks/:id/complete', method: 'POST', path: '/v1/tasks/00000000-0000-4000-8000-000000000000/complete' },
        { name: 'POST /v1/tasks/:id/archive', method: 'POST', path: '/v1/tasks/00000000-0000-4000-8000-000000000000/archive' },
        { name: 'POST /v1/projects', method: 'POST', path: '/v1/projects', body: { title: 'Namespace probe' } },
        { name: 'PATCH /v1/projects/:id', method: 'PATCH', path: '/v1/projects/probe-id', body: { title: 'x' } },
        { name: 'DELETE /v1/projects/:id', method: 'DELETE', path: '/v1/projects/probe-id' },
        { name: 'POST /v1/sections', method: 'POST', path: '/v1/sections', body: { title: 'Namespace probe', projectId: 'p1' } },
        { name: 'PATCH /v1/sections/:id', method: 'PATCH', path: '/v1/sections/probe-id', body: { title: 'x' } },
        { name: 'DELETE /v1/sections/:id', method: 'DELETE', path: '/v1/sections/probe-id' },
        { name: 'POST /v1/areas', method: 'POST', path: '/v1/areas', body: { name: 'Namespace probe' } },
        { name: 'PATCH /v1/areas/:id', method: 'PATCH', path: '/v1/areas/probe-id', body: { name: 'x' } },
        { name: 'DELETE /v1/areas/:id', method: 'DELETE', path: '/v1/areas/probe-id' },
        {
            name: 'PUT /v1/data',
            method: 'PUT',
            path: '/v1/data',
            body: { tasks: [], projects: [], sections: [], areas: [], settings: {} },
        },
        { name: 'POST /v1/capture', method: 'POST', path: '/v1/capture', body: { transcription: 'Namespace probe' } },
        { name: 'POST /v1/calendar/feed', method: 'POST', path: '/v1/calendar/feed' },
        { name: 'DELETE /v1/calendar/feed', method: 'DELETE', path: '/v1/calendar/feed' },
        { name: 'POST /v1/attachments/orphans', method: 'POST', path: '/v1/attachments/orphans' },
        { name: 'DELETE /v1/attachments/orphans', method: 'DELETE', path: '/v1/attachments/orphans' },
        { name: 'PUT /v1/attachments/:path', method: 'PUT', path: '/v1/attachments/probe.bin', body: 'raw-bytes' },
    ];

    test('enforces the namespace cap and the rate limiter on every namespaced write route', async () => {
        const tempDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-namespace-routes-test-'));
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: tempDataDir,
            allowedAuthTokens: null,
            // Disabling namespace creation outright means ANY brand-new token's first
            // write must be rejected by the guard, regardless of which route it hits.
            maxAnyTokenNamespaces: 0,
        });
        const url = `http://127.0.0.1:${server.port}`;
        try {
            for (const [index, route] of NAMESPACED_WRITE_ROUTES.entries()) {
                const token = `namespace-route-probe-token-${index}-1234567890`;
                const isJsonBody = typeof route.body === 'object';
                const response = await fetch(`${url}${route.path}`, {
                    method: route.method,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        ...(route.body !== undefined ? { 'content-type': isJsonBody ? 'application/json' : 'application/octet-stream' } : {}),
                    },
                    body: route.body === undefined ? undefined : isJsonBody ? JSON.stringify(route.body) : String(route.body),
                });
                const payload = await response.json().catch(() => null);
                if (response.status !== 403 || payload?.error !== 'Token namespace creation is disabled') {
                    throw new Error(`${route.name}: expected 403 "Token namespace creation is disabled", got ${response.status} ${JSON.stringify(payload)}`);
                }
            }
        } finally {
            server.stop();
            rmSync(tempDataDir, { recursive: true, force: true });
        }
    });

    // Integration-level regression for the same bug: before the fix, a read or
    // cleanup request from a stranger token who had never written data would silently
    // consume the any-token namespace cap by planting an attachments directory as a
    // side effect of path resolution, starving a legitimate first writer.
    test('attachment reads and cleanup never consume the any-token namespace cap', async () => {
        const tempDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-attachment-cap-bypass-'));
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: tempDataDir,
            allowedAuthTokens: null,
            maxAnyTokenNamespaces: 1,
        });
        const url = `http://127.0.0.1:${server.port}`;
        try {
            const strangerToken = 'attachment-cap-bypass-stranger-token-0001';
            const strangerHeaders = { Authorization: `Bearer ${strangerToken}` };
            await fetch(`${url}/v1/attachments/probe.bin`, { headers: strangerHeaders });
            await fetch(`${url}/v1/attachments/probe.bin`, { method: 'DELETE', headers: strangerHeaders });
            await fetch(`${url}/v1/attachments/orphans`, { method: 'POST', headers: strangerHeaders });
            await fetch(`${url}/v1/attachments/orphans`, { method: 'DELETE', headers: strangerHeaders });

            // Neither read consumed the (single) namespace slot, so a different
            // token's first real write must still succeed.
            const writerToken = 'attachment-cap-bypass-writer-token-0001';
            const putResponse = await fetch(`${url}/v1/data`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${writerToken}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            });
            expect(putResponse.status).toBe(200);
        } finally {
            server.stop();
            rmSync(tempDataDir, { recursive: true, force: true });
        }
    });

    test('rate limits a namespaced write route the same as its read route', async () => {
        const tempDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-namespace-rate-test-'));
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: tempDataDir,
            windowMs: 60_000,
            maxPerWindow: 2,
            maxAttachmentPerWindow: 2,
            allowedAuthTokens: new Set(['rate-limit-probe-token-1234567890']),
        });
        const url = `http://127.0.0.1:${server.port}`;
        const authHeaders = { Authorization: 'Bearer rate-limit-probe-token-1234567890' };
        try {
            let lastStatus = 0;
            for (let i = 0; i < 5; i += 1) {
                const response = await fetch(`${url}/v1/attachments/orphans`, {
                    method: 'POST',
                    headers: authHeaders,
                });
                lastStatus = response.status;
                if (lastStatus === 429) break;
            }
            expect(lastStatus).toBe(429);
        } finally {
            server.stop();
            rmSync(tempDataDir, { recursive: true, force: true });
        }
    });
});

describe('cloud server api', () => {
    let dataDir = '';
    let baseUrl = '';
    let stopServer: (() => void) | null = null;
    let completionRecords: CloudRequestCompletion[] = [];

    const integrationToken = 'integration-token-1234567890';
    const authHeaders = {
        Authorization: `Bearer ${integrationToken}`,
    };
    const expectCompletion = (
        completion: CloudRequestCompletion,
        expected: Omit<CloudRequestCompletion, 'elapsedMs'>,
    ): void => {
        const { elapsedMs, ...actual } = completion;
        expect(actual).toEqual(expected);
        expect(Number.isFinite(elapsedMs) && elapsedMs >= 0).toBe(true);
    };
    const getRequestId = (response: Response): string => {
        const requestId = response.headers.get('X-Request-Id');
        expect(requestId).toBeTruthy();
        return requestId!;
    };

    beforeEach(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-test-'));
        completionRecords = [];
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir,
            windowMs: 10_000,
            maxPerWindow: 1_000,
            maxAttachmentPerWindow: 1_000,
            allowedAuthTokens: new Set([integrationToken]),
            logAllRequests: true,
            requestCompletionSink: (record) => completionRecords.push(record),
        });
        baseUrl = `http://127.0.0.1:${server.port}`;
        stopServer = server.stop;
    });

    afterEach(() => {
        stopServer?.();
        stopServer = null;
        if (dataDir) {
            rmSync(dataDir, { recursive: true, force: true });
        }
        dataDir = '';
        baseUrl = '';
    });

    test('handles CORS preflight without requiring auth or returning JSON', async () => {
        const response = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'OPTIONS',
            headers: {
                Origin: corsOrigin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'Authorization, Content-Type',
            },
        });

        expect(response.status).toBe(204);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(corsOrigin);
        expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, If-Match');
        expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS');
        const requestId = getRequestId(response);
        expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id');
        expectCompletion(completionRecords.at(-1)!, {
            requestId,
            method: 'OPTIONS',
            route: '/v1/tasks',
            status: 204,
        });
        expect(await response.text()).toBe('');
    });

    test('keeps liveness independent while readiness fails closed when storage becomes unavailable', async () => {
        const live = await fetch(`${baseUrl}/health`);
        expect(live.status).toBe(200);
        expect(await live.json()).toEqual({ ok: true });

        const ready = await fetch(`${baseUrl}/ready`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ ok: true });
        expectCompletion(completionRecords.at(-1)!, {
            requestId: getRequestId(ready),
            method: 'GET',
            route: '/ready',
            status: 200,
        });

        rmSync(dataDir, { recursive: true, force: true });

        const missingStorage = await fetch(`${baseUrl}/ready`);
        expect(missingStorage.status).toBe(503);
        expect(await missingStorage.json()).toEqual({ ok: false });
        expect(existsSync(dataDir)).toBe(false);
        expectCompletion(completionRecords.at(-1)!, {
            requestId: getRequestId(missingStorage),
            method: 'GET',
            route: '/ready',
            status: 503,
        });

        const missingRead = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(missingRead.status).toBe(503);
        const missingWrite = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }),
        });
        expect(missingWrite.status).toBe(503);
        const missingAttachmentWrite = await fetch(`${baseUrl}/v1/attachments/tasks/test.txt`, {
            method: 'PUT',
            headers: authHeaders,
            body: 'must not be written',
        });
        expect(missingAttachmentWrite.status).toBe(503);
        expect(existsSync(dataDir)).toBe(false);

        mkdirSync(dataDir, { recursive: true });
        const replacementSentinel = join(dataDir, 'replacement-sentinel');
        writeFileSync(replacementSentinel, 'keep');
        const replacedStorage = await fetch(`${baseUrl}/ready`);
        expect(replacedStorage.status).toBe(503);
        expect(await replacedStorage.json()).toEqual({ ok: false });
        const replacedRead = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(replacedRead.status).toBe(503);
        const replacedWrite = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }),
        });
        expect(replacedWrite.status).toBe(503);
        const replacedAttachmentWrite = await fetch(`${baseUrl}/v1/attachments/tasks/test.txt`, {
            method: 'PUT',
            headers: authHeaders,
            body: 'must not be written',
        });
        expect(replacedAttachmentWrite.status).toBe(503);
        expect(readdirSync(dataDir)).toEqual(['replacement-sentinel']);

        rmSync(dataDir, { recursive: true, force: true });
        writeFileSync(dataDir, 'storage unavailable');

        const liveWithoutStorage = await fetch(`${baseUrl}/health`);
        expect(liveWithoutStorage.status).toBe(200);
        expect(await liveWithoutStorage.json()).toEqual({ ok: true });

        const unavailable = await fetch(`${baseUrl}/ready`);
        expect(unavailable.status).toBe(503);
        const unavailableBody = await unavailable.text();
        expect(JSON.parse(unavailableBody)).toEqual({ ok: false });
        expect(unavailableBody).not.toContain(dataDir);
        expectCompletion(completionRecords.at(-1)!, {
            requestId: getRequestId(unavailable),
            method: 'GET',
            route: '/ready',
            status: 503,
        });
    });

    test('fails a large data merge when the configured storage root is replaced mid-write', async () => {
        stopServer?.();
        const isolatedServer = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir,
            maxBodyBytes: 20_000_000,
            requestTimeoutMs: 30_000,
            allowedAuthTokens: new Set([integrationToken]),
        });
        baseUrl = `http://127.0.0.1:${isolatedServer.port}`;
        stopServer = isolatedServer.stop;

        const emptyData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(emptyData),
        });
        expect(seedResponse.status).toBe(200);

        const key = tokenToKey(integrationToken);
        const controlDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-root-replacer-'));
        const readyPath = join(controlDir, 'ready');
        const resultPath = join(controlDir, 'result');
        const displacedDataDir = `${dataDir}-data-write-displaced`;
        const workerPath = join(testDirectory, 'test-fixtures', 'cloud-storage-root-replacer.ts');
        const replacer = spawn(process.execPath, [
            workerPath,
            dataDir,
            displacedDataDir,
            key,
            readyPath,
            resultPath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        const replacerStderr = collectChildStderr(replacer);

        try {
            for (let attempt = 0; attempt < 200 && !existsSync(readyPath); attempt += 1) {
                await delay(5);
            }
            expect(existsSync(readyPath)).toBe(true);

            const iso = '2026-01-01T00:00:00.000Z';
            const tasks = Array.from({ length: 50_000 }, (_, index) => makeTestTask({
                id: `large-root-race-${index}`,
                title: `Large root race ${index}`,
                createdAt: iso,
                updatedAt: iso,
            }));
            const request = fetch(`${baseUrl}/v1/data`, {
                method: 'PUT',
                headers: { ...authHeaders, 'content-type': 'application/json' },
                body: JSON.stringify({ ...emptyData, tasks }),
            });
            const [response, replacerExit] = await Promise.all([
                request,
                waitForChildExit(replacer, 15_000),
            ]);
            if (replacerExit.timedOut) replacer.kill('SIGKILL');

            expect({ ...replacerExit, stderr: replacerStderr() }).toEqual({
                timedOut: false,
                code: 0,
                stderr: '',
            });
            expect(readFileSync(resultPath, 'utf8')).toBe('stage-observed');
            expect(response.status).toBe(503);
            expect(readdirSync(dataDir)).toEqual(['replacement-sentinel']);
            expect(existsSync(join(dataDir, `${key}.json`))).toBe(false);
            expect(existsSync(join(dataDir, '.locks'))).toBe(false);

            const originalData = JSON.parse(readFileSync(join(displacedDataDir, `${key}.json`), 'utf8'));
            expect(originalData.tasks).toHaveLength(0);
        } finally {
            if (replacer.exitCode === null && replacer.signalCode === null) {
                replacer.kill('SIGKILL');
                await waitForChildExit(replacer, 2_000);
            }
            rmSync(controlDir, { recursive: true, force: true });
            rmSync(displacedDataDir, { recursive: true, force: true });
        }
    });

    test('correlates success, validation, authorization, and internal-error responses without sensitive route data', async () => {
        const success = await fetch(`${baseUrl}/health?token=query-secret`);
        const successId = getRequestId(success);
        expect(success.status).toBe(200);
        expectCompletion(completionRecords.at(-1)!, {
            requestId: successId,
            method: 'GET',
            route: '/health',
            status: 200,
        });

        const validation = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: '{}',
        });
        expect(validation.status).toBe(400);
        expectCompletion(completionRecords.at(-1)!, {
            requestId: getRequestId(validation),
            method: 'POST',
            route: '/v1/tasks',
            status: 400,
        });

        const privateEntityId = 'private-project-identifier';
        const authorization = await fetch(`${baseUrl}/v1/projects/${privateEntityId}?credential=query-secret`);
        expect(authorization.status).toBe(401);
        const authorizationRecord = completionRecords.at(-1)!;
        expectCompletion(authorizationRecord, {
            requestId: getRequestId(authorization),
            method: 'GET',
            route: '/v1/projects/:id',
            status: 401,
        });
        const serializedAuthorizationRecord = JSON.stringify(authorizationRecord);
        expect(serializedAuthorizationRecord).not.toContain(privateEntityId);
        expect(serializedAuthorizationRecord).not.toContain('query-secret');
        expect(serializedAuthorizationRecord).not.toContain(integrationToken);

        const namespacePath = join(dataDir, `${tokenToKey(integrationToken)}.json`);
        mkdirSync(namespacePath);
        const internalError = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(internalError.status).toBe(500);
        expectCompletion(completionRecords.at(-1)!, {
            requestId: getRequestId(internalError),
            method: 'GET',
            route: '/v1/data',
            status: 500,
        });
        rmSync(namespacePath, { recursive: true, force: true });
    });

    test('canonicalizes dynamic and unknown paths without retaining identifiers', () => {
        expect(canonicalCloudRoute('/ready')).toBe('/ready');
        expect(canonicalCloudRoute('/v1/tasks/task-secret/complete')).toBe('/v1/tasks/:id/complete');
        expect(canonicalCloudRoute('/v1/attachments/private/folder/file.pdf')).toBe('/v1/attachments/:path');
        expect(canonicalCloudRoute('/v1/calendar/private-token.ics')).toBe('/v1/calendar/:token');
        expect(canonicalCloudRoute('/v1/capture-tokens')).toBe('/v1/capture-tokens');
        expect(canonicalCloudRoute('/v1/capture-tokens/private-id')).toBe('/v1/capture-tokens/:id');
        expect(canonicalCloudRoute('/private/unknown/path')).toBe('unmatched');
    });

    test('logs failures and slow requests by default while gating ordinary completions', () => {
        const ordinary: CloudRequestCompletion = {
            requestId: 'request-id',
            method: 'GET',
            route: '/health',
            status: 200,
            elapsedMs: 5,
        };
        expect(shouldLogCloudRequest(ordinary, false, 1_000)).toBe(false);
        expect(shouldLogCloudRequest({ ...ordinary, status: 401 }, false, 1_000)).toBe(true);
        expect(shouldLogCloudRequest({ ...ordinary, elapsedMs: 1_000 }, false, 1_000)).toBe(true);
        expect(shouldLogCloudRequest(ordinary, true, 1_000)).toBe(true);
    });

    test('correlates rate-limit and timeout responses with their completion records', async () => {
        const isolatedDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-correlation-'));
        const isolatedToken = 'correlation-token-1234567890';
        const isolatedRecords: CloudRequestCompletion[] = [];
        const isolatedServer = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: isolatedDataDir,
            windowMs: 60_000,
            maxPerWindow: 1,
            requestTimeoutMs: 100,
            allowedAuthTokens: new Set([isolatedToken]),
            logAllRequests: true,
            requestCompletionSink: (record) => isolatedRecords.push(record),
        });
        const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.port}`;
        const isolatedAuthHeaders = { Authorization: `Bearer ${isolatedToken}` };

        try {
            const first = await fetch(`${isolatedBaseUrl}/v1/projects`, { headers: isolatedAuthHeaders });
            expect(first.status).toBe(200);
            const rateLimited = await fetch(`${isolatedBaseUrl}/v1/projects`, { headers: isolatedAuthHeaders });
            expect(rateLimited.status).toBe(429);
            expectCompletion(isolatedRecords.at(-1)!, {
                requestId: getRequestId(rateLimited),
                method: 'GET',
                route: '/v1/projects',
                status: 429,
            });

            const stalledBody = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{'));
                },
            });
            const timeout = await fetch(`${isolatedBaseUrl}/v1/data`, {
                method: 'PUT',
                headers: { ...isolatedAuthHeaders, 'content-type': 'application/json' },
                body: stalledBody,
                duplex: 'half',
            });
            expect(timeout.status).toBe(408);
            expectCompletion(isolatedRecords.at(-1)!, {
                requestId: getRequestId(timeout),
                method: 'PUT',
                route: '/v1/data',
                status: 408,
            });
        } finally {
            isolatedServer.stop();
            rmSync(isolatedDataDir, { recursive: true, force: true });
        }
    });

    test('returns post-write metadata for PUT /v1/data', async () => {
        const response = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            } satisfies AppData),
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.ok).toBe(true);
        expect(body.etag).toMatch(/^W\/"mindwtr-/);
        expect(body.remoteFingerprint).toBe(`cloud:v1:etag=${body.etag}`);
        expect(body.serverMergedRemoteData).toBe(false);
        expect(body.contentLength).toBeTruthy();
        expect(response.headers.get('etag')).toBe(body.etag);
        expect(response.headers.get('access-control-expose-headers')).toContain('ETag');
    });

    test('marks PUT /v1/data when existing server data contributes to the stored merge', async () => {
        const seedData: AppData = {
            tasks: [makeTestTask({ id: 'server-only', title: 'Server Only' })],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify(seedData),
        });
        expect(seedResponse.status).toBe(200);

        const staleResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            } satisfies AppData),
        });

        expect(staleResponse.status).toBe(200);
        const body = await staleResponse.json();
        expect(body.serverMergedRemoteData).toBe(true);
        expect(body.remoteFingerprint).toBe(`cloud:v1:etag=${body.etag}`);

        const getResponse = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        const stored = await getResponse.json() as AppData;
        expect(stored.tasks.map((task) => task.id)).toEqual(['server-only']);
    });

    test('PUT /v1/data accepts every core TaskSortBy value and rejects a bogus one', async () => {
        const iso = '2026-01-01T00:00:00.000Z';
        const projects = TASK_SORT_BY_VALUES.map((taskSortBy, index) => ({
            id: `p-${index}`,
            title: `Project ${taskSortBy}`,
            status: 'active' as const,
            color: '#000000',
            order: index,
            tagIds: [],
            taskSortBy,
            createdAt: iso,
            updatedAt: iso,
        }));

        const acceptedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ tasks: [], projects, sections: [], areas: [], settings: {} }),
        });
        expect(acceptedResponse.status).toBe(200);

        const rejectedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [{ ...projects[0], taskSortBy: 'bogus-sort-mode' }],
                sections: [],
                areas: [],
                settings: {},
            }),
        });
        expect(rejectedResponse.status).toBe(400);
    });

    test('auth failure throttling never bypasses token checks for PUT /v1/data', async () => {
        let firstStatus = 0;
        let lastStatus = 0;
        for (let attempt = 0; attempt < 31; attempt += 1) {
            const response = await fetch(`${baseUrl}/v1/data`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            });
            if (attempt === 0) firstStatus = response.status;
            lastStatus = response.status;
        }

        expect(firstStatus).toBe(401);
        expect(lastStatus).toBe(429);
        expect(readdirSync(dataDir)).toEqual([]);
    });

    test('converges concurrent task creation and full data merge writes', async () => {
        const iso = '2026-01-01T00:00:00.000Z';
        const createRequest = fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Task from POST' }),
        });
        const putRequest = fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [makeTestTask({
                    id: 'task-from-put',
                    title: 'Task from PUT',
                    createdAt: iso,
                    updatedAt: iso,
                })],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            } satisfies AppData),
        });

        const [createResponse, putResponse] = await Promise.all([createRequest, putRequest]);
        expect(createResponse.status).toBe(201);
        expect(putResponse.status).toBe(200);
        const createdJson = await createResponse.json();
        const createdId = String(createdJson.task?.id || '');
        expect(createdId).toBeTruthy();

        const dataResponse = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(dataResponse.status).toBe(200);
        const data = await dataResponse.json() as AppData;
        const tasksById = new Map(data.tasks.map((task) => [task.id, task]));
        expect(tasksById.get('task-from-put')?.title).toBe('Task from PUT');
        expect(tasksById.get(createdId)?.title).toBe('Task from POST');
    });

    test('rejects writes when stored namespace data is corrupt before atomic write', async () => {
        const key = tokenToKey(integrationToken);
        const filePath = join(dataDir, `${key}.json`);
        const corruptPayload = '{"tasks":[';
        writeFileSync(filePath, corruptPayload);

        const response = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [makeTestTask({ id: 'replacement-task', title: 'Replacement Task' })],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            } satisfies AppData),
        });

        expect(response.status).toBe(500);
        expect((await response.json()).error).toBe('Stored data failed validation');
        expect(readFileSync(filePath, 'utf8')).toBe(corruptPayload);
    });

    test('refuses REST entity writes and attachment GC when stored namespace data is corrupt', async () => {
        const key = tokenToKey(integrationToken);
        const filePath = join(dataDir, `${key}.json`);
        const corruptPayload = '{"tasks":[';
        writeFileSync(filePath, corruptPayload);

        const postResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'Task from POST' }),
        });
        expect(postResponse.status).toBe(500);
        expect((await postResponse.json()).error).toBe('Stored data failed validation');
        expect(readFileSync(filePath, 'utf8')).toBe(corruptPayload);

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${crypto.randomUUID()}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Should not apply' }),
        });
        expect(patchResponse.status).toBe(500);
        expect((await patchResponse.json()).error).toBe('Stored data failed validation');

        const deleteResponse = await fetch(`${baseUrl}/v1/tasks/${crypto.randomUUID()}`, {
            method: 'DELETE',
            headers: authHeaders,
        });
        expect(deleteResponse.status).toBe(500);
        expect((await deleteResponse.json()).error).toBe('Stored data failed validation');

        const completeResponse = await fetch(`${baseUrl}/v1/tasks/${crypto.randomUUID()}/complete`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(completeResponse.status).toBe(500);
        expect((await completeResponse.json()).error).toBe('Stored data failed validation');

        const gcResponse = await fetch(`${baseUrl}/v1/attachments/orphans`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(gcResponse.status).toBe(500);
        expect((await gcResponse.json()).error).toBe('Stored data failed validation');

        expect(readFileSync(filePath, 'utf8')).toBe(corruptPayload);
    });

    test('refuses REST entity reads and search when stored namespace data is corrupt, but an absent namespace still reads empty', async () => {
        const key = tokenToKey(integrationToken);
        const filePath = join(dataDir, `${key}.json`);
        expect(existsSync(filePath)).toBe(false);

        const emptyTasks = await fetch(`${baseUrl}/v1/tasks`, { headers: authHeaders });
        expect(emptyTasks.status).toBe(200);
        expect((await emptyTasks.json()).tasks).toEqual([]);
        const emptySearch = await fetch(`${baseUrl}/v1/search?query=anything`, { headers: authHeaders });
        expect(emptySearch.status).toBe(200);
        expect((await emptySearch.json()).tasks).toEqual([]);

        const corruptPayload = '{"tasks":[';
        writeFileSync(filePath, corruptPayload);

        const tasksResponse = await fetch(`${baseUrl}/v1/tasks`, { headers: authHeaders });
        expect(tasksResponse.status).toBe(500);
        expect((await tasksResponse.json()).error).toBe('Stored data failed validation');

        const projectsResponse = await fetch(`${baseUrl}/v1/projects`, { headers: authHeaders });
        expect(projectsResponse.status).toBe(500);
        expect((await projectsResponse.json()).error).toBe('Stored data failed validation');

        const singleTaskResponse = await fetch(`${baseUrl}/v1/tasks/${crypto.randomUUID()}`, { headers: authHeaders });
        expect(singleTaskResponse.status).toBe(500);
        expect((await singleTaskResponse.json()).error).toBe('Stored data failed validation');

        const searchResponse = await fetch(`${baseUrl}/v1/search?query=anything`, { headers: authHeaders });
        expect(searchResponse.status).toBe(500);
        expect((await searchResponse.json()).error).toBe('Stored data failed validation');

        expect(readFileSync(filePath, 'utf8')).toBe(corruptPayload);
    });

    test('first write to a namespace with no stored data still succeeds', async () => {
        const key = tokenToKey(integrationToken);
        const filePath = join(dataDir, `${key}.json`);
        expect(existsSync(filePath)).toBe(false);

        const postResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'First task' }),
        });
        expect(postResponse.status).toBe(201);
        const created = await postResponse.json();
        expect(created.task?.title).toBe('First task');
    });

    test('preserves people across /v1/data server-side merges', async () => {
        const seedData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            people: [{
                id: 'person-1',
                name: 'Alex',
                note: 'Design lead',
                referenceLink: 'https://example.com/alex',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                rev: 1,
                revBy: 'device-a',
            }],
            settings: {},
        };
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify(seedData),
        });
        expect(seedResponse.status).toBe(200);

        const staleResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                people: [],
                settings: {},
            } satisfies AppData),
        });
        expect(staleResponse.status).toBe(200);

        const getResponse = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(getResponse.status).toBe(200);
        const data = await getResponse.json() as AppData;
        expect(data.people).toEqual(seedData.people);
    });

    test('returns fast-sync fingerprints for real self-hosted two-device writes', async () => {
        const dataUrl = `${baseUrl}/v1/data`;
        const firstDeviceData: AppData = {
            tasks: [makeTestTask({ id: 'device-a-task', title: 'Device A task' })],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };
        const secondDeviceData: AppData = {
            tasks: [makeTestTask({ id: 'device-b-task', title: 'Device B task' })],
            projects: [],
            sections: [],
            areas: [],
            people: [],
            settings: {},
        };

        const firstWrite = await cloudPutJson(dataUrl, firstDeviceData, {
            token: integrationToken,
            allowInsecureHttp: true,
        });
        expect(firstWrite.serverMergedRemoteData).toBe(false);
        expect(firstWrite.fingerprint).toMatch(/^cloud:v1:etag=/);
        expect(firstWrite.etag).toBeTruthy();

        const firstHead = await cloudHeadJson(dataUrl, {
            token: integrationToken,
            allowInsecureHttp: true,
        });
        expect(firstHead.fingerprint).toBe(firstWrite.fingerprint);

        const secondWrite = await cloudPutJson(dataUrl, secondDeviceData, {
            token: integrationToken,
            allowInsecureHttp: true,
        });
        expect(secondWrite.serverMergedRemoteData).toBe(true);
        expect(secondWrite.fingerprint).toMatch(/^cloud:v1:etag=/);

        const secondHead = await cloudHeadJson(dataUrl, {
            token: integrationToken,
            allowInsecureHttp: true,
        });
        expect(secondHead.fingerprint).toBe(secondWrite.fingerprint);

        const mergedResponse = await fetch(dataUrl, { headers: authHeaders });
        expect(mergedResponse.status).toBe(200);
        const mergedData = await mergedResponse.json() as AppData;
        expect(mergedData.tasks.map((task) => task.id).sort()).toEqual([
            'device-a-task',
            'device-b-task',
        ]);
    });

    test('returns data metadata for HEAD /v1/data without a body', async () => {
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [{
                    id: 'project-multibyte',
                    title: '多字节项目',
                    status: 'active',
                    color: '#2563EB',
                    order: 0,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }],
                sections: [],
                areas: [],
                settings: {},
            }),
        });
        expect(seedResponse.status).toBe(200);

        const response = await fetch(`${baseUrl}/v1/data`, {
            method: 'HEAD',
            headers: authHeaders,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).toMatch(/^W\/"mindwtr-/);
        expect(response.headers.get('last-modified')).toBeTruthy();
        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'GET',
            headers: authHeaders,
        });
        const getBody = await getResponse.text();
        expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(getBody).byteLength));
        expect(await response.text()).toBe('');
    });

    test('serves trusted GET /v1/data cache hits without reparsing JSON', async () => {
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [makeTestTask({
                    id: 'task-trusted-get',
                    title: 'Trusted GET',
                })],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            }),
        });
        expect(seedResponse.status).toBe(200);

        const key = tokenToKey(integrationToken);
        const filePath = join(dataDir, `${key}.json`);
        expect(isTrustedValidatedDataFile(filePath)).toBe(true);

        const parseSpy = spyOn(JSON, 'parse').mockImplementation(() => {
            throw new Error('trusted GET should not parse JSON');
        });
        try {
            const response = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
            expect(response.status).toBe(200);
            expect(await response.text()).toContain('Trusted GET');
        } finally {
            parseSpy.mockRestore();
        }
    });

    test('caches unchanged stat-based data metadata by file stats', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-head-cache-'));
        const filePath = join(tempDir, 'data.json');
        try {
            writeFileSync(filePath, JSON.stringify({ version: 1 }));
            const first = dataMetadataResponse(filePath);
            const second = dataMetadataResponse(filePath);

            expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
            expect(first.headers.get('etag')).toMatch(/^W\/"mindwtr-/);
            expect(__serverDataCacheTestUtils.getDataMetadataCacheSize()).toBeGreaterThan(0);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('supports task CRUD and soft delete flow', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Cloud Task' }),
        });
        expect(createResponse.status).toBe(201);
        const createdJson = await createResponse.json();
        const taskId = createdJson.task.id as string;
        expect(taskId).toBeTruthy();
        expect(createdJson.task.rev).toBe(1);
        expect(createdJson.task.revBy).toBe('cloud');

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Updated Cloud Task' }),
        });
        expect(patchResponse.status).toBe(200);
        const patchJson = await patchResponse.json();
        expect(patchJson.task.rev).toBe(2);
        expect(patchJson.task.revBy).toBe('cloud');

        const getResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const getJson = await getResponse.json();
        expect(getJson.task.title).toBe('Updated Cloud Task');

        const deleteResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'DELETE',
            headers: authHeaders,
        });
        expect(deleteResponse.status).toBe(200);

        const listDeleted = await fetch(`${baseUrl}/v1/tasks?deleted=1&all=1`, {
            headers: authHeaders,
        });
        expect(listDeleted.status).toBe(200);
        const deletedJson = await listDeleted.json();
        const deletedTask = (deletedJson.tasks as { id: string; deletedAt?: string; rev?: number; revBy?: string }[]).find((task) => task.id === taskId);
        expect(deletedTask?.deletedAt).toBeTruthy();
        expect(deletedTask?.rev).toBe(3);
        expect(deletedTask?.revBy).toBe('cloud');

        const getDeleted = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            headers: authHeaders,
        });
        expect(getDeleted.status).toBe(404);

        const patchDeleted = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Should fail' }),
        });
        expect(patchDeleted.status).toBe(404);

        const completeDeleted = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/complete`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(completeDeleted.status).toBe(404);

        const archiveDeleted = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/archive`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(archiveDeleted.status).toBe(404);
    });

    test('guards a task PATCH with the strong ETag from the individual GET', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Concurrent task' }),
        });
        const taskId = (await createResponse.json()).task.id as string;
        const entityUrl = `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`;

        const initialGet = await fetch(entityUrl, { headers: authHeaders });
        const initialEtag = initialGet.headers.get('etag');
        expect(initialEtag).toMatch(/^"mindwtr-entity-sha256-[0-9a-f]{64}"$/);

        const concurrentPatch = await fetch(entityUrl, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ description: 'written concurrently' }),
        });
        expect(concurrentPatch.status).toBe(200);

        const stalePatch = await fetch(entityUrl, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
                'if-match': initialEtag!,
            },
            body: JSON.stringify({ title: 'must not overwrite' }),
        });
        expect(stalePatch.status).toBe(412);
        expect((await stalePatch.json()).error).toBe('Entity changed; refresh and retry');

        const finalGet = await fetch(entityUrl, { headers: authHeaders });
        const finalTask = (await finalGet.json()).task;
        expect(finalTask.title).toBe('Concurrent task');
        expect(finalTask.description).toBe('written concurrently');
    });

    test('accepts a project PATCH with the current individual-entity ETag', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/projects`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Concurrent project' }),
        });
        const projectId = (await createResponse.json()).project.id as string;
        const entityUrl = `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}`;
        const initialGet = await fetch(entityUrl, { headers: authHeaders });
        const initialEtag = initialGet.headers.get('etag');
        expect(initialEtag).toMatch(/^"mindwtr-entity-sha256-[0-9a-f]{64}"$/);

        const guardedPatch = await fetch(entityUrl, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
                'if-match': initialEtag!,
            },
            body: JSON.stringify({ supportNotes: 'guarded update' }),
        });

        expect(guardedPatch.status).toBe(200);
        expect((await guardedPatch.json()).project.supportNotes).toBe('guarded update');
        expect(guardedPatch.headers.get('etag')).toMatch(/^"mindwtr-entity-sha256-[0-9a-f]{64}"$/);
        expect(guardedPatch.headers.get('etag')).not.toBe(initialEtag);
    });

    test('changes task and project ETags for attachment content updates with unchanged parent revisions', async () => {
        const taskId = crypto.randomUUID();
        const unchangedRev = 7;
        const baseAttachment = {
            id: 'file-1',
            kind: 'file' as const,
            title: 'document.txt',
            uri: '',
            cloudKey: 'attachments/file-1.txt',
            fileHash: 'a'.repeat(64),
            contentRev: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const task = makeTestTask({
            id: taskId,
            title: 'Attachment task',
            rev: unchangedRev,
            attachments: [baseAttachment],
        });
        const project = {
            id: 'attachment-project',
            title: 'Attachment project',
            status: 'active' as const,
            color: '#6B7280',
            order: 0,
            tagIds: [],
            rev: unchangedRev,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            attachments: [baseAttachment],
        };
        const putData = async (contentRev: number, fileHash: string) => fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                tasks: [{ ...task, attachments: [{ ...baseAttachment, contentRev, fileHash }] }],
                projects: [{ ...project, attachments: [{ ...baseAttachment, contentRev, fileHash }] }],
                sections: [],
                areas: [],
                settings: {},
            } satisfies AppData),
        });
        expect((await putData(1, 'a'.repeat(64))).status).toBe(200);

        const taskUrl = `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`;
        const projectUrl = `${baseUrl}/v1/projects/${encodeURIComponent(project.id)}`;
        const beforeTask = await fetch(taskUrl, { headers: authHeaders });
        const beforeProject = await fetch(projectUrl, { headers: authHeaders });
        const taskEtag = beforeTask.headers.get('etag');
        const projectEtag = beforeProject.headers.get('etag');

        expect((await putData(2, 'b'.repeat(64))).status).toBe(200);
        const afterTask = await fetch(taskUrl, { headers: authHeaders });
        const afterProject = await fetch(projectUrl, { headers: authHeaders });
        const afterTaskBody = await afterTask.json();
        const afterProjectBody = await afterProject.json();

        expect(afterTaskBody.task.rev).toBe(unchangedRev);
        expect(afterProjectBody.project.rev).toBe(unchangedRev);
        expect(afterTaskBody.task.attachments[0].contentRev).toBe(2);
        expect(afterProjectBody.project.attachments[0].contentRev).toBe(2);
        expect(afterTask.headers.get('etag')).not.toBe(taskEtag);
        expect(afterProject.headers.get('etag')).not.toBe(projectEtag);
    });

    test('promotes an inbox task to next on PATCH startTime with no explicit status', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Inbox task', props: { status: 'inbox' } }),
        });
        const taskId = (await createResponse.json()).task.id as string;

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ startTime: '2026-08-01' }),
        });
        expect(patchResponse.status).toBe(200);
        const patchJson = await patchResponse.json();
        expect(patchJson.task.status).toBe('next');
        expect(patchJson.task.startTime).toBe('2026-08-01');
    });

    test('promotes an inbox task to next on PATCH isFocusedToday (star promotion)', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Inbox task', props: { status: 'inbox' } }),
        });
        const taskId = (await createResponse.json()).task.id as string;

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ isFocusedToday: true }),
        });
        expect(patchResponse.status).toBe(200);
        const patchJson = await patchResponse.json();
        expect(patchJson.task.status).toBe('next');
        expect(patchJson.task.isFocusedToday).toBe(true);
    });

    test('filters GET /v1/tasks by isFocusedToday and rejects a non-boolean value', async () => {
        const create = async (title: string, isFocusedToday: boolean) => {
            const response = await fetch(`${baseUrl}/v1/tasks`, {
                method: 'POST',
                headers: { ...authHeaders, 'content-type': 'application/json' },
                body: JSON.stringify({ title, props: { status: 'next', isFocusedToday } }),
            });
            return (await response.json()).task.id as string;
        };
        const starredId = await create('Starred task', true);
        const plainId = await create('Plain task', false);

        const listTitles = async (queryString: string): Promise<string[]> => {
            const response = await fetch(`${baseUrl}/v1/tasks${queryString}`, { headers: authHeaders });
            expect(response.status).toBe(200);
            return ((await response.json()).tasks as Array<{ id: string }>).map((task) => task.id);
        };

        expect(await listTitles('?isFocusedToday=true')).toContain(starredId);
        expect(await listTitles('?isFocusedToday=true')).not.toContain(plainId);
        // `1` is the convention `all` and `deleted` already use, so both spellings must work.
        expect(await listTitles('?isFocusedToday=1')).toContain(starredId);
        expect(await listTitles('?isFocusedToday=false')).toContain(plainId);
        expect(await listTitles('?isFocusedToday=false')).not.toContain(starredId);
        // Omitting the param must not filter anything out.
        const unfiltered = await listTitles('');
        expect(unfiltered).toContain(starredId);
        expect(unfiltered).toContain(plainId);

        // A garbage value is rejected rather than silently treated as false, which would
        // return the whole list and read as "no tasks are focused".
        const invalid = await fetch(`${baseUrl}/v1/tasks?isFocusedToday=yes`, { headers: authHeaders });
        expect(invalid.status).toBe(400);
    });

    test('unstars and clears focusOrder on PATCH demoting a starred task to inbox', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Next task', props: { status: 'next' } }),
        });
        const taskId = (await createResponse.json()).task.id as string;

        const starResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ isFocusedToday: true, focusOrder: 2 }),
        });
        expect((await starResponse.json()).task.focusOrder).toBe(2);

        const demoteResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'inbox' }),
        });
        expect(demoteResponse.status).toBe(200);
        const demoteJson = await demoteResponse.json();
        expect(demoteJson.task.status).toBe('inbox');
        expect(demoteJson.task.isFocusedToday).toBe(false);
        expect(demoteJson.task.focusOrder).toBeUndefined();
    });

    test('completing a starred task sets completedAt and clears isFocusedToday/focusOrder', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Next task', props: { status: 'next' } }),
        });
        const taskId = (await createResponse.json()).task.id as string;

        await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ isFocusedToday: true, focusOrder: 5 }),
        });

        const doneResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'done' }),
        });
        expect(doneResponse.status).toBe(200);
        const doneJson = await doneResponse.json();
        expect(doneJson.task.status).toBe('done');
        expect(doneJson.task.completedAt).toBeTruthy();
        expect(doneJson.task.isFocusedToday).toBe(false);
        expect(doneJson.task.focusOrder).toBeUndefined();
    });

    test('clears boardOrder on PATCH status change that does not itself set boardOrder', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Next task', props: { status: 'next' } }),
        });
        const taskId = (await createResponse.json()).task.id as string;

        const boardResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ boardOrder: 3 }),
        });
        expect((await boardResponse.json()).task.boardOrder).toBe(3);

        const statusResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'waiting' }),
        });
        expect(statusResponse.status).toBe(200);
        const statusJson = await statusResponse.json();
        expect(statusJson.task.status).toBe('waiting');
        expect(statusJson.task.boardOrder).toBeUndefined();
    });

    test('an explicit status in the same PATCH body as startTime wins over promotion', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Inbox task', props: { status: 'inbox' } }),
        });
        const taskId = (await createResponse.json()).task.id as string;

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ startTime: '2026-08-01', status: 'inbox' }),
        });
        expect(patchResponse.status).toBe(200);
        const patchJson = await patchResponse.json();
        expect(patchJson.task.status).toBe('inbox');
        expect(patchJson.task.startTime).toBe('2026-08-01');
    });

    test('POST /v1/tasks promotes to next on a start date with no explicit status', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Captured with start', props: { startTime: '2026-08-01' } }),
        });
        expect(createResponse.status).toBe(201);
        const createdJson = await createResponse.json();
        expect(createdJson.task.status).toBe('next');
        expect(createdJson.task.startTime).toBe('2026-08-01');
    });

    test('POST /v1/tasks honours an explicit inbox status alongside a start date', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Captured with explicit inbox',
                props: { startTime: '2026-08-01', status: 'inbox' },
            }),
        });
        expect(createResponse.status).toBe(201);
        const createdJson = await createResponse.json();
        expect(createdJson.task.status).toBe('inbox');
        expect(createdJson.task.startTime).toBe('2026-08-01');
    });

    test('finalizes task REST writes before storing data', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                title: 'Dangling create',
                props: {
                    projectId: 'missing-project',
                    sectionId: 'missing-section',
                    areaId: 'missing-area',
                },
            }),
        });
        expect(createResponse.status).toBe(400);
        expect((await createResponse.json()).error).toContain('references missing or deleted project');

        const validCreateResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Valid task' }),
        });
        expect(validCreateResponse.status).toBe(201);
        const validCreatedJson = await validCreateResponse.json();
        const validTask = validCreatedJson.task as Task;

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(validTask.id)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                projectId: 'missing-project-after-patch',
                sectionId: 'missing-section-after-patch',
                areaId: 'missing-area-after-patch',
            }),
        });
        expect(patchResponse.status).toBe(400);
        expect((await patchResponse.json()).error).toContain('references missing or deleted project');

        const dataResponse = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(dataResponse.status).toBe(200);
        const stored = await dataResponse.json() as AppData;
        expect(stored.tasks).toHaveLength(1);
        const storedTask = stored.tasks.find((task) => task.id === validTask.id);
        expect(storedTask?.projectId).toBeUndefined();
        expect(storedTask?.sectionId).toBeUndefined();
        expect(storedTask?.areaId).toBeUndefined();
    });

    test('rejects invalid task ids in task and task-action routes', async () => {
        const invalidGet = await fetch(`${baseUrl}/v1/tasks/not-a-uuid`, {
            headers: authHeaders,
        });
        expect(invalidGet.status).toBe(400);
        expect((await invalidGet.json()).error).toBe('Invalid task id');

        const invalidAction = await fetch(`${baseUrl}/v1/tasks/not-a-uuid/complete`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(invalidAction.status).toBe(400);
        expect((await invalidAction.json()).error).toBe('Invalid task id');
    });

    test('paginates /v1/search results for both tasks and projects', async () => {
        const iso = '2026-01-01T00:00:00.000Z';
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [
                    { id: 'task-1', title: 'Alpha Task 1', status: 'inbox', createdAt: iso, updatedAt: iso },
                    { id: 'task-2', title: 'Alpha Task 2', status: 'inbox', createdAt: iso, updatedAt: iso },
                    { id: 'task-3', title: 'Alpha Task 3', status: 'inbox', createdAt: iso, updatedAt: iso },
                ],
                projects: [
                    { id: 'project-1', title: 'Alpha Project 1', status: 'active', createdAt: iso, updatedAt: iso },
                    { id: 'project-2', title: 'Alpha Project 2', status: 'active', createdAt: iso, updatedAt: iso },
                    { id: 'project-3', title: 'Alpha Project 3', status: 'active', createdAt: iso, updatedAt: iso },
                ],
                sections: [],
                areas: [],
                settings: {},
            }),
        });
        expect(seedResponse.status).toBe(200);

        const response = await fetch(`${baseUrl}/v1/search?query=Alpha&limit=2&offset=1`, {
            headers: authHeaders,
        });
        expect(response.status).toBe(200);

        const body = await response.json();
        expect(body.limit).toBe(2);
        expect(body.offset).toBe(1);
        expect(body.taskTotal).toBe(3);
        expect(body.projectTotal).toBe(3);
        expect((body.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual(['task-2', 'task-3']);
        expect((body.projects as Array<{ id: string }>).map((project) => project.id)).toEqual(['project-2', 'project-3']);

        const independentResponse = await fetch(`${baseUrl}/v1/search?query=Alpha&limit=2&taskOffset=2&projectOffset=0`, {
            headers: authHeaders,
        });
        expect(independentResponse.status).toBe(200);
        const independentBody = await independentResponse.json();
        expect(independentBody.taskOffset).toBe(2);
        expect(independentBody.projectOffset).toBe(0);
        expect((independentBody.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual(['task-3']);
        expect((independentBody.projects as Array<{ id: string }>).map((project) => project.id)).toEqual(['project-1', 'project-2']);
    });

    test('supports REST create and patch for areas, projects, and sections', async () => {
        const areaResponse = await fetch(`${baseUrl}/v1/areas`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Work', props: { color: '#2563eb' } }),
        });
        expect(areaResponse.status).toBe(201);
        const areaBody = await areaResponse.json();
        const areaId = areaBody.area.id as string;

        const projectResponse = await fetch(`${baseUrl}/v1/projects`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Launch', props: { areaId } }),
        });
        expect(projectResponse.status).toBe(201);
        const projectBody = await projectResponse.json();
        const projectId = projectBody.project.id as string;
        expect(projectBody.project.areaId).toBe(areaId);

        const sectionResponse = await fetch(`${baseUrl}/v1/sections`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ projectId, title: 'Planning' }),
        });
        expect(sectionResponse.status).toBe(201);
        const sectionBody = await sectionResponse.json();
        const sectionId = sectionBody.section.id as string;

        const patchProject = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Launch v2' }),
        });
        expect(patchProject.status).toBe(200);
        expect((await patchProject.json()).project.title).toBe('Launch v2');

        const rejectEmptyArea = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ areaId: '' }),
        });
        expect(rejectEmptyArea.status).toBe(400);
        expect((await rejectEmptyArea.json()).error).toBe('Invalid area id');

        const clearArea = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ areaId: null }),
        });
        expect(clearArea.status).toBe(200);
        expect((await clearArea.json()).project.areaId).toBeUndefined();

        const patchSection = await fetch(`${baseUrl}/v1/sections/${encodeURIComponent(sectionId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Planning v2' }),
        });
        expect(patchSection.status).toBe(200);
        expect((await patchSection.json()).section.title).toBe('Planning v2');

        const patchArea = await fetch(`${baseUrl}/v1/areas/${encodeURIComponent(areaId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Work v2' }),
        });
        expect(patchArea.status).toBe(200);
        expect((await patchArea.json()).area.name).toBe('Work v2');

        const projectsList = await fetch(`${baseUrl}/v1/projects`, { headers: authHeaders });
        const sectionsList = await fetch(`${baseUrl}/v1/sections?projectId=${encodeURIComponent(projectId)}`, { headers: authHeaders });
        const areasList = await fetch(`${baseUrl}/v1/areas`, { headers: authHeaders });
        expect((await projectsList.json()).total).toBe(1);
        expect((await sectionsList.json()).total).toBe(1);
        expect((await areasList.json()).total).toBe(1);
    });

    test('purges deleted REST projects with refcounted remote attachment cleanup', async () => {
        const iso = '2026-01-01T00:00:00.000Z';
        const purgeIso = '2026-01-02T00:00:00.000Z';
        const projectOnlyCloudKey = 'attachments/project-only.bin';
        const sharedCloudKey = 'attachments/shared.bin';
        const attachmentBase = {
            kind: 'file' as const,
            uri: '',
            createdAt: iso,
            updatedAt: iso,
            localStatus: 'available' as const,
        };

        const seedData: AppData = {
            tasks: [makeTestTask({
                id: 'task-retaining-shared',
                title: 'Retains shared attachment',
                attachments: [{
                    ...attachmentBase,
                    id: 'task-att-shared',
                    title: 'shared.bin',
                    cloudKey: sharedCloudKey,
                }],
            })],
            projects: [{
                id: 'project-purged',
                title: 'Purged project',
                status: 'active',
                color: '#6B7280',
                order: 0,
                tagIds: [],
                createdAt: iso,
                updatedAt: iso,
                deletedAt: iso,
                supportNotes: 'Private project notes',
                attachments: [
                    {
                        ...attachmentBase,
                        id: 'project-att-only',
                        title: 'project-only.bin',
                        cloudKey: projectOnlyCloudKey,
                    },
                    {
                        ...attachmentBase,
                        id: 'project-att-shared',
                        title: 'shared.bin',
                        cloudKey: sharedCloudKey,
                    },
                ],
            }],
            sections: [{
                id: 'section-purged',
                projectId: 'project-purged',
                title: 'Private section',
                description: 'Private section notes',
                order: 0,
                createdAt: iso,
                updatedAt: iso,
                deletedAt: iso,
            }],
            areas: [],
            people: [],
            settings: {},
        };
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify(seedData),
        });
        expect(seedResponse.status).toBe(200);

        const purgeResponse = await fetch(`${baseUrl}/v1/projects/project-purged`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ purgedAt: purgeIso }),
        });
        expect(purgeResponse.status).toBe(200);
        const purgeBody = await purgeResponse.json();
        expect(purgeBody.project.title).toBe('(deleted)');
        expect(purgeBody.project.purgedAt).toBe(purgeIso);
        expect(purgeBody.project.supportNotes).toBeUndefined();
        expect(purgeBody.project.attachments).toBeUndefined();

        const dataResponse = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(dataResponse.status).toBe(200);
        const storedData = await dataResponse.json() as AppData;
        const storedProject = storedData.projects.find((project) => project.id === 'project-purged');
        expect(storedProject?.title).toBe('(deleted)');
        expect(storedProject?.purgedAt).toBe(purgeIso);
        expect(storedProject?.supportNotes).toBeUndefined();
        expect(storedProject?.attachments).toBeUndefined();
        const storedSection = storedData.sections.find((section) => section.id === 'section-purged');
        expect(storedSection?.title).toBe('');
        expect(storedSection?.deletedAt).toBe(purgeIso);
        expect(storedSection?.description).toBeUndefined();
        expect(storedData.settings.attachments?.pendingRemoteDeletes).toEqual([{
            cloudKey: projectOnlyCloudKey,
        }]);
    });

    test('validates REST project, section, and area inputs consistently', async () => {
        const longName = 'x'.repeat(501);
        const reservedProject = await fetch(`${baseUrl}/v1/projects`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Reserved', props: { id: 'override', rev: 99 } }),
        });
        expect(reservedProject.status).toBe(400);
        expect((await reservedProject.json()).error).toContain('Unsupported project props');

        const missingAreaProject = await fetch(`${baseUrl}/v1/projects`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Dangling project', props: { areaId: 'missing-area' } }),
        });
        expect(missingAreaProject.status).toBe(404);

        const longSection = await fetch(`${baseUrl}/v1/sections`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ projectId: 'missing-project', title: longName }),
        });
        expect(longSection.status).toBe(400);
        expect((await longSection.json()).error).toContain('Section title too long');

        const longArea = await fetch(`${baseUrl}/v1/areas`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ name: longName }),
        });
        expect(longArea.status).toBe(400);
        expect((await longArea.json()).error).toContain('Area name too long');
    });

    test('/v1/search reports the true total and pages correctly past 200 matches', async () => {
        // searchAll() (packages/core/src/search.ts) internally truncates its returned tasks/
        // projects arrays to SEARCH_RESULT_LIMIT (200) before returning. /v1/search used to
        // read taskTotal off that already-truncated array and slice it again for offset/limit,
        // so a query with more than 200 true matches reported taskTotal capped at 200, and any
        // offset past 200 always returned an empty page. This seeds 250 matching tasks to prove
        // both are fixed: taskTotal reflects the true count, and offset=200 returns the
        // remaining 50 rather than nothing.
        const iso = '2026-01-01T00:00:00.000Z';
        const tasks = Array.from({ length: 250 }, (_, index) => ({
            id: `search-total-task-${String(index).padStart(3, '0')}`,
            title: `Alpha Task ${String(index).padStart(3, '0')}`,
            status: 'inbox',
            createdAt: iso,
            updatedAt: iso,
        }));
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ tasks, projects: [], sections: [], areas: [], settings: {} }),
        });
        expect(seedResponse.status).toBe(200);

        const totalResponse = await fetch(`${baseUrl}/v1/search?query=Alpha&limit=10`, {
            headers: authHeaders,
        });
        expect(totalResponse.status).toBe(200);
        const totalBody = await totalResponse.json();
        expect(totalBody.taskTotal).toBe(250);
        expect((totalBody.tasks as unknown[]).length).toBe(10);

        const pastLimitResponse = await fetch(`${baseUrl}/v1/search?query=Alpha&taskOffset=200&taskLimit=100`, {
            headers: authHeaders,
        });
        expect(pastLimitResponse.status).toBe(200);
        const pastLimitBody = await pastLimitResponse.json();
        expect(pastLimitBody.taskTotal).toBe(250);
        expect((pastLimitBody.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual(
            tasks.slice(200).map((task) => task.id),
        );
    });

    test('/v1/tasks?query= reports the true total and pages correctly past 200 matches', async () => {
        // Same truncation class as /v1/search above: pickTaskList used to intersect against
        // searchAll()'s 200-capped result, so a query with more than 200 matches lost the
        // tail before the route ever paginated. It now uses filterTasksBySearch (unsliced).
        const iso = '2026-01-01T00:00:00.000Z';
        const tasks = Array.from({ length: 250 }, (_, index) => ({
            id: `tasks-query-total-${String(index).padStart(3, '0')}`,
            title: `Beta Task ${String(index).padStart(3, '0')}`,
            status: 'inbox',
            createdAt: iso,
            updatedAt: iso,
        }));
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ tasks, projects: [], sections: [], areas: [], settings: {} }),
        });
        expect(seedResponse.status).toBe(200);

        const pastLimitResponse = await fetch(`${baseUrl}/v1/tasks?query=Beta&offset=200&limit=100`, {
            headers: authHeaders,
        });
        expect(pastLimitResponse.status).toBe(200);
        const pastLimitBody = await pastLimitResponse.json();
        expect(pastLimitBody.total).toBe(250);
        expect((pastLimitBody.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual(
            tasks.slice(200).map((task) => task.id),
        );
    });

    test('rejects invalid /v1/search pagination parameters', async () => {
        const response = await fetch(`${baseUrl}/v1/search?query=Alpha&limit=0`, {
            headers: authHeaders,
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('Invalid limit');
    });

    test('rejects reserved fields on task patch', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Cloud Task' }),
        });
        expect(createResponse.status).toBe(201);
        const createdJson = await createResponse.json();
        const taskId = createdJson.task.id as string;

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                id: 'override',
                rev: 99,
                createdAt: '2026-01-01T00:00:00.000Z',
                arbitrary: 'value',
            }),
        });
        expect(patchResponse.status).toBe(400);
        const payload = await patchResponse.json();
        expect(payload.error).toContain('Unsupported task updates');
    });

    test('bumps revision when completing and archiving a task', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Revision Task' }),
        });
        expect(createResponse.status).toBe(201);
        const createdJson = await createResponse.json();
        const taskId = createdJson.task.id as string;

        const completeResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/complete`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(completeResponse.status).toBe(200);
        const completeJson = await completeResponse.json();
        expect(completeJson.task.status).toBe('done');
        expect(completeJson.task.rev).toBe(2);
        expect(completeJson.task.revBy).toBe('cloud');

        const archiveResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/archive`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(archiveResponse.status).toBe(200);
        const archiveJson = await archiveResponse.json();
        expect(archiveJson.task.status).toBe('archived');
        expect(archiveJson.task.rev).toBe(3);
        expect(archiveJson.task.revBy).toBe('cloud');
    });

    test('reserves a project order for a recurring follow-up created via /complete', async () => {
        const projectResponse = await fetch(`${baseUrl}/v1/projects`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Recurring Project' }),
        });
        expect(projectResponse.status).toBe(201);
        const projectId = (await projectResponse.json()).project.id as string;

        const taskResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Recurring Task',
                props: {
                    projectId,
                    dueDate: '2026-08-20',
                    recurrence: { rule: 'daily' },
                },
            }),
        });
        expect(taskResponse.status).toBe(201);
        const taskId = (await taskResponse.json()).task.id as string;

        const completeResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/complete`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(completeResponse.status).toBe(200);

        const listResponse = await fetch(`${baseUrl}/v1/tasks?limit=100`, { headers: authHeaders });
        expect(listResponse.status).toBe(200);
        const listJson = await listResponse.json();
        const followUp = (listJson.tasks as Task[]).find((task) => task.projectId === projectId && task.id !== taskId);
        expect(followUp).toBeTruthy();
        // REST-created tasks carry no order, so this exercises the reservation
        // fallback; the inheritance path is covered against seeded data below.
        expect(Number.isFinite(followUp?.order)).toBe(true);
        expect(followUp?.orderNum).toBe(followUp?.order);
        expect(followUp?.pushCount).toBe(0);
    });

    test('reserves a project order for a recurring follow-up created via a status PATCH', async () => {
        const projectResponse = await fetch(`${baseUrl}/v1/projects`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Recurring Project 2' }),
        });
        expect(projectResponse.status).toBe(201);
        const projectId = (await projectResponse.json()).project.id as string;

        const taskResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                title: 'Recurring Task 2',
                props: {
                    projectId,
                    dueDate: '2026-08-20',
                    recurrence: { rule: 'daily' },
                },
            }),
        });
        expect(taskResponse.status).toBe(201);
        const taskId = (await taskResponse.json()).task.id as string;

        const patchResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'done' }),
        });
        expect(patchResponse.status).toBe(200);

        const listResponse = await fetch(`${baseUrl}/v1/tasks?limit=100`, { headers: authHeaders });
        expect(listResponse.status).toBe(200);
        const listJson = await listResponse.json();
        const followUp = (listJson.tasks as Task[]).find((task) => task.projectId === projectId && task.id !== taskId);
        expect(followUp).toBeTruthy();
        // REST-created tasks carry no order, so this exercises the reservation
        // fallback; the inheritance path is covered against seeded data below.
        expect(Number.isFinite(followUp?.order)).toBe(true);
        expect(followUp?.orderNum).toBe(followUp?.order);
        expect(followUp?.pushCount).toBe(0);
    });

    test('reserves a project order for a REST-created task', async () => {
        const projectResponse = await fetch(`${baseUrl}/v1/projects`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Ordered Project' }),
        });
        expect(projectResponse.status).toBe(201);
        const projectId = (await projectResponse.json()).project.id as string;

        const siblingResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Sibling', props: { projectId } }),
        });
        expect(siblingResponse.status).toBe(201);
        const sibling = (await siblingResponse.json()).task as Task;
        expect(sibling.order).toBe(0);

        const taskResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'New Task', props: { projectId } }),
        });
        expect(taskResponse.status).toBe(201);
        const task = (await taskResponse.json()).task as Task;
        expect(task.order).toBe(1);
        expect(task.orderNum).toBe(1);
    });

    // Documents synced from the apps do carry an order, and there the next
    // occurrence must hold the completed task's place rather than sort below
    // every sibling -- matching core's stampNewRecurringFollowUp.
    test('gives a recurring follow-up the completed task place when the document carries an order', async () => {
        const projectId = '11111111-2222-4333-8444-555555555555';
        const recurringId = '11111111-2222-4333-8444-666666666666';
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                tasks: [
                    makeTestTask({
                        id: recurringId,
                        title: 'Ordered Recurring',
                        status: 'next',
                        projectId,
                        order: 0,
                        orderNum: 0,
                        dueDate: '2026-08-20',
                        recurrence: { rule: 'daily' },
                    }),
                    makeTestTask({
                        id: '11111111-2222-4333-8444-777777777777',
                        title: 'Ordered Sibling',
                        status: 'next',
                        projectId,
                        order: 1,
                        orderNum: 1,
                    }),
                ],
                projects: [{
                    id: projectId,
                    title: 'Ordered Project',
                    status: 'active',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }],
                sections: [],
                areas: [],
                settings: {},
            } satisfies AppData),
        });
        expect(seedResponse.status).toBe(200);

        const completeResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(recurringId)}/complete`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(completeResponse.status).toBe(200);

        const listResponse = await fetch(`${baseUrl}/v1/tasks?limit=100`, { headers: authHeaders });
        expect(listResponse.status).toBe(200);
        const listJson = await listResponse.json();
        const followUp = (listJson.tasks as Task[])
            .find((task) => task.title === 'Ordered Recurring' && task.id !== recurringId);
        expect(followUp).toBeTruthy();
        expect(followUp?.order).toBe(0);
        expect(followUp?.orderNum).toBe(0);
        expect(followUp?.pushCount).toBe(0);
    });

    test('rejects reserved fields on task creation', async () => {
        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                title: 'Cloud Task',
                props: {
                    rev: 99,
                    deletedAt: '2026-01-01T00:00:00.000Z',
                },
            }),
        });
        expect(createResponse.status).toBe(400);
        const payload = await createResponse.json();
        expect(payload.error).toContain('Unsupported task props');
    });

    test('rejects invalid task prop values on REST writes', async () => {
        const invalidCreate = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Cloud Task', props: { repeatReminderMinutes: 7 } }),
        });
        expect(invalidCreate.status).toBe(400);
        expect((await invalidCreate.json()).error).toContain('repeatReminderMinutes');

        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ title: 'Cloud Task' }),
        });
        expect(createResponse.status).toBe(201);
        const created = (await createResponse.json()).task as Task;

        const invalidOffsetPatch = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(created.id)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ relativeStartOffset: { amount: 1, unit: 'day' } }),
        });
        expect(invalidOffsetPatch.status).toBe(400);
        expect((await invalidOffsetPatch.json()).error).toContain('relativeStartOffset');

        const invalidRecurrencePatch = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(created.id)}`, {
            method: 'PATCH',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ recurrence: { rule: 'daily', arbitrary: true } }),
        });
        expect(invalidRecurrencePatch.status).toBe(400);
        expect((await invalidRecurrencePatch.json()).error).toContain('recurrence');
    });

    test('accepts quick-add input longer than the task title limit when the parsed title stays short', async () => {
        const input = `Cloud Task /note:${'x'.repeat(700)}`;
        expect(input.length).toBeGreaterThan(500);

        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ input }),
        });

        expect(createResponse.status).toBe(201);
        const payload = await createResponse.json();
        expect(payload.task.title).toBe('Cloud Task');
    });

    test('rejects quick-add input above the cloud quick-add length cap', async () => {
        const input = `Cloud Task /note:${'x'.repeat(2100)}`;

        const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ input }),
        });

        expect(createResponse.status).toBe(400);
        expect((await createResponse.json()).error).toBe('Quick-add input too long (max 2000 characters)');
    });

    test('auth failure rate limiting does not trust spoofed forwarded IP headers by default', async () => {
        let lastStatus = 0;
        for (let attempt = 0; attempt < 31; attempt += 1) {
            const response = await fetch(`${baseUrl}/v1/tasks`, {
                headers: {
                    'x-forwarded-for': `203.0.113.${attempt}`,
                },
            });
            lastStatus = response.status;
        }
        expect(lastStatus).toBe(429);
    });

    test('supports attachment upload/download/delete endpoints', async () => {
        const payload = new TextEncoder().encode('attachment-bytes');
        const putResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/octet-stream',
            },
            body: payload,
        });
        expect(putResponse.status).toBe(200);

        const getResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const downloaded = new Uint8Array(await getResponse.arrayBuffer());
        expect(Array.from(downloaded)).toEqual(Array.from(payload));

        // #1119 presence pass: HEAD answers the same question without the bytes.
        const headResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            method: 'HEAD',
            headers: authHeaders,
        });
        expect(headResponse.status).toBe(200);
        expect(headResponse.headers.get('content-length')).toBe(String(payload.byteLength));
        expect(new Uint8Array(await headResponse.arrayBuffer())).toHaveLength(0);

        const unauthorizedHead = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            method: 'HEAD',
        });
        expect(unauthorizedHead.status).toBe(401);

        const deleteResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            method: 'DELETE',
            headers: authHeaders,
        });
        expect(deleteResponse.status).toBe(200);

        const missingResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            headers: authHeaders,
        });
        expect(missingResponse.status).toBe(404);

        const missingHead = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            method: 'HEAD',
            headers: authHeaders,
        });
        expect(missingHead.status).toBe(404);
    });

    test('fails a partial attachment upload when the configured storage root is replaced', async () => {
        const key = tokenToKey(integrationToken);
        const relativePath = 'stream/replaced-root.bin';
        const attachmentParent = join(dataDir, key, 'attachments', 'stream');
        const replacementTarget = join(dataDir, key, 'attachments', relativePath);
        const displacedDataDir = `${dataDir}-displaced`;
        const firstChunk = 'first-half-';
        const secondChunk = 'second-half';
        const contentLength = Buffer.byteLength(firstChunk) + Buffer.byteLength(secondChunk);
        const serverPort = Number(new URL(baseUrl).port);
        const socket = connect({ host: '127.0.0.1', port: serverPort });
        let rawResponse = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            rawResponse += chunk;
        });

        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('error', reject);
            });
            const responseFinished = new Promise<void>((resolve, reject) => {
                socket.once('end', resolve);
                socket.once('error', reject);
            });
            socket.write([
                `PUT /v1/attachments/${relativePath} HTTP/1.1`,
                `Host: 127.0.0.1:${serverPort}`,
                `Authorization: Bearer ${integrationToken}`,
                'Content-Type: application/octet-stream',
                `Content-Length: ${contentLength}`,
                'Connection: close',
                '',
                firstChunk,
            ].join('\r\n'));

            let stagedBeforeReplacement = false;
            for (let attempt = 0; attempt < 200; attempt += 1) {
                if (
                    existsSync(attachmentParent)
                    && readdirSync(attachmentParent).some((name) => name.startsWith('.mindwtr-upload-'))
                ) {
                    stagedBeforeReplacement = true;
                    break;
                }
                await delay(5);
            }
            expect(stagedBeforeReplacement).toBe(true);

            renameSync(dataDir, displacedDataDir);
            mkdirSync(dataDir);
            writeFileSync(join(dataDir, 'replacement-sentinel'), 'keep');
            socket.write(secondChunk);

            await Promise.race([
                responseFinished,
                delay(2_000).then(() => {
                    throw new Error('Timed out waiting for partial attachment upload response');
                }),
            ]);

            expect(rawResponse.split('\r\n', 1)[0]).toContain(' 503 ');
            expect(existsSync(replacementTarget)).toBe(false);
            expect(readdirSync(dataDir)).toEqual(['replacement-sentinel']);
        } finally {
            socket.destroy();
            rmSync(displacedDataDir, { recursive: true, force: true });
        }
    });

    test('returns redacted retryable 5xx for attachment directory durability failures while unsafe paths stay 400', async () => {
        const unsafeResponse = await fetch(`${baseUrl}/v1/attachments/%252e%252e/private.bin`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('unsafe'),
        });
        expect(unsafeResponse.status).toBe(400);

        const isolatedDataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-directory-failure-'));
        const sensitivePath = join(isolatedDataDir, 'private-namespace', 'attachments');
        const captured: string[] = [];
        const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        });
        const isolatedServer = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir: isolatedDataDir,
            allowedAuthTokens: new Set([integrationToken]),
            attachmentPathResolver: () => {
                throw Object.assign(new Error(`fsync failed for ${sensitivePath}`), { code: 'EIO' });
            },
        });

        try {
            const response = await fetch(
                `http://127.0.0.1:${isolatedServer.port}/v1/attachments/private.bin`,
                {
                    method: 'PUT',
                    headers: authHeaders,
                    body: new TextEncoder().encode('private bytes'),
                },
            );

            expect(response.status).toBe(500);
            expect((await response.json()).error).toBe('Internal server error');
            const serializedLogs = captured.join('');
            expect(serializedLogs).toContain('"failureClass":"filesystem"');
            expect(serializedLogs).toContain('"failureCode":"attachment_io_failed"');
            expect(serializedLogs).not.toContain(sensitivePath);
            expect(serializedLogs).not.toContain('fsync failed');
            expect(serializedLogs).not.toContain('private bytes');
        } finally {
            isolatedServer.stop();
            stderrSpy.mockRestore();
            rmSync(isolatedDataDir, { recursive: true, force: true });
        }
    });

    test('logs attachment filesystem failures without namespace hashes or paths', async () => {
        const key = tokenToKey(integrationToken);
        const privateRelativePath = 'private-folder/private-file.bin';
        const destinationPath = join(dataDir, key, 'attachments', privateRelativePath);
        mkdirSync(destinationPath, { recursive: true });
        const captured: string[] = [];
        const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        });

        try {
            const response = await fetch(`${baseUrl}/v1/attachments/${privateRelativePath}`, {
                method: 'PUT',
                headers: authHeaders,
                body: new TextEncoder().encode('private attachment bytes'),
            });

            expect(response.status).toBe(500);
            const serializedLogs = captured.join('');
            expect(serializedLogs).toContain('"failureClass":"filesystem"');
            expect(serializedLogs).toContain('"failureCode":"attachment_io_failed"');
            // S10: the durability failure log carries the bare errno (renaming a
            // published file onto an existing directory fails with EISDIR) so an
            // operator can diagnose without the log ever holding a path or message.
            expect(serializedLogs).toContain('"failureErrno":"EISDIR"');
            expect(serializedLogs).not.toContain(key);
            expect(serializedLogs).not.toContain(dataDir);
            expect(serializedLogs).not.toContain(privateRelativePath);
            expect(serializedLogs).not.toContain(destinationPath);
            expect(serializedLogs).not.toContain('private attachment bytes');
        } finally {
            stderrSpy.mockRestore();
        }
    });

    test('garbage-collects unreferenced attachment files on demand', async () => {
        const referencedPath = 'folder/referenced.bin';
        const orphanPath = 'folder/orphan.bin';
        const uploadReferenced = await fetch(`${baseUrl}/v1/attachments/${referencedPath}`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('referenced'),
        });
        const uploadOrphan = await fetch(`${baseUrl}/v1/attachments/${orphanPath}`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('orphan'),
        });
        expect(uploadReferenced.status).toBe(200);
        expect(uploadOrphan.status).toBe(200);
        const key = tokenToKey(integrationToken);
        expireFileForOrphanGc(join(dataDir, key, 'attachments', orphanPath));

        const iso = '2026-01-01T00:00:00.000Z';
        const seedResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [{
                    id: 'task-with-attachment',
                    title: 'Task with attachment',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    createdAt: iso,
                    updatedAt: iso,
                    attachments: [{
                        id: 'att-1',
                        kind: 'file',
                        title: 'referenced.bin',
                        uri: '',
                        cloudKey: referencedPath,
                        createdAt: iso,
                        updatedAt: iso,
                    }],
                }],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            }),
        });
        expect(seedResponse.status).toBe(200);

        const gcResponse = await fetch(`${baseUrl}/v1/attachments/orphans`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(gcResponse.status).toBe(200);
        const gcBody = await gcResponse.json();
        expect(gcBody.deleted).toBe(1);

        const referencedGet = await fetch(`${baseUrl}/v1/attachments/${referencedPath}`, { headers: authHeaders });
        const orphanGet = await fetch(`${baseUrl}/v1/attachments/${orphanPath}`, { headers: authHeaders });
        expect(referencedGet.status).toBe(200);
        expect(orphanGet.status).toBe(404);
    });

    test('does not garbage-collect fresh unreferenced attachment uploads', async () => {
        const freshPath = 'folder/fresh-orphan.bin';
        const uploadFresh = await fetch(`${baseUrl}/v1/attachments/${freshPath}`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('fresh'),
        });
        expect(uploadFresh.status).toBe(200);

        const gcResponse = await fetch(`${baseUrl}/v1/attachments/orphans`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(gcResponse.status).toBe(200);
        const gcBody = await gcResponse.json();
        expect(gcBody.deleted).toBe(0);
        expect(gcBody.kept).toBe(1);

        const freshGet = await fetch(`${baseUrl}/v1/attachments/${freshPath}`, { headers: authHeaders });
        expect(freshGet.status).toBe(200);
    });

    test('does not garbage-collect through a symlinked attachment root', async () => {
        const key = tokenToKey(integrationToken);
        const namespaceDir = join(dataDir, key);
        const outsideDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-outside-'));
        const outsideFile = join(outsideDir, 'private.bin');
        mkdirSync(namespaceDir, { recursive: true });
        writeFileSync(outsideFile, 'private');
        symlinkSync(outsideDir, join(namespaceDir, 'attachments'), 'dir');

        try {
            const gcResponse = await fetch(`${baseUrl}/v1/attachments/orphans`, {
                method: 'POST',
                headers: authHeaders,
            });
            // S8: a GC pass with errors must not answer 200.
            expect(gcResponse.status).toBe(500);
            const gcBody = await gcResponse.json();
            expect(gcBody.ok).toBe(false);
            expect(gcBody.deleted).toBe(0);
            expect(gcBody.errors).toContain('attachment root is not a normal directory');
            expect(existsSync(outsideFile)).toBe(true);
        } finally {
            rmSync(outsideDir, { recursive: true, force: true });
        }
    });

    test('rejects attachment uploads with blocked executable content types', async () => {
        const putResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.exe`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/x-msdownload; charset=binary',
            },
            body: new Uint8Array([1, 2, 3]),
        });
        expect(putResponse.status).toBe(400);
        expect((await putResponse.json()).error).toBe('Blocked attachment content type: application/x-msdownload');

        const getResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.exe`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(404);
    });

    test('rejects unauthenticated attachment uploads before writing files', async () => {
        const putResponse = await fetch(`${baseUrl}/v1/attachments/folder/unauth.bin`, {
            method: 'PUT',
            headers: {
                'content-type': 'application/octet-stream',
            },
            body: new TextEncoder().encode('unauthenticated-bytes'),
        });

        expect(putResponse.status).toBe(401);
        expect(readdirSync(dataDir)).toEqual([]);
    });

    test('rejects attachment uploads with executable file signatures even when content-type is benign', async () => {
        const putResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.png`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'image/png',
            },
            body: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]),
        });
        expect(putResponse.status).toBe(400);
        expect((await putResponse.json()).error).toBe('Blocked executable attachment signature: windows-pe');

        const getResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.png`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(404);
    });

    test('rejects attachment uploads when target path is a symlink', async () => {
        const token = integrationToken;
        const key = tokenToKey(token);
        const attachmentDir = join(dataDir, key, 'attachments', 'folder');
        mkdirSync(attachmentDir, { recursive: true });

        const outsideDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-outside-'));
        const outsideFile = join(outsideDir, 'outside.bin');
        writeFileSync(outsideFile, 'original');
        const symlinkPath = join(attachmentDir, 'link.bin');
        symlinkSync(outsideFile, symlinkPath);

        const putResponse = await fetch(`${baseUrl}/v1/attachments/folder/link.bin`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('attacker-data'),
        });
        expect(putResponse.status).toBe(400);
        expect(readFileSync(outsideFile, 'utf8')).toBe('original');

        rmSync(outsideDir, { recursive: true, force: true });
    });

    test('rejects attachment uploads when parent directory is a symlink', async () => {
        const token = integrationToken;
        const key = tokenToKey(token);
        const attachmentRoot = join(dataDir, key, 'attachments');
        mkdirSync(attachmentRoot, { recursive: true });

        const outsideDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-outside-parent-'));
        const symlinkedParent = join(attachmentRoot, 'folder');
        symlinkSync(outsideDir, symlinkedParent);

        const putResponse = await fetch(`${baseUrl}/v1/attachments/folder/nested/file.bin`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('attacker-data'),
        });

        expect(putResponse.status).toBe(400);
        expect(existsSync(join(outsideDir, 'file.bin'))).toBe(false);
        expect(existsSync(join(outsideDir, 'nested'))).toBe(false);

        rmSync(outsideDir, { recursive: true, force: true });
    });

    test('applies attachment endpoint rate limits', async () => {
        stopServer?.();
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir,
            windowMs: 60_000,
            maxPerWindow: 1_000,
            maxAttachmentPerWindow: 1,
            allowedAuthTokens: new Set([integrationToken]),
        });
        baseUrl = `http://127.0.0.1:${server.port}`;
        stopServer = server.stop;

        const first = await fetch(`${baseUrl}/v1/attachments/rate/file1.bin`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('a'),
        });
        expect(first.status).toBe(200);

        const second = await fetch(`${baseUrl}/v1/attachments/rate/file2.bin`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('b'),
        });
        expect(second.status).toBe(429);
    });

    test('rate limits /v1/data by method and route', async () => {
        stopServer?.();
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir,
            windowMs: 60_000,
            maxPerWindow: 1,
            allowedAuthTokens: new Set([integrationToken]),
        });
        baseUrl = `http://127.0.0.1:${server.port}`;
        stopServer = server.stop;

        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);

        const putResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            }),
        });
        expect(putResponse.status).toBe(200);

        const secondGetResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(secondGetResponse.status).toBe(429);

        const secondPutResponse = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            }),
        });
        expect(secondPutResponse.status).toBe(429);
    });

    test('serializes concurrent task writes without dropping records', async () => {
        const requests: Array<Promise<Response>> = [];
        for (let i = 0; i < 20; i += 1) {
            requests.push(fetch(`${baseUrl}/v1/tasks`, {
                method: 'POST',
                headers: {
                    ...authHeaders,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ title: `Task ${i}` }),
            }));
        }
        const responses = await Promise.all(requests);
        const createdIds = new Set<string>();
        for (const response of responses) {
            expect(response.status).toBe(201);
            const createdJson = await response.json();
            createdIds.add(String(createdJson.task?.id || ''));
        }
        expect(createdIds.size).toBe(20);

        const tasksResponse = await fetch(`${baseUrl}/v1/tasks?all=1`, {
            headers: authHeaders,
        });
        expect(tasksResponse.status).toBe(200);
        const tasksJson = await tasksResponse.json();
        const taskIds = new Set((tasksJson.tasks as Array<{ id: string }>).map((task) => task.id));
        for (const id of createdIds) {
            expect(taskIds.has(id)).toBe(true);
        }
    });

    test('serializes concurrent /v1/data merges without dropping records', async () => {
        const iso = '2026-01-01T00:00:00.000Z';
        const requests: Array<Promise<Response>> = [];
        for (let i = 0; i < 20; i += 1) {
            requests.push(fetch(`${baseUrl}/v1/data`, {
                method: 'PUT',
                headers: {
                    ...authHeaders,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    tasks: [{
                        id: `data-task-${i}`,
                        title: `Data Task ${i}`,
                        status: 'inbox',
                        createdAt: iso,
                        updatedAt: iso,
                    }],
                    projects: [],
                    sections: [],
                    areas: [],
                    settings: {},
                }),
            }));
        }

        const responses = await Promise.all(requests);
        for (const response of responses) {
            expect(response.status).toBe(200);
        }

        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const data = await getResponse.json();
        const taskIds = new Set((data.tasks as Array<{ id: string }>).map((task) => task.id));
        for (let i = 0; i < 20; i += 1) {
            expect(taskIds.has(`data-task-${i}`)).toBe(true);
        }
    });

    test('serializes concurrent /v1/data read-merge-write cycles against existing data', async () => {
        const iso = '2026-01-01T00:00:00.000Z';
        const key = tokenToKey(integrationToken);
        writeFileSync(join(dataDir, `${key}.json`), JSON.stringify({
            tasks: [makeTestTask({
                id: 'seed-task',
                title: 'Seed Task',
                rev: 1,
                revBy: 'seed-device',
                createdAt: iso,
                updatedAt: iso,
            })],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        }));

        const putTask = (id: string, title: string) => fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [makeTestTask({
                    id,
                    title,
                    rev: 2,
                    revBy: id,
                    createdAt: iso,
                    updatedAt: '2026-01-01T00:01:00.000Z',
                })],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            }),
        });

        const responses = await Promise.all([
            putTask('client-a-task', 'Client A Task'),
            putTask('client-b-task', 'Client B Task'),
        ]);

        for (const response of responses) {
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.ok).toBe(true);
            expect(body.stats).toBeTruthy();
        }

        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const data = await getResponse.json();
        const taskIds = new Set((data.tasks as Array<{ id: string }>).map((task) => task.id));
        expect(taskIds.has('seed-task')).toBe(true);
        expect(taskIds.has('client-a-task')).toBe(true);
        expect(taskIds.has('client-b-task')).toBe(true);
    });

    test('uses server timestamps for server-side merge repairs', async () => {
        const deletedProjectAt = '2026-01-01T00:00:00.000Z';
        const sectionAt = '2026-01-02T00:00:00.000Z';
        const key = tokenToKey(integrationToken);
        writeFileSync(join(dataDir, `${key}.json`), JSON.stringify({
            tasks: [],
            projects: [{
                id: 'project-deleted',
                title: 'Deleted project',
                status: 'active',
                createdAt: deletedProjectAt,
                updatedAt: deletedProjectAt,
                deletedAt: deletedProjectAt,
            }],
            sections: [],
            areas: [],
            settings: {},
        }));

        const startedAt = Date.now();
        const putSection = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [{
                    id: 'project-deleted',
                    title: 'Deleted project before delete',
                    status: 'active',
                    createdAt: '2025-12-31T00:00:00.000Z',
                    updatedAt: '2025-12-31T00:00:00.000Z',
                }],
                sections: [{
                    id: 'section-stale',
                    projectId: 'project-deleted',
                    title: 'Stale section',
                    order: 0,
                    createdAt: sectionAt,
                    updatedAt: sectionAt,
                }],
                areas: [],
                settings: {},
            }),
        });
        expect(putSection.status).toBe(200);

        const getResponse = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(getResponse.status).toBe(200);
        const body = await getResponse.json();
        const section = (body.sections as Array<{ id: string; deletedAt?: string; updatedAt: string }>).find((item) => item.id === 'section-stale');
        const repairedAt = Date.parse(section?.updatedAt ?? '');
        expect(Number.isFinite(repairedAt)).toBe(true);
        expect(section?.deletedAt).toBe(section?.updatedAt);
        expect(section?.updatedAt).not.toBe(sectionAt);
        expect(repairedAt).toBeGreaterThanOrEqual(startedAt);
        expect(repairedAt).toBeLessThanOrEqual(Date.now() + 1000);
    });

    test('clamps adversarial future payload timestamps for server-side repairs', async () => {
        const deletedProjectAt = '2026-01-01T00:00:00.000Z';
        const futureSectionAt = '2099-01-01T00:00:00.000Z';
        const key = tokenToKey(integrationToken);
        writeFileSync(join(dataDir, `${key}.json`), JSON.stringify({
            tasks: [],
            projects: [{
                id: 'project-deleted',
                title: 'Deleted project',
                status: 'active',
                createdAt: deletedProjectAt,
                updatedAt: deletedProjectAt,
                deletedAt: deletedProjectAt,
            }],
            sections: [],
            areas: [],
            settings: {},
        }));

        const startedAt = Date.now();
        const putSection = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                tasks: [],
                projects: [{
                    id: 'project-deleted',
                    title: 'Deleted project before delete',
                    status: 'active',
                    createdAt: '2025-12-31T00:00:00.000Z',
                    updatedAt: '2025-12-31T00:00:00.000Z',
                }],
                sections: [{
                    id: 'section-future',
                    projectId: 'project-deleted',
                    title: 'Future section',
                    order: 0,
                    createdAt: futureSectionAt,
                    updatedAt: futureSectionAt,
                }],
                areas: [],
                settings: {},
            }),
        });
        expect(putSection.status).toBe(200);

        const getResponse = await fetch(`${baseUrl}/v1/data`, { headers: authHeaders });
        expect(getResponse.status).toBe(200);
        const body = await getResponse.json();
        const section = (body.sections as Array<{ id: string; deletedAt?: string; updatedAt: string }>).find((item) => item.id === 'section-future');
        const repairedAt = Date.parse(section?.updatedAt ?? '');
        expect(Number.isFinite(repairedAt)).toBe(true);
        expect(section?.deletedAt).toBe(section?.updatedAt);
        expect(section?.updatedAt).not.toBe(futureSectionAt);
        expect(repairedAt).toBeGreaterThanOrEqual(startedAt);
        expect(repairedAt).toBeLessThanOrEqual(Date.now() + 1000);
    });

    test('serializes concurrent /v1/data edits to the same task with record-level merge rules', async () => {
        const base = {
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const taskA = {
            id: 'shared-task',
            title: 'foo',
            status: 'inbox',
            rev: 2,
            revBy: 'client-a',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:01:00.000Z',
        };
        const taskB = {
            id: 'shared-task',
            title: 'bar',
            status: 'inbox',
            rev: 3,
            revBy: 'client-b',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:02:00.000Z',
        };

        const responses = await Promise.all([taskA, taskB].map((task) =>
            fetch(`${baseUrl}/v1/data`, {
                method: 'PUT',
                headers: {
                    ...authHeaders,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    ...base,
                    tasks: [task],
                }),
            })
        ));

        for (const response of responses) {
            expect(response.status).toBe(200);
        }

        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const data = await getResponse.json();
        const task = (data.tasks as Array<{ id: string; title: string; rev?: number; revBy?: string }>).find(
            (candidate) => candidate.id === 'shared-task'
        );
        expect(task?.title).toBe('bar');
        expect(task?.rev).toBe(3);
        expect(task?.revBy).toBe('client-b');
    });

    test('rate limits repeated unauthorized requests per client', async () => {
        let lastStatus = 0;
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const response = await fetch(`${baseUrl}/v1/data`, {
                headers: {
                    Authorization: 'Bearer invalid-token-1234567890',
                },
            });
            lastStatus = response.status;
            if (lastStatus === 429) {
                break;
            }
            expect(lastStatus).toBe(401);
        }
        expect(lastStatus).toBe(429);
    });

    test('merges /v1/data payload with existing server state', async () => {
        const base = {
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const taskA = {
            id: 'task-a',
            title: 'Task A',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const taskB = {
            id: 'task-b',
            title: 'Task B',
            status: 'inbox',
            createdAt: '2026-01-01T00:01:00.000Z',
            updatedAt: '2026-01-01T00:01:00.000Z',
        };

        const firstPut = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                ...base,
                tasks: [taskA],
            }),
        });
        expect(firstPut.status).toBe(200);
        const firstPutBody = await firstPut.json();
        expect(firstPutBody.ok).toBe(true);
        expect(firstPutBody.stats.tasks.localTotal).toBe(0);
        expect(firstPutBody.stats.tasks.incomingTotal).toBe(1);
        expect(firstPutBody.stats.tasks.incomingOnly).toBe(1);
        expect(firstPutBody.stats.tasks.mergedTotal).toBe(1);
        expect(firstPutBody.stats.tasks.conflicts).toBe(0);
        expect(firstPutBody.clockSkewWarning).toBeNull();

        const secondPut = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                ...base,
                tasks: [taskB],
            }),
        });
        expect(secondPut.status).toBe(200);
        const secondPutBody = await secondPut.json();
        expect(secondPutBody.ok).toBe(true);
        expect(secondPutBody.stats.tasks.localTotal).toBe(1);
        expect(secondPutBody.stats.tasks.incomingTotal).toBe(1);
        expect(secondPutBody.stats.tasks.localOnly).toBe(1);
        expect(secondPutBody.stats.tasks.incomingOnly).toBe(1);
        expect(secondPutBody.stats.tasks.mergedTotal).toBe(2);
        expect(secondPutBody.stats.tasks.conflicts).toBe(0);

        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const body = await getResponse.json();
        const taskIds = new Set((body.tasks as Array<{ id: string }>).map((task) => task.id));
        expect(taskIds.has(taskA.id)).toBe(true);
        expect(taskIds.has(taskB.id)).toBe(true);
    });

    test('rejects /v1/data merge when existing on-disk state is invalid', async () => {
        const key = tokenToKey(integrationToken);
        const filePath = join(dataDir, `${key}.json`);
        writeFileSync(filePath, JSON.stringify({
            tasks: [],
            projects: [{ id: 'broken-project', title: 'Broken project', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }],
            sections: [],
            areas: [],
            settings: {},
        }));
        const captured: string[] = [];
        const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        });

        try {
            const response = await fetch(`${baseUrl}/v1/data`, {
                method: 'PUT',
                headers: {
                    ...authHeaders,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    tasks: [{
                        id: 'valid-task',
                        title: 'Valid task',
                        status: 'inbox',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    }],
                    projects: [],
                    sections: [],
                    areas: [],
                    settings: {},
                }),
            });

            expect(response.status).toBe(500);
            const body = await response.json();
            expect(body.error).toBe('Stored data failed validation');

            const serializedLogs = captured.join('');
            expect(serializedLogs).toContain('"failureClass":"validation"');
            expect(serializedLogs).toContain('"failureCode":"stored_data_invalid"');
            expect(serializedLogs).not.toContain(key);
            expect(serializedLogs).not.toContain(filePath);
            expect(serializedLogs).not.toContain('broken-project');
            expect(serializedLogs).not.toContain('createdAt/updatedAt');
        } finally {
            stdoutSpy.mockRestore();
        }

        const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
        expect((persisted.tasks as Array<{ id: string }>).some((task) => task.id === 'valid-task')).toBe(false);
        expect((persisted.projects as Array<{ id: string }>).some((project) => project.id === 'broken-project')).toBe(true);
    });

    test('keeps a nearby legacy delete during /v1/data merge', async () => {
        const base = { projects: [], sections: [], areas: [], settings: {} };
        const taskId = 'merge-race-live-wins';

        const seed = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                ...base,
                tasks: [{
                    id: taskId,
                    title: 'Live task',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.100Z',
                }],
            }),
        });
        expect(seed.status).toBe(200);

        const staleDelete = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                ...base,
                tasks: [{
                    id: taskId,
                    title: 'Live task',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    deletedAt: '2026-01-01T00:00:00.000Z',
                }],
            }),
        });
        expect(staleDelete.status).toBe(200);

        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const body = await getResponse.json();
        const mergedTask = (body.tasks as Array<{ id: string; updatedAt: string; deletedAt?: string }>).find((task) => task.id === taskId);
        expect(mergedTask).toBeTruthy();
        expect(mergedTask?.deletedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(mergedTask?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    test('keeps a slightly newer legacy delete during /v1/data merge', async () => {
        const base = { projects: [], sections: [], areas: [], settings: {} };
        const taskId = 'merge-race-delete-wins';

        const seed = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                ...base,
                tasks: [{
                    id: taskId,
                    title: 'Task deleted later',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.100Z',
                    deletedAt: '2026-01-01T00:00:00.100Z',
                }],
            }),
        });
        expect(seed.status).toBe(200);

        const staleLiveUpdate = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                ...base,
                tasks: [{
                    id: taskId,
                    title: 'Task deleted later',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }],
            }),
        });
        expect(staleLiveUpdate.status).toBe(200);

        const getResponse = await fetch(`${baseUrl}/v1/data`, {
            headers: authHeaders,
        });
        expect(getResponse.status).toBe(200);
        const body = await getResponse.json();
        const mergedTask = (body.tasks as Array<{ id: string; updatedAt: string; deletedAt?: string }>).find((task) => task.id === taskId);
        expect(mergedTask).toBeTruthy();
        expect(mergedTask?.deletedAt).toBe('2026-01-01T00:00:00.100Z');
        expect(mergedTask?.updatedAt).toBe('2026-01-01T00:00:00.100Z');
    });
});

describe('cloud server calendar feed', () => {
    const FEED_TOKEN = 'calendar-feed-test-token-1234567890';
    const authHeaders = { Authorization: `Bearer ${FEED_TOKEN}` };

    const startFeedServer = async (options: { maxPerWindow?: number } = {}) => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-calendar-feed-'));
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir,
            allowedAuthTokens: [FEED_TOKEN],
            maxPerWindow: options.maxPerWindow,
        });
        return { dataDir, server, url: `http://127.0.0.1:${server.port}` };
    };

    const seedData = async (url: string, tasks: unknown[], settings: unknown = {}) => {
        const response = await fetch(`${url}/v1/data`, {
            method: 'PUT',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ tasks, projects: [], sections: [], areas: [], settings }),
        });
        expect(response.status).toBe(200);
    };

    const scheduledTask = makeTestTask({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Publish the feed',
        status: 'next',
        startTime: '2026-05-06T09:00:00.000Z',
        description: 'private note',
    });

    test('publishes, rotates and revokes an unauthenticated .ics feed', async () => {
        const { dataDir, server, url } = await startFeedServer();
        try {
            await seedData(url, [scheduledTask]);

            expect(await (await fetch(`${url}/v1/calendar/feed`, { headers: authHeaders })).json())
                .toEqual({ feed: null });

            const created = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            expect(created.status).toBe(201);
            const feed = (await created.json()).feed as { path: string; token: string };
            expect(feed.token).toMatch(/^[a-f0-9]{64}$/);
            expect(feed.path).toBe(`/v1/calendar/${feed.token}.ics`);

            // The stored token round-trips, so the URL survives a client reinstall.
            expect(((await (await fetch(`${url}/v1/calendar/feed`, { headers: authHeaders })).json()).feed as { token: string }).token)
                .toBe(feed.token);

            // No Authorization header: the URL is the only credential.
            const feedResponse = await fetch(`${url}${feed.path}`);
            expect(feedResponse.status).toBe(200);
            expect(feedResponse.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
            expect(feedResponse.headers.get('cache-control')).toBe('private, no-store');
            const ics = await feedResponse.text();
            expect(ics).toContain('BEGIN:VCALENDAR');
            expect(ics).toContain('SUMMARY:Publish the feed');
            expect(ics).toContain(`UID:${scheduledTask.id}-start@mindwtr.app`);
            expect(ics).not.toContain('private note');

            const rotated = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            const rotatedFeed = (await rotated.json()).feed as { path: string; token: string };
            expect(rotatedFeed.token).not.toBe(feed.token);
            expect((await fetch(`${url}${feed.path}`)).status).toBe(404);
            expect((await fetch(`${url}${rotatedFeed.path}`)).status).toBe(200);

            const revoked = await fetch(`${url}/v1/calendar/feed`, { method: 'DELETE', headers: authHeaders });
            expect(revoked.status).toBe(200);
            expect((await fetch(`${url}${rotatedFeed.path}`)).status).toBe(404);
            expect(await (await fetch(`${url}/v1/calendar/feed`, { headers: authHeaders })).json())
                .toEqual({ feed: null });
        } finally {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('sizes events by the estimate only while Time estimates is on', async () => {
        const estimatedTask = makeTestTask({
            id: '22222222-2222-4222-8222-222222222222',
            title: 'Long block',
            status: 'next',
            startTime: '2026-05-06T09:00:00.000Z',
            timeEstimate: '2hr',
        });

        const readFeed = async (settings: unknown): Promise<string> => {
            const { dataDir, server, url } = await startFeedServer();
            try {
                await seedData(url, [estimatedTask], settings);
                const created = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
                const feed = (await created.json()).feed as { path: string };
                return await (await fetch(`${url}${feed.path}`)).text();
            } finally {
                server.stop();
                rmSync(dataDir, { recursive: true, force: true });
            }
        };

        expect(await readFeed({})).toContain('DTEND:20260506T110000Z');
        // Feature off: the stored estimate is kept but stops sizing the event.
        expect(await readFeed({ features: { timeEstimates: false } })).toContain('DTEND:20260506T093000Z');
    });

    test('rejects an unknown feed token and a feed for a namespace that never synced', async () => {
        const { dataDir, server, url } = await startFeedServer();
        try {
            expect((await fetch(`${url}/v1/calendar/${'a'.repeat(64)}.ics`)).status).toBe(404);
            expect((await fetch(`${url}/v1/calendar/not-a-token.ics`)).status).toBe(404);

            const tooEarly = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            expect(tooEarly.status).toBe(404);
        } finally {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('rate limits rotating unknown feed tokens by client before lookup', async () => {
        const { dataDir, server, url } = await startFeedServer({ maxPerWindow: 2 });
        try {
            expect((await fetch(`${url}/v1/calendar/${'a'.repeat(64)}.ics`)).status).toBe(404);
            expect((await fetch(`${url}/v1/calendar/${'b'.repeat(64)}.ics`)).status).toBe(404);
            expect((await fetch(`${url}/v1/calendar/${'c'.repeat(64)}.ics`)).status).toBe(429);
        } finally {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('requires authorization to read or change the feed token', async () => {
        const { dataDir, server, url } = await startFeedServer();
        try {
            await seedData(url, []);
            expect((await fetch(`${url}/v1/calendar/feed`)).status).toBe(401);
            expect((await fetch(`${url}/v1/calendar/feed`, { method: 'POST' })).status).toBe(401);
            expect((await fetch(`${url}/v1/calendar/feed`, { method: 'PATCH', headers: authHeaders })).status).toBe(405);
        } finally {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('keeps the feed sidecar out of the namespace count', async () => {
        const { dataDir, server, url } = await startFeedServer();
        try {
            await seedData(url, [scheduledTask]);
            await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            const namespaceFiles = readdirSync(dataDir).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry));
            expect(namespaceFiles).toHaveLength(1);
        } finally {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('errors instead of serving an empty feed when the namespace data is corrupt', async () => {
        const { dataDir, server, url } = await startFeedServer();
        try {
            await seedData(url, [scheduledTask]);
            const created = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            const feed = (await created.json()).feed as { path: string };

            const namespacePath = join(dataDir, `${tokenToKey(FEED_TOKEN)}.json`);
            writeFileSync(namespacePath, '{"tasks":[');

            const feedResponse = await fetch(`${url}${feed.path}`);
            expect(feedResponse.status).toBe(500);
        } finally {
            server.stop();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    // R-03: revoking a token (the documented rotation flow) must also stop the
    // calendar feed it published - the feed URL has no auth of its own, so an
    // unrevoked feed would keep serving that namespace's data forever.
    test('404s a published feed and prunes its sidecar once the token leaves the allowlist', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-calendar-feed-'));
        try {
            const server = await startCloudServer({
                host: '127.0.0.1', port: 0, dataDir, allowedAuthTokens: [FEED_TOKEN],
            });
            const url = `http://127.0.0.1:${server.port}`;
            await seedData(url, [scheduledTask]);
            const created = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            const feed = (await created.json()).feed as { path: string; token: string };
            expect((await fetch(`${url}${feed.path}`)).status).toBe(200);
            server.stop();

            // Rotation: the next allowlist no longer contains FEED_TOKEN.
            const restarted = await startCloudServer({
                host: '127.0.0.1', port: 0, dataDir,
                allowedAuthTokens: ['rotated-replacement-token-1234567890'],
            });
            try {
                const restartedUrl = `http://127.0.0.1:${restarted.port}`;
                expect((await fetch(`${restartedUrl}${feed.path}`)).status).toBe(404);
                expect(readdirSync(dataDir).some((entry) => entry.endsWith('.ics.json'))).toBe(false);
            } finally {
                restarted.stop();
            }
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('any-token mode keeps every feed valid, including across a restart', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-calendar-feed-'));
        try {
            const server = await startCloudServer({
                host: '127.0.0.1', port: 0, dataDir, allowedAuthTokens: null,
            });
            const url = `http://127.0.0.1:${server.port}`;
            await seedData(url, [scheduledTask]);
            const created = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            const feed = (await created.json()).feed as { path: string; token: string };
            expect((await fetch(`${url}${feed.path}`)).status).toBe(200);
            server.stop();

            const restarted = await startCloudServer({
                host: '127.0.0.1', port: 0, dataDir, allowedAuthTokens: null,
            });
            try {
                expect((await fetch(`http://127.0.0.1:${restarted.port}${feed.path}`)).status).toBe(200);
            } finally {
                restarted.stop();
            }
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('a feed stays valid and its sidecar untouched when its token is still allowlisted after a restart', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-calendar-feed-'));
        const allowedTokens = [FEED_TOKEN, 'another-allowed-token-1234567890'];
        try {
            const server = await startCloudServer({
                host: '127.0.0.1', port: 0, dataDir, allowedAuthTokens: allowedTokens,
            });
            const url = `http://127.0.0.1:${server.port}`;
            await seedData(url, [scheduledTask]);
            const created = await fetch(`${url}/v1/calendar/feed`, { method: 'POST', headers: authHeaders });
            const feed = (await created.json()).feed as { path: string; token: string };
            server.stop();

            const restarted = await startCloudServer({
                host: '127.0.0.1', port: 0, dataDir, allowedAuthTokens: allowedTokens,
            });
            try {
                expect((await fetch(`http://127.0.0.1:${restarted.port}${feed.path}`)).status).toBe(200);
                expect(readdirSync(dataDir).some((entry) => entry.endsWith('.ics.json'))).toBe(true);
            } finally {
                restarted.stop();
            }
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    // I4: an unlinkSync failure (permission error, a race with another
    // process, an unexpected filesystem entry) must never crash startup - a
    // directory can never be removed with unlinkSync regardless of
    // permissions or the running user, so it's a deterministic way to force
    // that failure without relying on file permissions (which root ignores).
    test('pruneOrphanedCalendarFeeds counts an undeletable entry as a failure instead of throwing', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-calendar-feed-'));
        try {
            const allowedKey = 'a'.repeat(64);
            const orphanedKey = 'b'.repeat(64);
            const undeletableKey = 'c'.repeat(64);
            writeFileSync(join(dataDir, `${allowedKey}.ics.json`), '{}');
            writeFileSync(join(dataDir, `${orphanedKey}.ics.json`), '{}');
            mkdirSync(join(dataDir, `${undeletableKey}.ics.json`));

            const result = pruneOrphanedCalendarFeeds(dataDir, new Set([allowedKey]));

            expect(result).toEqual({ pruned: 1, failed: 1 });
            expect(existsSync(join(dataDir, `${allowedKey}.ics.json`))).toBe(true);
            expect(existsSync(join(dataDir, `${orphanedKey}.ics.json`))).toBe(false);
            expect(existsSync(join(dataDir, `${undeletableKey}.ics.json`))).toBe(true);
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    // SEC-15a: a bare unlinkSync (no parent-directory fsync) can leave a revoked
    // feed's removal un-published — a crash between the unlink and the next fsync
    // resurrects the revoked token on restart. Route through the shared
    // durablyRemoveFile helper instead, and confirm it publishes the removal by
    // recording every directory it fsyncs.
    test('revokeCalendarFeed durably removes the feed file and tolerates an already-removed feed', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-calendar-feed-'));
        try {
            const key = 'd'.repeat(64);
            const feedPath = join(dataDir, `${key}.ics.json`);
            writeFileSync(feedPath, '{}');
            const fsyncedDirs: string[] = [];
            const trackingFileSystem: DurableRemovalFileSystem = {
                existsSync,
                unlinkSync,
                rmdirSync: () => { throw new Error('unused in this test'); },
                openSync: (path, flags) => {
                    fsyncedDirs.push(path);
                    return openSync(path, flags);
                },
                fsyncSync,
                closeSync,
            };

            expect(revokeCalendarFeed(dataDir, key, trackingFileSystem)).toBe(true);
            expect(existsSync(feedPath)).toBe(false);
            expect(fsyncedDirs).toContain(dataDir);

            // A second revoke races an already-removed feed (e.g. a retry after a
            // dropped response) — durablyRemoveFile tolerates ENOENT instead of the
            // bare unlinkSync this replaces throwing and becoming an uncaught 500.
            expect(revokeCalendarFeed(dataDir, key, trackingFileSystem)).toBe(false);
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('pruneOrphanedCalendarFeeds durably removes orphaned feed files', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-calendar-feed-'));
        try {
            const allowedKey = 'e'.repeat(64);
            const orphanedKey = 'f'.repeat(64);
            writeFileSync(join(dataDir, `${allowedKey}.ics.json`), '{}');
            writeFileSync(join(dataDir, `${orphanedKey}.ics.json`), '{}');
            const fsyncedDirs: string[] = [];
            const trackingFileSystem: DurableRemovalFileSystem = {
                existsSync,
                unlinkSync,
                rmdirSync: () => { throw new Error('unused in this test'); },
                openSync: (path, flags) => {
                    fsyncedDirs.push(path);
                    return openSync(path, flags);
                },
                fsyncSync,
                closeSync,
            };

            const result = pruneOrphanedCalendarFeeds(dataDir, new Set([allowedKey]), trackingFileSystem);

            expect(result).toEqual({ pruned: 1, failed: 0 });
            expect(existsSync(join(dataDir, `${orphanedKey}.ics.json`))).toBe(false);
            expect(fsyncedDirs).toContain(dataDir);
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
