import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { __cloudTestUtils, startCloudServer } from './server';

describe('cloud server utils', () => {
    test('parses bearer token and hashes it', () => {
        const req = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer demo-token-1234567890' },
        });
        const token = __cloudTestUtils.getToken(req);
        expect(token).toBe('demo-token-1234567890');
        expect(__cloudTestUtils.tokenToKey(token!)).toHaveLength(64);

        const base64TokenReq = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer YWxhZGRpbjpvcGVuL3Nlc2FtZT0=' },
        });
        expect(__cloudTestUtils.getToken(base64TokenReq)).toBe('YWxhZGRpbjpvcGVuL3Nlc2FtZT0=');

        const shortTokenReq = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer short' },
        });
        expect(__cloudTestUtils.getToken(shortTokenReq)).toBeNull();

        const tokenWithWhitespaceReq = new Request('http://localhost/v1/data', {
            headers: { Authorization: 'Bearer token with spaces' },
        });
        expect(__cloudTestUtils.getToken(tokenWithWhitespaceReq)).toBeNull();
    });

    test('parses optional auth token allowlist', () => {
        expect(__cloudTestUtils.parseAllowedAuthTokens('')).toBeNull();
        const tokens = __cloudTestUtils.parseAllowedAuthTokens('alpha, beta ,gamma');
        expect(tokens?.size).toBe(3);
        expect(__cloudTestUtils.isAuthorizedToken('beta', tokens || null)).toBe(true);
        expect(__cloudTestUtils.isAuthorizedToken('delta', tokens || null)).toBe(false);
        expect(__cloudTestUtils.isAuthorizedToken('any', null)).toBe(true);
    });

    test('resolves auth tokens from both current and legacy env var names', () => {
        const primaryOnly = __cloudTestUtils.resolveAllowedAuthTokensFromEnv({
            MINDWTR_CLOUD_AUTH_TOKENS: 'alpha,beta',
        });
        expect(primaryOnly).not.toBeNull();
        expect(primaryOnly?.has('alpha')).toBe(true);
        expect(primaryOnly?.has('beta')).toBe(true);

        const legacyOnly = __cloudTestUtils.resolveAllowedAuthTokensFromEnv({
            MINDWTR_CLOUD_TOKEN: 'legacy-token',
        });
        expect(legacyOnly).not.toBeNull();
        expect(legacyOnly?.has('legacy-token')).toBe(true);

        const combined = __cloudTestUtils.resolveAllowedAuthTokensFromEnv({
            MINDWTR_CLOUD_AUTH_TOKENS: 'new-token',
            MINDWTR_CLOUD_TOKEN: 'legacy-token',
        });
        expect(combined?.has('new-token')).toBe(true);
        expect(combined?.has('legacy-token')).toBe(true);

        const allowAny = __cloudTestUtils.resolveAllowedAuthTokensFromEnv({
            MINDWTR_CLOUD_ALLOW_ANY_TOKEN: 'true',
        });
        expect(allowAny).toBeNull();

        expect(() => __cloudTestUtils.resolveAllowedAuthTokensFromEnv({})).toThrow(
            'Cloud auth is not configured.'
        );
    });

    test('ignores proxy IP headers unless explicitly trusted', () => {
        const req = new Request('http://localhost/v1/data', {
            headers: {
                'x-forwarded-for': '203.0.113.10, 10.0.0.1',
                'cf-connecting-ip': '203.0.113.11',
                'x-real-ip': '203.0.113.12',
            },
        });

        expect(__cloudTestUtils.getClientIp(req)).toBe('unknown');
        expect(__cloudTestUtils.getClientIp(req, true)).toBe('203.0.113.10');
    });

    test('derives auth failure rate keys from the best available client identity', () => {
        const token = 'demo-token-1234567890';
        const req = new Request('http://localhost/v1/data', {
            headers: {
                authorization: `Bearer ${token}`,
                'x-forwarded-for': '203.0.113.10, 10.0.0.1',
            },
        });

        expect(__cloudTestUtils.getAuthFailureRateKey(req, {
            trustProxyHeaders: true,
            requestIpAddress: '127.0.0.1',
            token,
        })).toBe('auth-failure:ip:203.0.113.10');

        expect(__cloudTestUtils.getAuthFailureRateKey(req, {
            trustProxyHeaders: false,
            requestIpAddress: '127.0.0.1',
            token,
        })).toBe('auth-failure:ip:127.0.0.1');

        expect(__cloudTestUtils.getAuthFailureRateKey(req, {
            trustProxyHeaders: false,
            requestIpAddress: null,
            token,
        })).toBe(`auth-failure:token:${__cloudTestUtils.tokenToKey(token)}`);

        expect(__cloudTestUtils.getAuthFailureRateKey(new Request('http://localhost/v1/data', {
            headers: {
                authorization: 'Bearer malformed',
            },
        }), {
            trustProxyHeaders: false,
            requestIpAddress: null,
            authHeader: 'Bearer malformed',
        })).toBe(`auth-failure:header:${__cloudTestUtils.tokenToKey('Bearer malformed')}`);
    });

    test('rejects invalid app data payload', () => {
        const result = __cloudTestUtils.validateAppData({ tasks: 'invalid', projects: [] });
        expect(result.ok).toBe(false);
    });

    test('rejects invalid task status and timestamps in app data', () => {
        const invalidStatus = __cloudTestUtils.validateAppData({
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

        const invalidTimestamp = __cloudTestUtils.validateAppData({
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
     const result = __cloudTestUtils.validateAppData({
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

        const invalidTaskProject = __cloudTestUtils.validateAppData({
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

        const invalidTaskSection = __cloudTestUtils.validateAppData({
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

        const invalidProjectArea = __cloudTestUtils.validateAppData({
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
        expect(__cloudTestUtils.asStatus('reference')).toBe('reference');
        expect(__cloudTestUtils.asStatus('todo')).toBeNull();
        expect(__cloudTestUtils.asStatus('in-progress')).toBeNull();
    });

    test('rejects reserved task creation props', () => {
        expect(__cloudTestUtils.validateTaskCreationProps({
            status: 'next',
            projectId: 'p1',
        }).ok).toBe(true);

        const invalid = __cloudTestUtils.validateTaskCreationProps({
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
        expect(__cloudTestUtils.validateTaskPatchProps({
            title: 'Renamed',
            status: 'next',
            order: 1,
        }).ok).toBe(true);

        const invalid = __cloudTestUtils.validateTaskPatchProps({
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

    test('validates settings.attachments.pendingRemoteDeletes structure', () => {
        const iso = '2024-01-01T00:00:00.000Z';
        const base = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
        };
        const valid = __cloudTestUtils.validateAppData({
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

        const invalidCloudKey = __cloudTestUtils.validateAppData({
            ...base,
            settings: {
                attachments: {
                    pendingRemoteDeletes: [{ cloudKey: '../escape' }],
                },
            },
        });
        expect(invalidCloudKey.ok).toBe(false);

        const invalidAttempts = __cloudTestUtils.validateAppData({
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
        expect(__cloudTestUtils.toRateLimitRoute('/v1/tasks/abc')).toBe('/v1/tasks/:id');
        expect(__cloudTestUtils.toRateLimitRoute('/v1/tasks/abc/complete')).toBe('/v1/tasks/:id/:action');
        expect(__cloudTestUtils.toRateLimitRoute('/v1/tasks')).toBe('/v1/tasks');
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
        const parsed = await __cloudTestUtils.readJsonBody(req, 10);
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
        const parsed = await __cloudTestUtils.readJsonBody(req, 1024, controller.signal);
        expect(parsed.__mindwtrError.message).toBe('Request timed out');
        expect(parsed.__mindwtrError.status).toBe(408);
    });

    test('normalizes attachment paths with allowlist and segment checks', () => {
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('folder/file.txt')).toBe('folder/file.txt');
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('/folder/file.txt/')).toBe('folder/file.txt');
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('%2e%2e/secret')).toBeNull();
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('%252e%252e/secret')).toBeNull();
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('%25252e%25252e/secret')).toBeNull();
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('../secret')).toBeNull();
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('folder\\\\file.txt')).toBeNull();
        expect(__cloudTestUtils.normalizeAttachmentRelativePath('folder/file?.txt')).toBeNull();
    });

    test('checks whether resolved path stays inside root directory', () => {
        expect(__cloudTestUtils.isPathWithinRoot('/data/ns/attachments/file.txt', '/data/ns/attachments')).toBe(true);
        expect(__cloudTestUtils.isPathWithinRoot('/data/ns/attachments', '/data/ns/attachments')).toBe(true);
        expect(__cloudTestUtils.isPathWithinRoot('/data/ns/attachments-evil/file.txt', '/data/ns/attachments')).toBe(false);
    });

    test('detects symlink segments in attachment paths', () => {
        const sandbox = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-symlink-check-'));
        const root = join(sandbox, 'root');
        const outside = join(sandbox, 'outside');
        mkdirSync(root, { recursive: true });
        mkdirSync(outside, { recursive: true });

        const normalDir = join(root, 'plain');
        mkdirSync(normalDir, { recursive: true });
        expect(__cloudTestUtils.pathContainsSymlink(root, normalDir)).toBe(false);

        const linkDir = join(root, 'linked');
        symlinkSync(outside, linkDir);
        expect(__cloudTestUtils.pathContainsSymlink(root, linkDir)).toBe(true);

        rmSync(sandbox, { recursive: true, force: true });
    });

    test('write lock runner executes each queued write once, even after a failure', async () => {
        const withWriteLock = __cloudTestUtils.createWriteLockRunner();
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

    test('writeData atomically replaces the JSON file and cleans up temp files', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-write-data-'));
        const filePath = join(dir, 'data.json');

        __cloudTestUtils.writeData(filePath, { ok: true, version: 1 });
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ ok: true, version: 1 });

        __cloudTestUtils.writeData(filePath, { ok: true, version: 2 });
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ ok: true, version: 2 });
        expect(readdirSync(dir)).toEqual(['data.json']);

        rmSync(dir, { recursive: true, force: true });
    });
});

describe('cloud server api', () => {
    let dataDir = '';
    let baseUrl = '';
    let stopServer: (() => void) | null = null;

    const integrationToken = 'integration-token-1234567890';
    const authHeaders = {
        Authorization: `Bearer ${integrationToken}`,
    };

    beforeEach(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-test-'));
        const server = await startCloudServer({
            host: '127.0.0.1',
            port: 0,
            dataDir,
            windowMs: 10_000,
            maxPerWindow: 1_000,
            maxAttachmentPerWindow: 1_000,
            allowedAuthTokens: new Set([integrationToken]),
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
        expect(patchJson.task.rev).toBe(1);
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
        expect(deletedTask?.rev).toBe(2);
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
        expect(completeJson.task.rev).toBe(1);
        expect(completeJson.task.revBy).toBe('cloud');

        const archiveResponse = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/archive`, {
            method: 'POST',
            headers: authHeaders,
        });
        expect(archiveResponse.status).toBe(200);
        const archiveJson = await archiveResponse.json();
        expect(archiveJson.task.status).toBe('archived');
        expect(archiveJson.task.rev).toBe(2);
        expect(archiveJson.task.revBy).toBe('cloud');
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

        const deleteResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            method: 'DELETE',
            headers: authHeaders,
        });
        expect(deleteResponse.status).toBe(200);

        const missingResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            headers: authHeaders,
        });
        expect(missingResponse.status).toBe(404);
    });

    test('rejects attachment uploads when target path is a symlink', async () => {
        const token = integrationToken;
        const key = __cloudTestUtils.tokenToKey(token);
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
        const key = __cloudTestUtils.tokenToKey(token);
        const attachmentRoot = join(dataDir, key, 'attachments');
        mkdirSync(attachmentRoot, { recursive: true });

        const outsideDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-outside-parent-'));
        const symlinkedParent = join(attachmentRoot, 'folder');
        symlinkSync(outsideDir, symlinkedParent);

        const putResponse = await fetch(`${baseUrl}/v1/attachments/folder/file.bin`, {
            method: 'PUT',
            headers: authHeaders,
            body: new TextEncoder().encode('attacker-data'),
        });

        expect(putResponse.status).toBe(400);
        expect(existsSync(join(outsideDir, 'file.bin'))).toBe(false);

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
        const key = __cloudTestUtils.tokenToKey(integrationToken);
        const filePath = join(dataDir, `${key}.json`);
        writeFileSync(filePath, JSON.stringify({
            tasks: [],
            projects: [{ id: 'broken-project', title: 'Broken project', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }],
            sections: [],
            areas: [],
            settings: {},
        }));

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
        expect(body.error).toBe('Merged data failed validation');

        const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
        expect((persisted.tasks as Array<{ id: string }>).some((task) => task.id === 'valid-task')).toBe(false);
        expect((persisted.projects as Array<{ id: string }>).some((project) => project.id === 'broken-project')).toBe(true);
    });

    test('keeps newer live update over older delete during /v1/data merge', async () => {
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
        expect(mergedTask?.deletedAt).toBeUndefined();
        expect(mergedTask?.updatedAt).toBe('2026-01-01T00:00:00.100Z');
    });

    test('keeps the live record when delete is only slightly newer during /v1/data merge', async () => {
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
        expect(mergedTask?.deletedAt).toBeUndefined();
        expect(mergedTask?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });
});
