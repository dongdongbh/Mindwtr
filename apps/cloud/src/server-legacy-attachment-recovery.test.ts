import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeSyncPayloadFingerprint, type AppData } from '@mindwtr/core';
import { startCloudServer } from './server';
import { tokenToKey } from './server-auth';
import * as dataCache from './server-data-cache';

const TOKEN = 'issue1205integrationtoken0123456789';
const TASK_ID = 'a615d6ee-efef-4b30-9552-8900d27a3c11';
const PROJECT_ID = '463bcf5c-0c52-46e4-92b9-044d358eeea0';
const STAMP = '2026-09-01T12:00:00.000Z';
const LINK = 'https://jira.example.test/browse/DEMO-1';

const legacyData = () => ({
    tasks: [{
        id: TASK_ID, title: 'Automation capture', status: 'next', projectId: PROJECT_ID,
        description: 'Keep these notes', dueDate: '', tags: [], contexts: [],
        attachments: LINK, rev: 7, revBy: 'legacy-cloud', createdAt: STAMP, updatedAt: STAMP,
    }],
    projects: [{
        id: PROJECT_ID, title: 'Demo', status: 'active', color: '#123456', order: 0,
        attachments: LINK, createdAt: STAMP, updatedAt: STAMP,
    }],
    sections: [], areas: [], people: [], settings: {},
});

