// A WebDAV folder in memory for the device checks and the native bundle's tests (sync-harness.mjs re-exports it). Kept apart
// from sync-harness.mjs, whose second device loads node:sqlite, which Bun's test runner cannot resolve.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const serveWebdav = ({ port, username, password, open = false }) => new Promise((ready) => {
    const files = new Map();
    let version = 0;
    // `requests`: every request as it arrived; `authorized`: only those that carried the folder's user and password.
    // `delayMs`: every answer waits that long (a slow server). `holdWrites`: while it is a promise, a write of a sync document
    // waits for it and then fails with 503 (the write never landed); `heldAt` holds when each held write arrived (ms).
    const state = { files, requests: [], authorized: [], failWrites: 0, down: false, delayMs: 0, weakEtags: false, holdWrites: null, heldAt: [] };
    const authorized = (req) => open || req.headers.authorization === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => setTimeout(() => {
            const body = Buffer.concat(chunks);
            // A folder is stored and logged without its trailing slash; PROPFIND lists it with one, as real servers do.
            const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/(.)\/+$/, '$1');
            state.requests.push(`${req.method} ${path}`);
            const answer = (status, headers = {}, data = '') => {
                res.writeHead(status, headers);
                res.end(req.method === 'HEAD' ? undefined : data);
            };
            if (state.down) return answer(503, { 'Content-Type': 'text/plain' }, 'down');
            if (!authorized(req)) return answer(401, { 'WWW-Authenticate': 'Basic realm="mindwtr-test"' });
            state.authorized.push(`${req.method} ${path}`);
            const file = files.get(path);
            const ifMatch = req.headers['if-match'];
            const ifNoneMatch = req.headers['if-none-match'];
            const preconditionFails = () => (ifMatch !== undefined && (!file || file.dir || ifMatch !== file.etag))
                || (ifNoneMatch === '*' && file !== undefined);
            switch (req.method) {
                case 'GET':
                case 'HEAD':
                    if (!file || file.dir) return answer(404);
                    return answer(200, { ETag: file.etag, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.body.length) }, file.body);
                case 'PUT': {
                    if (state.holdWrites && path.endsWith('/data.json')) {
                        state.heldAt.push(Date.now());
                        void state.holdWrites.then(() => answer(503, { 'Content-Type': 'text/plain' }, 'held'));
                        return undefined;
                    }
                    if (preconditionFails()) return answer(412);
                    if (state.failWrites > 0 && path.endsWith('/data.json')) {
                        state.failWrites -= 1;
                        return answer(500, { 'Content-Type': 'text/plain' }, 'write failed');
                    }
                    const etag = `${state.weakEtags ? 'W/' : ''}"${++version}-${createHash('sha1').update(body).digest('hex').slice(0, 12)}"`;
                    files.set(path, { body, etag });
                    return answer(file ? 204 : 201, { ETag: etag });
                }
                case 'DELETE':
                    if (!file) return answer(404);
                    if (preconditionFails()) return answer(412);
                    files.delete(path);
                    return answer(204);
                case 'MKCOL':
                    if (file) return answer(405);
                    files.set(path, { dir: true });
                    return answer(201);
                case 'PROPFIND': {
                    const prefix = path.endsWith('/') ? path : `${path}/`;
                    const entries = [...files].filter(([name]) => name === path || (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')));
                    if (entries.length === 0 && path !== '/') return answer(404);
                    const xml = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${entries.map(([name, entry]) => (
                        `<d:response><d:href>${encodeURI(name)}${entry.dir ? '/' : ''}</d:href><d:propstat><d:prop>${entry.dir ? '<d:resourcetype><d:collection/></d:resourcetype>'
                            : `<d:resourcetype/><d:getetag>${entry.etag}</d:getetag><d:getcontentlength>${entry.body.length}</d:getcontentlength>`}</d:prop>`
                        + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
                    )).join('')}</d:multistatus>`;
                    return answer(207, { 'Content-Type': 'application/xml; charset=utf-8' }, xml);
                }
                default:
                    return answer(405);
            }
        }, state.delayMs));
    });
    server.listen(port, '127.0.0.1', () => ready({ server, state, close: () => new Promise((done) => server.close(done)) }));
});

/** The sync document the WebDAV folder holds now, parsed; null when there is none. */
export const webdavDocument = (dav, folder) => {
    const file = dav.state.files.get(`${folder}/data.json`);
    return file && !file.dir ? JSON.parse(file.body.toString('utf8')) : null;
};

