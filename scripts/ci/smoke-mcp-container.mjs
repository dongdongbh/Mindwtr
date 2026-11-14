import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const image = process.argv[2];
assert.ok(image, 'Usage: node scripts/ci/smoke-mcp-container.mjs IMAGE');
const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(readFileSync(resolve(root, 'apps/mcp-server/package.json'), 'utf8')).version;
const scratch = resolve(root, 'apps/mcp-server/.container-smoke');
mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(`${scratch}/run-`);
const cloudToken = 'container-smoke-cloud-token';
const httpToken = 'container-smoke-http-token';
const containers = new Set();
const clients = new Set();
let cloud;
let cloudOutput = '';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }).trim();
const baseArgs = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--add-host=host.docker.internal:host-gateway'];
const name = (suffix) => `mindwtr-mcp-smoke-${process.pid}-${suffix}`;
const pass = (message) => console.log(`PASS ${message}`);
const payload = (result) => {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content.find((item) => item.type === 'text').text);
};

const stopCloud = async () => {
    if (!cloud || cloud.exitCode !== null || cloud.signalCode !== null) return;
    const stopped = once(cloud, 'exit');
    cloud.kill('SIGTERM');
    const timer = setTimeout(() => cloud.kill('SIGKILL'), 5_000);
    await stopped;
    clearTimeout(timer);
};

