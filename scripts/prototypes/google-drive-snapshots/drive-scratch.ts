/** Isolated synthetic-data experiment. NOT an application sync backend. */
import { randomUUID } from 'node:crypto';
import type { Snapshot } from './model';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MARKER = 'mindwtrSnapshotPrototype';
const MAX_FILES = 16;
const MAX_BYTES = 2 * 1024 * 1024;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,200}$/.test(id);
export class ScratchError extends Error {
  constructor(readonly category: string) { super(category); }
}
const fail = (category: string): never => { throw new ScratchError(category); };
const object = (text: string): Record<string, any> => {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Never expose provider bodies. */ }
  return fail('invalid-response');
};

export function createScratchDriveStore(options: {
  accessToken: string; allowTestWrites?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number;
}) {
  if (options.allowTestWrites !== true) fail('writes-not-authorized');
  if (!options.accessToken?.trim()) fail('invalid-token');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('invalid-timeout');
  const namespace = randomUUID();
  const generated = new Set<string>();
  const attempted = new Set<string>();
  const fetchImpl = options.fetchImpl ?? fetch;
  const metrics = { requests: 0, uploadedBytes: 0, downloadedBytes: 0, created: 0, duplicateRetries: 0 };
  const metadataUrl = (id: string) => `${API}/files/${encodeURIComponent(id)}?fields=id,appProperties`;
  const owned = (body: Record<string, any>, id: string) => body.id === id
    && body.appProperties?.[MARKER] === namespace;

  async function request(url: string, method = 'GET', body?: string, contentType?: string) {
    if (++metrics.requests > 200) return fail('request-budget');
    const controller = new AbortController();
    let cancelBody: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        cancelBody?.();
        reject(new ScratchError('request-timeout'));
      }, timeoutMs);
    });
    if (body) metrics.uploadedBytes += Buffer.byteLength(body);
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, {
          method, body, redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${options.accessToken}`,
            ...(contentType ? { 'Content-Type': contentType } : {}) },
        });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          cancelBody = () => { void reader.cancel().catch(() => {}); };
          try {
            while (true) {
              if (controller.signal.aborted) return fail('request-timeout');
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > MAX_BYTES) { cancelBody(); return fail('response-too-large'); }
              chunks.push(chunk.value);
            }
          } finally { reader.releaseLock(); cancelBody = undefined; }
        }
        if (controller.signal.aborted) return fail('request-timeout');
        metrics.downloadedBytes += size;
        return { status: response.status, text: Buffer.concat(chunks).toString('utf8') };
      })()]);
    } catch (error) {
      throw error instanceof ScratchError ? error : new ScratchError('request-failed');
    } finally { clearTimeout(timer); }
  }

  return {
    namespace,
    metrics,
    async generateId(): Promise<string> {
      if (generated.size >= MAX_FILES) return fail('file-budget');
      const response = await request(`${API}/files/generateIds?count=1&space=drive&type=files`);
      if (response.status !== 200) return fail('generate-failed');
      const ids = object(response.text).ids;
      if (!Array.isArray(ids) || ids.length !== 1 || !validId(ids[0]) || generated.has(ids[0])) {
        return fail('invalid-generated-id');
      }
      generated.add(ids[0]);
      return ids[0];
    },
    async publish(snapshot: Snapshot): Promise<'created' | 'already-exists'> {
      if (!generated.has(snapshot.id) || snapshot.namespace !== namespace) return fail('foreign-snapshot');
      const bytes = JSON.stringify(snapshot);
      if (Buffer.byteLength(bytes) > MAX_BYTES / 2) return fail('snapshot-too-large');
      const boundary = `mindwtr-${randomUUID()}`;
      const metadata = { id: snapshot.id, name: `mindwtr-snapshot-PROTOTYPE-${randomUUID()}.json`,
        mimeType: 'application/json', appProperties: { [MARKER]: namespace } };
      const multipart = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
        JSON.stringify(metadata), `--${boundary}`, 'Content-Type: application/json', '',
        bytes, `--${boundary}--`, ''].join('\r\n');
      attempted.add(snapshot.id); // Includes timeout/ambiguous create; cleanup revalidates.
      const response = await request(`${UPLOAD}/files?uploadType=multipart&fields=id`,
        'POST', multipart, `multipart/related; boundary=${boundary}`);
      if (response.status !== 200 && response.status !== 409) return fail('create-failed');
      if (response.status === 200 && object(response.text).id !== snapshot.id) return fail('create-id-mismatch');
      const metadataRead = await request(metadataUrl(snapshot.id));
      if (metadataRead.status !== 200 || !owned(object(metadataRead.text), snapshot.id)) return fail('ownership-mismatch');
      const readBack = await request(`${API}/files/${encodeURIComponent(snapshot.id)}?alt=media`);
      if (readBack.status !== 200 || readBack.text !== bytes) return fail('immutable-content-mismatch');
      if (response.status === 409) { metrics.duplicateRetries++; return 'already-exists'; }
      metrics.created++;
      return 'created';
    },
    async readAll(): Promise<Snapshot[]> {
      const query = `trashed = false and appProperties has { key='${MARKER}' and value='${namespace}' }`;
      const ids = new Set<string>();
      const pages = new Set<string>();
      let next: string | undefined;
      do {
        const params = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '16',
          fields: 'files(id,appProperties),nextPageToken,incompleteSearch' });
        if (next) params.set('pageToken', next);
        const response = await request(`${API}/files?${params}`);
        if (response.status !== 200) return fail('list-failed');
        const page = object(response.text);
        if (page.incompleteSearch === true || !Array.isArray(page.files)) return fail('incomplete-list');
        for (const file of page.files) {
          if (!file || !validId(file.id) || !owned(file, file.id)) return fail('foreign-list-entry');
          ids.add(file.id);
          if (ids.size > MAX_FILES) return fail('file-budget');
        }
        next = page.nextPageToken;
        if (next !== undefined && (typeof next !== 'string' || !next || pages.has(next))) return fail('invalid-page');
        if (next) pages.add(next);
        if (pages.size > MAX_FILES) return fail('page-budget');
      } while (next);
      const result: Snapshot[] = [];
      for (const id of [...ids].sort()) {
        const response = await request(`${API}/files/${encodeURIComponent(id)}?alt=media`);
        if (response.status !== 200) return fail('snapshot-unavailable');
        const snapshot = object(response.text);
        if (snapshot.id !== id || snapshot.namespace !== namespace) return fail('snapshot-identity-mismatch');
        result.push(snapshot as Snapshot); // Full schema/graph validation belongs to model.
      }
      return result;
    },
    async cleanup(): Promise<{ attempted: number; deleted: number; absent: number; failed: number }> {
      const result = { attempted: attempted.size, deleted: 0, absent: 0, failed: 0 };
      // Never delete by list/name or response ID. Only IDs generated AND submitted by this instance.
      for (const id of attempted) {
        try {
          const validation = await request(metadataUrl(id));
          if (validation.status === 404) { result.absent++; continue; }
          if (validation.status !== 200 || !owned(object(validation.text), id)) { result.failed++; continue; }
          const deletion = await request(`${API}/files/${encodeURIComponent(id)}`, 'DELETE');
          if (deletion.status === 204) result.deleted++;
          else if (deletion.status === 404) result.absent++;
          else result.failed++;
        } catch { result.failed++; }
      }
      return result;
    },
  };
}