describe('legacy Cloud attachment URL recovery (#1205)', () => {
    let dataDir: string;
    let filePath: string;
    let baseUrl: string;
    let stop: (() => unknown) | undefined;
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    beforeEach(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-cloud-legacy-link-'));
        filePath = join(dataDir, `${tokenToKey(TOKEN)}.json`);
        writeFileSync(filePath, JSON.stringify(legacyData()));
        const server = await startCloudServer({
            host: '127.0.0.1', port: 0, dataDir, allowedAuthTokens: new Set([TOKEN]),
        });
        baseUrl = `http://127.0.0.1:${server.port}`;
        stop = server.stop;
    });

    afterEach(async () => {
        await stop?.();
        rmSync(dataDir, { recursive: true, force: true });
    });

    test('serves and durably repairs old task/project links with coherent HEAD metadata', async () => {
        const response = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(response.status).toBe(200);
        const body = await response.text();
        const data = JSON.parse(body) as AppData;
        expect({ ...data.tasks[0], attachments: LINK }).toEqual(legacyData().tasks[0]);
        expect(data.tasks[0].attachments?.length).toBe(1);
        expect(data.tasks[0].attachments?.[0].kind).toBe('link');
        expect(data.tasks[0].attachments?.[0].uri).toBe(LINK);
        expect({ ...data.projects[0], attachments: LINK }).toEqual(legacyData().projects[0]);
        expect(data.projects[0].attachments?.[0].kind).toBe('link');
        expect(data.projects[0].attachments?.[0].uri).toBe(LINK);
        expect(data.tasks[0].attachments?.[0].id).not.toBe(data.projects[0].attachments?.[0].id);
        expect(() => computeSyncPayloadFingerprint(data)).not.toThrow();
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(data);

        const head = await fetch(`${baseUrl}/v1/data`, { method: 'HEAD', headers });
        expect(head.status).toBe(200);
        expect(Number(head.headers.get('content-length'))).toBe(Buffer.byteLength(body));
        const beforeReread = statSync(filePath);
        const reread = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(await reread.text()).toBe(body);
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(data);
        const afterReread = statSync(filePath);
        expect([afterReread.ino, afterReread.mtimeMs, afterReread.ctimeMs])
            .toEqual([beforeReread.ino, beforeReread.mtimeMs, beforeReread.ctimeMs]);
    });

    test('can edit an existing legacy namespace before the first sync GET', async () => {
        const response = await fetch(`${baseUrl}/v1/tasks/${TASK_ID}`, {
            method: 'PATCH', headers, body: JSON.stringify({ title: 'Edited automation capture' }),
        });
        expect(response.status).toBe(200);
        const data = JSON.parse(readFileSync(filePath, 'utf8')) as AppData;
        expect(data.tasks[0].title).toBe('Edited automation capture');
        expect(data.tasks[0].description).toBe('Keep these notes');
        expect(data.tasks[0].projectId).toBe(PROJECT_ID);
        expect(data.tasks[0].attachments?.[0].kind).toBe('link');
        expect(data.tasks[0].attachments?.[0].uri).toBe(LINK);
        expect(data.projects[0].attachments?.[0].kind).toBe('link');
        expect(data.projects[0].attachments?.[0].uri).toBe(LINK);
        expect(() => computeSyncPayloadFingerprint(data)).not.toThrow();
    });

    test('merges an upload with existing legacy links before the first sync GET', async () => {
        const response = await fetch(`${baseUrl}/v1/data`, {
            method: 'PUT', headers,
            body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }),
        });
        expect(response.status).toBe(200);
        const data = JSON.parse(readFileSync(filePath, 'utf8')) as AppData;
        expect(data.tasks.length).toBe(1);
        expect(data.projects.length).toBe(1);
        expect(data.tasks[0].id).toBe(TASK_ID);
        expect(data.tasks[0].description).toBe('Keep these notes');
        expect(data.tasks[0].attachments?.[0].uri).toBe(LINK);
        expect(data.projects[0].attachments?.[0].uri).toBe(LINK);
        expect(() => computeSyncPayloadFingerprint(data)).not.toThrow();
    });

    test('keeps failed repair writes untrusted and retries without losing the original data', async () => {
        const original = readFileSync(filePath, 'utf8');
        const write = spyOn(dataCache, 'writeCloudData').mockImplementation(() => {
            throw new Error('Synthetic repair publication failure');
        });
        try {
            for (const method of ['GET', 'PUT']) {
                const failed = await fetch(`${baseUrl}/v1/data`, {
                    headers, method,
                    ...(method === 'PUT' ? {
                        body: JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
                    } : {}),
                });
                expect(failed.status).toBe(500);
                expect(readFileSync(filePath, 'utf8')).toBe(original);
                expect(dataCache.isTrustedValidatedDataFile(filePath)).toBe(false);
            }
        } finally {
            write.mockRestore();
        }
        const retry = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(retry.status).toBe(200);
        const repaired = await retry.json() as AppData;
        expect(repaired.tasks[0].attachments?.[0].uri).toBe(LINK);
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(repaired);
    });

    test('invalidates trusted bytes when an older writer replaces the document', async () => {
        expect((await fetch(`${baseUrl}/v1/data`, { headers })).status).toBe(200);
        expect(dataCache.isTrustedValidatedDataFile(filePath)).toBe(true);
        const replacement = legacyData();
        replacement.tasks[0].attachments = `${LINK}?updated=1`;
        writeFileSync(filePath, JSON.stringify(replacement));
        const response = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(response.status).toBe(200);
        const repaired = await response.json() as AppData;
        expect(repaired.tasks[0].attachments?.[0].uri).toBe(`${LINK}?updated=1`);
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(repaired);
    });

    test('persists purged-owner cleanup even when no live link is converted', async () => {
        const data = legacyData();
        data.projects = [];
        data.tasks = [{
            ...data.tasks[0], status: 'archived', projectId: '',
            deletedAt: STAMP, purgedAt: STAMP,
        } as typeof data.tasks[number]];
        writeFileSync(filePath, JSON.stringify(data));
        const response = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(response.status).toBe(200);
        const repaired = await response.json() as AppData;
        expect(repaired.tasks[0].deletedAt).toBe(STAMP);
        expect(repaired.tasks[0].purgedAt).toBe(STAMP);
        expect(repaired.tasks[0].attachments).toBeUndefined();
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(repaired);
    });

    test('serves and repairs a partial attachment entry stored by an older REST client', async () => {
        const data = legacyData() as unknown as { tasks: Record<string, unknown>[]; projects: Record<string, unknown>[] };
        data.tasks[0].attachments = [{ id: 'attachment-1', kind: 'link', title: 'Ticket', uri: LINK }];
        data.projects[0].attachments = [{ url: LINK }];
        writeFileSync(filePath, JSON.stringify(data));

        const response = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(response.status).toBe(200);
        const body = await response.text();
        const repaired = JSON.parse(body) as AppData;
        expect(repaired.tasks[0].attachments?.[0]).toEqual({
            id: 'attachment-1', kind: 'link', title: 'Ticket', uri: LINK,
            createdAt: STAMP, updatedAt: STAMP,
        });
        expect(repaired.projects[0].attachments?.[0].kind).toBe('link');
        expect(repaired.projects[0].attachments?.[0].uri).toBe(LINK);
        expect(repaired.projects[0].attachments?.[0].title).toBe(LINK);
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(repaired);


        const before = statSync(filePath);
        const reread = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(await reread.text()).toBe(body);
        const after = statSync(filePath);
        expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
    });

    test('names the offending field path when a stored attachment stays unreadable', async () => {
        const data = legacyData() as unknown as { tasks: Record<string, unknown>[]; projects: Record<string, unknown>[] };
        data.tasks[0].attachments = [{ id: 'attachment-1', kind: 'file', title: 'Report' }];
        data.projects[0].attachments = LINK;
        writeFileSync(filePath, JSON.stringify(data));

        const response = await fetch(`${baseUrl}/v1/data`, { headers });
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain('tasks[0].attachments[0]');
        expect(body).not.toContain(LINK);
    });

    test('does not replace an unsupported malformed document or trust it after rejection', async () => {
        const malformed = legacyData();
        malformed.tasks[0].attachments = 'not a URL';
        const bytes = JSON.stringify(malformed);
        writeFileSync(filePath, bytes);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await fetch(`${baseUrl}/v1/data`, { headers });
            expect(response.status).toBe(500);
            expect(readFileSync(filePath, 'utf8')).toBe(bytes);
        }
        const patch = await fetch(`${baseUrl}/v1/tasks/${TASK_ID}`, {
            method: 'PATCH', headers, body: JSON.stringify({ title: 'Must not save' }),
        });
        expect(patch.status).toBe(500);
        expect(readFileSync(filePath, 'utf8')).toBe(bytes);
    });
});
