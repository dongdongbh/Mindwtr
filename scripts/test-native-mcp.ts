// Runs the official MCP client against the native HTTP listener with fixture data.
// Real persistence is covered by the shared-operation Rust tests.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

execFileSync(process.execPath, ['scripts/generate-native-task-search-fixtures.ts', '--check'], {
    env: { ...process.env, TZ: 'America/New_York' }, stdio: 'inherit',
});

const target = resolve(process.env.CARGO_TARGET_DIR ?? 'apps/desktop/src-tauri/target');
mkdirSync(target, { recursive: true });
const directory = mkdtempSync(join(target, 'mcp-sdk-'));
const ready = join(directory, 'ready');
const stop = join(directory, 'stop');
const token = 'native-sdk-test-token';
const child = spawn('cargo', ['test', '--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml',
    '--lib', 'mcp_server::tests::mcp_sdk_listener_fixture', '--', '--ignored', '--exact', '--nocapture'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, TMPDIR: directory, MINDWTR_MCP_TEST_PORT: '0',
        MINDWTR_MCP_TEST_TOKEN: token, MINDWTR_MCP_TEST_READY: ready, MINDWTR_MCP_TEST_STOP: stop },
});
let spawnError: Error | undefined;
let didExit = false;
const exited = new Promise<number | null>((done) => {
    child.once('error', (error) => { spawnError = error; done(null); });
    child.once('exit', (code) => { didExit = true; done(code); });
});
const client = new Client({ name: 'mindwtr-native-smoke', version: '1.0.0' });
try {
    const deadline = Date.now() + 300_000;
    while (!existsSync(ready)) {
        if (spawnError) throw spawnError;
        assert.equal(didExit, false, 'Native fixture exited before becoming ready');
        assert.ok(Date.now() < deadline, 'Native fixture startup timed out');
        await delay(100);
    }
    const port = Number(readFileSync(ready, 'utf8').trim());
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    await client.ping();
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    assert.ok(tools.some((tool) => tool.name === 'mindwtr_list_tasks'));
    assert.ok(tools.some((tool) => tool.name === 'mindwtr_archive_task'));
    for (const tool of tools) assert.equal(tool.inputSchema.type, 'object');
    for (const name of ['mindwtr_list_tasks', 'mindwtr_list_projects', 'mindwtr_list_areas']) {
        const result = await client.callTool({ name, arguments: {} });
        assert.notEqual(result.isError, true, name);
        assert.ok(Array.isArray(result.content));
    }
    const task = await client.callTool({ name: 'mindwtr_get_task', arguments: { id: 'native-fixture-task' } });
    assert.notEqual(task.isError, true);
    assert.ok(JSON.stringify(task.content).includes('Native MCP fixture'));
    const denied = await client.callTool({ name: 'mindwtr_add_task', arguments: { title: 'must not write' } });
    assert.equal(denied.isError, true);
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping' });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    assert.equal((await fetch(url, { method: 'POST', headers, body: rpc })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers,
        Authorization: `bearer ${token}` }, body: rpc })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers,
        Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' }, body: rpc })).status, 403);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    console.log('Native MCP SDK smoke passed: handshake, discovery, reads, read-only, authentication, origin checks.');
} finally {
    await client.close().catch(() => {});
    writeFileSync(stop, 'stop');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const code = await exited;
    clearTimeout(timer);
    rmSync(directory, { recursive: true, force: true });
    if (code !== 0) process.exitCode = 1;
}