try {
    const info = JSON.parse(docker('image', 'inspect', image))[0];
    assert.ok(info.Config.User && !['0', 'root', '0:0', 'root:root'].includes(info.Config.User));
    assert.equal(info.Config.Labels['org.opencontainers.image.version'], version);
    const probe = JSON.parse(docker('run', '--rm', '--read-only', '--entrypoint=node', image, '-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        assert.notEqual(process.getuid(), 0);
        assert.throws(() => fs.writeFileSync('/app/smoke-write', 'must fail'), { code: 'EROFS' });
        assert.throws(() => require.resolve('better-sqlite3'), { code: 'MODULE_NOT_FOUND' });
        assert.equal(fs.readdirSync('/app', { recursive: true }).some(p => p.endsWith('.node')), false);
        console.log(JSON.stringify({ uid: process.getuid(), version: require('/app/package.json').version }));
    `));
    assert.equal(probe.version, version);
    pass(`image version ${version}, uid ${probe.uid}, read-only filesystem, no SQLite native module`);

    const source = `
        import { startCloudServer } from './apps/cloud/src/server.ts';
        const server = await startCloudServer({ host: '0.0.0.0', port: 0,
            dataDir: process.env.MINDWTR_CONTAINER_SMOKE_DATA,
            allowedAuthTokens: [process.env.MINDWTR_CONTAINER_SMOKE_TOKEN] });
        console.log('CONTAINER_SMOKE_PORT=' + server.port);
        process.on('SIGTERM', () => { server.stop(); process.exit(0); });
    `;
    cloud = spawn('bun', ['--eval', source], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MINDWTR_CONTAINER_SMOKE_DATA: directory, MINDWTR_CONTAINER_SMOKE_TOKEN: cloudToken } });
    cloud.on('error', (error) => { cloudOutput += error.message; });
    cloud.stdout.on('data', (chunk) => { cloudOutput += chunk; });
    cloud.stderr.on('data', (chunk) => { cloudOutput += chunk; });
    const deadline = Date.now() + 20_000;
    while (!/CONTAINER_SMOKE_PORT=(\d+)/.test(cloudOutput)) {
        assert.equal(cloud.exitCode, null, cloudOutput);
        assert.ok(Date.now() < deadline, `Cloud startup timed out: ${cloudOutput}`);
        await delay(50);
    }
    const port = Number(/CONTAINER_SMOKE_PORT=(\d+)/.exec(cloudOutput)[1]);
    assert.ok(port > 0);
    const cloudUrl = `http://host.docker.internal:${port}`;
    const hostCloudUrl = `http://127.0.0.1:${port}`;
    const cloudEnv = (token = cloudToken) => ['-e', `MINDWTR_MCP_CLOUD_URL=${cloudUrl}`,
        '-e', `MINDWTR_MCP_CLOUD_TOKEN=${token}`, '-e', 'MINDWTR_MCP_CLOUD_ALLOW_INSECURE_HTTP=true'];
    const cloudData = async () => {
        const response = await fetch(`${hostCloudUrl}/v1/data`, { headers: { Authorization: `Bearer ${cloudToken}` } });
        assert.equal(response.status, 200);
        return response.json();
    };
    const seed = await fetch(`${hostCloudUrl}/v1/tasks`, { method: 'POST',
        headers: { Authorization: `Bearer ${cloudToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Container seeded task' }) });
    assert.equal(seed.status, 201, await seed.clone().text());
    const seeded = (await seed.json()).task;

    const stdioClient = async (suffix, args = [], runtimeArgs = cloudEnv()) => {
        const container = name(suffix);
        containers.add(container);
        const transport = new StdioClientTransport({ command: 'docker',
            args: ['run', '--rm', '-i', '--name', container, ...baseArgs, ...runtimeArgs, image, ...args], stderr: 'pipe' });
        let stderr = '';
        transport.stderr.on('data', (chunk) => { stderr += chunk; });
        const client = new Client({ name: 'mindwtr-container-smoke', version: '1.0.0' });
        clients.add(client);
        await client.connect(transport, { timeout: 15_000 });
        assert.equal(client.getServerVersion().version, version);
        return { client, logs: () => stderr };
    };
    const readonly = await stdioClient('readonly');
    const tools = (await readonly.client.listTools()).tools;
    for (const tool of ['mindwtr_list_tasks', 'mindwtr_get_task', 'mindwtr_add_task']) {
        assert.ok(tools.some((entry) => entry.name === tool), tool);
    }
    assert.equal(payload(await readonly.client.callTool({ name: 'mindwtr_get_task', arguments: { id: seeded.id } })).task.title,
        seeded.title);
    const denied = await readonly.client.callTool({ name: 'mindwtr_add_task', arguments: { title: 'Denied container write' } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /read.only/i);
    assert.equal((await cloudData()).tasks.length, 1);
    pass('stdio initialize, tools/list, real Cloud read, default writes denied without backend mutation');

    const writer = await stdioClient('writer', ['--write']);
    const written = payload(await writer.client.callTool({ name: 'mindwtr_add_task', arguments: { title: 'Container explicit write' } })).task;
    assert.equal(written.title, 'Container explicit write');
    assert.ok((await cloudData()).tasks.some((task) => task.id === written.id));
    pass('explicit --write persisted a task through the real Cloud REST API');

    const badCloud = await stdioClient('bad-cloud', ['--write'], cloudEnv('container-smoke-invalid-token'));
    for (const request of [
        { name: 'mindwtr_list_tasks', arguments: {} },
        { name: 'mindwtr_add_task', arguments: { title: 'Bad token write' } },
    ]) {
        const result = await badCloud.client.callTool(request);
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /401|unauthorized/i);
    }
    assert.equal((await cloudData()).tasks.length, 2);
    for (const session of [readonly, writer, badCloud]) {
        assert.equal(session.logs().includes(cloudToken), false, 'Cloud credential leaked to stderr');
    }
    pass('invalid Cloud token refuses reads and writes without SQLite fallback or mutation');

    const httpContainer = name('http');
    containers.add(httpContainer);
    docker('run', '-d', '--name', httpContainer, ...baseArgs, ...cloudEnv(),
        '-p', '127.0.0.1::8722', '-e', 'MINDWTR_MCP_HTTP_HOST=0.0.0.0',
        '-e', `MINDWTR_MCP_HTTP_TOKEN=${httpToken}`, image);
    const address = docker('port', httpContainer, '8722/tcp');
    let url = new URL(`http://${address}/mcp`);
    const waitHttp = async () => {
        const end = Date.now() + 15_000;
        while (Date.now() < end) {
            try {
                if ((await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(1000) })).status === 200) return;
            } catch {}
            await delay(100);
        }
        throw new Error(`HTTP container did not become ready: ${docker('logs', httpContainer)}`);
    };
    const httpClient = async () => {
        const client = new Client({ name: 'mindwtr-container-http-smoke', version: '1.0.0' });
        clients.add(client);
        await client.connect(new StreamableHTTPClientTransport(url,
            { requestInit: { headers: { Authorization: `Bearer ${httpToken}` } } }), { timeout: 15_000 });
        return client;
    };
    await waitHttp();
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } });
    for (const authorization of [undefined, 'Bearer container-smoke-invalid-token']) {
        const response = await fetch(url, { method: 'POST', body: rpc,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                ...(authorization ? { Authorization: authorization } : {}) } });
        assert.equal(response.status, 401);
    }
    let http = await httpClient();
    assert.equal(payload(await http.callTool({ name: 'mindwtr_get_task', arguments: { id: written.id } })).task.title, written.title);
    await http.close();
    docker('stop', '--time=5', httpContainer);
    assert.equal(JSON.parse(docker('inspect', httpContainer))[0].State.ExitCode, 0);
    docker('start', httpContainer);
    url = new URL(`http://${docker('port', httpContainer, '8722/tcp')}/mcp`);
    await waitHttp();
    http = await httpClient();
    assert.equal(payload(await http.callTool({ name: 'mindwtr_get_task', arguments: { id: written.id } })).task.title, written.title);
    pass('HTTP authentication, initialize/read, clean stop and restart with backend data preserved');

    await stopCloud();
    for (const [client, request] of [
        [http, { name: 'mindwtr_list_tasks', arguments: {} }],
        [writer.client, { name: 'mindwtr_add_task', arguments: { title: 'Unavailable backend write' } }],
    ]) {
        const unavailable = await client.callTool(request);
        assert.equal(unavailable.isError, true);
        assert.match(JSON.stringify(unavailable), /fetch failed|network|connect|unavailable/i);
    }
    pass('unavailable Cloud reads and writes fail closed instead of returning local or empty success');

    const databasePath = resolve(directory, 'fixture.sqlite');
    execFileSync('bun', ['--eval', `import { Database } from 'bun:sqlite';
        const db = new Database(${JSON.stringify(databasePath)});
        db.exec('CREATE TABLE smoke_marker (value TEXT)'); db.close();`], { stdio: 'pipe' });
    for (const [suffix, args, runtimeArgs, error] of [
        ['unconfigured', [], [], /database not found/i],
        ['mounted', ['--db', '/app/fixture.sqlite'],
            ['--mount', `type=bind,source=${databasePath},target=/app/fixture.sqlite,readonly`],
            /Node SQLite mode requires the optional better-sqlite3 addon/],
    ]) {
        const local = await stdioClient(`local-${suffix}`, args, runtimeArgs);
        const result = await local.client.callTool({ name: 'mindwtr_list_tasks', arguments: {} });
        assert.equal(result.isError, true, 'API-only image unexpectedly read a local database');
        assert.match(JSON.stringify(result), error);
    }
    pass('missing backend fails; mounted valid SQLite database explicitly refuses the absent addon');
    console.log(`MCP container smoke passed: ${image}`);
} finally {
    await Promise.allSettled([...clients].map((client) => client.close()));
    for (const container of containers) {
        try { docker('rm', '-f', container); } catch {}
    }
    await stopCloud();
    rmSync(directory, { recursive: true, force: true });
}
