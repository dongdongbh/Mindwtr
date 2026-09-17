/** Read-only discovery experiment. No app storage, publication, or history GC. */
import { createCachedSnapshotResolver, type Snapshot } from './model';

export type Checkpoint = {
  version: 1;
  revision: number;
  namespace: string;
  cursor: string;
  snapshots: Snapshot[];
};
export interface CheckpointStore {
  load(): Promise<Checkpoint | null>;
  save(next: Checkpoint, expectedRevision: number | null): Promise<void>;
}
export type SnapshotChange = { id: string; removed: boolean; owned: boolean };
export type ChangePage = {
  changes: SnapshotChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
};
export interface DiscoverySource {
  readonly namespace: string;
  getStartPageToken(): Promise<string>;
  readAll(): Promise<Snapshot[]>;
  readSnapshot(id: string): Promise<Snapshot>;
  getChangePage(cursor: string): Promise<ChangePage>;
}

export class DiscoveryError extends Error {
  constructor(readonly category: string) { super(category); }
}
const fail = (category: string): never => { throw new DiscoveryError(category); };
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,200}$/.test(value);

export function createIncrementalDiscovery(source: DiscoverySource, store: CheckpointStore) {
  if (!token(source.namespace)) fail('invalid-namespace');
  const resolver = createCachedSnapshotResolver(source.namespace);
  let running = false;

  return {
    async sync(nowIso: string) {
      if (running) return fail('discovery-busy');
      running = true;
      try {
        if (!Number.isFinite(Date.parse(nowIso))) return fail('invalid-clock');
        const saved = await store.load();
        if (saved !== null && (saved.version !== 1 || saved.namespace !== source.namespace
          || !Number.isSafeInteger(saved.revision) || saved.revision < 1
          || !token(saved.cursor) || !Array.isArray(saved.snapshots))) return fail('invalid-checkpoint');
        // Validate restored disk data before it can seed discovery. The resolver
        // reuses only its own in-memory proofs, never flags stored in the cache.
        if (saved) resolver.resolve(saved.snapshots, nowIso);
        const start = saved?.cursor ?? await source.getStartPageToken();
        if (!token(start)) return fail('invalid-cursor');
        // Capture the start token BEFORE listing, then replay the listing window.
        const initial = saved?.snapshots ?? await source.readAll();
        const snapshots = new Map<string, Snapshot>();
        const remember = (snapshot: Snapshot, expectedId?: string) => {
          if (!snapshot || !validId(snapshot.id) || (expectedId && expectedId !== snapshot.id)
            || snapshot.namespace !== source.namespace) return fail('snapshot-identity-mismatch');
          const prior = snapshots.get(snapshot.id);
          if (prior && JSON.stringify(prior) !== JSON.stringify(snapshot)) return fail('immutable-content-changed');
          snapshots.set(snapshot.id, structuredClone(snapshot));
          if (snapshots.size > 128) return fail('history-budget');
        };
        for (const snapshot of initial) remember(snapshot);

        let cursor = start;
        let finalCursor: string | undefined;
        const visited = new Set<string>();
        const changed = new Set<string>();
        let feedEntries = 0;
        let pages = 0;
        do {
          if (visited.has(cursor) || ++pages > 64) return fail('change-page-budget');
          visited.add(cursor);
          const page = await source.getChangePage(cursor);
          if (!page || !Array.isArray(page.changes)) return fail('invalid-change-page');
          feedEntries += page.changes.length;
          if (feedEntries > 10_000) return fail('change-entry-budget');
          for (const change of page.changes) {
            if (!change || !validId(change.id) || typeof change.removed !== 'boolean'
              || typeof change.owned !== 'boolean') return fail('invalid-change');
            const known = snapshots.has(change.id) || changed.has(change.id);
            // A removal may mean permission loss, not deletion. Never map a
            // missing Drive file onto a task deletion or prune cached history.
            if (change.removed || !change.owned) {
              if (known || (change.removed && change.owned)) return fail('history-unavailable');
              continue;
            }
            changed.add(change.id);
          }
          if (page.nextPageToken !== undefined) {
            if (!token(page.nextPageToken) || page.newStartPageToken !== undefined) return fail('invalid-change-page');
            cursor = page.nextPageToken;
          } else {
            if (!token(page.newStartPageToken)) return fail('missing-final-cursor');
            finalCursor = page.newStartPageToken;
          }
        } while (finalCursor === undefined);

        if (new Set([...snapshots.keys(), ...changed]).size > 128) return fail('history-budget');
        // Fetch once per ID after all pages. Parent files may appear later than
        // their children; validation happens only on the complete candidate DAG.
        for (const id of [...changed].sort()) remember(await source.readSnapshot(id), id);
        const candidate = [...snapshots.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const resolved = resolver.resolve(candidate, nowIso);
        const needsSave = saved === null || finalCursor !== saved.cursor || candidate.length !== saved.snapshots.length;
        if (needsSave) {
          const next: Checkpoint = { version: 1, revision: (saved?.revision ?? 0) + 1,
            namespace: source.namespace, cursor: finalCursor, snapshots: candidate };
          // This is the only acknowledgement boundary. Failure propagates;
          // callers must not report successful sync or advance their cursor.
          await store.save(next, saved?.revision ?? null);
        }
        return { ...resolved, mode: saved ? 'incremental' as const : 'rebuild' as const,
          downloadedSnapshots: (saved ? 0 : initial.length) + changed.size,
          changePages: pages, checkpointWritten: needsSave };
      } finally { running = false; }
    },
  };
}
