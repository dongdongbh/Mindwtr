import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const json = (status, value, headers = {}) => ({ status, headers: { 'Content-Type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(value)) });
const pathError = (tag, nested) => json(409, { error_summary: `${tag}/${nested}/`, error: { '.tag': tag, [tag]: { '.tag': nested } } });
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');

export const createDropboxFake = ({ clientId, accessLifetimeSeconds = 14_400 }) => {
    const state = {
        files: new Map(), authorizes: [], tokens: [], requests: [], codes: new Map(),
        access: new Map(), refresh: new Set(), revoked: [], rev: 0, failNextAuth: 0, rejected: 0,
    };
    const issueAccess = (refresh) => {
        const token = `access-${randomBytes(9).toString('hex')}`;
        state.access.set(token, { refresh, expiresAt: Date.now() + accessLifetimeSeconds * 1000 });
        return token;
    };
    const metadata = (path, file) => ({ '.tag': 'file', name: path.split('/').pop(), path_lower: path.toLowerCase(), path_display: path,
        id: `id:${path}`, rev: file.rev, size: file.body.length, server_modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    const authorized = (headers) => {
        const token = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
        const grant = token && state.access.get(token);
        if (state.failNextAuth > 0) { state.failNextAuth -= 1; return false; }
        return Boolean(grant && grant.expiresAt > Date.now() && state.refresh.has(grant.refresh));
    };
    const token = (form) => {
        if (form.get('client_id') !== clientId) return json(400, { error: 'invalid_client', error_description: 'client_id is wrong' });
        if (form.get('grant_type') === 'authorization_code') {
            const issued = state.codes.get(form.get('code'));
            state.codes.delete(form.get('code'));
            if (!issued || issued.redirectUri !== form.get('redirect_uri') || issued.challenge !== challengeOf(form.get('code_verifier') ?? '')) {
                return json(400, { error: 'invalid_grant', error_description: 'code doesn\'t exist or has expired' });
            }
            const refresh = `refresh-${randomBytes(9).toString('hex')}`;
            state.refresh.add(refresh);
            state.tokens.push('authorization_code');
            return json(200, { access_token: issueAccess(refresh), token_type: 'bearer', expires_in: accessLifetimeSeconds, refresh_token: refresh,
                scope: issued.scope, uid: '1', account_id: 'dbid:fake' });
        }
        if (form.get('grant_type') === 'refresh_token') {
            state.tokens.push('refresh_token');
            if (!state.refresh.has(form.get('refresh_token'))) return json(400, { error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' });
            return json(200, { access_token: issueAccess(form.get('refresh_token')), token_type: 'bearer', expires_in: accessLifetimeSeconds });
        }
        return json(400, { error: 'unsupported_grant_type' });
    };
    const answer = (request) => {
        const reply = fake.handle(request);
        return { ...reply, headers: { Date: new Date().toUTCString(), ...reply.headers } };
    };
    const handle = ({ method, url, headers, body }) => {
        const { pathname, searchParams } = new URL(url, 'http://dropbox.fake');
        state.requests.push(`${method} ${pathname}`);
        if (pathname === '/oauth2/authorize') {
            const query = Object.fromEntries(searchParams);
            state.authorizes.push(query);
            const code = `code-${randomBytes(6).toString('hex')}`;
            state.codes.set(code, { redirectUri: query.redirect_uri, challenge: query.code_challenge, scope: query.scope, state: query.state });
            return { status: 200, headers: { 'Content-Type': 'text/html' }, body: Buffer.from(`<html><body>Fake Dropbox sign-in ${code}</body></html>`) };
        }
        if (pathname === '/oauth2/token') return token(new URLSearchParams(Buffer.from(body ?? []).toString('utf8')));
        if (!authorized(headers)) {
            state.rejected += 1;
            return json(401, { error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } });
        }
        const bearer = /^Bearer (.+)$/.exec(headers.authorization)[1];
        if (pathname === '/2/auth/token/revoke') {
            state.refresh.delete(state.access.get(bearer).refresh);
            state.revoked.push(bearer);
            return { status: 200, headers: {}, body: Buffer.from('null') };
        }
        const arg = headers['dropbox-api-arg'] ? JSON.parse(headers['dropbox-api-arg']) : JSON.parse(Buffer.from(body ?? []).toString('utf8') || '{}');
        const file = state.files.get(arg.path);
        switch (pathname) {
            case '/2/files/download':
                if (!file) return pathError('path', 'not_found');
                return { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify(metadata(arg.path, file)), 'Content-Type': 'application/octet-stream', Date: new Date().toUTCString() }, body: file.body };
            case '/2/files/get_metadata':
                return file ? json(200, metadata(arg.path, file)) : pathError('path', 'not_found');
            case '/2/files/upload': {
                const mode = arg.mode?.['.tag'] ?? 'add';
                if ((mode === 'add' && file) || (mode === 'update' && file?.rev !== arg.mode.update)) {
                    return json(409, { error_summary: 'path/conflict/file/', error: { '.tag': 'path', reason: { '.tag': 'conflict' } } });
                }
                const written = { body: Buffer.from(body ?? []), rev: `0${(++state.rev).toString(16).padStart(8, '0')}` };
                state.files.set(arg.path, written);
                return json(200, metadata(arg.path, written));
            }
            case '/2/files/delete_v2':
                if (!file) return pathError('path_lookup', 'not_found');
                if (arg.parent_rev && arg.parent_rev !== file.rev) return json(409, { error_summary: 'path_lookup/conflict/', error: { '.tag': 'path_lookup', path_lookup: { '.tag': 'conflict' } } });
                state.files.delete(arg.path);
                return json(200, { metadata: metadata(arg.path, file) });
            case '/2/files/list_folder': {
                const prefix = `${arg.path}/`;
                const entries = [...state.files].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'));
                if (entries.length === 0) return pathError('path', 'not_found');
                return json(200, { entries: entries.map(([path, entry]) => metadata(path, entry)), cursor: 'done', has_more: false });
            }
            case '/2/files/list_folder/continue':
                return json(200, { entries: [], cursor: 'done', has_more: false });
            default:
                return json(400, { error_summary: `unsupported ${pathname}` });
        }
    };
    const fetch = async (input, init = {}) => {
        const body = init.body === undefined || init.body === null ? undefined
            : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body);
        const headers = Object.fromEntries([...new Headers(init.headers)].map(([name, value]) => [name.toLowerCase(), value]));
        const reply = fake.answer({ method: init.method ?? 'GET', url: String(input).replace(/^https:\/\/[a-z.]*dropbox(api)?\.com/, ''), headers, body });
        return new Response(reply.body, { status: reply.status, headers: reply.headers });
    };
    const redirectFor = (authorize) => {
        const code = [...state.codes].find(([, issued]) => issued.state === authorize.state)?.[0];
        return `${authorize.redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(authorize.state)}`;
    };
    const fake = { state, handle, answer: (request) => answer(request), fetch, redirectFor, challengeOf };
    return fake;
};

export const serveDropbox = ({ port, clientId }) => new Promise((ready) => {
    const fake = createDropboxFake({ clientId });
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const reply = fake.answer({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
            res.writeHead(reply.status, reply.headers);
            res.end(reply.body);
        });
    });
    server.listen(port, '127.0.0.1', () => ready({ ...fake, server, close: () => new Promise((done) => server.close(done)) }));
});
