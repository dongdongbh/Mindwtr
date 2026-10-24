import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A separate origin exercises the shipped workers, independent of Vite's dev mode.
const pwaWorker = readFileSync('apps/desktop/public/sw.js', 'utf8');
const onlineWorker = readFileSync('docker/app/sw-online.js', 'utf8');
let server: Server;
let origin: string;
let onlineOnly = false;
let denied = false;
let basicAuthRequired = false;
const shell = '<!doctype html><title>Mindwtr worker test</title><input id="draft">';

test.beforeAll(async () => {
    server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.url === '/sw.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(onlineOnly ? onlineWorker : pwaWorker);
        } else if (req.url?.startsWith('/v1/')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end('{"error":"missing bearer token"}');
        } else if (denied || (basicAuthRequired && req.headers.authorization !== `Basic ${Buffer.from('demo:demo').toString('base64')}`)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Mindwtr"' });
            res.end('Authentication required');
        } else {
            res.setHeader('Content-Type', 'text/html');
            res.end(shell);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    origin = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(() => {
    onlineOnly = false;
    denied = false;
    basicAuthRequired = false;
});
test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('online-only replaces an installed worker without reloading or deleting local data', async ({ page, context }) => {
    await page.goto(origin);
    await page.evaluate(async () => {
        localStorage.setItem('unsynced-task', 'keep local work');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('local-task-test', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('tasks');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('tasks', 'readwrite');
            tx.objectStore('tasks').put('unsynchronized', 'task');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        await (await caches.open('another-app')).put('/other', new Response('keep'));
        await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle('Mindwtr worker test');
    await context.setOffline(false);
    await page.locator('#draft').fill('unsaved draft');
    onlineOnly = true;
    // Updating a public script also works while page authentication is denied.
    denied = true;
    await page.evaluate(async () => {
        const changed = new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
        await (await navigator.serviceWorker.getRegistration())!.update();
        await changed;
    });
    await expect(page.locator('#draft')).toHaveValue('unsaved draft');
    expect(await page.evaluate(() => new Promise(resolve => {
        navigator.serviceWorker.addEventListener('message', event => resolve(event.data), { once: true });
        navigator.serviceWorker.controller!.postMessage('mindwtr-service-worker-mode');
    }))).toBe('mindwtr-service-worker-online-only');
    const response = await page.reload();
    expect(response?.status()).toBe(401);
    expect(response?.fromServiceWorker()).toBe(false);
    await expect(page.locator('body')).toContainText('Authentication required');
    denied = false;
    await page.goto(origin);
    expect(await page.evaluate(() => localStorage.getItem('unsynced-task'))).toBe('keep local work');
    expect(await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>(resolve => {
            const request = indexedDB.open('local-task-test');
            request.onsuccess = () => resolve(request.result);
        });
        const value = await new Promise(resolve => {
            const request = db.transaction('tasks').objectStore('tasks').get('task');
            request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return value;
    })).toBe('unsynchronized');
    expect(await page.evaluate(async () => (await caches.match('/other'))?.text())).toBe('keep');
    expect(await page.evaluate(async () => (await fetch('/v1/data')).status)).toBe(401);
    await context.setOffline(true);
    await expect(page.reload()).rejects.toThrow();
    await context.setOffline(false);
});

test('a restarted profile keeps local work and recovers with the replacement worker', async ({ playwright, browserName }) => {
    const directory = await mkdtemp(join(homedir(), 'mindwtr-worker-test-'));
    const browserType = playwright[browserName];
    const credentials = { username: 'demo', password: 'demo' };
    basicAuthRequired = true;
    let context = await browserType.launchPersistentContext(directory, { headless: true, httpCredentials: credentials });
    try {
        let page = context.pages()[0];
        expect((await page.goto(origin))?.status()).toBe(200);
        await page.evaluate(async () => {
            localStorage.setItem('unsynced-task', 'survives browser restart');
            await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
            await navigator.serviceWorker.ready;
        });
        await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
        await context.close();

        // No credentials after restart; a headless browser cannot show a login dialog.
        context = await browserType.launchPersistentContext(directory, { headless: true });
        page = context.pages()[0];
        expect((await page.goto(origin))?.status()).toBe(401);
        onlineOnly = true;
        await page.evaluate(async () => {
            const changed = new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
            await (await navigator.serviceWorker.getRegistration())!.update();
            await changed;
        });
        const deniedResponse = await page.reload();
        expect(deniedResponse?.status()).toBe(401);
        expect(deniedResponse?.fromServiceWorker()).toBe(false);
        await context.close();

        context = await browserType.launchPersistentContext(directory, { headless: true, httpCredentials: credentials });
        page = context.pages()[0];
        expect((await page.goto(origin))?.status()).toBe(200);
        expect(await page.evaluate(() => localStorage.getItem('unsynced-task'))).toBe('survives browser restart');
    } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
    }
});
