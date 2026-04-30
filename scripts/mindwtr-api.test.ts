import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const BUN_BIN = Bun.which('bun') || process.execPath;
const tempDirs: string[] = [];

const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-api-'));
    tempDirs.push(dir);
    return dir;
};

const getFreePort = async (): Promise<number> => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => {
            if (address && typeof address === 'object') {
                resolve(address.port);
            } else {
                reject(new Error('Failed to allocate a test port'));
            }
        });
    });
});

const waitForHealth = async (baseUrl: string) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await Bun.sleep(50);
    }
    throw lastError instanceof Error ? lastError : new Error('Local API did not become ready');
};

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('mindwtr-api', () => {
    test('lists active areas from the Local API', async () => {
        const dir = makeTempDir();
        const dataPath = join(dir, 'data.json');
        const port = await getFreePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const now = '2026-04-27T12:00:00.000Z';

        writeFileSync(dataPath, JSON.stringify({
            tasks: [],
            projects: [],
            sections: [],
            areas: [
                {
                    id: 'area-work',
                    name: 'Work',
                    color: '#2563eb',
                    icon: 'briefcase',
                    order: 2,
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'area-deleted',
                    name: 'Deleted',
                    color: '#64748b',
                    order: 3,
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: now,
                },
            ],
            settings: {},
        }, null, 2));

        const server = Bun.spawn({
            cmd: [
                BUN_BIN,
                'scripts/mindwtr-api.ts',
                '--',
                '--port',
                String(port),
                '--host',
                '127.0.0.1',
                '--data',
                dataPath,
            ],
            cwd: REPO_ROOT,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, MINDWTR_API_TOKEN: '' },
        });

        try {
            await waitForHealth(baseUrl);

            const response = await fetch(`${baseUrl}/areas`);
            expect(response.status).toBe(200);
            const body = await response.json() as {
                areas: Array<Record<string, unknown>>;
            };
            expect(body.areas).toHaveLength(1);
            expect(body.areas[0]).toMatchObject({
                id: 'area-work',
                name: 'Work',
                color: '#2563eb',
                icon: 'briefcase',
                order: 2,
                createdAt: now,
                updatedAt: now,
            });

            const aliasResponse = await fetch(`${baseUrl}/v1/areas`);
            expect(aliasResponse.status).toBe(200);
            const aliasBody = await aliasResponse.json() as {
                areas: Array<Record<string, unknown>>;
            };
            expect(aliasBody.areas[0]?.id).toBe('area-work');
        } finally {
            server.kill();
            await server.exited.catch(() => undefined);
        }
    });
});
